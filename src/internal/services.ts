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
  ObservedWorkerConfig,
  OperationPersistenceError,
  ResultConflictError,
  WorkerProfilePolicy,
} from "../public.js";

export interface WorkerProcessIdentity {
  readonly processId: number;
  readonly processInstanceId: string;
  readonly processStartToken: string;
  readonly piSessionId: string;
  readonly observedConfig: Readonly<ObservedWorkerConfig>;
}

export interface PiUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface PiToolUse {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
}

export interface AgentRunEvidence {
  readonly usage: Readonly<PiUsage>;
  readonly toolUses: ReadonlyArray<Readonly<PiToolUse>>;
}

export interface WorkerCancellationEvidence {
  readonly proof: "worker-stop";
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
      readonly evidence: Readonly<AgentRunEvidence>;
      readonly resultDeliveryError?: ResultConflictError;
      readonly successfulExitConfirmed?: true;
    }
  | { readonly state: "worker_start_failed" }
  | { readonly state: "worker_protocol_failed" }
  | { readonly state: "process-exited-without-result" }
  | { readonly state: "liveness-unproven" }
  | { readonly state: "model_mismatch" }
  | { readonly state: "model_not_found" }
  | { readonly state: "model_auth_unavailable" }
  | { readonly state: "unsupported_capability" }
  | { readonly state: "tool_policy_violation" }
  | {
      readonly state: "agent_failed";
      readonly evidence: Readonly<AgentRunEvidence>;
    };

export interface Worker {
  run(
    hooks: Readonly<WorkerRunHooks>,
  ): Effect.Effect<WorkerRunOutcome, OperationPersistenceError | ResultConflictError>;
  cancel(
    cancellationEpoch: number,
    timeoutMs: number,
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
    cancel: (cancellationEpoch, timeoutMs) => implementation.cancel(cancellationEpoch, timeoutMs),
  };
}

export function acknowledgeResultAcceptance(
  acceptance: ResultAcceptanceOutcome,
  evidence: Readonly<AgentRunEvidence>,
  acknowledge: (
    proof: Readonly<ResultAcceptanceProof>,
  ) => Effect.Effect<void, unknown>,
): Effect.Effect<WorkerRunOutcome> {
  if (acceptance.state === "protocol_failed") {
    return Effect.succeed({ state: "worker_protocol_failed" } as const);
  }
  const outcome: WorkerRunOutcome = {
    state: "result_acknowledged",
    evidence,
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
  closeOwnedPane(operation: Operation): Effect.Effect<void, unknown>;
  project(operation: Operation): Effect.Effect<void, unknown>;
}

export interface RuntimeServices {
  readonly worker: WorkerAdapter;
  readonly clock: RuntimeClock;
  readonly ids: IdGenerator;
  readonly presentation: Presentation;
  readonly store: EventStore;
  readonly configuration?: Readonly<{
    readonly cwd: string;
    readonly profiles: Readonly<Record<string, Readonly<WorkerProfilePolicy>>>;
  }>;
}
