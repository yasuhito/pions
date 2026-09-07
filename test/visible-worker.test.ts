import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/event-store/index.js";
import type {
  CommandInvocation,
  CommandOutput,
} from "../src/internal/herdr-presentation.js";
import type {
  WorkerCancellationEvidence,
  WorkerProcessIdentity,
  WorkerRunHooks,
} from "../src/internal/services.js";
import type {
  WorkerProcessControl,
  WorkerProcessState,
} from "../src/internal/worker-process-control.js";
import { operationDirectoryKey } from "../src/internal/event-store/index.js";
import { VisibleWorker } from "../src/internal/visible-worker.js";
import { makeRuntime } from "../src/internal/runtime.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  InMemoryEventStore,
} from "../src/internal/testing.js";
import { WORKER_PROTOCOL_VERSION } from "../src/internal/worker-protocol.js";
import type { ResultDelivery } from "../src/internal/worker-protocol.js";
import {
  agentRunEvidence,
  effectiveConfig,
  observedConfig,
  piSessionId,
  profilePolicy,
  requestedConfig,
  resultAcceptanceProof,
  resultDigest,
} from "./worker-protocol-fixtures.js";
import { HerdrPreconditionError, makeVisibleRuntime } from "../src/index.js";

class FakeProcessControl implements WorkerProcessControl {
  readonly terminations: Array<Readonly<WorkerProcessIdentity>> = [];
  readonly stopObservations: Array<Readonly<WorkerProcessIdentity>> = [];

  constructor(
    private readonly state: WorkerProcessState,
    private readonly terminationEvidence?: WorkerCancellationEvidence,
  ) {}

  observe(_identity: Readonly<WorkerProcessIdentity>) {
    return Effect.succeed(this.state);
  }

  waitForStop(identity: Readonly<WorkerProcessIdentity>, _timeoutMilliseconds: number) {
    return Effect.sync(() => {
      this.stopObservations.push(identity);
      return this.state;
    });
  }

  terminate(identity: Readonly<WorkerProcessIdentity>) {
    return Effect.sync(() => {
      this.terminations.push(identity);
      return this.terminationEvidence;
    });
  }
}

class DeferredStopProcessControl implements WorkerProcessControl {
  private resolveStop!: (state: WorkerProcessState) => void;
  private readonly stop = new Promise<WorkerProcessState>((resolve) => {
    this.resolveStop = resolve;
  });
  private resolveWaitStarted!: () => void;
  readonly waitStarted = new Promise<void>((resolve) => {
    this.resolveWaitStarted = resolve;
  });

  observe(_identity: Readonly<WorkerProcessIdentity>) {
    return Effect.succeed("running" as const);
  }

  waitForStop(_identity: Readonly<WorkerProcessIdentity>, _timeoutMilliseconds: number) {
    this.resolveWaitStarted();
    return Effect.promise(() => this.stop);
  }

  terminate(_identity: Readonly<WorkerProcessIdentity>) {
    return Effect.succeed(undefined);
  }

  complete(state: WorkerProcessState): void {
    this.resolveStop(state);
  }
}

class FakeExecutor {
  readonly invocations: Array<CommandInvocation> = [];

  constructor(
    private readonly output = { stdout: "{}", stderr: "", exitCode: 0 },
  ) {}

  execute(invocation: CommandInvocation) {
    return Effect.sync(() => {
      this.invocations.push(invocation);
      return this.output;
    });
  }
}

class DeferredExecutor {
  readonly invocations: Array<CommandInvocation> = [];
  private resume?: (effect: Effect.Effect<CommandOutput, Error>) => void;
  private settlement?: Effect.Effect<CommandOutput, Error>;

  execute(invocation: CommandInvocation): Effect.Effect<CommandOutput, Error> {
    this.invocations.push(invocation);
    return Effect.async((resume) => {
      this.resume = resume;
      if (this.settlement !== undefined) resume(this.settlement);
    });
  }

  complete(output: CommandOutput = { stdout: "{}", stderr: "", exitCode: 0 }): void {
    this.settle(Effect.succeed(output));
  }

  fail(error: Error): void {
    this.settle(Effect.fail(error));
  }

