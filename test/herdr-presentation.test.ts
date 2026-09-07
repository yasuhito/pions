import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import type { Operation, OperationIntent } from "../src/internal/event-store/index.js";
import {
  HerdrPresentation,
  type CommandExecutor,
  type CommandInvocation,
} from "../src/internal/herdr-presentation.js";
import { makeRuntime } from "../src/internal/runtime.js";
import {
  FakeWorkerAdapter,
  FakeClock,
  FakeIdGenerator,
  InMemoryEventStore,
} from "../src/internal/testing.js";
import { HerdrPreconditionError } from "../src/index.js";
import { effectiveConfig, requestedConfig } from "./worker-protocol-fixtures.js";

class OwnershipFailingStore extends InMemoryEventStore {
  override advance(operationId: string, input: OperationIntent) {
    return input.type === "presentation_owned"
      ? Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "ownership persistence failed",
        })
      : super.advance(operationId, input);
  }
}

class FakeCommandExecutor implements CommandExecutor {
  readonly invocations: Array<CommandInvocation> = [];

  constructor(
    private readonly outputs: ReadonlyArray<{
      readonly stdout: string;
      readonly stderr?: string;
      readonly exitCode?: number;
    }>,
  ) {}

  execute(invocation: CommandInvocation) {
    return Effect.sync(() => {
      this.invocations.push(invocation);
      const output = this.outputs[this.invocations.length - 1];
      if (output === undefined) throw new Error("FakeCommandExecutor exhausted");
      return {
        stdout: output.stdout,
        stderr: output.stderr ?? "",
        exitCode: output.exitCode ?? 0,
      };
    });
  }
}

const herdrEnvironment = {
  HERDR_ENV: "1",
  HERDR_WORKSPACE_ID: "existing-workspace",
  HERDR_TAB_ID: "existing-tab",
  HERDR_PANE_ID: "existing-caller-pane",
};

function operation(paneId?: string): Operation {
  return {
    operationId: "operation-1",
    lineage: { rootOperationId: "operation-1", depth: 0 },
    state: "running",
    stateSeq: 3,
    workerLaunched: true,
    task: { promptRef: "private://prompt/1", profile: "coding", idempotencyKey: "task-1" },
    requestedConfig,
    effectiveConfig,
    childOperationIds: [],
    settledChildOperationIds: [],
    descendantFailure: false,
    spawnFrozen: false,
    cancellationEpoch: 0,
    ...(paneId === undefined
      ? {}
      : { presentation: { kind: "herdr_pane" as const, paneId, ownedByPions: true as const } }),
  };
}

function presentation(
  executor: CommandExecutor,
  environment: Readonly<Record<string, string | undefined>> = herdrEnvironment,
) {
  return new HerdrPresentation({
    cwd: "/work/project",
    environment,
    executor,
  });
}

test("Herdr preflight reports missing context as a typed violation", async () => {
  const adapter = presentation(new FakeCommandExecutor([]), {});
  const result = await Effect.runPromise(Effect.either(adapter.preflight()));

  assert.equal(result._tag === "Left" && result.left instanceof HerdrPreconditionError, true);
});

test("Herdr preflight does not invoke a command", async () => {
  const executor = new FakeCommandExecutor([]);
  await Effect.runPromise(presentation(executor).preflight());

  assert.equal(executor.invocations.length, 0);
});

test("pane creation uses shell-free argv, explicit cwd, and no focus", async () => {
  const executor = new FakeCommandExecutor([
    { stdout: JSON.stringify({ result: { pane: { pane_id: "opaque:new-pane" } } }) },
  ]);
  await Effect.runPromise(presentation(executor).create(operation()));

  assert.deepEqual(executor.invocations, [{
    executable: "herdr",
    args: ["pane", "split", "--current", "--direction", "right", "--cwd", "/work/project", "--no-focus"],
    cwd: "/work/project",
    shell: false,
  }]);
});

