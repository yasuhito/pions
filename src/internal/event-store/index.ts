import type { Effect } from "effect";

import type {
  EffectiveWorkerConfig,
  OperationState,
  RequestedWorkerConfig,
  ResultAcceptanceTransactionOutcome,
  TaskSpec,
} from "../types.js";
import type { Operation } from "./model.js";
import type { OperationIntent } from "./intent.js";

export type {
  CreatedPresentation,
  OperationIntent,
  PresentationOwnership,
} from "./intent.js";
export type { WorkerIdentity } from "../types.js";
export type { Operation, OperationEvent } from "./model.js";
export { RUNTIME_ACTOR_ID } from "./model.js";
export { presentationCleanupEligible } from "./reducer.js";

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
  readonly maxResultByteCount: number;
}

export interface OperationSnapshot {
  readonly version: Readonly<{
    readonly sequenceNumber: number;
    readonly recordedAt: string;
  }>;
  readonly operation: Operation;
}

export interface ResultAcceptanceRequest {
  readonly operationId: string;
  readonly acceptanceRequestId: string;
  readonly bytes: Uint8Array;
}

export interface EventStore {
  create(
    request: OperationRequest
  ): Effect.Effect<OperationSnapshot, StoreError>;
  advance(
    operationId: string,
    intent: OperationIntent
  ): Effect.Effect<OperationSnapshot, StoreError>;
  acceptResult(
    request: Readonly<ResultAcceptanceRequest>
  ): Effect.Effect<ResultAcceptanceTransactionOutcome>;
  readResultBody(
    operationId: string
  ): Effect.Effect<Uint8Array | undefined, StoreError>;
  read(operationId: string): Effect.Effect<OperationSnapshot, StoreError>;
  listRecoverableOperations(): Effect.Effect<
    ReadonlyArray<OperationSnapshot>,
    StoreError
  >;
  listPendingPresentationCleanups(): Effect.Effect<
    ReadonlyArray<OperationSnapshot>,
    StoreError
  >;
}

export type { OperationState };

export {
  operationDirectoryKey,
  PrivateFileEventStore,
} from "./file-storage.js";