  private settle(effect: Effect.Effect<CommandOutput, Error>): void {
    this.settlement = effect;
    this.resume?.(effect);
  }
}

function operation(
  operationId = "operation-1",
  paneId = "opaque:pane",
): Operation {
  return {
    operationId,
    lineage: { rootOperationId: operationId, depth: 0 },
    presentation: { kind: "herdr_pane", paneId, ownedByPions: true },
    state: "starting",
    stateSeq: 3,
    workerLaunched: false,
    task: { promptRef: "secret prompt reference", profile: "coding", idempotencyKey: operationId },
    requestedConfig,
    effectiveConfig,
    childOperationIds: [],
    settledChildOperationIds: [],
    descendantFailure: false,
    spawnFrozen: false,
    cancellationEpoch: 0,
  };
}

function workerHooks(
  acceptResults: WorkerRunHooks["acceptResults"] = () =>
    Effect.succeed({ state: "protocol_failed" }),
): WorkerRunHooks {
  return {
    workerLaunched: () => Effect.void,
    workerIdentified: () => Effect.void,
    acceptResults,
  };
}

async function fixture(options: {
  readonly processControl?: WorkerProcessControl;
  readonly backendCancellationGraceMs?: number;
  readonly socketDirectory?: string;
  readonly executor?: FakeExecutor | DeferredExecutor;
  readonly workerIdentified?: WorkerRunHooks["workerIdentified"];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  const executor = options.executor ?? new FakeExecutor();
  const capability = "ab".repeat(32);
  let protocolServer!: Server;
  let protocolSocket: Socket | undefined;
  const adapter = new VisibleWorker({
    rootDirectory: root,
    socketDirectory: options.socketDirectory ?? root,
    cwd: "/work/project",
    executor,
    extensionEntryPath: "/pions/worker-extension.js",
    capabilityGenerator: { nextCapability: () => capability },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
    processControl: options.processControl ?? new FakeProcessControl("stopped"),
    ...(options.backendCancellationGraceMs === undefined
      ? {}
      : { backendCancellationGraceMs: options.backendCancellationGraceMs }),
    serverFactory: () => {
      protocolServer = createServer();
      protocolServer.unref();
      protocolServer.on("connection", (connected) => {
        protocolSocket = connected;
      });
      return protocolServer;
    },
  });
  const current = operation();
  const deliveries: Array<ResultDelivery> = [];
  const identities: Array<string> = [];
  const piSessionIds: Array<string> = [];
  const hooks: WorkerRunHooks = {
    workerLaunched: () => Effect.void,
    workerIdentified: (identity) => Effect.sync(() => {
      identities.push(identity.processInstanceId);
      piSessionIds.push(identity.piSessionId);
    }).pipe(Effect.andThen(options.workerIdentified?.(identity) ?? Effect.void)),
    acceptResults: (received) => Effect.sync(() => {
      deliveries.push(...received);
      const first = received[0];
      if (first === undefined) return { state: "protocol_failed" } as const;
      return {
        state: "accepted",
        proofs: received.map((item) => resultAcceptanceProof(
          current.operationId,
          item.body,
          item.sequenceNumber,
        )),
      } as const;
    }),
  };
  const worker = adapter.open(current);
  const outcome = Effect.runPromise(worker.run(hooks));
  while (executor.invocations.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const directory = join(root, operationDirectoryKey(current.operationId));
  const config = JSON.parse(await readFile(join(directory, "worker.v6.json"), "utf8")) as {
    readonly socketPath: string;
  };
  const protocolSession = {
    server: protocolServer,
    get socket() {
      return protocolSocket;
    },
  };
  return {
    adapter,
    capability,
    config,
    current,
    deliveries,
    directory,
    executor,
    identities,
    piSessionIds,
    outcome,
    protocolSession,
    root,
    worker,
  };
}

async function socket(path: string): Promise<Socket> {
  const client = connect(path);
  client.unref();
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  return client;
}

function send(client: Socket, value: unknown): void {
  client.write(`${JSON.stringify(value)}\n`);
}

function protocolListenerCount(protocolSession: {
  readonly server: Server;
  readonly socket?: Socket | undefined;
}): number {
  return protocolSession.server.listenerCount("connection") +
    protocolSession.server.listenerCount("error") +
    (protocolSession.socket?.listenerCount("data") ?? 0) +
    (protocolSession.socket?.listenerCount("end") ?? 0) +
    (protocolSession.socket?.listenerCount("error") ?? 0);
}

const processId = 1234;
const processInstanceId = "12".repeat(32);
const processStartToken = "987654";

function frame(
  capability: string,
  sequenceNumber: number,
  type: string,
  fields: Readonly<Record<string, unknown>> = {},
) {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    operationId: "operation-1",
    capability,
    sequenceNumber,
    type,
    ...(type === "hello" ? { processId, processStartToken } : {}),
    ...fields,
  };
}

function receiveFrame(client: Socket): Promise<string> {
  return new Promise((resolve) => {
    client.once("data", (bytes) => resolve(bytes.toString("utf8")));
  });
}

async function sendResultDelivery(
  client: Socket,
  options: {
    readonly capability: string;
    readonly operationId: string;
    readonly body: string;
  },
): Promise<{ readonly acknowledgement: Promise<string>; readonly begin: string }> {
  const withOperation = (value: ReturnType<typeof frame>) => ({
    ...value,
    operationId: options.operationId,
  });
  const begin = receiveFrame(client);
  send(client, withOperation(frame(options.capability, 1, "hello", { processInstanceId })));
  send(client, withOperation(frame(options.capability, 2, "started", { piSessionId, observedConfig })));
  const receivedBegin = await begin;
  const acknowledgement = receiveFrame(client);
  send(client, withOperation(frame(options.capability, 3, "result", {
    body: options.body,
    digest: resultDigest(options.body),
    deliverySequenceNumber: 1,
  })));
  send(client, withOperation(frame(options.capability, 4, "done", { ...agentRunEvidence })));
  return { acknowledgement, begin: receivedBegin };
}

async function deliver(
  workerFixture: Awaited<ReturnType<typeof fixture>>,
  body = "finished",
) {
  const client = await socket(workerFixture.config.socketPath);
  const { acknowledgement, begin } = await sendResultDelivery(client, {
    capability: workerFixture.capability,
    operationId: workerFixture.current.operationId,
    body,
  });
  return { acknowledgement, begin, client, outcome: await workerFixture.outcome };
}

test("public visible Runtime composes the production path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = makeVisibleRuntime({ cwd: "/work/project", stateDirectory: root, profiles: { coding: profilePolicy }, environment: {} });

  await assert.rejects(
    runtime.spawn({ promptRef: "/private/prompt", profile: "coding", idempotencyKey: "task-1" }),
    (error) => error instanceof HerdrPreconditionError,
  );
});

