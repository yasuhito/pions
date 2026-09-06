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

test("Runtime completes one operation only after accepting its result", async () => {
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
  const result = await handle.result();

  assert.deepEqual(result, {
    body: "finished",
    byteCount: 8,
    digest: "sha256:05343e9845302eb730fa9d18ac7b28d5e509893daf1eb76ede8d6e82d47b2da9",
  });
  assert.equal(handle.operationId, "operation-1");
  assert.deepEqual(store.result("operation-1"), result);
  assert.equal(backend.startCount, 1);
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
  assert.equal(presentation.stateChangeSucceeded, false);
  assert.equal(presentation.projections.at(-1)?.state, "completed");
});
