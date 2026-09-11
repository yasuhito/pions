import { Effect } from "effect";

import type {
  CreatedPresentation,
  EventStore,
  Operation,
} from "./event-store/index.js";
import type { ResultAcceptanceOutcome } from "./result-acceptance.js";
import type { InternalResourceProofController } from "./resource-controller.js";
import type {
  ResultAcceptanceProof,
  StartInstruction,
} from "./worker-protocol.js";
import type {
  ArtifactStore,
  ObservedWorkerConfig,
  OperationPersistenceError,
  StartAuthorizationAuthenticator,
  StartAuthorizationAuthority,
  ResourceProofRejectedError,
  RevisionAuthenticator,
  RetryClearanceVerifier,
  WorkerProducedResult,
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

export class StartDeliveryAbortedError extends Error {
  override readonly name = "StartDeliveryAbortedError";
}

export interface DeliveryGenerationConfirmation {
  readonly dispatcherId: string;
  readonly deliveryGeneration: number;
  readonly acceptanceState: "not_accepted" | "accepted" | "unknown";
  readonly acceptedInstruction?: Readonly<StartInstruction>;
}

export interface WorkerRunHooks {
  workerLaunched(): Effect.Effect<void, OperationPersistenceError>;
  workerIdentified(
    identity: Readonly<WorkerProcessIdentity>
  ): Effect.Effect<
    Readonly<StartInstruction>,
    OperationPersistenceError | ResourceProofRejectedError
  >;
  startDeliveryAuthorityRevoked(
    successorDispatcherId: string,
    deliveryGeneration: number
  ): Effect.Effect<void, OperationPersistenceError>;
  deliveryGenerationConfirmed(
    confirmation: Readonly<DeliveryGenerationConfirmation>
  ): Effect.Effect<
    void,
    | OperationPersistenceError
    | ResourceProofRejectedError
    | StartDeliveryAbortedError
  >;
  startDeliveryEntered(
    instruction: Readonly<StartInstruction>
  ): Effect.Effect<void, OperationPersistenceError>;
  startInstructionDispatched(
    instruction: Readonly<StartInstruction>
  ): Effect.Effect<void, OperationPersistenceError>;
  startInstructionAccepted(
    instruction: Readonly<StartInstruction>
  ): Effect.Effect<void, OperationPersistenceError>;
  startInstructionAcknowledged(
    instruction: Readonly<StartInstruction>
  ): Effect.Effect<void, OperationPersistenceError>;
  acceptResult(
    result: Readonly<WorkerProducedResult>
  ): Effect.Effect<ResultAcceptanceOutcome>;
}

export type WorkerRunOutcome = (
  | {
      readonly state: "result_acknowledged";
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | { readonly state: "worker_start_failed" }
  | { readonly state: "worker_protocol_failed" }
  | { readonly state: "process-exited-without-result" }
  | { readonly state: "liveness-unproven" }
  | { readonly state: "model_mismatch" }
  | { readonly state: "thinking_level_mismatch" }
  | { readonly state: "model_not_found" }
  | { readonly state: "model_auth_unavailable" }
  | { readonly state: "unsupported_capability" }
  | { readonly state: "tool_policy_violation" }
  | {
      readonly state: "agent_failed";
      readonly evidence: Readonly<AgentRunEvidence>;
    }
) & { readonly successfulExitConfirmed?: true };

export interface Worker {
  run(
    hooks: Readonly<WorkerRunHooks>
  ): Effect.Effect<
    WorkerRunOutcome,
    | OperationPersistenceError
    | ResourceProofRejectedError
    | StartDeliveryAbortedError
  >;
  cancel(
    cancellationEpoch: number,
    timeoutMs: number
  ): Effect.Effect<WorkerCancellationEvidence | undefined>;
}

export function makeSingleRunWorker(implementation: Worker): Worker {
  let runStarted = false;
  return {
    run: (hooks) =>
      Effect.suspend(() => {
        if (runStarted) {
          return Effect.die(new Error("Worker can only run once"));
        }
        runStarted = true;
        return implementation.run(hooks);
      }),
    cancel: (cancellationEpoch, timeoutMs) =>
      implementation.cancel(cancellationEpoch, timeoutMs),
  };
}

export function acknowledgeResultAcceptance(
  acceptance: ResultAcceptanceOutcome,
  evidence: Readonly<AgentRunEvidence>,
  acknowledge: (
    proof: Readonly<ResultAcceptanceProof>
  ) => Effect.Effect<void, unknown>
): Effect.Effect<WorkerRunOutcome> {
  if (acceptance.state !== "accepted") {
    return Effect.succeed({ state: "worker_protocol_failed" } as const);
  }
  const outcome: WorkerRunOutcome = {
    state: "result_acknowledged",
    evidence,
  };
  return acknowledge(acceptance.proof).pipe(
    Effect.as(outcome),
    Effect.catchAll(() =>
      Effect.succeed({ state: "liveness-unproven" } as const)
    )
  );
}

export interface WorkerAdapter {
  readonly producesWorkProducts?: boolean;
  open(operation: Operation): Worker;
  recover(operation: Operation): Worker;
}

export interface RuntimeClock {
  now(): Effect.Effect<string>;
  sleep(milliseconds: number): Effect.Effect<void>;
  monotonicMilliseconds(): number;
  /** 復旧をまたぐ経過時間を、保存済み壁時計とは独立して制限できるかを返す。 */
  recoveredElapsedTimeIsReliable(): boolean;
}

export interface IdGenerator {
  nextOperationId(): Effect.Effect<string>;
}

export interface Presentation {
  preflight(): Effect.Effect<void, unknown>;
  create(operation: Operation): Effect.Effect<CreatedPresentation, unknown>;
  rollbackCreated(
    presentation: CreatedPresentation
  ): Effect.Effect<void, unknown>;
  onWorkerStartFailure(operation: Operation): Effect.Effect<void, unknown>;
  inspectOwnedPane(
    operation: Operation
  ): Effect.Effect<"matching" | "missing", unknown>;
  closeOwnedPane(operation: Operation): Effect.Effect<void, unknown>;
  project(operation: Operation): Effect.Effect<void, unknown>;
}

export interface RuntimeServices {
  readonly worker: WorkerAdapter;
  readonly clock: RuntimeClock;
  readonly ids: IdGenerator;
  readonly presentation: Presentation;
  readonly store: EventStore;
  readonly artifacts: ArtifactStore;
  readonly artifactCredential: string;
  readonly synchronizeArtifactClock?: (timestamp: string) => void;
  readonly startAuthorizationAuthenticator?: StartAuthorizationAuthenticator;
  readonly startAuthorizationAuthority?: StartAuthorizationAuthority;
  readonly revisionAuthenticator?: RevisionAuthenticator;
  readonly retryClearanceVerifier?: RetryClearanceVerifier;
  readonly resourceProofController?: InternalResourceProofController;
  readonly configuration?: Readonly<{
    readonly cwd: string;
    readonly profiles: Readonly<Record<string, Readonly<WorkerProfilePolicy>>>;
  }>;
}
