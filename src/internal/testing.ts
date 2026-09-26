import { Effect } from "effect";

import type {
  CreatedPresentation,
  EventStore,
  Operation,
  OperationState,
} from "./event-store/index.js";
import type { ResultAcceptanceProof } from "./worker-protocol.js";
import { makeRuntime } from "./runtime.js";
import { InMemoryEventStore } from "./event-store/memory-storage.js";
export { InMemoryEventStore };
import {
  acknowledgeResultAcceptance,
  makeSingleRunWorker,
} from "./services.js";
import type {
  WorkerCancellationEvidence,
  IdGenerator,
  Presentation,
  RuntimeClock,
  RuntimeServices,
  Worker,
  WorkerRunHooks,
  WorkerRunOutcome,
  WorkerAdapter,
} from "./services.js";
import type {
  OperationPersistenceError,
  Result,
  OperationRuntime,
} from "./types.js";
import { sha256Digest } from "./result-digest.js";
import {
  automaticStartScopeDigest,
  startInstructionReference,
} from "./start-instruction.js";

type TestRuntimeServices = RuntimeServices;

export async function advanceTestOperationToStartDeliveryAuthority(
  store: EventStore,
  operationId: string
): Promise<void> {
  const operation = (await Effect.runPromise(store.read(operationId)))
    .operation;
  const processInstanceId = "test-worker-instance";
  const instruction = {
    dispatcherId: "pions-runtime",
    workerProcessInstanceId: processInstanceId,
    receiptDigest: automaticStartScopeDigest(operation),
    deliveryGeneration: 1,
  };
  await Effect.runPromise(
    store.advance(operationId, {
      type: "presentation_owned",
      presentation: {
        kind: "herdr_workspace",
        workspaceId: "test-workspace",
        paneId: "test-pane",
        ownedByPions: true,
      },
    })
  );
  await Effect.runPromise(
    store.advance(operationId, { type: "operation_starting" })
  );
  await Effect.runPromise(
    store.advance(operationId, { type: "worker_launched" })
  );
  await Effect.runPromise(
    store.advance(operationId, {
      type: "worker_identified",
      workerIdentity: {
        processId: 1,
        processInstanceId,
        processStartToken: "test-worker-start",
        piSessionId: "test-pi-session",
        paneId: "test-pane",
      },
      observedConfig: {
        model: { state: "observed", value: operation.effectiveConfig.model },
        thinkingLevel: {
          state: "observed",
          value: operation.effectiveConfig.thinkingLevel,
        },
        tools: { state: "observed", value: operation.effectiveConfig.tools },
        cwd: { state: "observed", value: operation.effectiveConfig.cwd },
      },
    })
  );
  await Effect.runPromise(
    store.advance(operationId, {
      type: "start_delivery_authority_acquired",
      instruction,
    })
  );
}

export async function advanceTestOperationToRunning(
  store: EventStore,
  operationId: string
): Promise<void> {
  await advanceTestOperationToStartDeliveryAuthority(store, operationId);
  const instruction = startInstructionReference(
    (await Effect.runPromise(store.read(operationId))).operation
      .startDeliveryAuthority!
  );
  await Effect.runPromise(
    store.advance(operationId, { type: "start_delivery_entered", instruction })
  );
  await Effect.runPromise(
    store.advance(operationId, {
      type: "start_instruction_dispatched",
      instruction,
    })
  );
  await Effect.runPromise(
    store.advance(operationId, {
      type: "start_instruction_accepted",
      instruction,
      proof: "worker-durable-acceptance",
    })
  );
  await Effect.runPromise(
    store.advance(operationId, {
      type: "start_instruction_acknowledged",
      instruction,
      proof: "authenticated-worker-acknowledgement",
    })
  );
}

export function makeTestRuntime(
  services: TestRuntimeServices
): OperationRuntime {
  return makeRuntime(services);
}

export interface FakeResultMessage {
  readonly body: string;
  readonly digest?: Result["digest"];
  readonly sequenceNumber?: number;
}

