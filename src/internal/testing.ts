import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Effect } from "effect";

import type {
  CreatedPresentation,
  Operation,
  OperationState,
} from "./event-store/index.js";
import type { ResultAcceptanceProof } from "./worker-protocol.js";
import { makeRuntime } from "./runtime.js";
import { runtimeArtifactStore } from "./runtime-artifacts.js";
export { InMemoryEventStore } from "./event-store/memory-storage.js";
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
  ResourceProofRejectedError,
  Result,
  Runtime,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

type TestRuntimeServices = Omit<RuntimeServices, "artifacts" | "artifactCredential"> &
  Partial<Pick<RuntimeServices, "artifacts" | "artifactCredential">>;

export function makeTestRuntime(services: TestRuntimeServices): Runtime {
  if (services.artifacts !== undefined && services.artifactCredential !== undefined) {
    return makeRuntime({ ...services, artifacts: services.artifacts, artifactCredential: services.artifactCredential });
  }
  if (services.artifacts !== undefined || services.artifactCredential !== undefined) {
    throw new Error("Test Artifact Store and credential must be supplied together");
  }
  const artifactServices = runtimeArtifactStore(
    join(process.cwd(), ".test-dist", "runtime-artifacts", randomUUID()),
    services.store,
  );
  return makeRuntime({
    ...services,
    artifacts: artifactServices.artifacts,
    artifactCredential: artifactServices.credential,
    synchronizeArtifactClock: artifactServices.synchronizeClock,
  });
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
    | "model_not_found"
    | "model_auth_unavailable"
    | "unsupported_capability"
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

  protected run(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>,
  ): Effect.Effect<
    WorkerRunOutcome,
    OperationPersistenceError | ResourceProofRejectedError
  > {
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
        this.failure === "model_not_found" ||
        this.failure === "model_auth_unavailable" ||
        this.failure === "unsupported_capability" ||
        this.failure === "tool_policy_violation"
      ) {
        return { state: this.failure } as const;
      }
      yield* hooks.workerIdentified({
        processId: 1234,
        processInstanceId: "fake-process-instance",
        processStartToken: "fake-process-start",
        piSessionId: "fake-pi-session",
        observedConfig: {
          model: { state: "observed", value: { ...operation.effectiveConfig.model } },
          thinkingLevel: { state: "unavailable" },
          tools: { state: "observed", value: [...operation.effectiveConfig.tools] },
          cwd: { state: "observed", value: operation.effectiveConfig.cwd },
        },
      });
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
            toolUses: [{ toolCallId: "fake-call", toolName: "read", isError: true }],
          },
        } as const;
      }
      this.trace.push("worker-protocol:receive-result");
      const message = this.messages[0];
      if (message === undefined) return { state: "worker_protocol_failed" } as const;
      const bytes = Buffer.from(message.body, "utf8");
      const acceptance = yield* hooks.acceptResult({
        acceptanceRequestId: `request-${message.sequenceNumber ?? 1}`,
        body: {
          formatId: "pions.result-body.v1",
          normalizationId: "identity.v1",
          expectedByteCount: bytes.byteLength,
          expectedDigest: message.digest ?? sha256Digest(bytes),
          bytes,
        },
        workProducts: [],
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
          toolUses: [{ toolCallId: "fake-call", toolName: "read", isError: false }],
        },
        (proof) => this.acknowledgementFails
          ? Effect.fail(new Error("Fake Worker acknowledgement failed"))
          : Effect.sync(() => this.acknowledge(proof)),
      );
      return acknowledged.state === "result_acknowledged" && this.successfulExitConfirmed
        ? { ...acknowledged, successfulExitConfirmed: true }
        : acknowledged;
    });
  }

  protected acknowledge(acceptance: Readonly<ResultAcceptanceProof>): void {
    this.trace.push(`worker-protocol:ack:${acceptance.eventSequenceNumber}`);
  }

  protected cancel(
    _operation: Operation,
    _cancellationEpoch: number,
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

export interface FakePresentationOptions {
  readonly trace?: Array<string>;
  readonly attemptedState?: OperationState;
  readonly projectionFails?: boolean;
  readonly paneClosureFails?: boolean;
}

export class FakePresentation implements Presentation {
  readonly projections: Array<Operation> = [];
  readonly createdPaneIds: Array<string> = [];
  readonly rolledBackPaneIds: Array<string> = [];
  readonly closedPaneIds: Array<string> = [];
  stateChangeSucceeded = false;
  private readonly trace: Array<string>;
  private readonly attemptedState: OperationState | undefined;
  private readonly projectionFails: boolean;
  private readonly paneClosureFails: boolean;

  constructor(options: FakePresentationOptions = {}) {
    this.trace = options.trace ?? [];
    this.attemptedState = options.attemptedState;
    this.projectionFails = options.projectionFails ?? false;
    this.paneClosureFails = options.paneClosureFails ?? false;
  }

  preflight(): Effect.Effect<void> {
    return Effect.void;
  }

  create(operation: Operation): Effect.Effect<CreatedPresentation> {
    return Effect.sync(() => {
      const paneId = `fake-pane:${operation.operationId}`;
      this.createdPaneIds.push(paneId);
      return { kind: "herdr_pane", paneId };
    });
  }

  rollbackCreated(presentation: CreatedPresentation): Effect.Effect<void> {
    return Effect.sync(() => {
      this.rolledBackPaneIds.push(presentation.paneId);
    });
  }

  onWorkerStartFailure(_operation: Operation): Effect.Effect<void> {
    return Effect.void;
  }

  closeOwnedPane(operation: Operation): Effect.Effect<void> {
    return Effect.sync(() => {
      if (operation.presentation === undefined) return;
      this.closedPaneIds.push(operation.presentation.paneId);
      if (this.paneClosureFails) throw new Error("Pane closure failed");
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
