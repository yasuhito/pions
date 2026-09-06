import type { Effect } from "effect";

import type {
  Result,
  ResultConflictError,
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
  ResultDelivery,
  WorkerIdentity,
} from "./intent.js";
export type {
  Operation,
  OperationLineage,
  OperationState,
  ResultConflictEvidence,
  ResultReference,
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
  readonly lineage: Readonly<OperationLineage>;
}

export interface OperationSnapshot {
  readonly operation: Operation;
  readonly result?: Result;
}

export interface EventStore {
  create(request: OperationRequest): Effect.Effect<OperationSnapshot, StoreError>;
  advance(
    operationId: string,
    intent: OperationIntent,
  ): Effect.Effect<OperationSnapshot, StoreError | ResultConflictError>;
  read(operationId: string): Effect.Effect<OperationSnapshot, StoreError>;
}

export {
  operationDirectoryKey,
  PrivateFileEventStore,
} from "./file-storage.js";
