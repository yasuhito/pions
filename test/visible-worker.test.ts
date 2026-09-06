import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/event-store/index.js";
import type { CommandInvocation } from "../src/internal/herdr-presentation.js";
import type { WorkerRunHooks } from "../src/internal/services.js";
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
  piSessionId,
  resultAcceptanceProof,
  resultDigest,
} from "./worker-protocol-fixtures.js";
import { HerdrPreconditionError, makeVisibleRuntime } from "../src/index.js";

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  const executor = new FakeExecutor();
  const capability = "ab".repeat(32);
  let protocolServer!: Server;
  let protocolSocket: Socket | undefined;
  const adapter = new VisibleWorker({
    rootDirectory: root,
    cwd: "/work/project",
    executor,
    wrapperEntryPath: "/pions/worker-wrapper.js",
    nodeExecutable: "/node/bin/node",
    capabilityGenerator: { nextCapability: () => capability },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
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
    }),
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
  const config = JSON.parse(await readFile(join(directory, "worker.v1.json"), "utf8")) as {
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

const processInstanceId = "12".repeat(32);

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
    ...fields,
  };
}

function sendResultDelivery(
  client: Socket,
  options: {
    readonly capability: string;
    readonly operationId: string;
    readonly body: string;
  },
): void {
  const withOperation = (value: ReturnType<typeof frame>) => ({
    ...value,
    operationId: options.operationId,
  });
  send(client, withOperation(frame(options.capability, 1, "hello", { processInstanceId })));
  send(client, withOperation(frame(options.capability, 2, "started", { piSessionId })));
  send(client, withOperation(frame(options.capability, 3, "result", {
    body: options.body,
    digest: resultDigest(options.body),
    deliverySequenceNumber: 1,
  })));
  send(client, withOperation(frame(options.capability, 4, "done", { ...agentRunEvidence })));
}

async function deliver(
  workerFixture: Awaited<ReturnType<typeof fixture>>,
  body = "finished",
) {
  const client = await socket(workerFixture.config.socketPath);
  const acknowledgement = new Promise<string>((resolve) => {
    client.once("data", (bytes) => resolve(bytes.toString("utf8")));
  });
  sendResultDelivery(client, {
    capability: workerFixture.capability,
    operationId: workerFixture.current.operationId,
    body,
  });
  return { acknowledgement, client, outcome: await workerFixture.outcome };
}

test("public visible Runtime composes the production path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = makeVisibleRuntime({ cwd: "/work/project", stateDirectory: root, environment: {} });

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
    cwd: "/work/project",
    executor,
    wrapperEntryPath: "/pions/worker-wrapper.js",
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
  const configPath = join(root, operationDirectoryKey("operation-1"), "worker.v1.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { readonly socketPath: string };
  const client = await socket(config.socketPath);
  sendResultDelivery(client, { capability, operationId: "operation-1", body: "finished" });

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

test("visible Worker launch targets only the persisted owned pane", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(value.executor.invocations[0]?.args.slice(0, 4), [
    "pane",
    "run",
    "opaque:pane",
    `'/node/bin/node' '/pions/worker-wrapper.js' '${join(value.directory, "worker.v1.json")}'`,
  ]);
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

  assert.equal(await mode(join(value.directory, "worker.v1.json")), 0o600);
});

test("invalid Worker configuration reports a Worker start failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const worker = new VisibleWorker({
    rootDirectory: root,
    cwd: "/work/project",
    executor: new FakeExecutor(),
    wrapperEntryPath: "/pions/worker-wrapper.js",
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
    cwd: "/work/project",
    executor: {
      execute: () => Effect.succeed({
        stdout: "",
        stderr: "launch failed",
        exitCode: 1,
      }),
    },
    wrapperEntryPath: "/pions/worker-wrapper.js",
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

test("visible Worker keeps Node alive while awaiting the wrapper connection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pvk-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executor = new FakeExecutor();
  let unrefCount = 0;
  const adapter = new VisibleWorker({
    rootDirectory: root,
    cwd: "/work/project",
    executor,
    wrapperEntryPath: "/pions/worker-wrapper.js",
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
  await Effect.runPromise(worker.cancel(1));
  await outcome;

  assert.equal(unrefCount, 0);
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
  send(client, frame(value.capability, 2, "started", { piSessionId }));
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
  send(client, frame(value.capability, 2, "started", { piSessionId }));
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

test("normal completion releases Worker protocol listeners", async (context) => {
  const workerFixture = await fixture();
  context.after(() => rm(workerFixture.root, { recursive: true, force: true }));
  await deliver(workerFixture);

  assert.equal(protocolListenerCount(workerFixture.protocolSession), 0);
});

test("settled Pi failure becomes an agent failure with evidence", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started", { piSessionId }));
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

test("disconnect before Result becomes a Worker protocol failure", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  client.end();

  assert.equal((await value.outcome).state, "worker_protocol_failed");
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

  assert.equal(await Effect.runPromise(workerFixture.worker.cancel(1)), undefined);
});

test("cancellation releases Worker protocol listeners", async (context) => {
  const workerFixture = await fixture();
  context.after(() => rm(workerFixture.root, { recursive: true, force: true }));
  await Effect.runPromise(workerFixture.worker.cancel(1));

  assert.equal(protocolListenerCount(workerFixture.protocolSession), 0);
});

test("a Worker cancelled before run creates no process resource", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executor = new FakeExecutor({ stdout: "", stderr: "launch failed", exitCode: 1 });
  const adapter = new VisibleWorker({
    rootDirectory: root,
    cwd: "/work/project",
    executor,
    wrapperEntryPath: "/pions/worker-wrapper.js",
    capabilityGenerator: { nextCapability: () => "ab".repeat(32) },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
  });
  const worker = adapter.open(operation());
  await Effect.runPromise(worker.cancel(1));
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
    cwd: "/work/project",
    executor,
    wrapperEntryPath: "/pions/worker-wrapper.js",
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
  const firstConfig = JSON.parse(await readFile(join(firstDirectory, "worker.v1.json"), "utf8")) as { readonly socketPath: string };
  const secondConfig = JSON.parse(await readFile(join(secondDirectory, "worker.v1.json"), "utf8")) as { readonly socketPath: string };
  const secondClient = await socket(secondConfig.socketPath);
  sendResultDelivery(secondClient, {
    capability: "cd".repeat(32),
    operationId: second.operationId,
    body: "second",
  });
  await secondAtAcceptance;
  const firstClient = await socket(firstConfig.socketPath);
  sendResultDelivery(firstClient, {
    capability: "ab".repeat(32),
    operationId: first.operationId,
    body: "first",
  });
  const outcome = await firstOutcome;
  await Effect.runPromise(secondWorker.cancel(1));
  firstClient.destroy();
  secondClient.destroy();

  assert.equal(outcome.state, "worker_protocol_failed");
});