test("pane creation never targets existing or Qoral identifiers", async () => {
  const executor = new FakeCommandExecutor([
    { stdout: JSON.stringify({ result: { pane: { pane_id: "opaque:new-pane" } } }) },
  ]);
  const adapter = new HerdrPresentation({
    cwd: "/work/project",
    environment: { ...herdrEnvironment, QORAL_PANE_ID: "qoral-pane" },
    executor,
  });
  await Effect.runPromise(adapter.create(operation()));

  assert.equal(
    executor.invocations.flatMap(({ args }) => args).some((argument) =>
      ["existing-workspace", "existing-tab", "existing-caller-pane", "qoral-pane"].includes(argument)
    ),
    false,
  );
});

test("pane creation returns only the opaque identifier from Herdr", async () => {
  const executor = new FakeCommandExecutor([
    { stdout: JSON.stringify({ result: { pane: { pane_id: "opaque:new-pane", focused: false } } }) },
  ]);

  assert.deepEqual(
    await Effect.runPromise(presentation(executor).create(operation())),
    { kind: "herdr_pane", paneId: "opaque:new-pane" },
  );
});

test("projection targets the persisted Pions-owned pane", async () => {
  const executor = new FakeCommandExecutor([{ stdout: JSON.stringify({ result: {} }) }]);
  await Effect.runPromise(presentation(executor).project(operation("opaque:new-pane")));

  assert.deepEqual(executor.invocations[0]?.args, [
    "pane", "report-metadata", "--source", "pions", "opaque:new-pane",
    "--state-label", "working=running",
    "--display-agent", "effective(model=test/test-model;thinking=medium;tools=read,bash,edit,write;cwd=/test/workspace) observed(model=unavailable;thinking=unavailable;tools=unavailable;cwd=unavailable)",
    "--seq", "3",
  ]);
});

test("configuration projection excludes the private prompt reference", async () => {
  const executor = new FakeCommandExecutor([{ stdout: JSON.stringify({ result: {} }) }]);
  await Effect.runPromise(presentation(executor).project(operation("opaque:new-pane")));

  assert.equal(JSON.stringify(executor.invocations).includes("private://prompt/1"), false);
});

test("configuration projection is size-limited", async () => {
  const executor = new FakeCommandExecutor([{ stdout: JSON.stringify({ result: {} }) }]);
  const current: Operation = {
    ...operation("opaque:new-pane"),
    effectiveConfig: {
      ...effectiveConfig,
      cwd: `/${"長".repeat(600)}`,
    },
  };
  await Effect.runPromise(presentation(executor).project(current));
  const displayIndex = executor.invocations[0]?.args.indexOf("--display-agent") ?? -1;
  const projected = executor.invocations[0]?.args[displayIndex + 1] ?? "";

  assert.equal(Buffer.byteLength(projected, "utf8") <= 512, true);
});

test("investigation-worthy and phase-one terminal states retain their owned panes", async () => {
  const retainedStates: ReadonlyArray<Operation["state"]> = [
    "blocked",
    "failed",
    "cancelled",
    "unknown",
    "completed",
  ];
  const executor = new FakeCommandExecutor(
    retainedStates.map(() => ({ stdout: JSON.stringify({ result: {} }) })),
  );
  const adapter = presentation(executor);
  for (const state of retainedStates) {
    await Effect.runPromise(adapter.project({ ...operation("opaque:new-pane"), state }));
  }

  assert.equal(executor.invocations.some(({ args }) => args.includes("close")), false);
});

test("projection without durable ownership does not target a pane", async () => {
  const executor = new FakeCommandExecutor([]);
  await Effect.runPromise(presentation(executor).project(operation()));

  assert.equal(executor.invocations.length, 0);
});

test("rollback targets exactly the newly-created pane", async () => {
  const executor = new FakeCommandExecutor([{ stdout: JSON.stringify({ result: {} }) }]);
  const adapter = presentation(executor);
  await Effect.runPromise(adapter.rollbackCreated({ kind: "herdr_pane", paneId: "opaque:new-pane" }));

  assert.deepEqual(executor.invocations[0]?.args, ["pane", "close", "opaque:new-pane"]);
});

test("Runtime exposes a typed Herdr precondition violation", async () => {
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter({ messages: { body: "finished" } }),
    clock: new FakeClock([]),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: presentation(new FakeCommandExecutor([]), {}),
    store: new InMemoryEventStore(),
  });

  await assert.rejects(
    runtime.spawn({ promptRef: "private://prompt/1", profile: "coding", idempotencyKey: "task-1" }),
    (error) => error instanceof HerdrPreconditionError,
  );
});