test("visible Pi adapter satisfies the caller-facing Runtime Result contract", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pvc-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executor = new FakeExecutor();
  const capability = "ab".repeat(32);
  const worker = new VisibleWorker({
    rootDirectory: root,
    socketDirectory: root,
    cwd: "/work/project",
    executor,
    extensionEntryPath: "/pions/worker-extension.js",
    capabilityGenerator: { nextCapability: () => capability },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
  });
  const runtime = makeRuntime({
    worker,
    clock: new FakeClock(Array.from({ length: 12 }, (_, index) => `time-${index}`)),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore(),
  });
  const handle = await runtime.spawn({
    promptRef: "/private/prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  while (executor.invocations.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const configPath = join(root, operationDirectoryKey("operation-1"), "worker.v6.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { readonly socketPath: string };
  const client = await socket(config.socketPath);
  await sendResultDelivery(client, { capability, operationId: "operation-1", body: "finished" });

  assert.deepEqual(await handle.result(), {
    body: "finished",
    byteCount: 8,
    digest: resultDigest("finished"),
  });
});

test("visible Worker launch keeps the prompt out of process arguments", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(JSON.stringify(value.executor.invocations[0]).includes("private prompt"), false);
});

test("visible Worker launch keeps Operation authority out of process arguments", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(JSON.stringify(value.executor.invocations[0]).includes(value.capability), false);
});

