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
  RetryClearanceEvidence,
  RevisionReservation,
  RevisionReservationOutcome,
  RevisionResultAdoptionOutcome,
  RevisionResultAdoptionRecord,
  RevisionSeriesSnapshot,
  StartupReceiptPolicy,
  TaskSpec,
} from "../../public.js";
import type {
  Operation,
  OperationLineage,
  RevisionMembership,
} from "./model.js";
import type { OperationIntent } from "./intent.js";

export type {
  CreatedPresentation,
  OperationIntent,
  PresentationOwnership,
  WorkerIdentity,
} from "./intent.js";
export type {
  Operation,
  OperationEvent,
  OperationLineage,
  RevisionMembership,
} from "./model.js";
export { RUNTIME_ACTOR_ID } from "./model.js";

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
  readonly revisionMembership?: Readonly<RevisionMembership>;
  readonly startAuthorization: Readonly<{
    readonly configuredPolicy: "disabled" | "optional" | "required";
    readonly policy: "disabled" | "required";
    readonly windowMs: number;
    readonly authorizedSubjectIds: ReadonlyArray<string>;
    readonly receipt?: Readonly<StartupReceiptPolicy>;
  }>;
}

export interface OperationSnapshot {
  readonly version: Readonly<{
    readonly sequenceNumber: number;
    readonly recordedAt: string;
  }>;
  readonly operation: Operation;
}

export interface RevisionReservationCommand {
  readonly seriesOriginOperationId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly kind: "revision" | "retry";
  readonly targetOperationId: string;
  readonly targetResultId?: string;
  readonly targetResultDigest?: `sha256:${string}`;
  readonly retryOfOperationId?: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly maxAttempts?: number;
  readonly artifactAcceptanceSubjectIds?: ReadonlyArray<string>;
  readonly task: Readonly<TaskSpec>;
  readonly clearance?: Readonly<RetryClearanceEvidence>;
}

export interface RevisionAdoptionCommand extends Omit<
  RevisionResultAdoptionRecord,
  "decidedAt"
> {}

export interface EventStore {
  create(
    request: OperationRequest
  ): Effect.Effect<OperationSnapshot, StoreError>;
  advance(
    operationId: string,
    intent: OperationIntent
  ): Effect.Effect<OperationSnapshot, StoreError>;
  prepareResultAcceptance(
    request: Readonly<ResultAcceptanceReservationRequest>
  ): Effect.Effect<ResultAcceptanceTransactionOutcome>;
  publishResultAcceptance(
    evidence: Readonly<ResultAcceptancePreparationEvidence>
  ): Effect.Effect<ResultAcceptanceTransactionOutcome>;
  reserveRevision(
    command: Readonly<RevisionReservationCommand>
  ): Effect.Effect<RevisionReservationOutcome, StoreError>;
  adoptRevisionResult(
    command: Readonly<RevisionAdoptionCommand>
  ): Effect.Effect<RevisionResultAdoptionOutcome, StoreError>;
  readRevisionSeries(
    seriesOriginOperationId: string
  ): Effect.Effect<RevisionSeriesSnapshot, StoreError>;
  read(operationId: string): Effect.Effect<OperationSnapshot, StoreError>;
  listWaitingStartAuthorizations(): Effect.Effect<
    ReadonlyArray<OperationSnapshot>,
    StoreError
  >;
  listRecoverableOperations(): Effect.Effect<
    ReadonlyArray<OperationSnapshot>,
    StoreError
  >;
  listPendingPresentationCleanups(): Effect.Effect<
    ReadonlyArray<OperationSnapshot>,
    StoreError
  >;
  listPendingRevisionReservations(): Effect.Effect<
    ReadonlyArray<Readonly<RevisionReservation>>,
    StoreError
  >;
}

export type { OperationState };

export {
  operationDirectoryKey,
  PrivateFileEventStore,
} from "./file-storage.js";
