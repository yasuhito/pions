import assert from "node:assert/strict";
import { test } from "node:test";

import { makeRuntime } from "../src/internal/runtime.js";
import {
  OperationFailedError,
  ResultConflictError,
} from "../src/index.js";
import {
  FakeAgentBackend,
  FakeChildChannel,
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  InMemoryEventStore,
} from "../src/internal/testing.js";

async function completeOperation(
  messages: ConstructorParameters<typeof FakeChildChannel>[0] = {
    body: "finished",
  },
  presentationFails = false,
) {
  const trace: Array<string> = [];
  const backend = new FakeAgentBackend(trace);
  const channel = new FakeChildChannel(messages, trace);
  const store = new InMemoryEventStore(trace);
  const presentation = new FakePresentation(
    trace,
    "completed",
    presentationFails,
  );
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

test("Presentation failure cannot prevent terminal completion", async () => {
  const { store } = await completeOperation({ body: "finished" }, true);

  assert.equal(store.events("operation-1").at(-1)?.type, "operation_completed");
});

async function retryOperation(options?: { readonly parentOperationId?: string }) {
  const backend = new FakeAgentBackend();
  const runtime = makeRuntime({
    backend,
    channel: new FakeChildChannel({ body: "finished" }),
    clock: new FakeClock([
      "2026-09-06T10:00:00.000Z",
      "2026-09-06T10:00:01.000Z",
      "2026-09-06T10:00:02.000Z",
      "2026-09-06T10:00:03.000Z",
      "2026-09-06T10:00:04.000Z",
      "2026-09-06T10:00:05.000Z",
    ]),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore(),
  });
  const task = {
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  };

  const handles = await Promise.all([
    runtime.spawn(task, options),
    runtime.spawn(task, options),
  ]);

  return { backend, handles };
}

test("Runtime returns the same OperationHandle for an idempotent spawn", async () => {
  const { handles } = await retryOperation({ parentOperationId: "parent-1" });

  assert.equal(handles[0], handles[1]);
});

test("Runtime starts the AgentBackend once for an idempotent spawn", async () => {
  const { backend } = await retryOperation({ parentOperationId: "parent-1" });

  assert.equal(backend.startCount, 1);
});

test("Runtime publishes one event sequence for a duplicate Result delivery", async () => {
  const { store } = await completeOperation([
    { body: "finished", sequenceNumber: 1 },
    { body: "finished", sequenceNumber: 1 },
  ]);

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

test("Runtime rejects a conflicting Result with a typed error", async () => {
  await assert.rejects(
    completeOperation([
      { body: "finished", sequenceNumber: 1 },
      { body: "conflicting", sequenceNumber: 1 },
    ]),
    (error) => error instanceof ResultConflictError,
  );
});

async function conflictResult() {
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    backend: new FakeAgentBackend(),
    channel: new FakeChildChannel([
      { body: "finished", sequenceNumber: 1 },
      { body: "conflicting", sequenceNumber: 1 },
    ]),
    clock: new FakeClock([
      "2026-09-06T10:00:00.000Z",
      "2026-09-06T10:00:01.000Z",
      "2026-09-06T10:00:02.000Z",
      "2026-09-06T10:00:03.000Z",
      "2026-09-06T10:00:04.000Z",
      "2026-09-06T10:00:05.000Z",
    ]),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
  });

  await runtime
    .spawn({
      promptRef: "private://prompt/1",
      profile: "coding",
      idempotencyKey: "task-1",
    })
    .catch(() => undefined);

  return store;
}

test("a conflicting Result does not overwrite the accepted Result", async () => {
  const store = await conflictResult();

  assert.equal(store.result("operation-1")?.body, "finished");
});

test("a conflicting Result does not overwrite terminal completion", async () => {
  const store = await conflictResult();

  assert.equal(store.events("operation-1").at(-1)?.type, "operation_completed");
});

test("OperationHandle returns the same Result without republishing it", async () => {
  const { handle } = await completeOperation();

  const results = await Promise.all([handle.result(), handle.result()]);

  assert.deepEqual(results, [
    {
      body: "finished",
      byteCount: 8,
      digest: "sha256:05343e9845302eb730fa9d18ac7b28d5e509893daf1eb76ede8d6e82d47b2da9",
    },
    {
      body: "finished",
      byteCount: 8,
      digest: "sha256:05343e9845302eb730fa9d18ac7b28d5e509893daf1eb76ede8d6e82d47b2da9",
    },
  ]);
});

async function failOperation() {
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    backend: new FakeAgentBackend([], {
      _tag: "BackendError",
      reason: "backend_start_failed",
      message: "worker executable unavailable",
    }),
    channel: new FakeChildChannel({ body: "must not be returned" }),
    clock: new FakeClock([
      "2026-09-06T10:00:00.000Z",
      "2026-09-06T10:00:01.000Z",
      "2026-09-06T10:00:02.000Z",
      "2026-09-06T10:00:03.000Z",
    ]),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });

  return { handle, store };
}

test("OperationHandle reports backend failure as a bounded typed failure", async () => {
  const { handle } = await failOperation();

  await assert.rejects(
    handle.result(),
    (error) =>
      error instanceof OperationFailedError &&
      error.reason === "backend_start_failed",
  );
});

test("backend failure records the failed terminal result", async () => {
  const { store } = await failOperation();

  assert.deepEqual(
    store.events("operation-1").map(({ type }) => type),
    [
      "operation_requested",
      "operation_starting",
      "self_settled",
      "operation_failed",
    ],
  );
});

test("backend failure does not publish a successful Result", async () => {
  const { store } = await failOperation();

  assert.equal(store.result("operation-1"), undefined);
});

test("EventStore rebuilds the failed snapshot from accepted events", async () => {
  const { store } = await failOperation();

  assert.deepEqual(store.rebuild("operation-1"), store.snapshot("operation-1"));
});

test("EventStore rebuilds the accepted failure reason", async () => {
  const { store } = await failOperation();

  assert.equal(store.rebuild("operation-1")?.terminalReason, "backend_start_failed");
});