test("visible Worker starts a Herdr Pi agent in the persisted owned pane", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(value.executor.invocations[0]?.args.slice(0, 8), [
    "agent",
    "start",
    `pions-${operationDirectoryKey(value.current.operationId).slice(0, 26)}`,
    "--kind",
    "pi",
    "--pane",
    "opaque:pane",
    "--timeout",
  ]);
});

test("visible Worker gives Pi the effective policy as structured arguments", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(value.executor.invocations[0]?.args.slice(10), [
    "--provider", "test",
    "--model", "test-model",
    "--thinking", "medium",
    "--tools", "read,bash,edit,write",
    "--no-session",
    "--tui-mode", "regular",
    "--no-extensions",
    "--extension", "/pions/worker-extension.js",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--approve",
    "--pions-worker-config", join(value.directory, "worker.v6.json"),
  ]);
});

test("visible Worker agent name contains no task text", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(value.executor.invocations[0]?.args[2]?.includes("private prompt"), false);
});

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

test("visible Worker directory uses private permissions", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(await mode(value.directory), 0o700);
});

test("visible Worker prompt uses private permissions", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(await mode(join(value.directory, "prompt.utf8")), 0o600);
});

test("visible Worker configuration uses private permissions", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(await mode(join(value.directory, "worker.v6.json")), 0o600);
});

test("invalid Worker configuration reports a Worker start failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const worker = new VisibleWorker({
    rootDirectory: root,
    socketDirectory: root,
    cwd: "/work/project",
    executor: new FakeExecutor(),
    extensionEntryPath: "/pions/worker-extension.js",
    capabilityGenerator: { nextCapability: () => "invalid" },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
  });
  const outcome = await Effect.runPromise(
    worker.open(operation()).run(workerHooks()),
  );

  assert.equal(outcome.state, "worker_start_failed");
});

test("Worker launch failure releases Worker protocol listeners", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let protocolServer!: Server;
  const worker = new VisibleWorker({
    rootDirectory: root,
    socketDirectory: root,
    cwd: "/work/project",
    executor: {
      execute: () => Effect.succeed({
        stdout: "",
        stderr: "launch failed",
        exitCode: 1,
      }),
    },
    extensionEntryPath: "/pions/worker-extension.js",
    capabilityGenerator: { nextCapability: () => "ab".repeat(32) },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
    serverFactory: () => {
      protocolServer = createServer();
      return protocolServer;
    },
  });
  await Effect.runPromise(worker.open(operation()).run(workerHooks()));

  assert.equal(protocolListenerCount({ server: protocolServer }), 0);
});

test("visible Worker socket uses private permissions", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(await mode(value.config.socketPath), 0o600);
});

test("visible Worker can place its socket outside a long persistent state path", async (context) => {
  const socketDirectory = await mkdtemp(join(tmpdir(), "pions-worker-sockets-"));
  const value = await fixture({ socketDirectory });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  context.after(() => rm(socketDirectory, { recursive: true, force: true }));

  assert.equal(value.config.socketPath.startsWith(`${socketDirectory}/`), true);
});

test("visible Worker keeps Node alive while awaiting the Pi extension connection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pvk-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executor = new FakeExecutor();
  let unrefCount = 0;
  const adapter = new VisibleWorker({
    rootDirectory: root,
    socketDirectory: root,
    cwd: "/work/project",
    executor,
    extensionEntryPath: "/pions/worker-extension.js",
    capabilityGenerator: { nextCapability: () => "ab".repeat(32) },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
    serverFactory: () => {
      const server = createServer();
      const unref = server.unref.bind(server);
      server.unref = () => {
        unrefCount += 1;
        return unref();
      };
      return server;
    },
  });
  const worker = adapter.open(operation());
  const outcome = Effect.runPromise(worker.run(workerHooks()));
  while (executor.invocations.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Effect.runPromise(worker.cancel(1, 1_000));
  await outcome;

  assert.equal(unrefCount, 0);
});

