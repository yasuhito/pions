import { createHash } from "node:crypto";

import { Effect } from "effect";

import { reduceOperation } from "./reducer.js";
import type { Operation, OperationEvent, OperationState } from "./domain.js";
import type {
  AgentBackend,
  ChildChannel,
  EventStore,
  IdGenerator,
  Presentation,
  RuntimeClock,
  StoreError,
} from "./services.js";
import type { Result } from "../public.js";

function storeError(error: unknown): StoreError {
  return {
    _tag: "StoreError",
    message: error instanceof Error ? error.message : String(error),
  };
}

export class FakeAgentBackend implements AgentBackend {
  startCount = 0;

  constructor(private readonly trace: Array<string> = []) {}

  start(_operation: Operation): Effect.Effect<void> {
    return Effect.sync(() => {
      this.startCount += 1;
      this.trace.push("backend:start");
    });
  }
}

export class FakeChildChannel implements ChildChannel {
  constructor(
    private readonly message: { readonly body: string },
    private readonly trace: Array<string> = [],
  ) {}

  receiveResult(_operation: Operation): Effect.Effect<{ readonly body: string }> {
    return Effect.sync(() => {
      this.trace.push("channel:receive-result");
      return this.message;
    });
  }
}

export class FakeClock implements RuntimeClock {
  private index = 0;

  constructor(private readonly timestamps: ReadonlyArray<string>) {}

  now(): Effect.Effect<string> {
    return Effect.sync(() => {
      const timestamp = this.timestamps[this.index++];
      if (timestamp === undefined) throw new Error("FakeClock exhausted");
      return timestamp;
    });
  }
}

export class FakeIdGenerator implements IdGenerator {
  private index = 0;

  constructor(private readonly operationIds: ReadonlyArray<string>) {}

  nextOperationId(): Effect.Effect<string> {
    return Effect.sync(() => {
      const operationId = this.operationIds[this.index++];
      if (operationId === undefined) throw new Error("FakeIdGenerator exhausted");
      return operationId;
    });
  }
}

export class FakePresentation implements Presentation {
  readonly projections: Array<Operation> = [];
  stateChangeSucceeded = false;

  constructor(
    private readonly trace: Array<string> = [],
    private readonly attemptedState?: OperationState,
  ) {}

  project(operation: Operation): Effect.Effect<void> {
    return Effect.sync(() => {
      this.projections.push(operation);
      this.trace.push(`presentation:${operation.state}`);
      if (this.attemptedState !== undefined) {
        this.stateChangeSucceeded =
          Reflect.set(operation, "state", this.attemptedState) ||
          this.stateChangeSucceeded;
      }
    });
  }
}

export class InMemoryEventStore implements EventStore {
  private readonly eventLog = new Map<string, Array<OperationEvent>>();
  private readonly operations = new Map<string, Operation>();
  private readonly results = new Map<string, Result>();

  constructor(private readonly trace: Array<string> = []) {}

  append(event: OperationEvent): Effect.Effect<Operation, StoreError> {
    return Effect.try({
      try: () => {
        const current = this.operations.get(event.operationId);
        const next = reduceOperation(current, event);
        this.operations.set(event.operationId, next);
        const events = this.eventLog.get(event.operationId) ?? [];
        events.push(event);
        this.eventLog.set(event.operationId, events);
        this.trace.push(`event:${event.type}`);
        return next;
      },
      catch: storeError,
    });
  }

  acceptResult(
    operationId: string,
    body: string,
    metadata: Omit<OperationEvent, "type" | "result">,
  ): Effect.Effect<{ readonly operation: Operation; readonly result: Result }, StoreError> {
    return Effect.try({
      try: () => {
        const bytes = Buffer.from(body, "utf8");
        const result: Result = Object.freeze({
          body,
          byteCount: bytes.byteLength,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        });
        const event = {
          ...metadata,
          operationId,
          type: "result_persisted",
          result,
        } as OperationEvent;
        const next = reduceOperation(this.operations.get(operationId), event);

        this.trace.push("result:bytes-persisted");
        this.results.set(operationId, result);
        this.operations.set(operationId, next);
        const events = this.eventLog.get(operationId) ?? [];
        events.push(event);
        this.eventLog.set(operationId, events);
        this.trace.push("event:result_persisted");
        return { operation: next, result };
      },
      catch: storeError,
    });
  }

  get(operationId: string): Effect.Effect<Operation, StoreError> {
    return Effect.fromNullable(this.operations.get(operationId)).pipe(
      Effect.mapError(() => storeError(`Operation not found: ${operationId}`)),
    );
  }

  events(operationId: string): ReadonlyArray<OperationEvent> {
    return [...(this.eventLog.get(operationId) ?? [])];
  }

  result(operationId: string): Result | undefined {
    return this.results.get(operationId);
  }
}
