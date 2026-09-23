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
import type { WorkerProfilePolicy } from "../src/internal/types.js";

const profile: WorkerProfilePolicy = {
  modelCandidates: [{ provider: "test", id: "model" }],
  thinkingLevel: "medium",
  tools: ["read"],
  maxResultByteCount: 1024,
};

function runtime() {
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
    store: new InMemoryEventStore(),
    recovery: "disabled",
    configuration: { cwd: "/work", profiles: { coding: profile } },
  });
}

async function completedRuntime() {
  const value = runtime();
  const handle = await value.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  return { value, handle };
}

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