test("visible Worker does not send begin while the launch command is incomplete", async (context) => {
  const executor = new DeferredExecutor();
  const value = await fixture({ executor });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  const frames: Array<string> = [];
  client.on("data", (bytes) => frames.push(bytes.toString("utf8")));
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const framesBeforeLaunchCompleted = frames.length;
  executor.complete();
  while (frames.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  send(client, frame(value.capability, 3, "failed", {
    errorMessage: "finished cleanup",
    ...agentRunEvidence,
  }));
  await value.outcome;

  assert.equal(framesBeforeLaunchCompleted, 0);
});

test("visible Worker does not send begin when the launch command fails", async (context) => {
  const executor = new DeferredExecutor();
  const value = await fixture({ executor });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  const frames: Array<string> = [];
  client.on("data", (bytes) => frames.push(bytes.toString("utf8")));
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  executor.complete({ stdout: "", stderr: "launch failed", exitCode: 1 });
  await value.outcome;

  assert.equal(frames.length, 0);
});

test("visible Worker does not send begin when the launch command times out", async (context) => {
  const executor = new DeferredExecutor();
  const value = await fixture({ executor });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  const frames: Array<string> = [];
  client.on("data", (bytes) => frames.push(bytes.toString("utf8")));
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  executor.fail(new Error("launch timed out"));
  await value.outcome;

  assert.equal(frames.length, 0);
});

test("a Worker cancelled before begin does not receive begin", async (context) => {
  let identified!: () => void;
  const identification = new Promise<void>((resolve) => {
    identified = resolve;
  });
  let releaseIdentification!: () => void;
  const value = await fixture({
    workerIdentified: () => Effect.async<void>((resume) => {
      identified();
      releaseIdentification = () => resume(Effect.void);
    }),
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  await identification;
  const control = receiveFrame(client);
  const cancellation = Effect.runPromise(value.worker.cancel(1, 1_000));
  const receivedControl = JSON.parse(await control) as { readonly type: string };
  send(client, frame(value.capability, 3, "cancelled"));
  await cancellation;
  releaseIdentification();
  await value.outcome;

  assert.equal(receivedControl.type, "cancel");
});

test("visible Worker sends authenticated begin through the Worker protocol", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const { begin } = await deliver(value);

  assert.deepEqual(JSON.parse(begin), {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    operationId: value.current.operationId,
    capability: value.capability,
    sequenceNumber: 1,
    type: "begin",
  });
});

test("authenticated Result is observed through the Worker interface", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await deliver(value);

  assert.deepEqual(value.deliveries, [
    {
      operationId: "operation-1",
      body: "finished",
      digest: resultDigest("finished"),
      sequenceNumber: 1,
    },
  ]);
});

test("authenticated Worker identity is observed before Result delivery", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  while (value.identities.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(value.identities, [processInstanceId]);
});

test("authenticated Pi session identity is observed through the Worker interface", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  while (value.piSessionIds.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(value.piSessionIds, [piSessionId]);
});

test("visible Worker sends ACK after Result acceptance", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const { acknowledgement } = await deliver(value);

  assert.equal(JSON.parse(await acknowledgement).type, "ack");
});

test("visible Worker confirms the exact Pi process stopped after ACK", async (context) => {
  const processControl = new FakeProcessControl("stopped");
  const value = await fixture({ processControl });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await deliver(value);

  assert.equal(processControl.stopObservations[0]?.processStartToken, processStartToken);
});

test("successful Worker reports confirmed exit after process stop", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const delivered = await deliver(value);

  assert.equal(
    delivered.outcome.state === "result_acknowledged"
      ? delivered.outcome.successfulExitConfirmed
      : undefined,
    true,
  );
});

async function cancelDuringExitConfirmation(context: TestContext) {
  const processControl = new DeferredStopProcessControl();
  const value = await fixture({ processControl });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  const delivery = await sendResultDelivery(client, {
    capability: value.capability,
    operationId: value.current.operationId,
    body: "finished",
  });
  await delivery.acknowledgement;
  await processControl.waitStarted;
  const cancellation = Effect.runPromise(value.worker.cancel(1, 1_000));
  processControl.complete("stopped");
  return {
    cancellation: await cancellation,
    outcome: await value.outcome,
  };
}

test("cancellation during successful-exit confirmation withholds cleanup eligibility", async (context) => {
  const { outcome } = await cancelDuringExitConfirmation(context);

  assert.equal("successfulExitConfirmed" in outcome, false);
});

