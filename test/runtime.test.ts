import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  Effect,
  ManagedRuntime,
  TestClock,
  TestContext,
} from "effect";

import { makeRuntime } from "../src/internal/runtime.js";
import {
  CancellationRejectedError,
  OperationCancelledError,
  OperationFailedError,
  ResultConflictError,
  SpawnRejectedError,
} from "../src/index.js";
import type { Operation } from "../src/internal/event-store/index.js";
import type { ResultDelivery } from "../src/internal/worker-protocol.js";
import type {
  BackendCancellationEvidence,
  ChildChannel,
  RuntimeClock,
} from "../src/internal/services.js";
import {
  FakeAgentBackend,
  FakeChildChannel,
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  InMemoryEventStore,
} from "../src/internal/testing.js";

class ControlledCancellationBackend extends FakeAgentBackend {
  readonly cancelTrace: Array<string> = [];
  private readonly responders = new Map<
    string,
    (effect: Effect.Effect<BackendCancellationEvidence>) => void
  >();

  override cancel(
    operation: Operation,
    cancellationEpoch: number,
  ): Effect.Effect<BackendCancellationEvidence> {
    return Effect.async((resume) => {
      this.cancelTrace.push(`${operation.operationId}:${cancellationEpoch}`);
      this.responders.set(operation.operationId, resume);
    });
  }

  acknowledge(operationId: string): void {
    const resume = this.responders.get(operationId);
    if (resume === undefined) {
      throw new Error(`No cancellation for ${operationId}`);
    }
    resume(Effect.succeed({ proof: "acknowledgement" }));
  }
}

class ControlledTestClock implements RuntimeClock {
  private readonly runtime = ManagedRuntime.make(TestContext.TestContext);
  private timestampIndex = 0;

  constructor(private readonly timestamps: ReadonlyArray<string>) {}

  now(): Effect.Effect<string> {
    return Effect.sync(() => {
      const timestamp = this.timestamps[this.timestampIndex++];
      if (timestamp === undefined) throw new Error("TestClock exhausted");
      return timestamp;
    });
  }

  sleep(milliseconds: number): Effect.Effect<void> {
    return Effect.promise(() =>
      this.runtime.runPromise(TestClock.sleep(milliseconds)),
    );
  }

  advanceBy(milliseconds: number): Promise<void> {
    return this.runtime.runPromise(TestClock.adjust(milliseconds));
  }
}

class FailingResultChannel implements ChildChannel {
  receiveStarted(_operation: Operation) {
    return Effect.succeed({ processInstanceId: "failed-process-instance" });
  }

  receiveResults(_operationId: string) {
    return Effect.fail({ _tag: "ChannelError" as const, message: "disconnected" });
  }

  acknowledgeResult() {
    return Effect.void;
  }
}

class FailingAcknowledgementChannel extends FakeChildChannel {
  constructor() {
    super({ body: "accepted" });
  }

  override acknowledgeResult() {
    return Effect.fail({
      _tag: "ChannelError" as const,
      message: "acknowledgement failed",
    });
  }
}

class ControlledChildChannel implements ChildChannel {
  private readonly receivers = new Map<
    string,
    (effect: Effect.Effect<{
      readonly deliveries: ReadonlyArray<ResultDelivery>;
    }>) => void
  >();

  receiveStarted(operation: Operation) {
    return Effect.succeed({ processInstanceId: `process:${operation.operationId}` });
  }

  receiveResults(operationId: string) {
    return Effect.async<{
      readonly deliveries: ReadonlyArray<ResultDelivery>;
    }>((resume) => {
      this.receivers.set(operationId, resume);
    });
  }

  acknowledgeResult(): Effect.Effect<void> {
    return Effect.void;
  }

