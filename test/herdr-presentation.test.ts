import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import type {
  Operation,
  OperationIntent,
} from "../src/internal/event-store/index.js";
import {
  HerdrPresentation,
  workerWorkspaceLabel,
  type CommandExecutor,
  type CommandInvocation,
} from "../src/internal/herdr-presentation.js";
import {
  FakeWorkerAdapter,
  FakeClock,
  FakeIdGenerator,
  InMemoryEventStore,
  makeTestRuntime,
} from "../src/internal/testing.js";
import { HerdrPreconditionError } from "../src/internal/types.js";
import {
  effectiveConfig,
  requestedConfig,
  maxResultByteCount,
} from "./worker-protocol-fixtures.js";

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
    }>
  ) {}

  execute(invocation: CommandInvocation) {
    return Effect.sync(() => {
      this.invocations.push(invocation);
      const output = this.outputs[this.invocations.length - 1];
      if (output === undefined)
        throw new Error("FakeCommandExecutor exhausted");
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

const OPERATION_ID = "0f6b1d2c-6a3e-4b1f-9d0e-5f2a7c8b9e41";

const workspaceCreated = {
  stdout: JSON.stringify({
    result: {
      type: "workspace_created",
      workspace: {
        workspace_id: "w7",
        label: "Pions 0f6b1d2c",
        focused: false,
      },
      tab: { tab_id: "w7:t1" },
      root_pane: { pane_id: "w7:p1", focused: false },
    },
  }),
};

const ok = { stdout: JSON.stringify({ result: { type: "ok" } }) };

function operation(
  ownership?: Readonly<{ workspaceId: string; paneId: string }>
): Operation {
  return {
    operationId: OPERATION_ID,
    state: "running",
    stateSeq: 3,
    workerLaunched: true,
    task: {
      promptRef: "private://prompt/1",
      profile: "coding",
      idempotencyKey: "task-1",
    },
    requestedConfig,
    effectiveConfig,
    maxResultByteCount,
    startDeliveryHandoffs: [],
    cancellationEpoch: 0,
    ...(ownership === undefined
      ? {}
      : {
          presentation: {
            kind: "herdr_workspace" as const,
            workspaceId: ownership.workspaceId,
            paneId: ownership.paneId,
            ownedByPions: true as const,
          },
        }),
  };
}

const owned = { workspaceId: "w7", paneId: "w7:p1" };

function presentation(
  executor: CommandExecutor,
  environment: Readonly<Record<string, string | undefined>> = herdrEnvironment
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

  assert.equal(
    result._tag === "Left" && result.left instanceof HerdrPreconditionError,
    true
  );
});

test("Herdr preflight does not invoke a command", async () => {
  const executor = new FakeCommandExecutor([]);
  await Effect.runPromise(presentation(executor).preflight());

  assert.equal(executor.invocations.length, 0);
});

test("the Worker workspace label is a short Operation identifier", () => {
  assert.equal(workerWorkspaceLabel(OPERATION_ID), "Pions 0f6b1d2c");
});

test("workspace creation uses shell-free argv, explicit cwd, the label, and no focus", async () => {
  const executor = new FakeCommandExecutor([workspaceCreated]);
  await Effect.runPromise(presentation(executor).create(operation()));

  assert.deepEqual(executor.invocations, [
    {
      executable: "herdr",
      args: [
        "workspace",
        "create",
        "--cwd",
        "/work/project",
        "--label",
        "Pions 0f6b1d2c",
        "--no-focus",
      ],
      cwd: "/work/project",
      shell: false,
    },
  ]);
});

test("workspace creation never splits a pane or creates a tab", async () => {
  const executor = new FakeCommandExecutor([workspaceCreated]);
  await Effect.runPromise(presentation(executor).create(operation()));

  assert.deepEqual(
    executor.invocations.map(({ args }) => args.slice(0, 2)),
    [["workspace", "create"]]
  );
});

test("workspace creation never targets existing or Qoral identifiers", async () => {
  const executor = new FakeCommandExecutor([workspaceCreated]);
  const adapter = new HerdrPresentation({
    cwd: "/work/project",
    environment: { ...herdrEnvironment, QORAL_PANE_ID: "qoral-pane" },
    executor,
  });
  await Effect.runPromise(adapter.create(operation()));

  assert.equal(
    executor.invocations
      .flatMap(({ args }) => args)
      .some((argument) =>
        [
          "existing-workspace",
          "existing-tab",
          "existing-caller-pane",
          "qoral-pane",
        ].includes(argument)
      ),
    false
  );
});

test("the workspace label excludes the private prompt reference", async () => {
  const executor = new FakeCommandExecutor([workspaceCreated]);
  await Effect.runPromise(presentation(executor).create(operation()));

  assert.equal(
    JSON.stringify(executor.invocations).includes("private://prompt/1"),
    false
  );
});

test("workspace creation returns the opaque workspace and root pane identifiers", async () => {
  const executor = new FakeCommandExecutor([workspaceCreated]);

  assert.deepEqual(
    await Effect.runPromise(presentation(executor).create(operation())),
    { kind: "herdr_workspace", workspaceId: "w7", paneId: "w7:p1" }
  );
});

test("workspace creation rejects a response without a workspace identifier", async () => {
  const executor = new FakeCommandExecutor([
    {
      stdout: JSON.stringify({
        result: { root_pane: { pane_id: "w7:p1" } },
      }),
    },
  ]);

  await assert.rejects(
    Effect.runPromise(presentation(executor).create(operation())),
    /no opaque workspace identifier/u
  );
});

test("workspace creation rejects a response without a root pane identifier", async () => {
  const executor = new FakeCommandExecutor([
    {
      stdout: JSON.stringify({
        result: { workspace: { workspace_id: "w7" } },
      }),
    },
  ]);

  await assert.rejects(
    Effect.runPromise(presentation(executor).create(operation())),
    /no opaque root pane identifier/u
  );
});

test("projection targets the root pane of the persisted Pions-owned workspace", async () => {
  const executor = new FakeCommandExecutor([ok]);
  await Effect.runPromise(presentation(executor).project(operation(owned)));

  assert.deepEqual(executor.invocations[0]?.args, [
    "pane",
    "report-metadata",
    "--source",
    "pions",
    "w7:p1",
    "--state-label",
    "working=running",
    "--display-agent",
    "effective(model=test/test-model;thinking=medium;tools=read,bash;cwd=/test/workspace) observed(model=unavailable;thinking=unavailable;tools=unavailable;cwd=unavailable)",
    "--seq",
    "3",
  ]);
});

test("configuration projection excludes the private prompt reference", async () => {
  const executor = new FakeCommandExecutor([ok]);
  await Effect.runPromise(presentation(executor).project(operation(owned)));

  assert.equal(
    JSON.stringify(executor.invocations).includes("private://prompt/1"),
    false
  );
});

test("configuration projection is size-limited", async () => {
  const executor = new FakeCommandExecutor([ok]);
  const current: Operation = {
    ...operation(owned),
    effectiveConfig: {
      ...effectiveConfig,
      cwd: `/${"長".repeat(600)}`,
    },
  };
  await Effect.runPromise(presentation(executor).project(current));
  const displayIndex =
    executor.invocations[0]?.args.indexOf("--display-agent") ?? -1;
  const projected = executor.invocations[0]?.args[displayIndex + 1] ?? "";

  assert.equal(Buffer.byteLength(projected, "utf8") <= 512, true);
});

test("projection of any terminal state never closes the owned workspace", async () => {
  const retainedStates: ReadonlyArray<Operation["state"]> = [
    "failed",
    "cancelled",
    "unknown",
    "completed",
  ];
  const executor = new FakeCommandExecutor(retainedStates.map(() => ok));
  const adapter = presentation(executor);
  for (const state of retainedStates) {
    await Effect.runPromise(adapter.project({ ...operation(owned), state }));
  }

  assert.equal(
    executor.invocations.some(({ args }) => args.includes("close")),
    false
  );
});

test("projection without durable ownership does not target Herdr", async () => {
  const executor = new FakeCommandExecutor([]);
  await Effect.runPromise(presentation(executor).project(operation()));

  assert.equal(executor.invocations.length, 0);
});

test("rollback closes exactly the newly-created workspace", async () => {
  const executor = new FakeCommandExecutor([ok]);
  const adapter = presentation(executor);
  await Effect.runPromise(
    adapter.rollbackCreated({
      kind: "herdr_workspace",
      workspaceId: "w7",
      paneId: "w7:p1",
    })
  );

  assert.deepEqual(executor.invocations[0]?.args, ["workspace", "close", "w7"]);
});

test("owned workspace inspection matches the persisted opaque identity", async () => {
  const executor = new FakeCommandExecutor([
    {
      stdout: JSON.stringify({
        result: {
          workspaces: [{ workspace_id: "w1" }, { workspace_id: "w7" }],
        },
      }),
    },
  ]);

  assert.equal(
    await Effect.runPromise(
      presentation(executor).inspectOwnedWorkspace(operation(owned))
    ),
    "matching"
  );
});

test("owned workspace inspection uses a read-only workspace listing", async () => {
  const executor = new FakeCommandExecutor([
    {
      stdout: JSON.stringify({
        result: { workspaces: [{ workspace_id: "w7" }] },
      }),
    },
  ]);
  await Effect.runPromise(
    presentation(executor).inspectOwnedWorkspace(operation(owned))
  );

  assert.deepEqual(executor.invocations[0]?.args, ["workspace", "list"]);
});

test("owned workspace inspection reports a missing persisted identity", async () => {
  const executor = new FakeCommandExecutor([
    {
      stdout: JSON.stringify({
        result: { workspaces: [{ workspace_id: "w8" }] },
      }),
    },
  ]);

  assert.equal(
    await Effect.runPromise(
      presentation(executor).inspectOwnedWorkspace(operation(owned))
    ),
    "missing"
  );
});

test("owned workspace inspection does not match on the root pane identifier", async () => {
  const executor = new FakeCommandExecutor([
    {
      stdout: JSON.stringify({
        result: { workspaces: [{ workspace_id: "w7:p1" }] },
      }),
    },
  ]);

  assert.equal(
    await Effect.runPromise(
      presentation(executor).inspectOwnedWorkspace(operation(owned))
    ),
    "missing"
  );
});

test("owned workspace inspection fails on a malformed listing", async () => {
  const executor = new FakeCommandExecutor([
    { stdout: JSON.stringify({ result: { type: "workspace_list" } }) },
  ]);

  await assert.rejects(
    Effect.runPromise(
      presentation(executor).inspectOwnedWorkspace(operation(owned))
    ),
    /no workspace list/u
  );
});

test("owned workspace inspection without durable ownership is missing", async () => {
  const executor = new FakeCommandExecutor([]);

  assert.equal(
    await Effect.runPromise(
      presentation(executor).inspectOwnedWorkspace(operation())
    ),
    "missing"
  );
});

test("successful cleanup closes exactly the persistently owned workspace", async () => {
  const executor = new FakeCommandExecutor([ok]);
  await Effect.runPromise(
    presentation(executor).closeOwnedWorkspace(operation(owned))
  );

  assert.deepEqual(executor.invocations[0]?.args, ["workspace", "close", "w7"]);
});

test("successful cleanup without durable ownership does not target Herdr", async () => {
  const executor = new FakeCommandExecutor([]);
  await Effect.runPromise(
    presentation(executor).closeOwnedWorkspace(operation())
  );

  assert.equal(executor.invocations.length, 0);
});

test("a Herdr error envelope on close is surfaced as a failure", async () => {
  const executor = new FakeCommandExecutor([
    {
      stdout: JSON.stringify({
        error: {
          code: "workspace_not_found",
          message: "workspace w7 not found",
        },
      }),
    },
  ]);

  await assert.rejects(
    Effect.runPromise(
      presentation(executor).closeOwnedWorkspace(operation(owned))
    ),
    /workspace w7 not found/u
  );
});

test("Runtime exposes a typed Herdr precondition violation", async () => {
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "finished" },
      successfulExitConfirmed: true,
    }),
    clock: new FakeClock([]),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: presentation(new FakeCommandExecutor([]), {}),
    store: new InMemoryEventStore(),
  });

  await assert.rejects(
    runtime.spawn({
      promptRef: "private://prompt/1",
      profile: "coding",
      idempotencyKey: "task-1",
    }),
    (error) => error instanceof HerdrPreconditionError
  );
});

