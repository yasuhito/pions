import type { Effect } from "effect";

import type { Operation, OperationEvent } from "./domain.js";
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

export interface StoreError {
  readonly _tag: "StoreError";
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
  receiveResults(
    operation: Operation,
  ): Effect.Effect<ReadonlyArray<ResultDelivery>, ChannelError>;
}

export interface RuntimeClock {
  now(): Effect.Effect<string>;
  sleep(milliseconds: number): Effect.Effect<void>;
}

export interface IdGenerator {
  nextOperationId(): Effect.Effect<string>;
}

export interface Presentation {
  project(operation: Operation): Effect.Effect<void, unknown>;
}

export interface EventStore {
  append(event: OperationEvent): Effect.Effect<Operation, StoreError>;
  acceptResult(
    operationId: string,
    delivery: ResultDelivery,
    metadata: Omit<OperationEvent, "type" | "result">,
  ): Effect.Effect<
    { readonly operation: Operation; readonly result: Result },
    StoreError | ResultConflictError
  >;
  get(operationId: string): Effect.Effect<Operation, StoreError>;
}

export interface RuntimeServices {
  readonly backend: AgentBackend;
  readonly channel: ChildChannel;
  readonly clock: RuntimeClock;
  readonly ids: IdGenerator;
  readonly presentation: Presentation;
  readonly store: EventStore;
}