test("confirmed stop during successful-exit cancellation is cancellation evidence", async (context) => {
  const { cancellation } = await cancelDuringExitConfirmation(context);

  assert.deepEqual(cancellation, { proof: "worker-stop" });
});

test("unconfirmed Pi exit after ACK has unknown liveness", async (context) => {
  const value = await fixture({ processControl: new FakeProcessControl("unverifiable") });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const delivered = await deliver(value);

  assert.equal(delivered.outcome.state, "liveness-unproven");
});

test("normal completion releases Worker protocol listeners", async (context) => {
  const workerFixture = await fixture();
  context.after(() => rm(workerFixture.root, { recursive: true, force: true }));
  await deliver(workerFixture);

  assert.equal(protocolListenerCount(workerFixture.protocolSession), 0);
});

test("observed model mismatch becomes a typed Worker failure", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", {
    piSessionId,
    observedConfig: {
      ...observedConfig,
      model: { state: "observed", value: { provider: "other", id: "model" } },
    },
  }));

  assert.equal((await value.outcome).state, "model_mismatch");
});

test("visible Worker does not send begin when observed configuration mismatches", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  const frames: Array<string> = [];
  client.on("data", (bytes) => frames.push(bytes.toString("utf8")));
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", {
    piSessionId,
    observedConfig: {
      ...observedConfig,
      model: { state: "observed", value: { provider: "other", id: "model" } },
    },
  }));
  await value.outcome;

  assert.equal(frames.length, 0);
});

test("pre-start configuration failure becomes a typed Worker failure", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "configuration_failed", {
    reason: "tool_policy_violation",
  }));

  assert.equal((await value.outcome).state, "tool_policy_violation");
});

test("settled Pi failure becomes an agent failure with evidence", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  const begin = receiveFrame(client);
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  await begin;
  send(client, frame(value.capability, 3, "failed", {
    errorMessage: "provider failed",
    ...agentRunEvidence,
  }));

  assert.deepEqual(await value.outcome, {
    state: "agent_failed",
    evidence: agentRunEvidence,
  });
});

test("protocol rejection becomes a Worker protocol failure", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame("cd".repeat(32), 1, "hello", { processInstanceId }));

  assert.equal((await value.outcome).state, "worker_protocol_failed");
});

test("protocol failure releases Worker protocol listeners", async (context) => {
  const workerFixture = await fixture();
  context.after(() => rm(workerFixture.root, { recursive: true, force: true }));
  const client = await socket(workerFixture.config.socketPath);
  send(client, frame("cd".repeat(32), 1, "hello", { processInstanceId }));
  await workerFixture.outcome;

  assert.equal(protocolListenerCount(workerFixture.protocolSession), 0);
});

test("disconnect before session identification has unknown liveness", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  client.end();

  assert.equal((await value.outcome).state, "liveness-unproven");
});

test("disconnect releases Worker protocol listeners", async (context) => {
  const workerFixture = await fixture();
  context.after(() => rm(workerFixture.root, { recursive: true, force: true }));
  const client = await socket(workerFixture.config.socketPath);
  send(client, frame(workerFixture.capability, 1, "hello", { processInstanceId }));
  client.end();
  await workerFixture.outcome;

  assert.equal(protocolListenerCount(workerFixture.protocolSession), 0);
});

test("confirmed process exit without a Result is classified separately", async (context) => {
  const value = await fixture({ processControl: new FakeProcessControl("stopped") });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  client.end();

  assert.equal((await value.outcome).state, "process-exited-without-result");
});

test("unverifiable process liveness is classified as unknown evidence", async (context) => {
  const value = await fixture({ processControl: new FakeProcessControl("unverifiable") });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  client.end();

  assert.equal((await value.outcome).state, "liveness-unproven");
});

test("one Worker cannot run twice", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(
    Effect.runPromise(value.worker.run(workerHooks())),
    /only run once/,
  );
});

test("visible Worker cancellation returns no stop evidence", async (context) => {
  const workerFixture = await fixture();
  context.after(() => rm(workerFixture.root, { recursive: true, force: true }));

  assert.equal(await Effect.runPromise(workerFixture.worker.cancel(1, 1_000)), undefined);
});

