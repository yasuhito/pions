import type { Effect } from "effect";

import type { Operation, OperationEvent } from "./domain.js";
import type { Result } from "../public.js";

export interface StoreError {
  readonly _tag: "StoreError";
  readonly message: string;
}

export interface BackendError {
  readonly _tag: "BackendError";
  readonly message: string;
}

export interface ChannelError {
  readonly _tag: "ChannelError";
  readonly message: string;
}

export interface AgentBackend {
  start(operation: Operation): Effect.Effect<void, BackendError>;
}

export interface ChildChannel {
  receiveResult(operation: Operation): Effect.Effect<{ readonly body: string }, ChannelError>;
}

export interface RuntimeClock {
  now(): Effect.Effect<string>;
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
    body: string,
    metadata: Omit<OperationEvent, "type" | "result">,
  ): Effect.Effect<{ readonly operation: Operation; readonly result: Result }, StoreError>;
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
