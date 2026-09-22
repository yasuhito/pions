import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { PrivateFileEventStore } from "../src/internal/event-store/index.js";
import type { Operation } from "../src/internal/event-store/index.js";
import { makeResultFormatRegistry } from "../src/internal/result-format-registry.js";
import {
  DEFAULT_MAX_RESULT_BYTE_COUNT,
  DEFAULT_WORKER_PROFILE_POLICY,
} from "../src/internal/worker-configuration.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  advanceTestOperationToRunning,
  makeTestRuntime,
} from "../src/internal/testing.js";
import type {
  WorkerAdapter,
  WorkerRunHooks,
} from "../src/internal/services.js";
import {
  installPionsExtension,
  type PionsDelegateDetails,
  type PionsExtensionOptions,
} from "../src/internal/pi-extension.js";
import type { VisibleRuntimeOptions } from "../src/internal/visible-runtime.js";
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
  CleanupDiagnostic,
  OperationHandle,
  OperationReader,
  OperationSnapshot,
  Result,
  ResultChunk,
  Runtime,
  TaskSpec,
} from "../src/index.js";

const SNAPSHOT: OperationSnapshot = {
  operationId: "operation-1",
  version: { sequenceNumber: 4, recordedAt: "2026-04-01T00:00:03.000Z" },
  state: "starting",
  effectiveConfig: {
    model: { provider: "anthropic", id: "claude-opus-5" },
    thinkingLevel: "high",
    tools: ["read"],
    cwd: "/repository",
    maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
    modelPolicy: {
      candidates: [{ provider: "anthropic", id: "claude-opus-5" }],
      attempted: [{ provider: "anthropic", id: "claude-opus-5" }],
      maxAttempts: 1,
      fallback: "forbidden",
      aliases: [],
    },
  },
  observedConfig: {
    model: {
      state: "observed",
      value: { provider: "anthropic", id: "claude-opus-5" },
    },
    thinkingLevel: { state: "observed", value: "high" },
    tools: { state: "observed", value: ["read"] },
    cwd: { state: "observed", value: "/repository" },
  },
  startDeliveryHandoffs: [],
  cleanupDiagnostics: [{ code: "workspace_close_failed" }],
};

const ACCEPTANCE_ID = `pions.result-acceptance.v1:${"ef".repeat(32)}` as const;

class FakeRuntime implements Runtime {
  readonly tasks: Array<TaskSpec> = [];
  spawnCount = 0;
  operationReadCount = 0;
  resultReadCount = 0;
  closeCount = 0;
  readyCount = 0;
  constructor(
    private readonly outcome: Result | Error = {
      body: "review complete",
      byteCount: 15,
      digest: `sha256:${"ab".repeat(32)}`,
    },
    private readonly cleanupDiagnostics: ReadonlyArray<
      Readonly<CleanupDiagnostic>
    > = [],
    private readonly snapshot: Readonly<OperationSnapshot> = SNAPSHOT
  ) {}

  async spawn(task: TaskSpec): Promise<OperationHandle> {
    this.spawnCount += 1;
    this.tasks.push(task);
    const outcome = this.outcome;
    return {
      operationId: "operation-1",
      read: () => Promise.resolve(this.snapshot),
      readResult: () => Promise.reject(new Error("unused")),
      readResultChunk: () => Promise.reject(new Error("unused")),
      result: () =>
        outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve({
              result: outcome,
              cleanupDiagnostics: this.cleanupDiagnostics,
            }),
      cancel: () =>
        Promise.resolve({ cancellationEpoch: 1, state: "cancelled" }),
    };
  }

