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
  OperationPersistenceError,
  ResultConflictError,
  SpawnRejectedError,
} from "../src/index.js";
import type { Operation } from "../src/internal/event-store/index.js";
import type { ResultDelivery } from "../src/internal/worker-protocol.js";
import {
  acknowledgeResultAcceptance,
  makeSingleRunWorker,
} from "../src/internal/services.js";
import type {
  WorkerCancellationEvidence,
  RuntimeClock,
  Worker,
  WorkerRunHooks,
  WorkerRunOutcome,
  WorkerAdapter,
} from "../src/internal/services.js";
import {
  FakeWorkerAdapter,
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  InMemoryEventStore,
} from "../src/internal/testing.js";
import type { FakeWorkerAdapterOptions } from "../src/internal/testing.js";

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

class ControlledWorkerAdapter implements WorkerAdapter {
  startCount = 0;
  readonly cancelTrace: Array<string> = [];
  private readonly receivers = new Map<
    string,
    (effect: Effect.Effect<ReadonlyArray<ResultDelivery>>) => void
  >();
  private readonly cancellationResponders = new Map<
    string,
    (effect: Effect.Effect<WorkerCancellationEvidence | undefined>) => void
  >();

  open(operation: Operation): Worker {
    return makeSingleRunWorker({
      run: (hooks) => this.run(operation, hooks),
      cancel: (cancellationEpoch) => Effect.async((resume) => {
        this.cancelTrace.push(`${operation.operationId}:${cancellationEpoch}`);
        this.cancellationResponders.set(operation.operationId, resume);
      }),
    });
  }

  protected run(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>,
  ): Effect.Effect<
    WorkerRunOutcome,
    OperationPersistenceError | ResultConflictError
  > {
    return Effect.gen(this, function* () {
      this.startCount += 1;
      yield* hooks.workerLaunched();
      yield* hooks.workerIdentified({ processInstanceId: `process:${operation.operationId}` });
      const deliveries = yield* Effect.async<ReadonlyArray<ResultDelivery>>((resume) => {
        this.receivers.set(operation.operationId, resume);
      });
      const acceptance = yield* hooks.acceptResults(deliveries);
      return yield* acknowledgeResultAcceptance(
        acceptance,
        () => Effect.void,
      );
    });
  }

  deliver(operationId: string, body = "finished"): void {
    const resume = this.receivers.get(operationId);
    if (resume === undefined) throw new Error(`No receiver for ${operationId}`);
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}` as const;
    resume(Effect.succeed([{ operationId, body, digest, sequenceNumber: 1 }]));
  }

  acknowledge(operationId: string): void {
    const resume = this.cancellationResponders.get(operationId);
    if (resume === undefined) throw new Error(`No cancellation for ${operationId}`);
    resume(Effect.succeed({ proof: "acknowledgement" }));
  }
}

class FailingChildWorkerAdapter extends ControlledWorkerAdapter {
  protected override run(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>,
  ): Effect.Effect<
    WorkerRunOutcome,
    OperationPersistenceError | ResultConflictError
  > {
    if (operation.operationId === "child") {
      this.startCount += 1;
      return Effect.succeed({ state: "worker_start_failed" });
    }
    return super.run(operation, hooks);
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
  messages: NonNullable<FakeWorkerAdapterOptions["messages"]> = {
    body: "finished",
  },
  presentationFails = false,
) {
  const trace: Array<string> = [];
  const worker = new FakeWorkerAdapter({ messages, trace });
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
    "2026-09-06T10:00:09.000Z",
  ]);
  const store = new InMemoryEventStore(trace, clock);
  const presentation = new FakePresentation(
    trace,
    "completed",
    presentationFails,
  );
  const runtime = makeRuntime({
    worker,
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
    worker,
    handle,
    presentation,
    result: await handle.result(),
    store,
    trace,
  };
}

test("each Operation records root, parent, and depth lineage", async () => {
  const worker = new ControlledWorkerAdapter();
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    worker,
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
  const worker = new ControlledWorkerAdapter();
  const ids = new FakeIdGenerator(operationIds);
  const presentation = new FakePresentation();
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    worker,
    clock: new FakeClock(
      Array.from({ length: 100 }, (_, index) =>
        `2026-09-06T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      ),
    ),
    ids,
    presentation,
    store,
  });
  return { ids, presentation, runtime, store, worker };
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
  const worker = new ControlledWorkerAdapter();
  const clock = new ControlledTestClock(
    Array.from({ length: 100 }, (_, index) => `cancel-time-${index}`),
  );
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(trace);
  const runtime = makeRuntime({
    worker,
    clock,
    ids: new FakeIdGenerator(operationIds),
    presentation: new FakePresentation(),
    store,
  });
  return { clock, runtime, store, trace, worker };
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
  const { runtime, worker } = cancellableNestedRuntime(["root"]);
  const root = await runtime.spawn({
    promptRef: "root",
    profile: "coding",
    idempotencyKey: "root",
  });
  await waitForReceiver();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  worker.deliver(root.operationId);
  await waitForReceiver();
  worker.acknowledge(root.operationId);
  await cancellation;

  await assert.rejects(
    root.result(),
    (error) => error instanceof OperationCancelledError,
  );
});