  deliver(operationId: string, body = "finished"): void {
    const resume = this.receivers.get(operationId);
    if (resume === undefined) throw new Error(`No receiver for ${operationId}`);
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}` as const;
    resume(Effect.succeed({
      deliveries: [{ body, digest, sequenceNumber: 1 }],
    }));
  }
}

async function waitForReceiver(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function storedOperation(store: InMemoryEventStore, operationId: string) {
  return (await Effect.runPromise(store.read(operationId))).operation;
}

function operationEvents(trace: ReadonlyArray<string>, operationId: string) {
  return trace
    .filter((entry) => entry.startsWith("event:"))
    .map((entry) => JSON.parse(entry.slice("event:".length)) as {
      readonly operationId: string;
      readonly type: string;
      readonly seq: number;
      readonly timestamp: string;
    })
    .filter((event) => event.operationId === operationId);
}

async function completeOperation(
  messages: ConstructorParameters<typeof FakeChildChannel>[0] = {
    body: "finished",
  },
  presentationFails = false,
) {
  const trace: Array<string> = [];
  const backend = new FakeAgentBackend(trace);
  const channel = new FakeChildChannel(messages, trace);
  const clock = new FakeClock([
    "2026-09-06T10:00:00.000Z",
    "2026-09-06T10:00:01.000Z",
    "2026-09-06T10:00:02.000Z",
    "2026-09-06T10:00:03.000Z",
    "2026-09-06T10:00:04.000Z",
    "2026-09-06T10:00:05.000Z",
    "2026-09-06T10:00:06.000Z",
    "2026-09-06T10:00:07.000Z",
    "2026-09-06T10:00:08.000Z",
  ]);
  const store = new InMemoryEventStore(trace, clock);
  const presentation = new FakePresentation(
    trace,
    "completed",
    presentationFails,
  );
  const runtime = makeRuntime({
    backend,
    channel,
    clock,
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

test("each Operation records root, parent, and depth lineage", async () => {
  const channel = new ControlledChildChannel();
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    backend: new FakeAgentBackend(),
    channel,
    clock: new FakeClock(Array.from({ length: 30 }, (_, index) =>
      `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`,
    )),
    ids: new FakeIdGenerator(["root", "child", "grandchild"]),
    presentation: new FakePresentation(),
    store,
  });

  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  const child = await runtime.spawn(
    { promptRef: "child", profile: "coding", idempotencyKey: "child" },
    { parentOperationId: root.operationId },
  );
  const grandchild = await runtime.spawn(
    { promptRef: "grandchild", profile: "coding", idempotencyKey: "grandchild" },
    { parentOperationId: child.operationId },
  );

  assert.deepEqual(
    await Promise.all(
      [root, child, grandchild].map(async ({ operationId }) =>
        (await storedOperation(store, operationId)).lineage,
      ),
    ),
    [
      { rootOperationId: "root", depth: 0 },
      { rootOperationId: "root", parentOperationId: "root", depth: 1 },
      { rootOperationId: "root", parentOperationId: "child", depth: 2 },
    ],
  );
});

function nestedRuntime(operationIds: ReadonlyArray<string>) {
  const backend = new FakeAgentBackend();
  const channel = new ControlledChildChannel();
  const ids = new FakeIdGenerator(operationIds);
  const presentation = new FakePresentation();
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    backend,
    channel,
    clock: new FakeClock(
      Array.from({ length: 100 }, (_, index) =>
        `2026-09-06T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      ),
    ),
    ids,
    presentation,
    store,
  });
  return { backend, channel, ids, presentation, runtime, store };
}

async function spawnNested(
  runtime: ReturnType<typeof makeRuntime>,
  parentOperationId: string,
  key: string,
) {
  return runtime.spawn(
    { promptRef: key, profile: "coding", idempotencyKey: key },
    { parentOperationId },
  );
}

function cancellableNestedRuntime(operationIds: ReadonlyArray<string>) {
  const backend = new ControlledCancellationBackend();
  const channel = new ControlledChildChannel();
  const clock = new ControlledTestClock(
    Array.from({ length: 100 }, (_, index) => `cancel-time-${index}`),
  );
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(trace);
  const runtime = makeRuntime({
    backend,
    channel,
    clock,
    ids: new FakeIdGenerator(operationIds),
    presentation: new FakePresentation(),
    store,
  });
  return { backend, channel, clock, runtime, store, trace };
}

async function spawnCancellationTree() {
  const fixture = cancellableNestedRuntime(["root", "child", "grandchild"]);
  const root = await fixture.runtime.spawn({
    promptRef: "root",
    profile: "coding",
    idempotencyKey: "root",
  });
  const child = await spawnNested(fixture.runtime, root.operationId, "child");
  const grandchild = await spawnNested(
    fixture.runtime,
    child.operationId,
    "grandchild",
  );
  await waitForReceiver();
  return { ...fixture, child, grandchild, root };
}

test("subtree cancellation freezes new descendants before dispatch", async () => {
  const { clock, root, runtime } = await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  const rejection = assert.rejects(
    spawnNested(runtime, root.operationId, "late-child"),
    (error) =>
      error instanceof SpawnRejectedError &&
      error.reason === "cancellation_in_progress",
  );
  await waitForReceiver();
  await clock.advanceBy(1_000);
  await cancellation;

  await rejection;
});