export interface FakeWorkerAdapterOptions {
  readonly messages?: FakeResultMessage | ReadonlyArray<FakeResultMessage>;
  readonly trace?: Array<string>;
  readonly failure?:
    | "worker_start_failed"
    | "worker_protocol_failed"
    | "process-exited-without-result"
    | "liveness-unproven"
    | "agent_failed"
    | "model_mismatch"
    | "thinking_level_mismatch"
    | "tool_policy_violation";
  readonly acknowledgementFails?: boolean;
  readonly successfulExitConfirmed?: boolean;
}

export class FakeWorkerAdapter implements WorkerAdapter {
  startCount = 0;
  private readonly acknowledgementFails: boolean;
  private readonly failure: FakeWorkerAdapterOptions["failure"];
  private readonly messages: ReadonlyArray<FakeResultMessage>;
  private readonly trace: Array<string>;
  private readonly successfulExitConfirmed: boolean;

  constructor(options: FakeWorkerAdapterOptions = {}) {
    const messages = options.messages ?? { body: "finished" };
    this.messages = Array.isArray(messages) ? messages : [messages];
    this.trace = options.trace ?? [];
    this.failure = options.failure;
    this.acknowledgementFails = options.acknowledgementFails ?? false;
    this.successfulExitConfirmed = options.successfulExitConfirmed ?? false;
  }

  open(operation: Operation): Worker {
    return makeSingleRunWorker({
      run: (hooks) => this.run(operation, hooks),
      cancel: (epoch) => this.cancel(operation, epoch),
    });
  }

  recover(operation: Operation): Worker {
    return this.open(operation);
  }

  protected run(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>
  ): Effect.Effect<WorkerRunOutcome, OperationPersistenceError> {
    return Effect.gen(this, function* () {
      this.startCount += 1;
      this.trace.push("worker:start");
      if (this.failure === "worker_start_failed") {
        return { state: "worker_start_failed" } as const;
      }
      yield* hooks.workerLaunched();
      if (this.failure === "worker_protocol_failed") {
        return { state: "worker_protocol_failed" } as const;
      }
      if (
        this.failure === "model_mismatch" ||
        this.failure === "thinking_level_mismatch" ||
        this.failure === "tool_policy_violation"
      ) {
        return { state: this.failure } as const;
      }
      const startInstruction = yield* hooks.workerIdentified({
        processId: 1234,
        processInstanceId: "fake-process-instance",
        processStartToken: "fake-process-start",
        piSessionId: "fake-pi-session",
        observedConfig: {
          model: {
            state: "observed",
            value: { ...operation.effectiveConfig.model },
          },
          thinkingLevel: { state: "unavailable" },
          tools: {
            state: "observed",
            value: [...operation.effectiveConfig.tools],
          },
          cwd: { state: "observed", value: operation.effectiveConfig.cwd },
        },
      });
      yield* hooks.startDeliveryEntered(startInstruction);
      yield* hooks.startInstructionDispatched(startInstruction);
      yield* hooks.startInstructionAccepted(startInstruction);
      yield* hooks.startInstructionAcknowledged(startInstruction);
      if (
        this.failure === "process-exited-without-result" ||
        this.failure === "liveness-unproven"
      ) {
        return { state: this.failure } as const;
      }
      if (this.failure === "agent_failed") {
        return {
          state: "agent_failed",
          evidence: {
            usage: {
              input: 10,
              output: 4,
              cacheRead: 2,
              cacheWrite: 1,
              totalTokens: 17,
              cost: 0.33,
            },
            toolUses: [
              { toolCallId: "fake-call", toolName: "read", isError: true },
            ],
            errorMessage: "fake provider rejected the request",
          },
        } as const;
      }
      this.trace.push("worker-protocol:receive-result");
      const message = this.messages[0];
      if (message === undefined)
        return { state: "worker_protocol_failed" } as const;
      const bytes = Buffer.from(message.body, "utf8");
      const acceptance = yield* hooks.acceptResult({
        acceptanceRequestId: `request-${message.sequenceNumber ?? 1}`,
        body: message.body,
        expectedByteCount: bytes.byteLength,
        expectedDigest: message.digest ?? sha256Digest(bytes),
      });
      const acknowledged = yield* acknowledgeResultAcceptance(
        acceptance,
        {
          usage: {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 17,
            cost: 0.33,
          },
          toolUses: [
            { toolCallId: "fake-call", toolName: "read", isError: false },
          ],
        },
        (proof) =>
          this.acknowledgementFails
            ? Effect.fail(new Error("Fake Worker acknowledgement failed"))
            : Effect.sync(() => this.acknowledge(proof))
      );
      return acknowledged.state === "result_acknowledged" &&
        this.successfulExitConfirmed
        ? { ...acknowledged, successfulExitConfirmed: true }
        : acknowledged;
    });
  }

