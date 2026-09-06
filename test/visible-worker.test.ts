import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/event-store/index.js";
import type { CommandInvocation } from "../src/internal/herdr-presentation.js";
import { operationDirectoryKey } from "../src/internal/event-store/index.js";
import {
  CHILD_PROTOCOL_VERSION,
  VisibleWorker,
} from "../src/internal/visible-worker.js";
import { HerdrPreconditionError, makeVisibleRuntime } from "../src/index.js";

class FakeExecutor {
  readonly invocations: Array<CommandInvocation> = [];

  execute(invocation: CommandInvocation) {
    return Effect.sync(() => {
      this.invocations.push(invocation);
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });
  }
}

function operation(): Operation {
  return {
    operationId: "operation-1",
    lineage: { rootOperationId: "operation-1", depth: 0 },
    presentation: { kind: "herdr_pane", paneId: "opaque:pane", ownedByPions: true },
    state: "starting",
    stateSeq: 3,
    task: { promptRef: "secret prompt reference", profile: "coding", idempotencyKey: "task-1" },
    childOperationIds: [],
    settledChildOperationIds: [],
    descendantFailure: false,
    spawnFrozen: false,
    cancellationEpoch: 0,
  };
}

async function fixture(options: {
  readonly maxFirstFrameBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxResultBytes?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "pions-visible-worker-"));
  const executor = new FakeExecutor();
  const capability = "ab".repeat(32);
  const worker = new VisibleWorker({
    rootDirectory: root,
    cwd: "/work/project",
    executor,
    wrapperEntryPath: "/pions/worker-wrapper.js",
    nodeExecutable: "/node/bin/node",
    capabilityGenerator: { nextCapability: () => capability },
    promptReader: { read: () => Promise.resolve(Buffer.from("private prompt", "utf8")) },
    ...options,
  });
  const current = operation();
  await Effect.runPromise(worker.start(current));
  const directory = join(root, operationDirectoryKey(current.operationId));
  const config = JSON.parse(await readFile(join(directory, "worker.v1.json"), "utf8")) as {
    readonly socketPath: string;
  };
  return { capability, config, current, directory, executor, root, worker };
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

const processInstanceId = "12".repeat(32);

function frame(capability: string, sequenceNumber: number, type: string, fields: Readonly<Record<string, unknown>> = {}) {
  return {
    protocolVersion: CHILD_PROTOCOL_VERSION,
    operationId: "operation-1",
    capability,
    sequenceNumber,
    type,
    ...fields,
  };
}

function digest(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

async function deliver(fixtureValue: Awaited<ReturnType<typeof fixture>>, body = "finished") {
  const client = await socket(fixtureValue.config.socketPath);
  send(client, frame(fixtureValue.capability, 1, "hello", { processInstanceId }));
  send(client, frame(fixtureValue.capability, 2, "started"));
  send(client, frame(fixtureValue.capability, 3, "result", { body, digest: digest(body), deliverySequenceNumber: 1 }));
  send(client, frame(fixtureValue.capability, 4, "done"));
  const reception = await Effect.runPromise(fixtureValue.worker.receiveResults(fixtureValue.current.operationId));
  return { client, reception };
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

test("visible worker launch keeps the prompt out of process arguments", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(JSON.stringify(value.executor.invocations[0]).includes("private prompt"), false);
});

test("visible worker launch keeps Operation authority out of process arguments", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(JSON.stringify(value.executor.invocations[0]).includes(value.capability), false);
});

test("visible worker launch targets only the persisted owned pane", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(value.executor.invocations[0]?.args.slice(0, 4), ["pane", "run", "opaque:pane", "'/node/bin/node' '/pions/worker-wrapper.js' '" + join(value.directory, "worker.v1.json") + "'"]);
});

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

test("visible worker directory uses private permissions", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(await mode(value.directory), 0o700);
});

test("visible worker prompt uses private permissions", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(await mode(join(value.directory, "prompt.utf8")), 0o600);
});

test("visible worker configuration uses private permissions", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(await mode(join(value.directory, "worker.v1.json")), 0o600);
});

test("visible worker socket uses private permissions", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(await mode(value.config.socketPath), 0o600);
});

