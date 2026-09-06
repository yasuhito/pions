import { Effect } from "effect";

import type {
  CreatedPresentation,
  EventStore,
  Operation,
} from "./event-store/index.js";
import type { ResultAcceptanceOutcome } from "./result-acceptance.js";
import type {
  ResultAcceptanceProof,
  ResultDelivery,
} from "./worker-protocol.js";
import type {
  OperationPersistenceError,
  ResultConflictError,
} from "../public.js";

export interface WorkerProcessIdentity {
  readonly processInstanceId: string;
}

export interface WorkerCancellationEvidence {
  readonly proof: "acknowledgement" | "worker-stop";
}

export interface WorkerRunHooks {
  workerLaunched(): Effect.Effect<void, OperationPersistenceError | ResultConflictError>;
  workerIdentified(
    identity: Readonly<WorkerProcessIdentity>,
  ): Effect.Effect<void, OperationPersistenceError | ResultConflictError>;
  acceptResults(
    deliveries: ReadonlyArray<ResultDelivery>,
  ): Effect.Effect<ResultAcceptanceOutcome, OperationPersistenceError>;
}

export type WorkerRunOutcome =
  | {
      readonly state: "result_acknowledged";
      readonly resultDeliveryError?: ResultConflictError;
    }
  | { readonly state: "worker_start_failed" }
  | { readonly state: "worker_protocol_failed" };

export interface Worker {
  run(
    hooks: Readonly<WorkerRunHooks>,
  ): Effect.Effect<WorkerRunOutcome, OperationPersistenceError | ResultConflictError>;
  cancel(
    cancellationEpoch: number,
  ): Effect.Effect<WorkerCancellationEvidence | undefined>;
}

export function makeSingleRunWorker(
  implementation: Worker,
): Worker {
  let runStarted = false;
  return {
    run: (hooks) => Effect.suspend(() => {
      if (runStarted) {
        return Effect.die(new Error("Worker can only run once"));
      }
      runStarted = true;
      return implementation.run(hooks);
    }),
    cancel: (cancellationEpoch) => implementation.cancel(cancellationEpoch),
  };
}

export function acknowledgeResultAcceptance(
  acceptance: ResultAcceptanceOutcome,
  acknowledge: (
    proof: Readonly<ResultAcceptanceProof>,
  ) => Effect.Effect<void, unknown>,
): Effect.Effect<WorkerRunOutcome> {
  if (acceptance.state === "protocol_failed") {
    return Effect.succeed({ state: "worker_protocol_failed" } as const);
  }
  const outcome: WorkerRunOutcome = {
    state: "result_acknowledged",
    ...(acceptance.resultDeliveryError === undefined
      ? {}
      : { resultDeliveryError: acceptance.resultDeliveryError }),
  };
  return Effect.forEach(acceptance.proofs, acknowledge, { discard: true }).pipe(
    Effect.as(outcome),
    Effect.catchAll(() => Effect.succeed({ state: "worker_protocol_failed" } as const)),
  );
}

export interface WorkerAdapter {
  open(operation: Operation): Worker;
}

export interface RuntimeClock {
  now(): Effect.Effect<string>;
  sleep(milliseconds: number): Effect.Effect<void>;
}

export interface IdGenerator {
  nextOperationId(): Effect.Effect<string>;
}

export interface Presentation {
  preflight(): Effect.Effect<void, unknown>;
  create(operation: Operation): Effect.Effect<CreatedPresentation, unknown>;
  rollbackCreated(presentation: CreatedPresentation): Effect.Effect<void, unknown>;
  onWorkerStartFailure(operation: Operation): Effect.Effect<void, unknown>;
  project(operation: Operation): Effect.Effect<void, unknown>;
}

export interface RuntimeServices {
  readonly worker: WorkerAdapter;
  readonly clock: RuntimeClock;
  readonly ids: IdGenerator;
  readonly presentation: Presentation;
  readonly store: EventStore;
}
