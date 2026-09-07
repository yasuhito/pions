import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  installPionsExtension,
  type PionsExtensionOptions,
} from "../src/internal/pi-extension.js";
import {
  HerdrPreconditionError,
  OperationCancelledError,
  OperationFailedError,
  OperationUnknownError,
  ProjectConfigurationError,
  WorkerConfigurationError,
} from "../src/index.js";
import type {
  CancellationResult,
  OperationHandle,
  Result,
  Runtime,
  TaskSpec,
} from "../src/index.js";

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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function waitForOperation(runtime: PendingRuntime, operationId = "operation-1"): Promise<void> {
  while (!runtime.results.has(operationId)) await new Promise(setImmediate);
}

class PendingRuntime implements Runtime {
  readonly cancellations: Array<{ readonly operationId: string; readonly scope: "subtree" }> = [];
  readonly results = new Map<string, ReturnType<typeof deferred<Result>>>();
  cancellationResponse: Promise<CancellationResult> = Promise.resolve({
    cancellationEpoch: 1,
    state: "cancelled",
  });
  private nextId = 1;

  async spawn(): Promise<OperationHandle> {
    const operationId = `operation-${this.nextId}`;
    this.nextId += 1;
    const result = deferred<Result>();
    this.results.set(operationId, result);
    return {
      operationId,
      result: () => result.promise,
      cancel: async ({ scope }) => {
        this.cancellations.push({ operationId, scope });
        const response = await this.cancellationResponse;
        result.reject(
          response.state === "unknown"
            ? new OperationUnknownError(operationId, "cancel-unproven")
            : new OperationCancelledError(operationId),
        );
        return response;
      },
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

async function fixture<TRuntime extends Runtime = FakeRuntime>(
  runtime: TRuntime = new FakeRuntime() as unknown as TRuntime,
  options: Omit<PionsExtensionOptions, "runtime" | "stateBaseDirectory"> & {
    readonly stateBaseDirectory?: string;
  } = {},
  useDefaultStateDirectory = false,
) {
  const root = await mkdtemp(join(tmpdir(), "pions-extension-"));
  let registered: RegisteredTool | undefined;
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool as unknown as RegisteredTool;
    },
    on(event: string, handler: (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown) {
      handlers.set(event, handler);
    },
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
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => "pi-session-1" },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  const execute = (
    toolCallId = "tool-call-1",
    task = "Review the change",
    signal?: AbortSignal,
  ) => tool.execute(toolCallId, { task }, signal, undefined, context);
  const shutdown = (reason: "quit" | "reload" | "new" | "resume" | "fork") => {
    const handler = handlers.get("session_shutdown");
    if (handler === undefined) throw new Error("session_shutdown was not registered");
    return Promise.resolve(handler({ type: "session_shutdown", reason }, context));
  };
  return { context, execute, registered: tool, root, runtime, shutdown };
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

test("project configuration overrides the review model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: { model: { provider: "openai", id: "gpt-5.6-codex" } },
  }));
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.model, { provider: "openai", id: "gpt-5.6-codex" });
});

test("model-only project configuration inherits the Pi thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: { model: { provider: "openai", id: "gpt-5.6-codex" } },
  }));
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.thinkingLevel, "high");
});

test("thinking-only project configuration inherits the Pi model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({ review: { thinkingLevel: "low" } }));
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.model, { provider: "anthropic", id: "claude-opus-5" });
});

test("project configuration overrides the review thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({ review: { thinkingLevel: "low" } }));
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.thinkingLevel, "low");
});

test("project configuration applies model and thinking level together", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: {
      model: { provider: "anthropic", id: "claude-opus-5" },
      thinkingLevel: "xhigh",
    },
  }));
  await value.execute();

  assert.deepEqual(
    { model: value.runtime.tasks[0]?.model, thinkingLevel: value.runtime.tasks[0]?.thinkingLevel },
    { model: { provider: "anthropic", id: "claude-opus-5" }, thinkingLevel: "xhigh" },
  );
});

test("malformed project configuration is rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), "{");

  await assert.rejects(
    value.execute(),
    (error) => error instanceof ProjectConfigurationError && error.reason === "invalid_json",
  );
});

test("unknown project configuration keys are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({ review: { apiKey: "secret" } }));

  await assert.rejects(
    value.execute(),
    (error) => error instanceof ProjectConfigurationError && error.reason === "unknown_key",
  );
});

test("invalid review model providers are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: { model: { provider: "not a provider", id: "model" } },
  }));

  await assert.rejects(
    value.execute(),
    (error) => error instanceof ProjectConfigurationError && error.reason === "invalid_provider",
  );
});

test("invalid review model identifiers are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: { model: { provider: "anthropic", id: "" } },
  }));

  await assert.rejects(
    value.execute(),
    (error) => error instanceof ProjectConfigurationError && error.reason === "invalid_model_id",
  );
});

test("invalid review thinking levels are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({ review: { thinkingLevel: "ultra" } }));

  await assert.rejects(
    value.execute(),
    (error) => error instanceof ProjectConfigurationError && error.reason === "invalid_thinking_level",
  );
});

test("invalid existing project configuration does not spawn a Worker", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), "{");
  await value.execute().catch(() => undefined);

  assert.equal(value.runtime.spawnCount, 0);
});

test("an unavailable configured model returns a typed failure", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: { model: { provider: "anthropic", id: "missing" } },
  }));
  (value.context.modelRegistry as unknown as { find: () => undefined }).find = () => undefined;

  await assert.rejects(
    value.execute(),
    (error) => error instanceof WorkerConfigurationError && error.reason === "model_not_found",
  );
});