test("cancellation remains the outcome when Result acceptance loses the persistence race", async () => {
  const { backend, channel, runtime } = cancellableNestedRuntime(["root"]);
  const root = await runtime.spawn({
    promptRef: "root",
    profile: "coding",
    idempotencyKey: "root",
  });
  await waitForReceiver();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  channel.deliver(root.operationId);
  await waitForReceiver();
  backend.acknowledge(root.operationId);
  await cancellation;

  await assert.rejects(
    root.result(),
    (error) => error instanceof OperationCancelledError,
  );
});

test("subtree cancellation dispatches from grandchild to parent", async () => {
  const { backend, clock, root } = await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  await clock.advanceBy(1_000);
  await cancellation;

  assert.deepEqual(backend.cancelTrace, ["grandchild:1", "child:1", "root:1"]);
});

test("acknowledged subtree cancellation ends as cancelled", async () => {
  const { backend, child, clock, grandchild, root, store } =
    await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  backend.acknowledge(grandchild.operationId);
  backend.acknowledge(child.operationId);
  backend.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  assert.equal((await storedOperation(store, root.operationId)).state, "cancelled");
});

test("an unproven descendant makes subtree cancellation unknown", async () => {
  const { backend, clock, grandchild, root, store } =
    await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  backend.acknowledge(grandchild.operationId);
  backend.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  assert.deepEqual(
    [
      (await storedOperation(store, root.operationId)).state,
      (await storedOperation(store, root.operationId)).terminalReason,
    ],
    ["unknown", "cancel-unproven"],
  );
});

test("an acknowledged parent retains its evidence when a descendant is unproven", async () => {
  const { backend, clock, grandchild, root, trace } =
    await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  backend.acknowledge(grandchild.operationId);
  backend.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  assert.deepEqual(
    operationEvents(trace, root.operationId).slice(-2).map(({ type }) => type),
    ["cancel_acknowledged", "operation_unknown"],
  );
});

test("retrying one cancellation epoch is idempotent", async () => {
  const { backend, child, clock, grandchild, root } =
    await spawnCancellationTree();
  const first = root.cancel({ scope: "subtree", cancellationEpoch: 1 });
  const retry = root.cancel({ scope: "subtree", cancellationEpoch: 1 });
  await waitForReceiver();
  backend.acknowledge(grandchild.operationId);
  backend.acknowledge(child.operationId);
  backend.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await first;

  assert.equal(first, retry);
});

test("Runtime rejects an older cancellation epoch", async () => {
  const { backend, child, clock, grandchild, root } =
    await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree", cancellationEpoch: 1 });
  await waitForReceiver();
  backend.acknowledge(grandchild.operationId);
  backend.acknowledge(child.operationId);
  backend.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  await assert.rejects(
    root.cancel({ scope: "subtree", cancellationEpoch: 0 }),
    (error: unknown) =>
      error instanceof CancellationRejectedError && error.reason === "stale_epoch",
  );
});

test("subtree cancellation preserves an already completed descendant", async () => {
  const { backend, channel, child, clock, grandchild, root, store } =
    await spawnCancellationTree();
  channel.deliver(grandchild.operationId);
  await grandchild.result();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  backend.acknowledge(child.operationId);
  backend.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  assert.equal((await storedOperation(store, grandchild.operationId)).state, "completed");
});

