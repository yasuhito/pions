import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Effect } from "effect";

import type { OperationEvent } from "../src/internal/event-store/model.js";
import type { EventStore, StoreError } from "../src/internal/event-store/index.js";
import { PrivateFileEventStore, operationDirectoryKey } from "../src/internal/event-store/index.js";
import {
  FakeWorkerAdapter,
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  InMemoryEventStore,
} from "../src/internal/testing.js";
import { makeRuntime } from "../src/internal/runtime.js";
import { OperationPersistenceError } from "../src/index.js";

const task = {
  promptRef: "private://prompt/1",
  profile: "coding",
  idempotencyKey: "task-1",
};

function digest(body: string) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}` as const;
}

async function privateRoot(): Promise<string> {
  const root = join(tmpdir(), `pions-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  return root;
}

function clock(): FakeClock {
  return new FakeClock(Array.from({ length: 20 }, (_, index) => `time-${index}`));
}

async function complete(store: EventStore, operationId = "operation-1") {
  await Effect.runPromise(store.create({
    operationId,
    task,
    lineage: { rootOperationId: operationId, depth: 0 },
  }));
  await Effect.runPromise(store.advance(operationId, { type: "operation_starting" }));
  await Effect.runPromise(store.advance(operationId, { type: "worker_launched" }));
  await Effect.runPromise(store.advance(operationId, { type: "operation_started" }));
  await Effect.runPromise(store.advance(operationId, {
    type: "accept_result",
    delivery: {
      operationId,
      body: "finished",
      digest: digest("finished"),
      sequenceNumber: 1,
    },
  }));
  await Effect.runPromise(store.advance(operationId, { type: "self_settled", outcome: "succeeded" }));
  return Effect.runPromise(store.advance(operationId, { type: "operation_completed" }));
}

async function storeFailure(effect: Effect.Effect<unknown, { readonly code: string }>) {
  return Effect.runPromise(Effect.flip(effect));
}

const eventStoreAdapters: ReadonlyArray<{
  readonly name: string;
  readonly make: (context: TestContext) => Promise<EventStore>;
}> = [
  {
    name: "memory",
    make: () => Promise.resolve(new InMemoryEventStore([], clock())),
  },
  {
    name: "file",
    make: async (context) => {
      const root = await privateRoot();
      context.after(() => rm(root, { recursive: true, force: true }));
      return new PrivateFileEventStore(root, clock());
    },
  },
];

for (const adapter of eventStoreAdapters) {
  test(`${adapter.name} EventStore adapter creates a queued Operation`, async (context) => {
    const store = await adapter.make(context);
    const snapshot = await Effect.runPromise(store.create({
      operationId: "operation-1",
      task,
      lineage: { rootOperationId: "operation-1", depth: 0 },
    }));

    assert.equal(snapshot.operation.state, "queued");
  });

  test(`${adapter.name} EventStore adapter returns an accepted Result`, async (context) => {
    const store = await adapter.make(context);
    const snapshot = await complete(store);

    assert.equal(snapshot.result?.body, "finished");
  });
}

test("EventStore adapters reconstruct the same terminal snapshot", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const memory = new InMemoryEventStore([], clock());
  const file = new PrivateFileEventStore(root, clock());
  const expected = await complete(memory);
  await complete(file);
  const reopened = new PrivateFileEventStore(root, clock());

  assert.deepEqual((await Effect.runPromise(reopened.read("operation-1"))).operation, expected.operation);
});

test("reloading a Result does not append a delivery event", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const recordPath = join(root, operationDirectoryKey("operation-1"), "events.v4.json");
  const before = await readFile(recordPath, "utf8");
  const reopened = new PrivateFileEventStore(root, clock());
  await Effect.runPromise(reopened.read("operation-1"));

  assert.equal(await readFile(recordPath, "utf8"), before);
});

test("a reopened EventStore returns the integrity-checked Result", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));

  assert.deepEqual(
    (await Effect.runPromise(new PrivateFileEventStore(root, clock()).read("operation-1"))).result,
    { body: "finished", byteCount: 8, digest: digest("finished") },
  );
});

test("private records use private directory and file permissions", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const operationDirectory = join(root, operationDirectoryKey("operation-1"));
  const paths = [root, operationDirectory, join(operationDirectory, "events.v4.json"), join(operationDirectory, "result.utf8")];
  const modes = await Promise.all(paths.map(async (path) => (await lstat(path)).mode & 0o777));

  assert.deepEqual(modes, [0o700, 0o700, 0o600, 0o600]);
});

test("Operation identifiers are not used as record paths", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const operationId = "../private-operation";
  await complete(new PrivateFileEventStore(root, clock()), operationId);

  assert.equal((await lstat(join(root, operationDirectoryKey(operationId)))).isDirectory(), true);
});

test("a symlink Operation directory is rejected", async (context) => {
  const root = await privateRoot();
  const target = await privateRoot();
  context.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]));
  await symlink(target, join(root, operationDirectoryKey("operation-1")));
  const store = new PrivateFileEventStore(root, clock());

  assert.equal((await storeFailure(store.create({
    operationId: "operation-1",
    task,
    lineage: { rootOperationId: "operation-1", depth: 0 },
  }))).code, "corrupt_record");
});

test("a Result without an event record is incomplete", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, operationDirectoryKey("operation-1"));
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "result.utf8"), "finished", { mode: 0o600 });

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "incomplete_record");
});

test("a missing Result referenced by an event record is corrupt", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  await rm(join(root, operationDirectoryKey("operation-1"), "result.utf8"));

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "corrupt_record");
});