test("authenticated started and Result frames are accepted without terminal parsing", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const { reception } = await deliver(value);

  assert.deepEqual(reception, {
    deliveries: [{ body: "finished", digest: digest("finished"), sequenceNumber: 1 }],
  });
});

test("started notification exposes process identity before Result delivery", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started"));

  assert.deepEqual(await Effect.runPromise(value.worker.receiveStarted(value.current)), { processInstanceId });
});

test("Result ACK is emitted only when explicitly requested after persistence", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const { client } = await deliver(value);
  const ack = new Promise<string>((resolve) => client.once("data", (bytes) => resolve(bytes.toString("utf8"))));
  await Effect.runPromise(value.worker.acknowledgeResult(value.current.operationId, 1));

  assert.equal(JSON.parse(await ack).type, "ack");
});

test("Result acknowledgement discards the visible Worker session", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await deliver(value);
  await Effect.runPromise(
    value.worker.acknowledgeResult(value.current.operationId, 1),
  );

  await assert.rejects(
    Effect.runPromise(value.worker.receiveResults(value.current.operationId)),
    /not prepared/,
  );
});

test("same-delivery retries with monotonic frames reach the Runtime contract", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 2, "started"));
  send(client, frame(value.capability, 3, "result", { body: "finished", digest: digest("finished"), deliverySequenceNumber: 1 }));
  send(client, frame(value.capability, 4, "result", { body: "finished", digest: digest("finished"), deliverySequenceNumber: 1 }));
  send(client, frame(value.capability, 5, "done"));
  const reception = await Effect.runPromise(value.worker.receiveResults(value.current.operationId));

  assert.deepEqual(reception.deliveries.map(({ sequenceNumber }) => sequenceNumber), [1, 1]);
});

test("an invalid Operation capability cannot create a Result", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame("cd".repeat(32), 1, "hello", { processInstanceId }));

  await assert.rejects(Effect.runPromise(value.worker.receiveResults(value.current.operationId)), /authority/);
});

test("protocol rejection discards the visible Worker session", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame("cd".repeat(32), 1, "hello", { processInstanceId }));
  await Effect.runPromise(value.worker.receiveResults(value.current.operationId)).catch(() => undefined);

  await assert.rejects(
    Effect.runPromise(value.worker.receiveResults(value.current.operationId)),
    /not prepared/,
  );
});

test("a stale child sequence number cannot create a Result", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  send(client, frame(value.capability, 1, "started"));

  await assert.rejects(Effect.runPromise(value.worker.receiveResults(value.current.operationId)), /sequence/);
});

test("an oversized first frame cannot create a Result", async (context) => {
  const value = await fixture({ maxFirstFrameBytes: 64 });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  client.write("x".repeat(65));

  await assert.rejects(Effect.runPromise(value.worker.receiveResults(value.current.operationId)), /size limit/);
});

test("an oversized coalesced remainder cannot bypass the message limit", async (context) => {
  const value = await fixture({ maxMessageBytes: 256 });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  client.write(`${JSON.stringify(frame(value.capability, 1, "hello", { processInstanceId }))}\n${"x".repeat(257)}`);

  await assert.rejects(Effect.runPromise(value.worker.receiveResults(value.current.operationId)), /size limit/);
});

test("coalesced post-authentication frames use the message limit", async (context) => {
  const value = await fixture({ maxResultBytes: 8 * 1024 });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  const body = "x".repeat(5 * 1024);
  client.write([
    frame(value.capability, 1, "hello", { processInstanceId }),
    frame(value.capability, 2, "started"),
    frame(value.capability, 3, "result", { body, digest: digest(body), deliverySequenceNumber: 1 }),
    frame(value.capability, 4, "done"),
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const reception = await Effect.runPromise(value.worker.receiveResults(value.current.operationId));

  assert.equal(reception.deliveries[0]?.body.length, 5 * 1024);
});

test("an oversized Result cannot create completion", async (context) => {
  const value = await fixture({ maxResultBytes: 4 });
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(deliver(value, "finished"), /size limit/);
});

test("disconnect before Result cannot create completion", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const client = await socket(value.config.socketPath);
  send(client, frame(value.capability, 1, "hello", { processInstanceId }));
  client.end();

  await assert.rejects(Effect.runPromise(value.worker.receiveResults(value.current.operationId)), /disconnected/);
});
