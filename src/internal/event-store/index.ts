import type { Effect } from "effect";

import type {
  EffectiveWorkerConfig,
  OperationState,
  RequestedWorkerConfig,
  ResolvedWorkProductRequirements,
  ResultAcceptancePreparationEvidence,
  ResultAcceptanceReservationRequest,
  ResultAcceptanceRetentionPolicyEvidence,
  ResultAcceptanceTransactionOutcome,
  StartupReceiptPolicy,
  TaskSpec,
} from "../../public.js";
import type {
  Operation,
  OperationLineage,
} from "./model.js";
import type {
  OperationIntent,
} from "./intent.js";

export type {
  CreatedPresentation,
  OperationIntent,
  PresentationOwnership,
  WorkerIdentity,
} from "./intent.js";
export type {
  Operation,
  OperationLineage,
} from "./model.js";

export type StoreErrorCode =
  | "not_found"
  | "write_failed"
  | "incomplete_record"
  | "corrupt_record"
  | "unsupported_schema";

export interface StoreError {
  readonly _tag: "StoreError";
  readonly code: StoreErrorCode;
  readonly message: string;
}

export interface OperationRequest {
  readonly operationId: string;
  readonly task: Readonly<TaskSpec>;
  readonly requestedConfig: Readonly<RequestedWorkerConfig>;
  readonly effectiveConfig: Readonly<EffectiveWorkerConfig>;
  readonly workProductRequirements: Readonly<ResolvedWorkProductRequirements>;
  readonly resultRetentionPolicy: Readonly<ResultAcceptanceRetentionPolicyEvidence>;
  readonly lineage: Readonly<OperationLineage>;
  readonly startAuthorization: Readonly<{
    readonly configuredPolicy: "disabled" | "optional" | "required";
    readonly policy: "disabled" | "required";
    readonly windowMs: number;
    readonly authorizedSubjectIds: ReadonlyArray<string>;
    readonly receipt?: Readonly<StartupReceiptPolicy>;
  }>;
}

export interface OperationSnapshot {
  readonly version: Readonly<{ readonly sequenceNumber: number; readonly recordedAt: string }>;
  readonly operation: Operation;
}

export interface EventStore {
  create(request: OperationRequest): Effect.Effect<OperationSnapshot, StoreError>;
  advance(
    operationId: string,
    intent: OperationIntent,
  ): Effect.Effect<OperationSnapshot, StoreError>;
  prepareResultAcceptance(
    request: Readonly<ResultAcceptanceReservationRequest>,
  ): Effect.Effect<ResultAcceptanceTransactionOutcome>;
  publishResultAcceptance(
    evidence: Readonly<ResultAcceptancePreparationEvidence>,
  ): Effect.Effect<ResultAcceptanceTransactionOutcome>;
  read(operationId: string): Effect.Effect<OperationSnapshot, StoreError>;
  listWaitingStartAuthorizations(): Effect.Effect<ReadonlyArray<OperationSnapshot>, StoreError>;
}

export type { OperationState };

export {
  operationDirectoryKey,
  PrivateFileEventStore,
} from "./file-storage.js";