test("Runtime rejects missing Herdr before creating any resource", async () => {
  const executor = new FakeCommandExecutor([]);
  const ids = new FakeIdGenerator(["operation-1"]);
  const store = new InMemoryEventStore();
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({ messages: { body: "finished" } }),
    clock: new FakeClock([]),
    ids,
    presentation: presentation(executor, {}),
    store,
  });

  await runtime
    .spawn({
      promptRef: "private://prompt/1",
      profile: "coding",
      idempotencyKey: "task-1",
    })
    .catch(() => undefined);

  const read = await Effect.runPromise(
    Effect.either(store.read("operation-1"))
  );

  assert.deepEqual(
    [ids.issuedCount, executor.invocations.length, read._tag],
    [0, 0, "Left"]
  );
});

test("failed ownership persistence rolls back exactly the created workspace", async () => {
  const executor = new FakeCommandExecutor([workspaceCreated, ok]);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({ messages: { body: "finished" } }),
    clock: new FakeClock(["2026-09-06T10:00:00.000Z"]),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: presentation(executor),
    store: new OwnershipFailingStore(),
  });

  await runtime
    .spawn({
      promptRef: "private://prompt/1",
      profile: "coding",
      idempotencyKey: "task-1",
    })
    .catch(() => undefined);

  assert.deepEqual(executor.invocations.at(-1)?.args, [
    "workspace",
    "close",
    "w7",
  ]);
});

test("a Herdr projection failure cannot create Operation completion", async () => {
  const executor = new FakeCommandExecutor([workspaceCreated]);
  const store = new InMemoryEventStore();
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "unused" },
      failure: "worker_start_failed",
    }),
    clock: new FakeClock(
      Array.from(
        { length: 5 },
        (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
      )
    ),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: presentation(executor),
    store,
  });

  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result().catch(() => undefined);

  assert.equal(
    (await Effect.runPromise(store.read("operation-1"))).operation.state,
    "failed"
  );
});

test("Runtime persists workspace ownership returned by Herdr", async () => {
  const executor = new FakeCommandExecutor([
    workspaceCreated,
    ok,
    ok,
    ok,
    ok,
    ok,
    ok,
  ]);
  const store = new InMemoryEventStore();
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "finished" },
      successfulExitConfirmed: true,
    }),
    clock: new FakeClock(
      Array.from(
        { length: 10 },
        (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
      )
    ),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: presentation(executor),
    store,
  });

  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.deepEqual(
    (await Effect.runPromise(store.read("operation-1"))).operation.presentation,
    {
      kind: "herdr_workspace",
      workspaceId: "w7",
      paneId: "w7:p1",
      ownedByPions: true,
    }
  );
});
