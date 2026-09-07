import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  installPionsExtension,
  type PionsExtensionOptions,
} from "../src/internal/pi-extension.js";
import { HerdrPreconditionError, OperationFailedError } from "../src/index.js";
import type { OperationHandle, Result, Runtime, TaskSpec } from "../src/index.js";

class FakeRuntime implements Runtime {
  readonly tasks: Array<TaskSpec> = [];
  spawnCount = 0;

  constructor(
    private readonly outcome: Result | Error = {
      body: "review complete",
      byteCount: 15,
      digest: `sha256:${"ab".repeat(32)}`,
    },
  ) {}

  async spawn(task: TaskSpec): Promise<OperationHandle> {
    this.spawnCount += 1;
    this.tasks.push(task);
    const outcome = this.outcome;
    return {
      operationId: "operation-1",
      result: () => outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
      cancel: () => Promise.resolve({ cancellationEpoch: 1, state: "cancelled" }),
    };
  }
}

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: string,
    params: { readonly task: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<{ readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>; readonly details?: unknown }>;
}

async function fixture(
  runtime = new FakeRuntime(),
  options: Omit<PionsExtensionOptions, "runtime" | "stateBaseDirectory"> & {
    readonly stateBaseDirectory?: string;
  } = {},
  useDefaultStateDirectory = false,
) {
  const root = await mkdtemp(join(tmpdir(), "pions-extension-"));
  let registered: RegisteredTool | undefined;
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool as unknown as RegisteredTool;
    },
    on() {},
  } as unknown as ExtensionAPI;
  installPionsExtension(pi, {
    ...(options.runtimeFactory === undefined ? { runtime } : {}),
    repositoryRoot: root,
    ...(useDefaultStateDirectory ? {} : { stateBaseDirectory: join(root, "state") }),
    ...options,
  });
  if (registered === undefined) throw new Error("pions_delegate was not registered");
  const tool = registered;
  const context = {
    cwd: root,
    model: { provider: "anthropic", id: "claude-opus-5" },
    thinkingLevel: "high",
    sessionManager: { getSessionId: () => "pi-session-1" },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  const execute = (toolCallId = "tool-call-1", task = "Review the change") =>
    tool.execute(toolCallId, { task }, undefined, undefined, context);
  return { context, execute, registered: tool, root, runtime };
}

test("project extension registers pions_delegate", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(value.registered.name, "pions_delegate");
});

test("pions_delegate requires only task input", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(value.registered.parameters, {
    type: "object",
    required: ["task"],
    additionalProperties: false,
    properties: { task: { type: "string", minLength: 1, description: "Self-contained work to delegate" } },
  });
});

test("pions_delegate description identifies subagent delegation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.match(value.registered.description, /pions_delegate.*subagent|subagent.*pions_delegate/i);
});

test("pions_delegate prompt guidance identifies isolated delegation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.match(`${value.registered.promptSnippet} ${value.registered.promptGuidelines?.join(" ")}`, /pions_delegate.*independent context/i);
});

test("one tool execution starts one root Operation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.equal(value.runtime.spawnCount, 1);
});

test("accepted Result body becomes the tool result", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal((await value.execute()).content[0]?.text, "review complete");
});

test("successful delegation returns Result diagnostics", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual((await value.execute()).details, {
    operationId: "operation-1",
    byteCount: 15,
    digest: `sha256:${"ab".repeat(32)}`,
    truncated: false,
  });
});

test("delegation inherits the exact Pi model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.model, { provider: "anthropic", id: "claude-opus-5" });
});

test("delegation inherits the exact Pi thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.thinkingLevel, "high");
});

test("delegation limits Worker tools to the review profile", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.tools, ["read", "grep", "find", "ls", "bash"]);
});

test("a later tool call inherits a newly selected Pi model", async (context) => {
  const configuredModels: Array<unknown> = [];
  const runtime = new FakeRuntime();
  const value = await fixture(runtime, {
    runtimeFactory: (options) => {
      configuredModels.push(options.profiles.review?.modelCandidates[0]);
      return runtime;
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute("first-call");
  (value.context as unknown as { model: { provider: string; id: string } }).model = {
    provider: "openai",
    id: "gpt-5.6-codex",
  };
  await value.execute("second-call");

  assert.deepEqual(configuredModels, [
    { provider: "anthropic", id: "claude-opus-5" },
    { provider: "openai", id: "gpt-5.6-codex" },
  ]);
});

test("delegated task is stored in a private file", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("promptRef missing");

  assert.equal((await stat(promptRef)).mode & 0o777, 0o600);
});

test("delegated task does not appear in TaskSpec metadata", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute("tool-call-1", "secret review request");

  assert.equal(JSON.stringify(value.runtime.tasks[0]).includes("secret review request"), false);
});

test("Worker prompt states that bash policy is not isolation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("promptRef missing");

  assert.match(await readFile(promptRef, "utf8"), /bash.*not.*technical isolation/is);
});

test("the same Pi tool call derives the same idempotency key", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute("same-call");
  await value.execute("same-call");

  assert.equal(value.runtime.tasks[0]?.idempotencyKey, value.runtime.tasks[1]?.idempotencyKey);
});

test("different Pi tool calls derive different idempotency keys", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute("first-call");
  await value.execute("second-call");

  assert.notEqual(value.runtime.tasks[0]?.idempotencyKey, value.runtime.tasks[1]?.idempotencyKey);
});

test("XDG state directory is respected", async (context) => {
  const value = await fixture(new FakeRuntime(), {
    environment: { XDG_STATE_HOME: join(tmpdir(), "pions-xdg-test") },
  }, true);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  context.after(() => rm(join(tmpdir(), "pions-xdg-test"), { recursive: true, force: true }));
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.promptRef.startsWith(join(tmpdir(), "pions-xdg-test", "pions")), true);
});

test("default state directory follows the user state convention", async (context) => {
  const home = join(tmpdir(), "pions-home-test");
  const value = await fixture(new FakeRuntime(), {
    environment: {},
    homeDirectory: home,
  }, true);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  context.after(() => rm(home, { recursive: true, force: true }));
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.promptRef.startsWith(join(home, ".local", "state", "pions")), true);
});

test("repository state identifier does not disclose the repository name", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "secret-repository-name-"));
  const stateBase = join(tmpdir(), "pions-opaque-state-test");
  const value = await fixture(new FakeRuntime(), { repositoryRoot: repository, stateBaseDirectory: stateBase });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  context.after(() => rm(repository, { recursive: true, force: true }));
  context.after(() => rm(stateBase, { recursive: true, force: true }));
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.promptRef.includes("secret-repository-name"), false);
});

test("typed Worker failure reaches the parent unchanged", async (context) => {
  const failure = new OperationFailedError("operation-7", "agent_failed");
  const value = await fixture(new FakeRuntime(failure));
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(value.execute(), (error) => error === failure);
});

test("Worker failure is not retried", async (context) => {
  const runtime = new FakeRuntime(new OperationFailedError("operation-7", "agent_failed"));
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute().catch(() => undefined);

  assert.equal(runtime.spawnCount, 1);
});

test("Herdr precondition failure occurs at execution rather than registration", async (context) => {
  const failure = new HerdrPreconditionError(["HERDR_ENV"]);
  const value = await fixture(new FakeRuntime(failure));
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(value.execute(), (error) => error === failure);
});