test("a Result with changed bytes is corrupt", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  await writeFile(join(root, operationDirectoryKey("operation-1"), "result.utf8"), "changed", { mode: 0o600 });

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "corrupt_record");
});

test("an unsupported record schema is rejected", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const path = join(root, operationDirectoryKey("operation-1"), "events.v4.json");
  const record = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number };
  record.schemaVersion = 5;
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "unsupported_schema");
});

test("an unsupported event schema is rejected", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const path = join(root, operationDirectoryKey("operation-1"), "events.v4.json");
  const record = JSON.parse(await readFile(path, "utf8")) as {
    events: Array<{ schemaVersion: number }>;
  };
  record.events[0]!.schemaVersion = 5;
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "unsupported_schema");
});

test("an event record with a forged envelope is corrupt", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const path = join(root, operationDirectoryKey("operation-1"), "events.v4.json");
  const record = JSON.parse(await readFile(path, "utf8")) as { events: Array<OperationEvent> };
  record.events[1] = { ...record.events[1]!, eventId: "forged-event" };
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "corrupt_record");
});

test("an out-of-order event record is corrupt", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const path = join(root, operationDirectoryKey("operation-1"), "events.v4.json");
  const record = JSON.parse(await readFile(path, "utf8")) as { events: Array<OperationEvent> };
  [record.events[1], record.events[2]] = [record.events[2]!, record.events[1]!];
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "corrupt_record");
});

test("a persisted Result event contains only its durable reference", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const path = join(root, operationDirectoryKey("operation-1"), "events.v4.json");
  const record = JSON.parse(await readFile(path, "utf8")) as { events: Array<OperationEvent> };
  const resultEvent = record.events.find((event) => event.type === "result_persisted");

  assert.deepEqual(resultEvent?.type === "result_persisted" ? resultEvent.result : undefined, {
    location: "result.utf8",
    byteCount: 8,
    digest: digest("finished"),
    deliverySequenceNumber: 1,
  });
});

test("a Result retry must match its claimed digest", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new PrivateFileEventStore(root, clock());
  await complete(store);

  const error = await storeFailure(store.advance("operation-1", {
    type: "accept_result",
    delivery: {
      operationId: "operation-1",
      body: "tampered",
      digest: digest("finished"),
      sequenceNumber: 2,
    },
  }) as Effect.Effect<unknown, StoreError>);

  assert.equal(error.code, "corrupt_record");
});

async function interruptResultPublication(root: string) {
  const store = new PrivateFileEventStore(
    root,
    new FakeClock(["time-0", "time-1", "time-2", "time-3"]),
  );
  await Effect.runPromise(store.create({
    operationId: "operation-1",
    task,
    lineage: { rootOperationId: "operation-1", depth: 0 },
  }));
  await Effect.runPromise(store.advance("operation-1", { type: "operation_starting" }));
  await Effect.runPromise(store.advance("operation-1", { type: "worker_launched" }));
  await Effect.runPromise(store.advance("operation-1", { type: "operation_started" }));
  return storeFailure(store.advance("operation-1", {
    type: "accept_result",
    delivery: {
      operationId: "operation-1",
      body: "finished",
      digest: digest("finished"),
      sequenceNumber: 1,
    },
  }) as Effect.Effect<unknown, StoreError>);
}

test("a failure after writing Result bytes is reported as write_failed", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal((await interruptResultPublication(root)).code, "write_failed");
});

test("a fresh EventStore rejects Result bytes left by interrupted publication", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await interruptResultPublication(root);

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "incomplete_record");
});

test("a reopened EventStore reconstructs Result conflict evidence", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const reopened = new PrivateFileEventStore(root, clock());
  await Effect.runPromise(Effect.either(reopened.advance("operation-1", {
    type: "accept_result",
    delivery: {
      operationId: "operation-1",
      body: "conflicting",
      digest: digest("conflicting"),
      sequenceNumber: 2,
    },
  })));

  const reconstructed = await Effect.runPromise(
    new PrivateFileEventStore(root, clock()).read("operation-1"),
  );

  assert.deepEqual(reconstructed.operation.resultConflict, {
    acceptedDigest: digest("finished"),
    conflictingDigest: digest("conflicting"),
    deliverySequenceNumber: 2,
  });
});

test("conflicting persisted Result events make a record corrupt", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(new PrivateFileEventStore(root, clock()));
  const path = join(root, operationDirectoryKey("operation-1"), "events.v4.json");
  const record = JSON.parse(await readFile(path, "utf8")) as { events: Array<OperationEvent> };
  const original = record.events[3]!;
  const duplicate = { ...original, seq: 5, eventId: "operation-1:5" } as OperationEvent;
  record.events = [
    ...record.events.slice(0, 4),
    duplicate,
    ...record.events.slice(4).map((event) => ({
      ...event,
      seq: event.seq + 1,
      eventId: `operation-1:${event.seq + 1}`,
    })),
  ];
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });

  assert.equal((await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"))).code, "corrupt_record");
});

test("Runtime reports record write failure as a typed persistence failure", async (context) => {
  const root = await privateRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, operationDirectoryKey("operation-1"));
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o500);
  const runtimeClock = clock();
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter({ messages: { body: "finished" } }),
    clock: runtimeClock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new PrivateFileEventStore(root, runtimeClock),
  });

  await assert.rejects(runtime.spawn(task), (error) =>
    error instanceof OperationPersistenceError && error.reason === "write_failed",
  );
});
