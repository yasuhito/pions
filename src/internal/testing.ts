import { Effect } from "effect";

import type {
  CreatedPresentation,
  Operation,
  OperationState,
} from "./event-store/index.js";
import type {
  ResultAcceptanceProof,
  ResultDelivery,
} from "./worker-protocol.js";
export { InMemoryEventStore } from "./event-store/memory-storage.js";
import type {
  AgentBackend,
  ChildChannel,
  ChannelError,
  ChannelReception,
  IdGenerator,
  Presentation,
  RuntimeClock,
  BackendError,
  BackendCancellationEvidence,
} from "./services.js";
import type { Result } from "../public.js";
import { resultDigest } from "./result-digest.js";

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

export class FakeChildChannel implements ChildChannel {
  private readonly messages: ReadonlyArray<FakeResultMessage>;

  constructor(
    messages: FakeResultMessage | ReadonlyArray<FakeResultMessage>,
    private readonly trace: Array<string> = [],
  ) {
    this.messages = Array.isArray(messages) ? messages : [messages];
  }

  receiveStarted(_operation: Operation) {
    return Effect.succeed({ processInstanceId: "fake-process-instance" });
  }

  receiveResults(
    _operationId: string,
  ): Effect.Effect<ChannelReception, ChannelError> {
    return Effect.sync(() => {
      this.trace.push("channel:receive-result");
      return {
        deliveries: this.messages.map((message) => ({
          body: message.body,
          digest: message.digest ?? resultDigest(Buffer.from(message.body, "utf8")),
          sequenceNumber: message.sequenceNumber ?? 1,
        })),
      };
    });
  }

  acknowledgeResult(
    acceptance: Readonly<ResultAcceptanceProof>,
  ): Effect.Effect<void, ChannelError> {
    return Effect.sync(() => {
      this.trace.push(`channel:ack:${acceptance.sequenceNumber}`);
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
  readonly rolledBackPaneIds: Array<string> = [];
  stateChangeSucceeded = false;

  constructor(
    private readonly trace: Array<string> = [],
    private readonly attemptedState?: OperationState,
    private readonly fails = false,
  ) {}

  preflight(): Effect.Effect<void> {
    return Effect.void;
  }

  create(operation: Operation): Effect.Effect<CreatedPresentation> {
    return Effect.succeed({
      kind: "herdr_pane",
      paneId: `fake-pane:${operation.operationId}`,
    });
  }

  rollbackCreated(presentation: CreatedPresentation): Effect.Effect<void> {
    return Effect.sync(() => {
      this.rolledBackPaneIds.push(presentation.paneId);
    });
  }

  onBackendStartFailure(_operation: Operation): Effect.Effect<void> {
    return Effect.void;
  }

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