test("an unauthenticated configured model returns a typed failure", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: { model: { provider: "anthropic", id: "claude-opus-5" } },
  }));
  (value.context.modelRegistry as unknown as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => false;

  await assert.rejects(
    value.execute(),
    (error) => error instanceof WorkerConfigurationError && error.reason === "model_auth_unavailable",
  );
});

test("a configured model mismatch reaches the parent unchanged", async (context) => {
  const failure = new OperationFailedError("operation-7", "model_mismatch");
  const value = await fixture(new FakeRuntime(failure));
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: { model: { provider: "anthropic", id: "claude-opus-5" } },
  }));

  await assert.rejects(value.execute(), (error) => error === failure);
});

test("configured model failure does not fall back to the delegating model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), JSON.stringify({
    review: { model: { provider: "anthropic", id: "missing" } },
  }));
  (value.context.modelRegistry as unknown as { find: () => undefined }).find = () => undefined;
  await value.execute().catch(() => undefined);

  assert.equal(value.runtime.spawnCount, 0);
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

test("Pi interruption requests subtree cancellation once", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const controller = new AbortController();
  const execution = value.execute("interrupted-call", "Review", controller.signal);
  void execution.catch(() => undefined);
  await waitForOperation(runtime);
  controller.abort();
  await execution.catch(() => undefined);

  assert.deepEqual(runtime.cancellations, [
    { operationId: "operation-1", scope: "subtree" },
  ]);
});

test("an Operation completed before interruption is not cancelled", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const controller = new AbortController();
  const execution = value.execute("completed-call", "Review", controller.signal);
  await waitForOperation(runtime);
  runtime.results.get("operation-1")?.resolve({
    body: "done",
    byteCount: 4,
    digest: `sha256:${"ab".repeat(32)}`,
  });
  await execution;
  controller.abort();

  assert.equal(runtime.cancellations.length, 0);
});

test("unproven interrupted cancellation reaches the parent as unknown", async (context) => {
  const runtime = new PendingRuntime();
  runtime.cancellationResponse = Promise.resolve({
    cancellationEpoch: 1,
    state: "unknown",
    reason: "cancel-unproven",
  });
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const controller = new AbortController();
  const execution = value.execute("unknown-call", "Review", controller.signal);
  await waitForOperation(runtime);
  controller.abort();

  await assert.rejects(
    execution,
    (error) => error instanceof OperationUnknownError && error.operationId === "operation-1",
  );
});

test("failed interrupted cancellation is not reported as cancellation success", async (context) => {
  const runtime = new PendingRuntime();
  const failure = new Error("cancellation dispatch failed");
  const cancellation = deferred<CancellationResult>();
  runtime.cancellationResponse = cancellation.promise;
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const controller = new AbortController();
  const execution = value.execute("failed-cancel-call", "Review", controller.signal);
  await waitForOperation(runtime);
  controller.abort();
  cancellation.reject(failure);

  await assert.rejects(execution, (error) => error === failure);
});

for (const reason of ["quit", "new", "resume", "fork", "reload"] as const) {
  test(`session shutdown caused by ${reason} cancels the active Operation`, async (context) => {
    const runtime = new PendingRuntime();
    const value = await fixture(runtime);
    context.after(() => rm(value.root, { recursive: true, force: true }));
    void value.execute(`${reason}-call`).catch(() => undefined);
    await waitForOperation(runtime);
    await value.shutdown(reason);

    assert.deepEqual(runtime.cancellations, [
      { operationId: "operation-1", scope: "subtree" },
    ]);
  });
}

test("session shutdown waits for cancellation classification", async (context) => {
  const runtime = new PendingRuntime();
  const classification = deferred<CancellationResult>();
  runtime.cancellationResponse = classification.promise;
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  void value.execute("waiting-call").catch(() => undefined);
  await waitForOperation(runtime);
  let settled = false;
  const shutdown = value.shutdown("quit").then(() => { settled = true; });
  await new Promise(setImmediate);

  assert.equal(settled, false);
  classification.resolve({ cancellationEpoch: 1, state: "cancelled" });
  await shutdown;
});

test("session shutdown cancels every active Operation by its identifier", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  void value.execute("first-call").catch(() => undefined);
  void value.execute("second-call").catch(() => undefined);
  await waitForOperation(runtime, "operation-2");
  await value.shutdown("quit");

  assert.deepEqual(runtime.cancellations, [
    { operationId: "operation-1", scope: "subtree" },
    { operationId: "operation-2", scope: "subtree" },
  ]);
});

test("interruption and shutdown share one cancellation request", async (context) => {
  const runtime = new PendingRuntime();
  const classification = deferred<CancellationResult>();
  runtime.cancellationResponse = classification.promise;
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const controller = new AbortController();
  void value.execute("shared-call", "Review", controller.signal).catch(() => undefined);
  await waitForOperation(runtime);
  controller.abort();
  const shutdown = value.shutdown("quit");
  classification.resolve({ cancellationEpoch: 1, state: "cancelled" });
  await shutdown;

  assert.equal(runtime.cancellations.length, 1);
});

test("a failed terminal Operation is no longer tracked at shutdown", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const execution = value.execute("failed-call");
  await waitForOperation(runtime);
  runtime.results.get("operation-1")?.reject(new OperationFailedError("operation-1", "agent_failed"));
  await execution.catch(() => undefined);
  await value.shutdown("quit");

  assert.equal(runtime.cancellations.length, 0);
});