  protected acknowledge(acceptance: Readonly<ResultAcceptanceProof>): void {
    this.trace.push(`worker-protocol:ack:${acceptance.eventSequenceNumber}`);
  }

  protected cancel(
    _operation: Operation,
    _cancellationEpoch: number
  ): Effect.Effect<WorkerCancellationEvidence | undefined> {
    return Effect.succeed({ proof: "worker-stop" });
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

  monotonicMilliseconds(): number {
    return this.elapsed;
  }

  recoveredElapsedTimeIsReliable(): boolean {
    return true;
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
      if (operationId === undefined)
        throw new Error("FakeIdGenerator exhausted");
      return operationId;
    });
  }
}

export interface FakePresentationOptions {
  readonly trace?: Array<string>;
  readonly attemptedState?: OperationState;
  readonly projectionFails?: boolean;
  readonly workspaceInspection?: "matching" | "missing" | "unavailable";
  readonly workspaceClosureFails?: boolean;
}

export class FakePresentation implements Presentation {
  readonly projections: Array<Operation> = [];
  readonly createdWorkspaceIds: Array<string> = [];
  readonly rolledBackWorkspaceIds: Array<string> = [];
  readonly closedWorkspaceIds: Array<string> = [];
  stateChangeSucceeded = false;
  private readonly trace: Array<string>;
  private readonly attemptedState: OperationState | undefined;
  private readonly projectionFails: boolean;
  private readonly workspaceInspection: "matching" | "missing" | "unavailable";
  private readonly workspaceClosureFails: boolean;

  constructor(options: FakePresentationOptions = {}) {
    this.trace = options.trace ?? [];
    this.attemptedState = options.attemptedState;
    this.projectionFails = options.projectionFails ?? false;
    this.workspaceInspection = options.workspaceInspection ?? "matching";
    this.workspaceClosureFails = options.workspaceClosureFails ?? false;
  }

  preflight(): Effect.Effect<void> {
    return Effect.void;
  }

  create(operation: Operation): Effect.Effect<CreatedPresentation> {
    return Effect.sync(() => {
      const workspaceId = `fake-workspace:${operation.operationId}`;
      this.createdWorkspaceIds.push(workspaceId);
      return {
        kind: "herdr_workspace",
        workspaceId,
        paneId: `fake-pane:${operation.operationId}`,
      };
    });
  }

  rollbackCreated(presentation: CreatedPresentation): Effect.Effect<void> {
    return Effect.sync(() => {
      this.rolledBackWorkspaceIds.push(presentation.workspaceId);
    });
  }

  inspectOwnedWorkspace(
    _operation: Operation
  ): Effect.Effect<"matching" | "missing", Error> {
    return Effect.sync(() => {
      this.trace.push("presentation:inspect-owned-workspace");
      if (this.workspaceInspection === "unavailable")
        throw new Error("Workspace inspection unavailable");
      return this.workspaceInspection;
    });
  }

  closeOwnedWorkspace(operation: Operation): Effect.Effect<void> {
    return Effect.sync(() => {
      this.trace.push("presentation:close-owned-workspace");
      if (operation.presentation === undefined) return;
      this.closedWorkspaceIds.push(operation.presentation.workspaceId);
      if (this.workspaceClosureFails)
        throw new Error("Workspace closure failed");
    });
  }

  project(operation: Operation): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.projectionFails) throw new Error("Presentation failed");
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
