import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Effect } from "effect";

import type { EventStore } from "../src/internal/event-store/index.js";
import { operationDirectoryKey, PrivateFileEventStore } from "../src/internal/event-store/index.js";
import { FakeClock, InMemoryEventStore } from "../src/internal/testing.js";
import {
  effectiveConfig,
  requestedConfig,
  retentionPolicy,
  workProductRequirements,
} from "./worker-protocol-fixtures.js";

const task = { promptRef: "private://prompt/1", profile: "coding", idempotencyKey: "task-1" };
function clock() {
  return new FakeClock(Array.from({ length: 20 }, (_, index) =>
    `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`,
  ));
}
async function root(context: TestContext) {
  const path = join(tmpdir(), `pions-event-store-${crypto.randomUUID()}`);
  await mkdir(path, { mode: 0o700 });
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function create(store: EventStore, operationId = "operation-1") {
  return Effect.runPromise(store.create({
    operationId,
    task,
    requestedConfig,
    effectiveConfig,
    workProductRequirements,
    resultRetentionPolicy: retentionPolicy(operationId),
    lineage: { rootOperationId: operationId, depth: 0 },
    startAuthorization: { configuredPolicy: "disabled", policy: "disabled", windowMs: 0, authorizedSubjectIds: [] },
  }));
}
async function running(store: EventStore, operationId = "operation-1") {
  await create(store, operationId);
  await Effect.runPromise(store.advance(operationId, { type: "operation_starting" }));
  await Effect.runPromise(store.advance(operationId, { type: "worker_launched" }));
  await Effect.runPromise(store.advance(operationId, { type: "automatic_operation_started" }));
}
async function failure(effect: Effect.Effect<unknown, { readonly code: string }>) {
  return Effect.runPromise(Effect.flip(effect));
}

test("memory Event Store creates a queued Operation", async () => {
  const snapshot = await create(new InMemoryEventStore([], clock()));
  assert.equal(snapshot.operation.state, "queued");
});

test("file Event Store reconstructs a running Operation after restart", async (context) => {
  const directory = await root(context);
  await running(new PrivateFileEventStore(directory, clock()));
  const reopened = new PrivateFileEventStore(directory, clock());
  assert.equal((await Effect.runPromise(reopened.read("operation-1"))).operation.state, "running");
});

test("Operation identifiers are not used as record paths", async (context) => {
  const directory = await root(context);
  await create(new PrivateFileEventStore(directory, clock()), "../private-operation");
  assert.equal((await readFile(join(directory, operationDirectoryKey("../private-operation"), "events.v14.json"))).byteLength > 0, true);
});

test("an unsupported record schema is rejected", async (context) => {
  const directory = await root(context);
  await create(new PrivateFileEventStore(directory, clock()));
  const path = join(directory, operationDirectoryKey("operation-1"), "events.v14.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  record.schemaVersion = 11;
  await writeFile(path, JSON.stringify(record));
  assert.equal((await failure(new PrivateFileEventStore(directory, clock()).read("operation-1"))).code, "unsupported_schema");
});

test("an unsupported event schema is rejected", async (context) => {
  const directory = await root(context);
  await create(new PrivateFileEventStore(directory, clock()));
  const path = join(directory, operationDirectoryKey("operation-1"), "events.v14.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  record.events[0].schemaVersion = 11;
  await writeFile(path, JSON.stringify(record));
  assert.equal((await failure(new PrivateFileEventStore(directory, clock()).read("operation-1"))).code, "unsupported_schema");
});

test("an old Event Store root is not initialized as the current schema", async (context) => {
  const directory = await root(context);
  const operationDirectory = join(directory, operationDirectoryKey("operation-1"));
  await mkdir(operationDirectory);
  await writeFile(join(operationDirectory, "events.v12.json"), "{}\n");
  assert.equal((await failure(new PrivateFileEventStore(directory, clock()).read("operation-1"))).code, "unsupported_schema");
});