  async operation(operationId: string): Promise<OperationReader> {
    this.operationReadCount += 1;
    if (operationId !== "operation-1" || this.outcome instanceof Error) {
      throw new Error("unknown Operation");
    }
    const result = this.outcome;
    return {
      operationId,
      read: () => Promise.resolve(this.snapshot),
      readResult: () => {
        this.resultReadCount += 1;
        return Promise.resolve({
          kind: "retrieved" as const,
          acceptanceId: ACCEPTANCE_ID,
          result,
        });
      },
      readResultChunk: ({ maxBytes, cursor }) => {
        this.resultReadCount += 1;
        const startByte = cursor === undefined ? 0 : Number(cursor);
        const bytes = Buffer.from(result.body, "utf8");
        const endByte = Math.min(startByte + maxBytes, bytes.byteLength);
        return Promise.resolve({
          kind: "retrieved" as const,
          chunk: {
            acceptanceId: ACCEPTANCE_ID,
            body: bytes.subarray(startByte, endByte).toString("utf8"),
            startByte,
            totalByteCount: bytes.byteLength,
            digest: result.digest,
            ...(endByte === bytes.byteLength
              ? {}
              : { nextCursor: String(endByte) }),
          },
        });
      },
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  async ready(): Promise<void> {
    this.readyCount += 1;
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

async function waitForOperation(
  runtime: PendingRuntime,
  operationId = "operation-1"
): Promise<void> {
  while (!runtime.results.has(operationId)) await new Promise(setImmediate);
}

class PendingRuntime implements Runtime {
  readonly cancellations: Array<{ readonly operationId: string }> = [];
  readonly results = new Map<string, ReturnType<typeof deferred<Result>>>();
  closeCount = 0;
  cancellationResponse: Promise<CancellationResult> = Promise.resolve({
    cancellationEpoch: 1,
    state: "cancelled",
  });
  private nextId = 1;

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async spawn(): Promise<OperationHandle> {
    const operationId = `operation-${this.nextId}`;
    this.nextId += 1;
    const result = deferred<Result>();
    this.results.set(operationId, result);
    return {
      operationId,
      read: () => Promise.reject(new Error("unused")),
      readResult: () => Promise.reject(new Error("unused")),
      readResultChunk: () => Promise.reject(new Error("unused")),
      result: () =>
        result.promise.then((accepted) => ({
          result: accepted,
          cleanupDiagnostics: [],
        })),
      cancel: async () => {
        this.cancellations.push({ operationId });
        const response = await this.cancellationResponse;
        result.reject(
          response.state === "unknown"
            ? new OperationUnknownError(operationId, "cancel-unproven")
            : new OperationCancelledError(operationId)
        );
        return response;
      },
    };
  }

  operation(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
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
    params: Readonly<Record<string, string | undefined>>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext
  ): Promise<{
    readonly content: ReadonlyArray<{
      readonly type: string;
      readonly text: string;
    }>;
    readonly details?: unknown;
  }>;
}

const FORMAL_REVIEW_RESULT_FORMATS = makeResultFormatRegistry([
  {
    formatId: "test.formal-review-result",
    version: "1",
    normalizationId: "identity.v1",
    validator: {
      validatorId: "test.formal-review-result-validator",
      validatorVersion: "1",
      implementation: Buffer.from("test validator v1", "utf8"),
      validate: async () => ({ kind: "valid" }),
    },
  },
]);
const FORMAL_REVIEW_RESULT_FORMAT = FORMAL_REVIEW_RESULT_FORMATS.pin({
  formatId: "test.formal-review-result",
  version: "1",
  expectations: { axis: "standards" },
});
const CONFIGURED_FORMAL_REVIEW_RESULT_FORMATS = {
  registry: FORMAL_REVIEW_RESULT_FORMATS,
  resultFormat: FORMAL_REVIEW_RESULT_FORMAT,
};

async function fixture<TRuntime extends Runtime = FakeRuntime>(
  runtime: TRuntime = new FakeRuntime() as unknown as TRuntime,
  options: Omit<PionsExtensionOptions, "runtime" | "stateBaseDirectory"> & {
    readonly stateBaseDirectory?: string;
  } = {},
  useDefaultStateDirectory = false,
  fixtureOptions: {
    readonly enableFormalReview?: boolean;
    readonly registeredProviderIds?: ReadonlyArray<string>;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "pions-extension-"));
  let registered: RegisteredTool | undefined;
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<
    string,
    (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown
  >();
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool as unknown as RegisteredTool;
      tools.set(tool.name, tool as unknown as RegisteredTool);
    },
    on(
      event: string,
      handler: (
        event: unknown,
        context: ExtensionContext
      ) => Promise<unknown> | unknown
    ) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  installPionsExtension(pi, {
    ...(options.runtimeFactory === undefined ? { runtime } : {}),
    ...(fixtureOptions.enableFormalReview === true
      ? {
          formalReview: {
            resultFormats: CONFIGURED_FORMAL_REVIEW_RESULT_FORMATS,
          },
        }
      : {}),
    repositoryRoot: root,
    ...(useDefaultStateDirectory
      ? {}
      : { stateBaseDirectory: join(root, "state") }),
    ...options,
  });
  if (registered === undefined)
    throw new Error("pions_delegate was not registered");
  const tool = registered;
  let sessionId = "pi-session-1";
  const context = {
    cwd: root,
    model: { provider: "anthropic", id: "claude-opus-5" },
    thinkingLevel: "high",
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
      getRegisteredProviderIds: () =>
        fixtureOptions.registeredProviderIds ?? [],
    },
    sessionManager: { getSessionId: () => sessionId },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  const execute = (
    toolCallId = "tool-call-1",
    task = "Review the change",
    signal?: AbortSignal
  ) => tool.execute(toolCallId, { task }, signal, undefined, context);
  const result = (operationId = "operation-1", cursor?: string) => {
    const resultTool = tools.get("pions_result");
    if (resultTool === undefined)
      throw new Error("pions_result was not registered");
    return resultTool.execute(
      "result-call-1",
      { operationId, ...(cursor === undefined ? {} : { cursor }) },
      undefined,
      undefined,
      context
    );
  };
  const inspect = (operationId = "operation-1") => {
    const operationTool = tools.get("pions_operation");
    if (operationTool === undefined)
      throw new Error("pions_operation was not registered");
    return operationTool.execute(
      "operation-call-1",
      { operationId },
      undefined,
      undefined,
      context
    );
  };
  const shutdown = (reason: "quit" | "reload" | "new" | "resume" | "fork") => {
    const handler = handlers.get("session_shutdown");
    if (handler === undefined)
      throw new Error("session_shutdown was not registered");
    return Promise.resolve(
      handler({ type: "session_shutdown", reason }, context)
    );
  };
  const start = () => {
    const handler = handlers.get("session_start");
    if (handler === undefined)
      throw new Error("session_start was not registered");
    return Promise.resolve(handler({ type: "session_start" }, context));
  };
  return {
    context,
    execute,
    inspect,
    registered: tool,
    result,
    start,
    root,
    setSessionId: (value: string) => {
      sessionId = value;
    },
    setWorkingDirectory: (value: string) => {
      (context as { cwd: string }).cwd = value;
    },
    runtime,
    shutdown,
    tools,
  };
}

function formalReviewFixture<TRuntime extends Runtime = FakeRuntime>(
  runtime?: TRuntime,
  options: Parameters<typeof fixture>[1] = {},
  fixtureOptions: Parameters<typeof fixture>[3] = {}
) {
  return fixture(runtime, options, false, {
    enableFormalReview: true,
    ...fixtureOptions,
  });
}

test("the delegation-only extension registers exactly the three delegation tools", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    [...value.tools.keys()],
    ["pions_result", "pions_operation", "pions_delegate"]
  );
});

test("the delegation-only extension does not register pions_review", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(value.tools.has("pions_review"), false);
});

test("the delegation-only extension does not register pions_review_decision", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(value.tools.has("pions_review_decision"), false);
});