test("a self-settled parent drains while its child is still running", async () => {
  const { channel, runtime, store } = nestedRuntime(["root", "child"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  await spawnNested(runtime, root.operationId, "child");
  await waitForReceiver();

  channel.deliver(root.operationId);
  await waitForReceiver();

  assert.equal((await storedOperation(store, root.operationId)).state, "draining_descendants");
});

test("a parent completes after its child result handoff terminates", async () => {
  const { channel, runtime, store } = nestedRuntime(["root", "child"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  const child = await spawnNested(runtime, root.operationId, "child");
  await waitForReceiver();
  channel.deliver(root.operationId);
  channel.deliver(child.operationId);
  await Promise.all([root.result(), child.result()]);

  assert.equal((await storedOperation(store, root.operationId)).state, "completed");
});

test("a grandparent completes only after its grandchild terminates", async () => {
  const { channel, runtime, store } = nestedRuntime(["root", "child", "grandchild"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  const child = await spawnNested(runtime, root.operationId, "child");
  const grandchild = await spawnNested(runtime, child.operationId, "grandchild");
  await waitForReceiver();
  channel.deliver(root.operationId);
  channel.deliver(child.operationId);
  await waitForReceiver();

  const beforeGrandchild = (await storedOperation(store, root.operationId)).state;
  channel.deliver(grandchild.operationId);
  await Promise.all([root.result(), child.result(), grandchild.result()]);

  assert.equal(beforeGrandchild, "draining_descendants");
});

test("the default descendant failure policy fails a successful parent", async () => {
  const channel = new ControlledChildChannel();
  const store = new InMemoryEventStore();
  const backend = {
    start(operation: Operation) {
      return operation.operationId === "child"
        ? Effect.fail({
            _tag: "BackendError" as const,
            reason: "backend_start_failed" as const,
            message: "child failed",
          })
        : Effect.void;
    },
    cancel() {
      return Effect.succeed({ proof: "backend-stop" as const });
    },
  };
  const runtime = makeRuntime({
    backend,
    channel,
    clock: new FakeClock(Array.from({ length: 30 }, (_, index) => `time-${index}`)),
    ids: new FakeIdGenerator(["root", "child"]),
    presentation: new FakePresentation(),
    store,
  });
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  await spawnNested(runtime, root.operationId, "child");
  await waitForReceiver();
  channel.deliver(root.operationId);

  await assert.rejects(
    root.result(),
    (error) =>
      error instanceof OperationFailedError && error.reason === "descendant_failed",
  );
});

test("Runtime rejects a child beyond depth two", async () => {
  const { runtime } = nestedRuntime(["root", "child", "grandchild"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  const child = await spawnNested(runtime, root.operationId, "child");
  const grandchild = await spawnNested(runtime, child.operationId, "grandchild");

  await assert.rejects(
    spawnNested(runtime, grandchild.operationId, "great-grandchild"),
    (error) =>
      error instanceof SpawnRejectedError && error.reason === "depth_limit_exceeded",
  );
});

test("Runtime rejects a fourth child of one parent", async () => {
  const { runtime } = nestedRuntime(["root", "child-1", "child-2", "child-3"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  await Promise.all([
    spawnNested(runtime, root.operationId, "child-1"),
    spawnNested(runtime, root.operationId, "child-2"),
    spawnNested(runtime, root.operationId, "child-3"),
  ]);

  await assert.rejects(
    spawnNested(runtime, root.operationId, "child-4"),
    (error) =>
      error instanceof SpawnRejectedError && error.reason === "child_limit_exceeded",
  );
});

test("Runtime rejects a fifth live descendant of one root", async () => {
  const { runtime } = nestedRuntime(["root", "child-1", "child-2", "child-3", "grandchild"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  const children = await Promise.all([
    spawnNested(runtime, root.operationId, "child-1"),
    spawnNested(runtime, root.operationId, "child-2"),
    spawnNested(runtime, root.operationId, "child-3"),
  ]);
  await spawnNested(runtime, children[0]?.operationId ?? "missing", "grandchild");

  await assert.rejects(
    spawnNested(runtime, children[1]?.operationId ?? "missing", "fifth"),
    (error) =>
      error instanceof SpawnRejectedError &&
      error.reason === "live_descendant_limit_exceeded",
  );
});

test("a rejected child creates no identifier, backend, or Presentation resource", async () => {
  const { backend, ids, presentation, runtime } = nestedRuntime([
    "root",
    "child-1",
    "child-2",
    "child-3",
  ]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  await Promise.all([
    spawnNested(runtime, root.operationId, "child-1"),
    spawnNested(runtime, root.operationId, "child-2"),
    spawnNested(runtime, root.operationId, "child-3"),
  ]);
  await waitForReceiver();
  const before = [ids.issuedCount, backend.startCount, presentation.projections.length];
  await spawnNested(runtime, root.operationId, "child-4").catch(() => undefined);
  await waitForReceiver();

  assert.deepEqual(
    [ids.issuedCount, backend.startCount, presentation.projections.length],
    before,
  );
});

test("retrying the same child acceptance returns one child", async () => {
  const { runtime } = nestedRuntime(["root", "child"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  const children = await Promise.all([
    spawnNested(runtime, root.operationId, "child"),
    spawnNested(runtime, root.operationId, "child"),
  ]);

  assert.equal(children[0], children[1]);
});

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

test("Runtime starts the AgentBackend once", async () => {
  const { backend } = await completeOperation();

  assert.equal(backend.startCount, 1);
});

test("Operation records the worker process instance identity", async () => {
  const { store } = await completeOperation();

  assert.equal((await storedOperation(store, "operation-1")).workerIdentity?.processInstanceId, "fake-process-instance");
});

test("Operation records the worker's owned pane identity", async () => {
  const { store } = await completeOperation();

  assert.equal((await storedOperation(store, "operation-1")).workerIdentity?.paneId, "fake-pane:operation-1");
});

test("Runtime records the successful Operation event sequence", async () => {
  const { trace } = await completeOperation();

  assert.deepEqual(
    operationEvents(trace, "operation-1").map(({ type }) => type),
    [
      "operation_requested",
      "presentation_owned",
      "operation_starting",
      "operation_started",
      "worker_identified",
      "result_persisted",
      "self_settled",
      "operation_completed",
    ],
  );
});

test("Runtime uses deterministic event sequence numbers and timestamps", async () => {
  const { trace } = await completeOperation();

  assert.deepEqual(
    operationEvents(trace, "operation-1").map(({ seq, timestamp }) => ({ seq, timestamp })),
    [
      { seq: 1, timestamp: "2026-09-06T10:00:00.000Z" },
      { seq: 2, timestamp: "2026-09-06T10:00:01.000Z" },
      { seq: 3, timestamp: "2026-09-06T10:00:02.000Z" },
      { seq: 4, timestamp: "2026-09-06T10:00:03.000Z" },
      { seq: 5, timestamp: "2026-09-06T10:00:04.000Z" },
      { seq: 6, timestamp: "2026-09-06T10:00:05.000Z" },
      { seq: 7, timestamp: "2026-09-06T10:00:06.000Z" },
      { seq: 8, timestamp: "2026-09-06T10:00:07.000Z" },
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

  assert.equal((await storedOperation(store, "operation-1")).state, "completed");
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
      "2026-09-06T10:00:06.000Z",
      "2026-09-06T10:00:07.000Z",
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
  await handles[0]?.result();

  return { backend, handles };
}

test("Runtime returns the same OperationHandle for an idempotent spawn", async () => {
  const { handles } = await retryOperation();

  assert.equal(handles[0], handles[1]);
});

test("Runtime starts the AgentBackend once for an idempotent spawn", async () => {
  const { backend } = await retryOperation();

  assert.equal(backend.startCount, 1);
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
      "2026-09-06T10:00:06.000Z",
      "2026-09-06T10:00:07.000Z",
      "2026-09-06T10:00:08.000Z",
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
  await handle.result().catch(() => undefined);

  return store;
}

test("a conflicting Result does not overwrite terminal completion", async () => {
  const store = await conflictResult();

  assert.equal((await storedOperation(store, "operation-1")).state, "completed");
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
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(trace);
  const runtime = makeRuntime({
    backend: new FakeAgentBackend(trace, {
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
      "2026-09-06T10:00:04.000Z",
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
  await handle.result().catch(() => undefined);

  return { handle, store, trace };
}

test("a ChildChannel failure is durably classified without fake completion", async () => {
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    backend: new FakeAgentBackend(),
    channel: new FailingResultChannel(),
    clock: new FakeClock(Array.from({ length: 10 }, (_, index) => `failure-time-${index}`)),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
  });
  const handle = await runtime.spawn({ promptRef: "prompt", profile: "coding", idempotencyKey: "task" });
  await handle.result().catch(() => undefined);

  assert.equal((await storedOperation(store, "operation-1")).terminalReason, "worker_protocol_failed");
});

test("an acknowledgement failure is durably classified", async () => {
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    backend: new FakeAgentBackend(),
    channel: new FailingAcknowledgementChannel(),
    clock: new FakeClock(Array.from({ length: 10 }, (_, index) => `failure-time-${index}`)),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
  });
  const handle = await runtime.spawn({ promptRef: "prompt", profile: "coding", idempotencyKey: "task" });
  await handle.result().catch(() => undefined);

  assert.equal((await storedOperation(store, "operation-1")).terminalReason, "worker_protocol_failed");
});

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
  const { trace } = await failOperation();

  assert.deepEqual(
    operationEvents(trace, "operation-1").map(({ type }) => type),
    [
      "operation_requested",
      "presentation_owned",
      "operation_starting",
      "self_settled",
      "operation_failed",
    ],
  );
});

test("backend failure does not publish a successful Result", async () => {
  const { store } = await failOperation();

  assert.equal((await Effect.runPromise(store.read("operation-1"))).result, undefined);
});
