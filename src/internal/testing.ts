import { createHash } from "node:crypto";

import { Effect } from "effect";

import { replayOperation } from "./reducer.js";
import type { Operation, OperationEvent, OperationState } from "./domain.js";
import {
  ValidatedEventStore,
} from "./event-store.js";
import type { StoredOperationRecord } from "./event-store.js";
import type {
  AgentBackend,
  ChildChannel,
  IdGenerator,
  Presentation,
  ResultDelivery,
  RuntimeClock,
  BackendError,
  BackendCancellationEvidence,
} from "./services.js";
import type { Result } from "../public.js";

export class FakeAgentBackend implements AgentBackend {
  startCount = 0;

  constructor(
    private readonly trace: Array<string> = [],
    private readonly failure?: BackendError,
  ) {}

  start(_operation: Operation): Effect.Effect<void, BackendError> {
    return Effect.suspend(() => {
      this.startCount += 1;
      this.trace.push("backend:start");
      return this.failure === undefined
        ? Effect.void
        : Effect.fail(this.failure);
    });
  }

  cancel(
    _operation: Operation,
    _cancellationEpoch: number,
  ): Effect.Effect<BackendCancellationEvidence, BackendError> {
    return Effect.succeed({ proof: "backend-stop" });
  }
}

interface FakeResultMessage {
  readonly body: string;
  readonly digest?: Result["digest"];
  readonly sequenceNumber?: number;
}

function digest(body: string): Result["digest"] {
  return `sha256:${createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex")}`;
}

export class FakeChildChannel implements ChildChannel {
  private readonly messages: ReadonlyArray<FakeResultMessage>;

  constructor(
    messages: FakeResultMessage | ReadonlyArray<FakeResultMessage>,
    private readonly trace: Array<string> = [],
  ) {
    this.messages = Array.isArray(messages) ? messages : [messages];
  }

  receiveResults(
    _operation: Operation,
  ): Effect.Effect<ReadonlyArray<ResultDelivery>> {
    return Effect.sync(() => {
      this.trace.push("channel:receive-result");
      return this.messages.map((message) => ({
        body: message.body,
        digest: message.digest ?? digest(message.body),
        sequenceNumber: message.sequenceNumber ?? 1,
      }));
    });
  }
}

export class FakeClock implements RuntimeClock {
  private index = 0;
  private elapsed = 0;
  private readonly sleepers: Array<{
    readonly deadline: number;
    readonly resume: (effect: Effect.Effect<void>) => void;
  }> = [];

  constructor(private readonly timestamps: ReadonlyArray<string>) {}

  now(): Effect.Effect<string> {
    return Effect.sync(() => {
      const timestamp = this.timestamps[this.index++];
      if (timestamp === undefined) throw new Error("FakeClock exhausted");
      return timestamp;
    });
  }

  sleep(milliseconds: number): Effect.Effect<void> {
    return Effect.async((resume) => {
      this.sleepers.push({ deadline: this.elapsed + milliseconds, resume });
    });
  }

  advanceBy(milliseconds: number): void {
    this.elapsed += milliseconds;
    for (const sleeper of this.sleepers.splice(0)) {
      if (sleeper.deadline <= this.elapsed) {
        sleeper.resume(Effect.void);
      } else {
        this.sleepers.push(sleeper);
      }
    }
  }
}

export class FakeIdGenerator implements IdGenerator {
  private index = 0;

  constructor(private readonly operationIds: ReadonlyArray<string>) {}

  get issuedCount(): number {
    return this.index;
  }

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
    private readonly fails = false,
  ) {}

  project(operation: Operation): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.fails) throw new Error("Presentation failed");
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

const systemClock: RuntimeClock = {
  now: () => Effect.sync(() => new Date().toISOString()),
  sleep: (milliseconds) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, milliseconds))),
};

export class InMemoryEventStore extends ValidatedEventStore {
  private readonly records = new Map<string, StoredOperationRecord>();
  private readonly resultBytes = new Map<string, Buffer>();

  constructor(
    private readonly trace: Array<string> = [],
    clock: RuntimeClock = systemClock,
  ) {
    super(clock);
  }

  protected readRecord(operationId: string): Promise<unknown | undefined> {
    return Promise.resolve(this.records.get(operationId));
  }

  protected writeRecord(operationId: string, record: StoredOperationRecord): Promise<void> {
    this.records.set(operationId, structuredClone(record));
    return Promise.resolve();
  }

  protected readResultBytes(operationId: string): Promise<Buffer | undefined> {
    const bytes = this.resultBytes.get(operationId);
    return Promise.resolve(bytes === undefined ? undefined : Buffer.from(bytes));
  }

  protected writeResultBytes(operationId: string, bytes: Buffer): Promise<void> {
    this.resultBytes.set(operationId, Buffer.from(bytes));
    return Promise.resolve();
  }

  protected override didPersistResultBytes(): void {
    this.trace.push("result:bytes-persisted");
  }

  protected override didAppend(event: OperationEvent): void {
    this.trace.push(`event:${event.type}`);
  }

  events(operationId: string): ReadonlyArray<OperationEvent> {
    return [...(this.records.get(operationId)?.events ?? [])];
  }

  result(operationId: string): Result | undefined {
    const bytes = this.resultBytes.get(operationId);
    if (bytes === undefined) return undefined;
    return {
      body: bytes.toString("utf8"),
      byteCount: bytes.byteLength,
      digest: digest(bytes.toString("utf8")),
    };
  }

  snapshot(operationId: string): Operation | undefined {
    return replayOperation(this.events(operationId));
  }

  rebuild(operationId: string): Operation | undefined {
    return replayOperation(this.events(operationId));
  }
}