test("backend cancellation acknowledgement is stop evidence", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  while (value.piSessionIds.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const cancellation = Effect.runPromise(value.worker.cancel(1, 1_000));
  await new Promise<void>((resolve) => setImmediate(resolve));
  send(client, frame(value.capability, 3, "cancelled"));

  assert.deepEqual(await cancellation, { proof: "acknowledgement" });
});

test("forced termination begins only after the backend grace period", async (context) => {
  const processControl = new FakeProcessControl("running", { proof: "worker-stop" });
  const value = await fixture({ processControl, backendCancellationGraceMs: 0 });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId, observedConfig }));
  while (value.piSessionIds.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Effect.runPromise(value.worker.cancel(1, 1_000));

  assert.equal(processControl.terminations.length, 1);
});

test("cancellation releases Worker protocol listeners", async (context) => {
  const workerFixture = await fixture();
  context.after(() => rm(workerFixture.root, { recursive: true, force: true }));
  await Effect.runPromise(workerFixture.worker.cancel(1, 1_000));

  assert.equal(protocolListenerCount(workerFixture.protocolSession), 0);
});

test("a Worker cancelled before run creates no process resource", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executor = new FakeExecutor({ stdout: "", stderr: "launch failed", exitCode: 1 });
  const adapter = new VisibleWorker({
    rootDirectory: root,
    socketDirectory: root,
    cwd: "/work/project",
    executor,
    extensionEntryPath: "/pions/worker-extension.js",
    capabilityGenerator: { nextCapability: () => "ab".repeat(32) },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
  });
  const worker = adapter.open(operation());
  await Effect.runPromise(worker.cancel(1, 1_000));
  await Effect.runPromise(worker.run(workerHooks()));

  assert.equal(executor.invocations.length, 0);
});

test("a Worker rejects a Result acceptance proof for another Operation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executor = new FakeExecutor();
  const capabilities = ["ab".repeat(32), "cd".repeat(32)];
  const adapter = new VisibleWorker({
    rootDirectory: root,
    socketDirectory: root,
    cwd: "/work/project",
    executor,
    extensionEntryPath: "/pions/worker-extension.js",
    capabilityGenerator: { nextCapability: () => capabilities.shift() ?? "ef".repeat(32) },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
  });
  const first = operation("operation-1", "pane-1");
  const second = operation("operation-2", "pane-2");
  const firstWorker = adapter.open(first);
  const secondWorker = adapter.open(second);
  let secondAcceptanceReached!: () => void;
  const secondAtAcceptance = new Promise<void>((resolve) => {
    secondAcceptanceReached = resolve;
  });
  const firstOutcome = Effect.runPromise(firstWorker.run(workerHooks(() =>
    Effect.succeed({
      state: "accepted",
      proofs: [resultAcceptanceProof(second.operationId, "second")],
    }))));
  void Effect.runPromise(secondWorker.run(workerHooks(() =>
    Effect.async(() => {
      secondAcceptanceReached();
    }))));
  while (executor.invocations.length < 2) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const firstDirectory = join(root, operationDirectoryKey(first.operationId));
  const secondDirectory = join(root, operationDirectoryKey(second.operationId));
  const firstConfig = JSON.parse(await readFile(join(firstDirectory, "worker.v6.json"), "utf8")) as { readonly socketPath: string };
  const secondConfig = JSON.parse(await readFile(join(secondDirectory, "worker.v6.json"), "utf8")) as { readonly socketPath: string };
  const secondClient = await socket(secondConfig.socketPath);
  await sendResultDelivery(secondClient, {
    capability: "cd".repeat(32),
    operationId: second.operationId,
    body: "second",
  });
  await secondAtAcceptance;
  const firstClient = await socket(firstConfig.socketPath);
  await sendResultDelivery(firstClient, {
    capability: "ab".repeat(32),
    operationId: first.operationId,
    body: "first",
  });
  const outcome = await firstOutcome;
  await Effect.runPromise(secondWorker.cancel(1, 1_000));
  firstClient.destroy();
  secondClient.destroy();

  assert.equal(outcome.state, "worker_protocol_failed");
});