test("Runtime rejects missing Herdr before creating any resource", async () => {
  const executor = new FakeCommandExecutor([]);
  const ids = new FakeIdGenerator(["operation-1"]);
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter({ messages: { body: "finished" } }),
    clock: new FakeClock([]),
    ids,
    presentation: presentation(executor, {}),
    store,
  });

  await runtime.spawn({ promptRef: "private://prompt/1", profile: "coding", idempotencyKey: "task-1" }).catch(() => undefined);

  const read = await Effect.runPromise(Effect.either(store.read("operation-1")));

  assert.deepEqual([ids.issuedCount, executor.invocations.length, read._tag], [0, 0, "Left"]);
});

test("failed ownership persistence rolls back exactly the created pane", async () => {
  const executor = new FakeCommandExecutor([
    { stdout: JSON.stringify({ result: { pane: { pane_id: "opaque:new-pane" } } }) },
    { stdout: JSON.stringify({ result: {} }) },
  ]);
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter({ messages: { body: "finished" } }),
    clock: new FakeClock(["time-0"]),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: presentation(executor),
    store: new OwnershipFailingStore(),
  });

  await runtime.spawn({ promptRef: "private://prompt/1", profile: "coding", idempotencyKey: "task-1" }).catch(() => undefined);

  assert.deepEqual(executor.invocations.at(-1)?.args, ["pane", "close", "opaque:new-pane"]);
});

test("the default Worker-start failure policy retains the owned pane", async () => {
  const executor = new FakeCommandExecutor([]);
  await Effect.runPromise(presentation(executor).onWorkerStartFailure(operation("opaque:new-pane")));

  assert.equal(executor.invocations.length, 0);
});

test("configured Worker-start rollback closes exactly the owned pane", async () => {
  const executor = new FakeCommandExecutor([{ stdout: JSON.stringify({ result: {} }) }]);
  const adapter = new HerdrPresentation({
    cwd: "/work/project",
    environment: herdrEnvironment,
    executor,
    retainOnWorkerStartFailure: false,
  });
  await Effect.runPromise(adapter.onWorkerStartFailure(operation("opaque:new-pane")));

  assert.deepEqual(executor.invocations[0]?.args, ["pane", "close", "opaque:new-pane"]);
});

test("a Herdr projection failure cannot create Operation completion", async () => {
  const executor = new FakeCommandExecutor([
    { stdout: JSON.stringify({ result: { pane: { pane_id: "opaque:new-pane" } } }) },
  ]);
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "unused" },
      failure: "worker_start_failed",
    }),
    clock: new FakeClock(Array.from({ length: 5 }, (_, index) => `time-${index}`)),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: presentation(executor),
    store,
  });

  const handle = await runtime.spawn({ promptRef: "private://prompt/1", profile: "coding", idempotencyKey: "task-1" });
  await handle.result().catch(() => undefined);

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "failed");
});

test("Runtime persists ownership returned by Herdr", async () => {
  const executor = new FakeCommandExecutor([
    { stdout: JSON.stringify({ result: { pane: { pane_id: "opaque:new-pane" } } }) },
    { stdout: JSON.stringify({ result: {} }) },
    { stdout: JSON.stringify({ result: {} }) },
    { stdout: JSON.stringify({ result: {} }) },
    { stdout: JSON.stringify({ result: {} }) },
    { stdout: JSON.stringify({ result: {} }) },
    { stdout: JSON.stringify({ result: {} }) },
  ]);
  const store = new InMemoryEventStore();
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter({ messages: { body: "finished" } }),
    clock: new FakeClock(Array.from({ length: 10 }, (_, index) => `time-${index}`)),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: presentation(executor),
    store,
  });

  const handle = await runtime.spawn({ promptRef: "private://prompt/1", profile: "coding", idempotencyKey: "task-1" });
  await handle.result();

  assert.deepEqual((await Effect.runPromise(store.read("operation-1"))).operation.presentation, {
    kind: "herdr_pane",
    paneId: "opaque:new-pane",
    ownedByPions: true,
  });
});