test("subtree cancellation dispatches from grandchild to parent", async () => {
  const { clock, root, worker } = await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  await clock.advanceBy(1_000);
  await cancellation;

  assert.deepEqual(worker.cancelTrace, ["grandchild:1", "child:1", "root:1"]);
});

test("acknowledged subtree cancellation ends as cancelled", async () => {
  const { child, clock, grandchild, root, store, worker } =
    await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  worker.acknowledge(grandchild.operationId);
  worker.acknowledge(child.operationId);
  worker.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  assert.equal((await storedOperation(store, root.operationId)).state, "cancelled");
});

test("an unproven descendant makes subtree cancellation unknown", async () => {
  const { clock, grandchild, root, store, worker } =
    await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  worker.acknowledge(grandchild.operationId);
  worker.acknowledge(root.operationId);
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
  const { clock, grandchild, root, trace, worker } =
    await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  worker.acknowledge(grandchild.operationId);
  worker.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  assert.deepEqual(
    operationEvents(trace, root.operationId).slice(-2).map(({ type }) => type),
    ["cancel_acknowledged", "operation_unknown"],
  );
});

test("retrying one cancellation epoch is idempotent", async () => {
  const { child, clock, grandchild, root, worker } =
    await spawnCancellationTree();
  const first = root.cancel({ scope: "subtree", cancellationEpoch: 1 });
  const retry = root.cancel({ scope: "subtree", cancellationEpoch: 1 });
  await waitForReceiver();
  worker.acknowledge(grandchild.operationId);
  worker.acknowledge(child.operationId);
  worker.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await first;

  assert.equal(first, retry);
});

test("Runtime rejects an older cancellation epoch", async () => {
  const { child, clock, grandchild, root, worker } =
    await spawnCancellationTree();
  const cancellation = root.cancel({ scope: "subtree", cancellationEpoch: 1 });
  await waitForReceiver();
  worker.acknowledge(grandchild.operationId);
  worker.acknowledge(child.operationId);
  worker.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  await assert.rejects(
    root.cancel({ scope: "subtree", cancellationEpoch: 0 }),
    (error: unknown) =>
      error instanceof CancellationRejectedError && error.reason === "stale_epoch",
  );
});

test("subtree cancellation preserves an already completed descendant", async () => {
  const { child, clock, grandchild, root, store, worker } =
    await spawnCancellationTree();
  worker.deliver(grandchild.operationId);
  await grandchild.result();
  const cancellation = root.cancel({ scope: "subtree" });
  await waitForReceiver();
  worker.acknowledge(child.operationId);
  worker.acknowledge(root.operationId);
  await clock.advanceBy(1_000);
  await cancellation;

  assert.equal((await storedOperation(store, grandchild.operationId)).state, "completed");
});

