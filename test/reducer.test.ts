import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import {
  advanceTestOperationToRunning,
  FakeClock,
  InMemoryEventStore,
} from "../src/internal/testing.js";
import type { EventStore } from "../src/internal/event-store/index.js";

const requestedConfig = {};
const effectiveConfig = {
  model: { provider: "test", id: "model" },
  thinkingLevel: "medium" as const,
  tools: ["read"],
  cwd: "/work",
  maxResultByteCount: 1024,
  modelPolicy: {
    candidates: [{ provider: "test", id: "model" }],
    attempted: [{ provider: "test", id: "model" }],
    maxAttempts: 1 as const,
    fallback: "forbidden" as const,
    aliases: [],
  },
};

function clock(): FakeClock {
  return new FakeClock(
    Array.from(
      { length: 40 },
      (_, index) => `2026-09-23T00:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
}

async function create(store: EventStore): Promise<void> {
  await Effect.runPromise(
    store.create({
      operationId: "operation-1",
      task: {
        promptRef: "private://prompt",
        profile: "coding",
        idempotencyKey: "task-1",
      },
      requestedConfig,
      effectiveConfig,
      maxResultByteCount: 1024,
    })
  );
}

test("作成したオペレーションは待機状態になる", async () => {
  const store = new InMemoryEventStore([], clock());
  await create(store);
  const snapshot = await Effect.runPromise(store.read("operation-1"));
  assert.equal(snapshot.operation.state, "queued");
});

test("永続状態に旧ライフサイクル領域を持たない", async () => {
  const store = new InMemoryEventStore([], clock());
  await create(store);
  const snapshot = await Effect.runPromise(store.read("operation-1"));
  const oldKeys = [
    "lineage",
    "revisionSeries",
    "resourceEvidenceRecord",
    "externalReviewAllocation",
    "startAuthorizationTiming",
    "startupReceipt",
    "childOperationIds",
  ].filter((key) => key in snapshot.operation);
  assert.deepEqual(oldKeys, []);
});

test("開始確認応答を保存すると実行中になる", async () => {
  const store = new InMemoryEventStore([], clock());
  await create(store);
  await advanceTestOperationToRunning(store, "operation-1");
  const snapshot = await Effect.runPromise(store.read("operation-1"));
  assert.equal(snapshot.operation.state, "running");
});

test("開始受理が確認不能なら状態不明を保存する", async () => {
  const store = new InMemoryEventStore([], clock());
  await create(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "operation_unknown",
      reason: "start-acceptance-unknown",
    })
  );
  const snapshot = await Effect.runPromise(store.read("operation-1"));
  assert.equal(snapshot.operation.terminalReason, "start-acceptance-unknown");
});

test("停止確認済みのキャンセルはキャンセル済みになる", async () => {
  const store = new InMemoryEventStore([], clock());
  await create(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "cancellation_requested",
      cancellationEpoch: 1,
    })
  );
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "cancel_dispatched",
      cancellationEpoch: 1,
    })
  );
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "cancel_acknowledged",
      cancellationEpoch: 1,
      proof: "worker-stop",
    })
  );
  const snapshot = await Effect.runPromise(
    store.advance("operation-1", {
      type: "operation_cancelled",
      cancellationEpoch: 1,
    })
  );
  assert.equal(snapshot.operation.state, "cancelled");
});

test("停止未確認のキャンセルは状態不明になる", async () => {
  const store = new InMemoryEventStore([], clock());
  await create(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "cancellation_requested",
      cancellationEpoch: 1,
    })
  );
  const snapshot = await Effect.runPromise(
    store.advance("operation-1", {
      type: "operation_unknown",
      reason: "cancel-unproven",
      cancellationEpoch: 1,
    })
  );
  assert.equal(snapshot.operation.state, "unknown");
});
