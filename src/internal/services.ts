import type { Effect } from "effect";

import type {
  CreatedPresentation,
  EventInput,
  Operation,
  PresentationOwnership,
} from "./domain.js";
import type {
  OperationFailureReason,
  Result,
  ResultConflictError,
} from "../public.js";

export interface ResultDelivery {
  readonly body: string;
  readonly digest: Result["digest"];
  readonly sequenceNumber: number;
}

export interface WorkerProcessIdentity {
  readonly processInstanceId: string;
}

export interface ChannelReception {
  readonly deliveries: ReadonlyArray<ResultDelivery>;
}

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

export interface BackendError {
  readonly _tag: "BackendError";
  readonly reason: OperationFailureReason;
  readonly message: string;
}

export interface ChannelError {
  readonly _tag: "ChannelError";
  readonly message: string;
}

export interface BackendCancellationEvidence {
  readonly proof: "acknowledgement" | "backend-stop";
}

export interface AgentBackend {
  start(operation: Operation): Effect.Effect<void, BackendError>;
  cancel(
    operation: Operation,
    cancellationEpoch: number,
  ): Effect.Effect<BackendCancellationEvidence, BackendError>;
}

export interface ChildChannel {
  receiveStarted(operation: Operation): Effect.Effect<WorkerProcessIdentity, ChannelError>;
  receiveResults(operationId: string): Effect.Effect<ChannelReception, ChannelError>;
  acknowledgeResult(
    operationId: string,
    sequenceNumber: number,
  ): Effect.Effect<void, ChannelError>;
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
  onBackendStartFailure(operation: Operation): Effect.Effect<void, unknown>;
  project(operation: Operation): Effect.Effect<void, unknown>;
}

export interface EventStore {
  append(operationId: string, event: EventInput): Effect.Effect<Operation, StoreError>;
  acceptResult(
    operationId: string,
    delivery: ResultDelivery,
  ): Effect.Effect<
    { readonly operation: Operation; readonly result: Result },
    StoreError | ResultConflictError
  >;
  get(operationId: string): Effect.Effect<Operation, StoreError>;
  readResult(operationId: string): Effect.Effect<Result, StoreError>;
}

export interface RuntimeServices {
  readonly backend: AgentBackend;
  readonly channel: ChildChannel;
  readonly clock: RuntimeClock;
  readonly ids: IdGenerator;
  readonly presentation: Presentation;
  readonly store: EventStore;
}