test("trusted formal review configuration pauses new review creation", async (context) => {
  const value = await formalReviewFixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(value.tools.has("pions_review"), false);
});

test("trusted formal review configuration cannot create a review profile", async (context) => {
  let profiles: VisibleRuntimeOptions["profiles"] | undefined;
  const value = await formalReviewFixture(undefined, {
    runtimeFactory: (options) => {
      profiles = options.profiles;
      return new FakeRuntime();
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.deepEqual(Object.keys(profiles ?? {}), ["worker"]);
});

test("trusted formal review configuration supplies recovery validators", async (context) => {
  let configured: VisibleRuntimeOptions["formalReviewResultFormats"];
  const value = await formalReviewFixture(undefined, {
    runtimeFactory: (options) => {
      configured = options.formalReviewResultFormats;
      return new FakeRuntime();
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.deepEqual(configured?.resultFormat, FORMAL_REVIEW_RESULT_FORMAT);
});

test("delegation after cold recovery does not recover the same Workers twice", async (context) => {
  const recoveryModes: Array<VisibleRuntimeOptions["recovery"]> = [];
  const value = await fixture(undefined, {
    runtimeFactory: (options) => {
      recoveryModes.push(options.recovery);
      return new FakeRuntime();
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.start();
  await value.execute();

  assert.deepEqual(recoveryModes, [undefined, "disabled"]);
});

test("一時的な復旧失敗後も同じRuntimeが回収を続ける", async (context) => {
  const recoveryModes: Array<VisibleRuntimeOptions["recovery"]> = [];
  let fail = true;
  class FailingOnceRuntime extends FakeRuntime {
    override async ready(): Promise<void> {
      if (fail) {
        fail = false;
        throw new Error("temporary recovery failure");
      }
      await super.ready();
    }
  }
  const value = await fixture(undefined, {
    runtimeFactory: (options) => {
      recoveryModes.push(options.recovery);
      return recoveryModes.length === 1
        ? new FailingOnceRuntime()
        : new FakeRuntime();
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.start().catch(() => undefined);
  await value.execute();

  assert.deepEqual(recoveryModes, [undefined, "disabled"]);
});

test("cold session resumes format-pinned Result acceptance", async (context) => {
  const repository = await realpath(
    await mkdtemp(join(tmpdir(), "pions-cold-repository-"))
  );
  const stateBase = await mkdtemp(join(tmpdir(), "pions-cold-state-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  context.after(() => rm(stateBase, { recursive: true, force: true }));
  const repositoryKey = createHash("sha256")
    .update(repository, "utf8")
    .digest("hex");
  const stateDirectory = join(
    stateBase,
    "pions",
    "repositories",
    repositoryKey,
    "runtime"
  );
  const clock = new FakeClock(
    Array.from(
      { length: 80 },
      (_, index) => `2026-09-23T04:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
  const store = new PrivateFileEventStore(stateDirectory, clock);
  await Effect.runPromise(
    store.create({
      operationId: "operation-1",
      task: {
        promptRef: "private://review",
        profile: "formal-review",
        idempotencyKey: "review-1",
      },
      requestedConfig: {},
      effectiveConfig: {
        model: { provider: "anthropic", id: "claude-opus-5" },
        thinkingLevel: "high",
        tools: ["read"],
        cwd: repository,
        maxResultByteCount: 1024,
        modelPolicy: {
          candidates: [{ provider: "anthropic", id: "claude-opus-5" }],
          attempted: [{ provider: "anthropic", id: "claude-opus-5" }],
          maxAttempts: 1,
          fallback: "forbidden",
          aliases: [],
        },
      },
      maxResultByteCount: 1024,
      resultFormat: FORMAL_REVIEW_RESULT_FORMAT,
    })
  );
  await advanceTestOperationToRunning(store, "operation-1");
  const worker: WorkerAdapter = {
    open: () => {
      throw new Error("new Worker was not requested");
    },
    recover: (operation: Operation) => ({
      run: (hooks: Readonly<WorkerRunHooks>) =>
        Effect.gen(function* () {
          const identity = operation.workerIdentity!;
          const instruction = yield* hooks.workerIdentified({
            processId: identity.processId,
            processInstanceId: identity.processInstanceId,
            processStartToken: identity.processStartToken,
            piSessionId: identity.piSessionId,
            observedConfig: operation.observedConfig!,
          });
          yield* hooks.startDeliveryAuthorityRevoked(
            instruction.dispatcherId,
            instruction.deliveryGeneration
          );
          yield* hooks.deliveryGenerationConfirmed({
            dispatcherId: instruction.dispatcherId,
            deliveryGeneration: instruction.deliveryGeneration,
            acceptanceState: "accepted",
            acceptedInstruction: operation.startInstructionAcceptance!,
          });
          const body = "recovered review";
          const bytes = Buffer.from(body, "utf8");
          const acceptance = yield* hooks.acceptResult({
            acceptanceRequestId: "review-result-1",
            body,
            expectedByteCount: bytes.byteLength,
            expectedDigest: `sha256:${createHash("sha256")
              .update(bytes)
              .digest("hex")}`,
          });
          if (acceptance.state !== "accepted")
            return { state: "worker_protocol_failed" as const };
          return {
            state: "result_acknowledged" as const,
            successfulExitConfirmed: true as const,
            evidence: {
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: 0,
              },
              toolUses: [],
            },
          };
        }),
      cancel: () => Effect.succeed({ proof: "worker-stop" as const }),
    }),
  };
  const value = await formalReviewFixture(undefined, {
    repositoryRoot: repository,
    stateBaseDirectory: stateBase,
    runtimeFactory: (options) =>
      makeTestRuntime({
        worker,
        clock,
        ids: new FakeIdGenerator([]),
        presentation: new FakePresentation(),
        store: new PrivateFileEventStore(options.stateDirectory, clock),
        configuration: { cwd: options.cwd, profiles: options.profiles },
        ...(options.recovery === undefined
          ? {}
          : { recovery: options.recovery }),
        ...(options.formalReviewResultFormats === undefined
          ? {}
          : { formalReviewResultFormats: options.formalReviewResultFormats }),
      }),
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  value.setWorkingDirectory(repository);
  await value.start();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await Effect.runPromise(store.read("operation-1"));
    if (snapshot.operation.state === "completed") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }

  const snapshot = (await value.inspect()).details as OperationSnapshot;
  assert.equal(snapshot.state, "completed");
});

test("project extension registers pions_operation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(value.tools.get("pions_operation")?.name, "pions_operation");
});

test("pions_operation accepts only an Operation identifier", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(value.tools.get("pions_operation")?.parameters, {
    type: "object",
    required: ["operationId"],
    additionalProperties: false,
    properties: { operationId: { type: "string", minLength: 1 } },
  });
});

test("pions_operation returns the persisted Operation snapshot", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual((await value.inspect()).details, SNAPSHOT);
});

test("pions_operation reads an earlier session snapshot through a retrieval Runtime", async (context) => {
  const retrievalRuntime = new FakeRuntime();
  const value = await fixture(undefined, {
    runtimeFactory: () => new FakeRuntime(),
    resultRuntimeFactory: () => retrievalRuntime,
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  value.setSessionId("pi-session-2");
  await value.inspect();

  assert.equal(retrievalRuntime.operationReadCount, 1);
});

test("pions_operation returns the effective model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    ((await value.inspect()).details as OperationSnapshot).effectiveConfig
      .model,
    { provider: "anthropic", id: "claude-opus-5" }
  );
});

test("pions_operation returns the observed model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    ((await value.inspect()).details as OperationSnapshot).observedConfig
      ?.model,
    SNAPSHOT.observedConfig?.model
  );
});

test("pions_operation returns the effective thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    ((await value.inspect()).details as OperationSnapshot).effectiveConfig
      .thinkingLevel,
    "high"
  );
});

test("pions_operation returns the observed thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    ((await value.inspect()).details as OperationSnapshot).observedConfig
      ?.thinkingLevel,
    { state: "observed", value: "high" }
  );
});

test("pions_operation returns Cleanup diagnostics independently", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    ((await value.inspect()).details as OperationSnapshot).cleanupDiagnostics,
    [{ code: "workspace_close_failed" }]
  );
});

test("pions_operation does not read Result bytes", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.inspect();

  assert.equal(value.runtime.resultReadCount, 0);
});

test("pions_operation hides Operations outside the current repository", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(
    value.inspect("other-operation"),
    /Operation is unavailable in the current repository/u
  );
});

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
    properties: {
      task: {
        type: "string",
        minLength: 1,
        description: "Self-contained work to delegate",
      },
    },
  });
});

test("pions_delegate description identifies subagent delegation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.match(
    value.registered.description,
    /pions_delegate.*subagent|subagent.*pions_delegate/i
  );
});

test("pions_delegate prompt guidance identifies isolated delegation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.match(
    `${value.registered.promptSnippet} ${value.registered.promptGuidelines?.join(" ")}`,
    /pions_delegate.*independent context/i
  );
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

  assert.equal(
    (await value.execute()).content[0]?.text,
    "review complete\n\n[Operation: operation-1]"
  );
});

test("successful delegation returns Result diagnostics", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual((await value.execute()).details, {
    operationId: "operation-1",
    byteCount: 15,
    digest: `sha256:${"ab".repeat(32)}`,
    truncated: false,
    cleanupDiagnostics: [],
  });
});

test("successful delegation returns every cleanup failure", async (context) => {
  const value = await fixture(
    new FakeRuntime(undefined, [
      { code: "workspace_close_failed" },
      { code: "cleanup_record_unavailable" },
    ])
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    (
      (await value.execute()).details as PionsDelegateDetails
    ).cleanupDiagnostics.map(({ code }) => code),
    ["workspace_close_failed", "cleanup_record_unavailable"]
  );
});

test("cleanup diagnostics do not change the accepted Result body", async (context) => {
  const value = await fixture(
    new FakeRuntime(undefined, [{ code: "workspace_close_failed" }])
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    (await value.execute()).content[0]?.text,
    "review complete\n\n[Operation: operation-1]"
  );
});

test("cleanup diagnostics do not change the accepted Result byte count", async (context) => {
  const value = await fixture(
    new FakeRuntime(undefined, [{ code: "workspace_close_failed" }])
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    ((await value.execute()).details as PionsDelegateDetails).byteCount,
    15
  );
});

test("cleanup diagnostics do not change the accepted Result digest", async (context) => {
  const value = await fixture(
    new FakeRuntime(undefined, [{ code: "workspace_close_failed" }])
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    ((await value.execute()).details as PionsDelegateDetails).digest,
    `sha256:${"ab".repeat(32)}`
  );
});

test("a truncated tool Result stays within Pi's byte limit", async (context) => {
  const body = `${"x".repeat(99)}\n`.repeat(1_000);
  const value = await fixture(
    new FakeRuntime({
      body,
      byteCount: Buffer.byteLength(body),
      digest: `sha256:${"ab".repeat(32)}`,
    })
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.ok(
    Buffer.byteLength((await value.execute()).content[0]?.text ?? "") <=
      DEFAULT_MAX_BYTES
  );
});

test("a truncated tool Result stays within Pi's line limit", async (context) => {
  const body = "finding\n".repeat(3_000);
  const value = await fixture(
    new FakeRuntime({
      body,
      byteCount: Buffer.byteLength(body),
      digest: `sha256:${"ab".repeat(32)}`,
    })
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.ok(
    ((await value.execute()).content[0]?.text.split("\n").length ?? 0) <=
      DEFAULT_MAX_LINES
  );
});

test("a truncated tool Result identifies its complete persisted Operation", async (context) => {
  const body = "finding\n".repeat(3_000);
  const value = await fixture(
    new FakeRuntime({
      body,
      byteCount: Buffer.byteLength(body),
      digest: `sha256:${"ab".repeat(32)}`,
    })
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.match(
    (await value.execute()).content[0]?.text ?? "",
    /truncated.*Operation: operation-1/is
  );
});

test("delegation inherits the exact Pi model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.model, {
    provider: "anthropic",
    id: "claude-opus-5",
  });
});

test("delegation inherits the exact Pi thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.thinkingLevel, "high");
});

test("project configuration overrides the Worker model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "openai", id: "gpt-5.6-codex" },
    })
  );
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.model, {
    provider: "openai",
    id: "gpt-5.6-codex",
  });
});

test("model-only project configuration inherits the Pi thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "openai", id: "gpt-5.6-codex" },
    })
  );
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.thinkingLevel, "high");
});

test("thinking-only project configuration inherits the Pi model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({ thinkingLevel: "low" })
  );
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.model, {
    provider: "anthropic",
    id: "claude-opus-5",
  });
});

test("project configuration overrides the Worker thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({ thinkingLevel: "low" })
  );
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.thinkingLevel, "low");
});

test("project configuration applies model and thinking level together", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "anthropic", id: "claude-opus-5" },
      thinkingLevel: "xhigh",
    })
  );
  await value.execute();

  assert.deepEqual(
    {
      model: value.runtime.tasks[0]?.model,
      thinkingLevel: value.runtime.tasks[0]?.thinkingLevel,
    },
    {
      model: { provider: "anthropic", id: "claude-opus-5" },
      thinkingLevel: "xhigh",
    }
  );
});

test("malformed project configuration is rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.root, ".pions.json"), "{");

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "invalid_json"
  );
});

test("unknown project configuration keys are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({ apiKey: "secret" })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "unknown_key"
  );
});

test("the legacy review project configuration form is rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      review: {
        model: { provider: "anthropic", id: "claude-opus-5" },
        thinkingLevel: "high",
      },
    })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "unknown_key"
  );
});

test("the legacy review project configuration form does not spawn a Worker", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({ review: { thinkingLevel: "high" } })
  );
  await value.execute().catch(() => undefined);

  assert.equal(value.runtime.spawnCount, 0);
});

test("project configuration cannot select formal review authority or enablement", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      formalReview: {
        adapterPath: "./untrusted-adapter.js",
        credential: "secret",
        profile: { tools: ["bash"] },
        enabled: true,
      },
    })
  );

  await assert.rejects(value.execute(), {
    name: "ProjectConfigurationError",
    reason: "unknown_key",
  });
});

test("invalid Worker model providers are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "not a provider", id: "model" },
    })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "invalid_provider"
  );
});

test("invalid Worker model identifiers are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "anthropic", id: "" },
    })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "invalid_model_id"
  );
});

test("invalid Worker thinking levels are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({ thinkingLevel: "ultra" })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "invalid_thinking_level"
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
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "anthropic", id: "missing" },
    })
  );
  (value.context.modelRegistry as unknown as { find: () => undefined }).find =
    () => undefined;

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof WorkerConfigurationError &&
      error.reason === "model_not_found"
  );
});

test("an unauthenticated configured model returns a typed failure", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "anthropic", id: "claude-opus-5" },
    })
  );
  (
    value.context.modelRegistry as unknown as {
      hasConfiguredAuth: () => boolean;
    }
  ).hasConfiguredAuth = () => false;

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof WorkerConfigurationError &&
      error.reason === "model_auth_unavailable"
  );
});

test("a configured model mismatch reaches the parent unchanged", async (context) => {
  const failure = new OperationFailedError("operation-7", "model_mismatch");
  const value = await fixture(new FakeRuntime(failure));
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "anthropic", id: "claude-opus-5" },
    })
  );

  await assert.rejects(value.execute(), (error) => error === failure);
});

test("configured model failure does not fall back to the delegating model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "anthropic", id: "missing" },
    })
  );
  (value.context.modelRegistry as unknown as { find: () => undefined }).find =
    () => undefined;
  await value.execute().catch(() => undefined);

  assert.equal(value.runtime.spawnCount, 0);
});

test("a configured model provider registered by a Pi extension is rejected before spawning", async (context) => {
  const value = await fixture(new FakeRuntime(), {}, false, {
    registeredProviderIds: ["claude-bridge"],
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "claude-bridge", id: "claude-opus-5" },
    })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof WorkerConfigurationError &&
      error.reason === "unsupported_capability"
  );
});

test("an inherited model provider registered by a Pi extension is rejected before spawning", async (context) => {
  const value = await fixture(new FakeRuntime(), {}, false, {
    registeredProviderIds: ["anthropic"],
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute().catch(() => undefined);

  assert.equal(value.runtime.spawnCount, 0);
});

test("a model provider registered by a Pi extension does not fall back to another provider", async (context) => {
  const value = await fixture(new FakeRuntime(), {}, false, {
    registeredProviderIds: ["claude-bridge"],
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      model: { provider: "claude-bridge", id: "claude-opus-5" },
    })
  );
  await value.execute().catch(() => undefined);

  assert.equal(value.runtime.spawnCount, 0);
});

test("delegation resolves the default Worker extension from the Pions distribution", async (context) => {
  let extensionEntryPath: string | undefined;
  const runtime = new FakeRuntime();
  const harness = await fixture(runtime, {
    runtimeFactory: (options) => {
      extensionEntryPath = options.extensionEntryPath;
      return runtime;
    },
  });
  context.after(() => rm(harness.root, { recursive: true, force: true }));
  await harness.execute();

  assert.equal(
    extensionEntryPath,
    fileURLToPath(new URL("../src/worker-extension.js", import.meta.url))
  );
});

test("delegation reports the absolute path of a missing Worker extension before runtime creation", async (context) => {
  const harness = await fixture(new FakeRuntime(), {
    extensionEntryPath: "missing-worker-extension.js",
    runtimeFactory: () => {
      throw new Error("runtime was created");
    },
  });
  context.after(() => rm(harness.root, { recursive: true, force: true }));

  await assert.rejects(
    harness.execute(),
    new RegExp(join(harness.root, "missing-worker-extension\\.js"))
  );
});

test("delegation preserves an explicit Worker extension entry", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pions-worker-entry-"));
  const explicitEntryPath = join(directory, "worker-extension.js");
  await writeFile(explicitEntryPath, "");
  let extensionEntryPath: string | undefined;
  const runtime = new FakeRuntime();
  const harness = await fixture(runtime, {
    extensionEntryPath: explicitEntryPath,
    runtimeFactory: (options) => {
      extensionEntryPath = options.extensionEntryPath;
      return runtime;
    },
  });
  context.after(() => rm(harness.root, { recursive: true, force: true }));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await harness.execute();

  assert.equal(extensionEntryPath, explicitEntryPath);
});

test("delegation validates a relative Worker extension from the Worker cwd", async (context) => {
  let extensionEntryPath: string | undefined;
  const runtime = new FakeRuntime();
  const harness = await fixture(runtime, {
    extensionEntryPath: "worker-extension.js",
    runtimeFactory: (options) => {
      extensionEntryPath = options.extensionEntryPath;
      return runtime;
    },
  });
  await writeFile(join(harness.root, "worker-extension.js"), "");
  context.after(() => rm(harness.root, { recursive: true, force: true }));
  await harness.execute();

  assert.equal(extensionEntryPath, "worker-extension.js");
});

test("delegation revalidates the Worker extension before reusing a runtime", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pions-worker-entry-"));
  const explicitEntryPath = join(directory, "worker-extension.js");
  await writeFile(explicitEntryPath, "");
  const runtime = new FakeRuntime();
  const harness = await fixture(runtime, {
    extensionEntryPath: explicitEntryPath,
    runtimeFactory: () => runtime,
  });
  context.after(() => rm(harness.root, { recursive: true, force: true }));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await harness.execute("first-call");
  await unlink(explicitEntryPath);

  await assert.rejects(
    harness.execute("second-call"),
    /Pions Worker extension entry is unavailable/
  );
});

test("delegation provides the general Worker tools", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.tools, [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
    "ls",
  ]);
});

test("delegation does not provide pions_delegate to the Worker", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.equal(
    value.runtime.tasks[0]?.tools?.includes("pions_delegate"),
    false
  );
});

test("delegation uses the general Worker profile", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.profile, "worker");
});

test("the Worker profile allows only built-in tools", async (context) => {
  let profiles: VisibleRuntimeOptions["profiles"] | undefined;
  const runtime = new FakeRuntime();
  const value = await fixture(runtime, {
    runtimeFactory: (options) => {
      profiles = options.profiles;
      return runtime;
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.deepEqual(profiles?.worker?.tools, ["read", "write", "edit", "bash", "grep", "find", "ls"]);
});

test("the Worker runs in the delegating working directory", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const workingDirectory = join(value.root, "packages", "app");
  await mkdir(workingDirectory, { recursive: true });
  value.setWorkingDirectory(workingDirectory);
  await value.execute();

  assert.equal(value.runtime.tasks[0]?.cwd, await realpath(workingDirectory));
});

test("a later tool call inherits a newly selected Pi model", async (context) => {
  const configuredModels: Array<unknown> = [];
  const runtime = new FakeRuntime();
  const value = await fixture(runtime, {
    runtimeFactory: (options) => {
      configuredModels.push(options.profiles.worker?.modelCandidates[0]);
      return runtime;
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute("first-call");
  (
    value.context as unknown as { model: { provider: string; id: string } }
  ).model = {
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

  assert.equal(
    JSON.stringify(value.runtime.tasks[0]).includes("secret review request"),
    false
  );
});

test("Worker prompt begins with a general-purpose role without naming review", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("promptRef missing");

  assert.equal(
    (await readFile(promptRef, "utf8")).startsWith(
      "You are a general-purpose Worker with an independent context.\n"
    ),
    true
  );
});

test("Worker prompt instructions do not assign a review role", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("promptRef missing");
  const instructions =
    (await readFile(promptRef, "utf8")).split("\n\nTask:\n", 1)[0] ?? "";

  assert.doesNotMatch(instructions, /\breview(?:er)?\b/i);
});

test("Worker prompt names the general Worker tools", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("promptRef missing");

  assert.match(
    await readFile(promptRef, "utf8"),
    /^Use only read, write, edit, bash, grep, find, ls\.$/m
  );
});

test("Worker prompt forbids further delegation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("promptRef missing");

  assert.match(await readFile(promptRef, "utf8"), /cannot delegate further/u);
});

test("the same Pi tool call derives the same idempotency key", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute("same-call");
  await value.execute("same-call");

  assert.equal(
    value.runtime.tasks[0]?.idempotencyKey,
    value.runtime.tasks[1]?.idempotencyKey
  );
});

test("different Pi tool calls derive different idempotency keys", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute("first-call");
  await value.execute("second-call");

  assert.notEqual(
    value.runtime.tasks[0]?.idempotencyKey,
    value.runtime.tasks[1]?.idempotencyKey
  );
});

test("XDG state directory is respected", async (context) => {
  const value = await fixture(
    new FakeRuntime(),
    {
      environment: { XDG_STATE_HOME: join(tmpdir(), "pions-xdg-test") },
    },
    true
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));
  context.after(() =>
    rm(join(tmpdir(), "pions-xdg-test"), { recursive: true, force: true })
  );
  await value.execute();

  assert.equal(
    value.runtime.tasks[0]?.promptRef.startsWith(
      join(tmpdir(), "pions-xdg-test", "pions")
    ),
    true
  );
});

test("default state directory follows the user state convention", async (context) => {
  const home = join(tmpdir(), "pions-home-test");
  const value = await fixture(
    new FakeRuntime(),
    {
      environment: {},
      homeDirectory: home,
    },
    true
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));
  context.after(() => rm(home, { recursive: true, force: true }));
  await value.execute();

  assert.equal(
    value.runtime.tasks[0]?.promptRef.startsWith(
      join(home, ".local", "state", "pions")
    ),
    true
  );
});

test("repository state identifier does not disclose the repository name", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "secret-repository-name-"));
  const stateBase = join(tmpdir(), "pions-opaque-state-test");
  const value = await fixture(new FakeRuntime(), {
    repositoryRoot: repository,
    stateBaseDirectory: stateBase,
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  context.after(() => rm(repository, { recursive: true, force: true }));
  context.after(() => rm(stateBase, { recursive: true, force: true }));
  await value.execute();

  assert.equal(
    value.runtime.tasks[0]?.promptRef.includes("secret-repository-name"),
    false
  );
});

test("typed Worker failure reaches the parent unchanged", async (context) => {
  const failure = new OperationFailedError("operation-7", "agent_failed");
  const value = await fixture(new FakeRuntime(failure));
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(value.execute(), (error) => error === failure);
});

test("Worker failure is not retried", async (context) => {
  const runtime = new FakeRuntime(
    new OperationFailedError("operation-7", "agent_failed")
  );
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
  const execution = value.execute(
    "interrupted-call",
    "Review",
    controller.signal
  );
  void execution.catch(() => undefined);
  await waitForOperation(runtime);
  controller.abort();
  await execution.catch(() => undefined);

  assert.deepEqual(runtime.cancellations, [
    { operationId: "operation-1" },
  ]);
});

test("an Operation completed before interruption is not cancelled", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const controller = new AbortController();
  const execution = value.execute(
    "completed-call",
    "Review",
    controller.signal
  );
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
    (error) =>
      error instanceof OperationUnknownError &&
      error.operationId === "operation-1"
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
  const execution = value.execute(
    "failed-cancel-call",
    "Review",
    controller.signal
  );
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
      { operationId: "operation-1" },
    ]);
  });
}

test("a tool call after session shutdown does not create a Runtime", async (context) => {
  let runtimeCreations = 0;
  const value = await fixture(new FakeRuntime(), {
    runtimeFactory: () => {
      runtimeCreations += 1;
      return new FakeRuntime();
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.shutdown("reload");

  await value.execute().catch(() => undefined);

  assert.equal(runtimeCreations, 0);
});

for (const reason of ["quit", "new", "resume", "fork", "reload"] as const) {
  test(`session shutdown caused by ${reason} closes the Runtime`, async (context) => {
    const value = await fixture();
    context.after(() => rm(value.root, { recursive: true, force: true }));
    await value.execute();

    await value.shutdown(reason);

    assert.equal(value.runtime.closeCount, 1);
  });
}

test("session shutdown closes every Runtime used by the extension instance", async (context) => {
  const runtimes = [new FakeRuntime(), new FakeRuntime()];
  let nextRuntime = 0;
  const value = await fixture(runtimes[0], {
    runtimeFactory: () => runtimes[nextRuntime++]!,
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute("first-call");
  (
    value.context as unknown as { model: { provider: string; id: string } }
  ).model = {
    provider: "openai",
    id: "gpt-5.6-codex",
  };
  await value.execute("second-call");

  await value.shutdown("reload");

  assert.equal(
    runtimes.reduce((count, runtime) => count + runtime.closeCount, 0),
    2
  );
});

test("session shutdown closes the Runtime when cancellation classification fails", async (context) => {
  const runtime = new PendingRuntime();
  const classification = deferred<CancellationResult>();
  runtime.cancellationResponse = classification.promise;
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  void value.execute("failed-shutdown-call").catch(() => undefined);
  await waitForOperation(runtime);
  const shutdown = value.shutdown("reload").catch(() => undefined);

  classification.reject(new Error("cancellation dispatch failed"));
  await shutdown;

  assert.equal(runtime.closeCount, 1);
});

test("session shutdown waits for cancellation classification", async (context) => {
  const runtime = new PendingRuntime();
  const classification = deferred<CancellationResult>();
  runtime.cancellationResponse = classification.promise;
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  void value.execute("waiting-call").catch(() => undefined);
  await waitForOperation(runtime);
  let settled = false;
  const shutdown = value.shutdown("quit").then(() => {
    settled = true;
  });
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
    { operationId: "operation-1" },
    { operationId: "operation-2" },
  ]);
});

test("concurrent tool calls return distinct Operation identifiers", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const first = value.execute("first-call");
  const second = value.execute("second-call");
  await waitForOperation(runtime, "operation-2");
  const result = {
    body: "complete",
    byteCount: 8,
    digest: `sha256:${"ab".repeat(32)}` as const,
  };
  runtime.results.get("operation-1")?.resolve(result);
  runtime.results.get("operation-2")?.resolve(result);

  assert.notEqual(
    ((await first).details as PionsDelegateDetails).operationId,
    ((await second).details as PionsDelegateDetails).operationId
  );
});

test("one concurrent failure does not discard the other accepted Result", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const accepted = value.execute("accepted-call");
  const failed = value.execute("failed-call");
  const outcomes = Promise.allSettled([accepted, failed]);
  await waitForOperation(runtime, "operation-2");
  runtime.results.get("operation-1")?.resolve({
    body: "Standards review",
    byteCount: 16,
    digest: `sha256:${"ab".repeat(32)}`,
  });
  runtime.results
    .get("operation-2")
    ?.reject(new OperationFailedError("operation-2", "agent_failed"));
  const settled = await outcomes;
  const acceptedOutcome = settled.find(
    (outcome) => outcome.status === "fulfilled"
  );

  assert.equal(
    acceptedOutcome?.status === "fulfilled"
      ? acceptedOutcome.value.content[0]?.text
      : undefined,
    "Standards review\n\n[Operation: operation-1]"
  );
});

test("interruption and shutdown share one cancellation request", async (context) => {
  const runtime = new PendingRuntime();
  const classification = deferred<CancellationResult>();
  runtime.cancellationResponse = classification.promise;
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const controller = new AbortController();
  void value
    .execute("shared-call", "Review", controller.signal)
    .catch(() => undefined);
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
  runtime.results
    .get("operation-1")
    ?.reject(new OperationFailedError("operation-1", "agent_failed"));
  await execution.catch(() => undefined);
  await value.shutdown("quit");

  assert.equal(runtime.cancellations.length, 0);
});

test("project extension registers pions_result", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(value.tools.get("pions_result")?.name, "pions_result");
});

test("pions_result accepts only an Operation identifier and optional cursor", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(value.tools.get("pions_result")?.parameters, {
    type: "object",
    required: ["operationId"],
    additionalProperties: false,
    properties: {
      operationId: { type: "string", minLength: 1 },
      cursor: { type: "string", minLength: 1 },
    },
  });
});

test("pions_result retrieves the first persisted Result chunk", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.match(
    (await value.result()).content[0]?.text ?? "",
    /^review complete/
  );
});

test("pions_result identifies the Result acceptance for its chunk", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    ((await value.result()).details as ResultChunk).acceptanceId,
    ACCEPTANCE_ID
  );
});

test("pions_result retrieves the next persisted Result chunk", async (context) => {
  const body = "x".repeat(DEFAULT_MAX_LINES * 2);
  const value = await fixture(
    new FakeRuntime({
      body,
      byteCount: Buffer.byteLength(body),
      digest: `sha256:${"ab".repeat(32)}`,
    })
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const first = await value.result();
  const cursor = (first.details as { readonly nextCursor?: string }).nextCursor;
  if (cursor === undefined) throw new Error("Missing cursor");

  assert.equal(
    (
      (await value.result("operation-1", cursor)).details as {
        readonly startByte: number;
      }
    ).startByte,
    Number(cursor)
  );
});

test("pions_result output stays within Pi's byte limit", async (context) => {
  const body = "x".repeat(DEFAULT_MAX_BYTES * 2);
  const value = await fixture(
    new FakeRuntime({
      body,
      byteCount: Buffer.byteLength(body),
      digest: `sha256:${"ab".repeat(32)}`,
    })
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.ok(
    Buffer.byteLength((await value.result()).content[0]?.text ?? "") <=
      DEFAULT_MAX_BYTES
  );
});

test("pions_result output stays within Pi's line limit", async (context) => {
  const body = "x\n".repeat(DEFAULT_MAX_LINES * 2);
  const value = await fixture(
    new FakeRuntime({
      body,
      byteCount: Buffer.byteLength(body),
      digest: `sha256:${"ab".repeat(32)}`,
    })
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.ok(
    ((await value.result()).content[0]?.text.split("\n").length ?? 0) <=
      DEFAULT_MAX_LINES
  );
});

test("pions_result hides Operations outside the current repository", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(
    value.result("other-operation"),
    /unavailable in the current repository/
  );
});

test("pions_result closes its temporary retrieval Runtime", async (context) => {
  const retrievalRuntime = new FakeRuntime();
  const value = await fixture(new FakeRuntime(), {
    runtimeFactory: () => new FakeRuntime(),
    resultRuntimeFactory: () => retrievalRuntime,
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.result();

  assert.equal(retrievalRuntime.closeCount, 1);
});

test("pions_result retrieves a persisted Result after Pi session restart", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "pions-result-repository-"));
  const stateBase = await mkdtemp(join(tmpdir(), "pions-result-state-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  context.after(() => rm(stateBase, { recursive: true, force: true }));
  const repositoryKey = createHash("sha256")
    .update(repository, "utf8")
    .digest("hex");
  const state = join(
    stateBase,
    "pions",
    "repositories",
    repositoryKey,
    "runtime"
  );
  const timestamps = Array.from(
    { length: 30 },
    (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
  );
  const clock = new FakeClock(timestamps);
  const store = new PrivateFileEventStore(state, clock);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "persisted result" },
      successfulExitConfirmed: true,
    }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  await runtime.close();
  const value = await fixture(new FakeRuntime(), {
    repositoryRoot: repository,
    stateBaseDirectory: stateBase,
    runtimeFactory: () => new FakeRuntime(),
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.match(
    (await value.result()).content[0]?.text ?? "",
    /^persisted result/
  );
});

async function persistedFilesContain(
  root: string,
  expected: string
): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await persistedFilesContain(path, expected)) return true;
      continue;
    }
    if ((await readFile(path, "utf8")).includes(expected)) return true;
  }
  return false;
}

test("shared-workspace file changes are not copied into Pions persistence", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "pions-shared-workspace-"));
  const state = await mkdtemp(join(tmpdir(), "pions-shared-state-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  context.after(() => rm(state, { recursive: true, force: true }));
  const sentinel = "ordinary workspace mutation 31d245f7";
  const clock = new FakeClock(
    Array.from(
      { length: 30 },
      (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({ successfulExitConfirmed: true }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new PrivateFileEventStore(state, clock),
    configuration: {
      cwd: workspace,
      profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
    },
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await writeFile(join(workspace, "worker-change.txt"), sentinel, "utf8");
  await handle.result();
  await runtime.close();

  assert.equal(await persistedFilesContain(state, sentinel), false);
});
