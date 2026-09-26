import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  InMemoryEventStore,
  makeTestRuntime,
} from "../src/internal/testing.js";
import { makeOperationReader } from "../src/internal/operation-reader.js";
import type { WorkerProfilePolicy } from "../src/internal/types.js";

const profile: WorkerProfilePolicy = {
  modelCandidates: [{ provider: "test", id: "model" }],
  thinkingLevel: "medium",
  tools: ["read"],
  extensions: [],
  maxResultByteCount: 1024,
};

function runtime(store = new InMemoryEventStore()) {
  return makeTestRuntime({
    worker: new FakeWorkerAdapter({ successfulExitConfirmed: true }),
    clock: new FakeClock(
      Array.from(
        { length: 50 },
        (_, index) => `2026-09-23T02:00:${String(index).padStart(2, "0")}.000Z`
      )
    ),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
    recovery: "disabled",
    configuration: { cwd: "/work", profiles: { coding: profile } },
  });
}

async function completedRuntime() {
  const store = new InMemoryEventStore();
  const value = runtime(store);
  const handle = await value.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  return { value, handle, store };
}

test("起動用のランタイムを閉じた後も結果を再取得できる", async () => {
  const { value, handle, store } = await completedRuntime();
  await value.close();
  const reader = await makeOperationReader(store).operation(handle.operationId);
  const outcome = await reader.readResult();
  assert.equal(
    outcome.kind === "retrieved" ? outcome.result.body : undefined,
    "finished"
  );
});

test("起動用のランタイムを閉じた後も状態を取得できる", async () => {
  const { value, handle, store } = await completedRuntime();
  await value.close();
  const reader = await makeOperationReader(store).operation(handle.operationId);
  assert.equal((await reader.read()).state, "completed");
});

test("状態取得は結果本文を含めない", async () => {
  const { value, handle } = await completedRuntime();
  const snapshot = await (await value.operation(handle.operationId)).read();
  assert.equal(JSON.stringify(snapshot).includes('"body":'), false);
});

test("状態取得は縮小後の結果受理診断を返す", async () => {
  const { value, handle } = await completedRuntime();
  const snapshot = await (await value.operation(handle.operationId)).read();
  assert.equal(snapshot.resultAcceptance?.byteCount, 8);
});