test("a self-settled parent drains while its child is still running", async () => {
  const { runtime, store, worker } = nestedRuntime(["root", "child"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  await spawnNested(runtime, root.operationId, "child");
  await waitForReceiver();

  worker.deliver(root.operationId);
  await waitForReceiver();

  assert.equal((await storedOperation(store, root.operationId)).state, "draining_descendants");
});

test("a parent completes after its child result handoff terminates", async () => {
  const { runtime, store, worker } = nestedRuntime(["root", "child"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  const child = await spawnNested(runtime, root.operationId, "child");
  await waitForReceiver();
  worker.deliver(root.operationId);
  worker.deliver(child.operationId);
  await Promise.all([root.result(), child.result()]);

  assert.equal((await storedOperation(store, root.operationId)).state, "completed");
});

test("a grandparent completes only after its grandchild terminates", async () => {
  const { runtime, store, worker } = nestedRuntime(["root", "child", "grandchild"]);
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  const child = await spawnNested(runtime, root.operationId, "child");
  const grandchild = await spawnNested(runtime, child.operationId, "grandchild");
  await waitForReceiver();
  worker.deliver(root.operationId);
  worker.deliver(child.operationId);
  await waitForReceiver();

  const beforeGrandchild = (await storedOperation(store, root.operationId)).state;
  worker.deliver(grandchild.operationId);
  await Promise.all([root.result(), child.result(), grandchild.result()]);

  assert.equal(beforeGrandchild, "draining_descendants");
});

test("the default descendant failure policy fails a successful parent", async () => {
  const worker = new FailingChildWorkerAdapter();
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    worker,
    clock: new FakeClock(Array.from({ length: 30 }, (_, index) => `time-${index}`)),
    ids: new FakeIdGenerator(["root", "child"]),
    presentation: new FakePresentation(),
    store,
  });
  const root = await runtime.spawn({ promptRef: "root", profile: "coding", idempotencyKey: "root" });
  await spawnNested(runtime, root.operationId, "child");
  await waitForReceiver();
  worker.deliver(root.operationId);

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

async function rejectedChildResources() {
  const { ids, presentation, runtime, worker } = nestedRuntime([
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
  const before = {
    issuedIdentifiers: ids.issuedCount,
    presentations: presentation.projections.length,
    workerStarts: worker.startCount,
  };
  await spawnNested(runtime, root.operationId, "child-4").catch(() => undefined);
  await waitForReceiver();
  return { before, ids, presentation, worker };
}

test("a rejected child creates no identifier", async () => {
  const { before, ids } = await rejectedChildResources();

  assert.equal(ids.issuedCount, before.issuedIdentifiers);
});

test("a rejected child creates no Worker resource", async () => {
  const { before, worker } = await rejectedChildResources();

  assert.equal(worker.startCount, before.workerStarts);
});

test("a rejected child creates no Presentation resource", async () => {
  const { before, presentation } = await rejectedChildResources();

  assert.equal(presentation.projections.length, before.presentations);
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

test("Runtime starts the Worker once", async () => {
  const { worker } = await completeOperation();

  assert.equal(worker.startCount, 1);
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
      "worker_launched",
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
      { seq: 9, timestamp: "2026-09-06T10:00:08.000Z" },
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
  const worker = new FakeWorkerAdapter({ messages: { body: "finished" } });
  const runtime = makeRuntime({
    worker,
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

  return { handles, worker };
}

test("Runtime returns the same OperationHandle for an idempotent spawn", async () => {
  const { handles } = await retryOperation();

  assert.equal(handles[0], handles[1]);
});

test("Runtime starts the Worker once for an idempotent spawn", async () => {
  const { worker } = await retryOperation();

  assert.equal(worker.startCount, 1);
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
    worker: new FakeWorkerAdapter({
      messages: [
        { body: "finished", sequenceNumber: 1 },
        { body: "conflicting", sequenceNumber: 1 },
      ],
    }),
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
    worker: new FakeWorkerAdapter({
      messages: { body: "must not be returned" },
      trace,
      failure: "worker_start_failed",
    }),
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

test("a Worker protocol failure is durably classified without fake completion", async () => {
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "unused" },
      failure: "worker_protocol_failed",
    }),
    clock: new FakeClock(Array.from({ length: 10 }, (_, index) => `failure-time-${index}`)),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
  });
  const handle = await runtime.spawn({ promptRef: "prompt", profile: "coding", idempotencyKey: "task" });
  await handle.result().catch(() => undefined);

  assert.equal((await storedOperation(store, "operation-1")).terminalReason, "worker_protocol_failed");
});

async function acknowledgementFailure(
  messages: NonNullable<FakeWorkerAdapterOptions["messages"]> = { body: "accepted" },
): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter({ messages, acknowledgementFails: true }),
    clock: new FakeClock(Array.from({ length: 10 }, (_, index) => `failure-time-${index}`)),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
  });
  const handle = await runtime.spawn({ promptRef: "prompt", profile: "coding", idempotencyKey: "task" });
  await handle.result().catch(() => undefined);
  return store;
}

test("an acknowledgement failure is durably classified", async () => {
  const store = await acknowledgementFailure();

  assert.equal((await storedOperation(store, "operation-1")).terminalReason, "worker_protocol_failed");
});

test("an acknowledgement failure retains the accepted Result", async () => {
  const store = await acknowledgementFailure();

  assert.equal((await Effect.runPromise(store.read("operation-1"))).result?.body, "accepted");
});

test("an acknowledgement failure retains Result conflict evidence", async () => {
  const store = await acknowledgementFailure([
    { body: "accepted", sequenceNumber: 1 },
    { body: "conflicting", sequenceNumber: 2 },
  ]);

  assert.equal(
    (await storedOperation(store, "operation-1")).resultConflict?.deliverySequenceNumber,
    2,
  );
});

test("OperationHandle reports Worker start failure as a bounded typed failure", async () => {
  const { handle } = await failOperation();

  await assert.rejects(
    handle.result(),
    (error) =>
      error instanceof OperationFailedError &&
      error.reason === "worker_start_failed",
  );
});

test("Worker start failure records the failed terminal result", async () => {
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

test("Worker start failure does not publish a successful Result", async () => {
  const { store } = await failOperation();

  assert.equal((await Effect.runPromise(store.read("operation-1"))).result, undefined);
});
