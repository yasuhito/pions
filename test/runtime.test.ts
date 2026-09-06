import assert from "node:assert/strict";
import { test } from "node:test";

import { makeRuntime } from "../src/internal/runtime.js";
import {
  FakeAgentBackend,
  FakeChildChannel,
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  InMemoryEventStore,
} from "../src/internal/testing.js";

async function completeOperation() {
  const trace: Array<string> = [];
  const backend = new FakeAgentBackend(trace);
  const channel = new FakeChildChannel({ body: "finished" }, trace);
  const store = new InMemoryEventStore(trace);
  const presentation = new FakePresentation(trace, "completed");
  const runtime = makeRuntime({
    backend,
    channel,
    clock: new FakeClock([
      "2026-09-06T10:00:00.000Z",
      "2026-09-06T10:00:01.000Z",
      "2026-09-06T10:00:02.000Z",
      "2026-09-06T10:00:03.000Z",
      "2026-09-06T10:00:04.000Z",
      "2026-09-06T10:00:05.000Z",
    ]),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation,
    store,
  });

  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });

  return {
    backend,
    handle,
    presentation,
    result: await handle.result(),
    store,
    trace,
  };
}

test("OperationHandle returns the accepted Result", async () => {
  const { result } = await completeOperation();

  assert.deepEqual(result, {
    body: "finished",
    byteCount: 8,
    digest: "sha256:05343e9845302eb730fa9d18ac7b28d5e509893daf1eb76ede8d6e82d47b2da9",
  });
});

test("OperationHandle exposes the Operation identifier", async () => {
  const { handle } = await completeOperation();

  assert.equal(handle.operationId, "operation-1");
});

test("EventStore retains the accepted Result", async () => {
  const { result, store } = await completeOperation();

  assert.deepEqual(store.result("operation-1"), result);
});

test("Runtime starts the AgentBackend once", async () => {
  const { backend } = await completeOperation();

  assert.equal(backend.startCount, 1);
});

test("Runtime records the successful Operation event sequence", async () => {
  const { store } = await completeOperation();

  assert.deepEqual(
    store.events("operation-1").map(({ type }) => type),
    [
      "operation_requested",
      "operation_starting",
      "operation_started",
      "result_persisted",
      "self_settled",
      "operation_completed",
    ],
  );
});

test("Runtime persists result bytes before self-settlement and completion", async () => {
  const { trace } = await completeOperation();

  assert.deepEqual(trace, [
    "event:operation_requested",
    "presentation:queued",
    "event:operation_starting",
    "presentation:starting",
    "backend:start",
    "event:operation_started",
    "presentation:running",
    "channel:receive-result",
    "result:bytes-persisted",
    "event:result_persisted",
    "event:self_settled",
    "event:operation_completed",
    "presentation:completed",
  ]);
});

test("Runtime uses deterministic event sequence numbers and timestamps", async () => {
  const { store } = await completeOperation();

  assert.deepEqual(
    store.events("operation-1").map(({ seq, timestamp }) => ({ seq, timestamp })),
    [
      { seq: 1, timestamp: "2026-09-06T10:00:00.000Z" },
      { seq: 2, timestamp: "2026-09-06T10:00:01.000Z" },
      { seq: 3, timestamp: "2026-09-06T10:00:02.000Z" },
      { seq: 4, timestamp: "2026-09-06T10:00:03.000Z" },
      { seq: 5, timestamp: "2026-09-06T10:00:04.000Z" },
      { seq: 6, timestamp: "2026-09-06T10:00:05.000Z" },
    ],
  );
});

test("Presentation cannot change Operation state", async () => {
  const { presentation } = await completeOperation();

  assert.equal(presentation.stateChangeSucceeded, false);
});

test("Presentation receives the completed Operation projection", async () => {
  const { presentation } = await completeOperation();

  assert.equal(presentation.projections.at(-1)?.state, "completed");
});
