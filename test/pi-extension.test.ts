import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  makeTestRuntime,
} from "../src/internal/testing.js";
import {
  installPionsExtension,
  type PionsDelegateDetails,
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
  CleanupDiagnostic,
  OperationHandle,
  OperationReader,
  OperationSnapshot,
  Result,
  Runtime,
  RuntimeReviewSubjectAuthority,
  SpawnOptions,
  StartAuthorizationAuthenticator,
  StartAuthorizationDecisionRequest,
  StartAuthorizationDecisionOutcome,
  TaskSpec,
  WorkerProfilePolicy,
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
  startAuthorization: {
    timing: {
      createdAt: "2026-04-01T00:00:00.000Z",
      windowMs: 60_000,
      deadline: "2026-04-01T00:01:00.000Z",
      configuredPolicy: "required",
      policy: "required",
      authorizedSubjectIds: ["coordinator-1"],
    },
    gate: "waiting",
    receipt: {
      operationId: "operation-1",
      digest: `sha256:${"ef".repeat(32)}`,
      recordedAt: "2026-04-01T00:00:03.000Z",
      workerIdentity: {
        processId: 123,
        processInstanceId: "process-1",
        processStartToken: "start-1",
        piSessionId: "worker-session-1",
        paneId: "pane-1",
      },
      requestedConfig: {
        model: { provider: "anthropic", id: "claude-opus-5" },
        thinkingLevel: "high",
        tools: ["read"],
        cwd: "/repository",
      },
      effectiveConfig: {
        model: { provider: "anthropic", id: "claude-opus-5" },
        thinkingLevel: "high",
        tools: ["read"],
        cwd: "/repository",
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
      workspace: {
        workspaceId: "workspace-1",
        normalizedPath: "/repository",
        baseRevision: "revision-1",
        owner: { state: "unknown" },
        pionsMayDelete: false,
      },
      permissionManifest: {
        manifestId: "manifest-1",
        digest: `sha256:${"cd".repeat(32)}`,
      },
      reviewSubject: {
        artifactId: "artifact-1",
        byteCount: 42,
        digest: `sha256:${"ab".repeat(32)}`,
        format: "pions.review.patch.v1",
        normalization: "identity",
        registrationEvidenceId: "review-subject-evidence-1",
        registrationEvidenceDigest: `sha256:${"12".repeat(32)}`,
      },
      reviewSubjectVerification: "required",
      configuredAuthorizationPolicy: "required",
      authorizationPolicy: "required",
      authorizationDeadline: "2026-04-01T00:01:00.000Z",
    },
    rejectedDecisions: [],
  },
  startDeliveryHandoffs: [],
  cleanupDiagnostics: [{ code: "pane_close_failed" }],
};

class FakeRuntime implements Runtime {
  readonly tasks: Array<TaskSpec> = [];
  readonly spawnOptions: Array<Readonly<SpawnOptions> | undefined> = [];
  spawnCount = 0;
  operationReadCount = 0;
  resultReadCount = 0;
  closeCount = 0;
  readonly authorizationCredentials: Array<string> = [];
  readonly authorizationDecisions: Array<
    Readonly<StartAuthorizationDecisionRequest>
  > = [];

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

  async spawn(
    task: TaskSpec,
    options?: SpawnOptions
  ): Promise<OperationHandle> {
    this.spawnCount += 1;
    this.tasks.push(task);
    this.spawnOptions.push(options);
    const outcome = this.outcome;
    return {
      operationId: "operation-1",
      read: () => Promise.resolve(this.snapshot),
      readResult: () => Promise.reject(new Error("unused")),
      readResultChunk: () => Promise.reject(new Error("unused")),
      waitForStartupReceipt: () => Promise.reject(new Error("unused")),
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
        return Promise.resolve({ kind: "retrieved" as const, result });
      },
      readResultChunk: ({ maxBytes, cursor }) => {
        this.resultReadCount += 1;
        const startByte = cursor === undefined ? 0 : Number(cursor);
        const bytes = Buffer.from(result.body, "utf8");
        const endByte = Math.min(startByte + maxBytes, bytes.byteLength);
        return Promise.resolve({
          kind: "retrieved" as const,
          chunk: {
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
      waitForStartupReceipt: () => Promise.reject(new Error("unused")),
    };
  }

  startAuthorizationInbox(credential: string) {
    this.authorizationCredentials.push(credential);
    return Promise.resolve({
      listWaiting: () => Promise.resolve([]),
      decide: (request: Readonly<StartAuthorizationDecisionRequest>) => {
        this.authorizationDecisions.push(request);
        return Promise.resolve({
          status: "accepted",
          decision: {
            decisionId: request.decisionId,
            actorId: "coordinator-1",
            kind: request.kind,
            receiptDigest: request.receiptDigest,
            decidedAt: "2026-04-01T00:00:04.000Z",
          },
          gate: request.kind === "authorize" ? "authorized" : "rejected",
        } satisfies StartAuthorizationDecisionOutcome);
      },
    });
  }

  revisions(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  resourceProofs(): never {
    throw new Error("unused");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
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
  readonly cancellations: Array<{
    readonly operationId: string;
    readonly scope: "subtree";
  }> = [];
  readonly results = new Map<string, ReturnType<typeof deferred<Result>>>();
  closeCount = 0;
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
      read: () => Promise.reject(new Error("unused")),
      readResult: () => Promise.reject(new Error("unused")),
      readResultChunk: () => Promise.reject(new Error("unused")),
      waitForStartupReceipt: () => Promise.reject(new Error("unused")),
      result: () =>
        result.promise.then((accepted) => ({
          result: accepted,
          cleanupDiagnostics: [],
        })),
      cancel: async ({ scope }) => {
        this.cancellations.push({ operationId, scope });
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

  startAuthorizationInbox(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  revisions(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  resourceProofs(): never {
    throw new Error("unused");
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

const FORMAL_REVIEW_PROFILE: WorkerProfilePolicy = {
  intendedUse: "formal_reviewer",
  modelCandidates: [{ provider: "anthropic", id: "claude-opus-5" }],
  thinkingLevel: "high",
  tools: ["read", "grep", "find", "ls", "bash"],
  resources: { resourceProofPolicy: "disabled" },
  startAuthorization: {
    policy: "required",
    windowMs: 60_000,
    authorizedSubjectIds: ["coordinator-1"],
    receipt: {
      workspace: {
        workspaceId: "workspace-1",
        normalizedPath: "/repository",
        baseRevision: "revision-1",
        owner: { state: "unknown" },
        pionsMayDelete: false,
      },
      permissionManifest: {
        manifestId: "manifest-1",
        digest: `sha256:${"cd".repeat(32)}`,
      },
      reviewSubjectVerification: "required",
    },
  },
  workProductRequirements: {
    body: {
      formatId: "pions.result-body.utf8.v1",
      normalizationId: "identity",
      maxByteCount: 50_000,
    },
    workProducts: [],
    maxTotalByteCount: 50_000,
  },
  acceptedArtifactRetentionMs: 86_400_000,
};

const REVIEW_SUBJECT_AUTHORITY: RuntimeReviewSubjectAuthority = {
  currentUse: async () => "allowed",
};

const START_AUTHORIZATION_AUTHENTICATOR: StartAuthorizationAuthenticator = {
  authenticate: async () => ({
    subjectId: "coordinator-1",
    currentAuthorization: async () => "authorized",
  }),
};

const COORDINATOR_CREDENTIAL = "private-coordinator-credential";

async function fixture<TRuntime extends Runtime = FakeRuntime>(
  runtime: TRuntime = new FakeRuntime() as unknown as TRuntime,
  options: Omit<PionsExtensionOptions, "runtime" | "stateBaseDirectory"> & {
    readonly stateBaseDirectory?: string;
  } = {},
  useDefaultStateDirectory = false,
  fixtureOptions: {
    readonly enableFormalReview?: boolean;
    readonly enableCoordinator?: boolean;
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
    ...(fixtureOptions.enableFormalReview !== false
      ? {
          formalReview: {
            profile: FORMAL_REVIEW_PROFILE,
            reviewSubjectAuthority: REVIEW_SUBJECT_AUTHORITY,
            ...(fixtureOptions.enableCoordinator === false
              ? {}
              : {
                  coordinator: {
                    credential: COORDINATOR_CREDENTIAL,
                    authenticator: START_AUTHORIZATION_AUTHENTICATOR,
                  },
                }),
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
  const review = (
    artifactId = "artifact-1",
    task = "Review the registered change"
  ) => {
    const reviewTool = tools.get("pions_review");
    if (reviewTool === undefined)
      throw new Error("pions_review was not registered");
    return reviewTool.execute(
      "review-call-1",
      { artifactId, task },
      undefined,
      undefined,
      context
    );
  };
  const decide = (
    kind: "authorize" | "reject" = "authorize",
    operationId = "operation-1",
    receiptDigest = `sha256:${"ef".repeat(32)}`
  ) => {
    const decisionTool = tools.get("pions_review_decision");
    if (decisionTool === undefined)
      throw new Error("pions_review_decision was not registered");
    return decisionTool.execute(
      "decision-call-1",
      { operationId, receiptDigest, decision: kind },
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
  return {
    context,
    decide,
    execute,
    inspect,
    registered: tool,
    result,
    review,
    root,
    setSessionId: (value: string) => {
      sessionId = value;
    },
    runtime,
    shutdown,
    tools,
  };
}

test("project extension registers pions_review", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(value.tools.get("pions_review")?.name, "pions_review");
});

test("pions_review accepts only an Artifact identifier and review task", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(value.tools.get("pions_review")?.parameters, {
    type: "object",
    required: ["artifactId", "task"],
    additionalProperties: false,
    properties: {
      artifactId: { type: "string", minLength: 1 },
      task: {
        type: "string",
        minLength: 1,
        description: "Self-contained formal review task",
      },
    },
  });
});

test("pions_review returns the created Operation identifier", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    (await value.review()).content[0]?.text,
    "[Operation: operation-1]"
  );
});

test("pions_review fixes the registered Artifact as the Review subject", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review("artifact-42");

  assert.equal(
    value.runtime.spawnOptions[0]?.reviewSubjectArtifactId,
    "artifact-42"
  );
});

test("pions_review uses the formal reviewer profile", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.equal(value.runtime.tasks[0]?.profile, "formal-review");
});

test("pions_review uses the trusted formal-review model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.deepEqual(value.runtime.tasks[0]?.model, {
    provider: "anthropic",
    id: "claude-opus-5",
  });
});

test("pions_review uses the trusted formal-review thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.equal(value.runtime.tasks[0]?.thinkingLevel, "high");
});

test("pions_review passes the trusted Review subject authority to the Runtime", async (context) => {
  let authority: RuntimeReviewSubjectAuthority | undefined;
  const runtime = new FakeRuntime();
  const value = await fixture(runtime, {
    runtimeFactory: (options) => {
      authority = options.reviewSubjectAuthority;
      return runtime;
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.equal(authority, REVIEW_SUBJECT_AUTHORITY);
});

test("pions_review registers a required Start gate in the Runtime", async (context) => {
  let profile: Readonly<WorkerProfilePolicy> | undefined;
  const runtime = new FakeRuntime();
  const value = await fixture(runtime, {
    runtimeFactory: (options) => {
      profile = options.profiles["formal-review"];
      return runtime;
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.equal(profile?.startAuthorization.policy, "required");
});

test("pions_review fails closed without trusted formal-review configuration", async (context) => {
  const value = await fixture(new FakeRuntime(), {}, false, {
    enableFormalReview: false,
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(
    value.review(),
    (error) =>
      error instanceof WorkerConfigurationError &&
      error.reason === "unsupported_capability"
  );
});

test("pions_review does not wait for the Result", async (context) => {
  const value = await fixture(new PendingRuntime());
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    (await value.review()).content[0]?.text,
    "[Operation: operation-1]"
  );
});

for (const reason of ["quit", "new", "resume", "fork", "reload"] as const) {
  test(`session shutdown caused by ${reason} cancels an active formal review`, async (context) => {
    const runtime = new PendingRuntime();
    const value = await fixture(runtime);
    context.after(() => rm(value.root, { recursive: true, force: true }));
    await value.review();
    await value.shutdown(reason);

    assert.deepEqual(runtime.cancellations, [
      { operationId: "operation-1", scope: "subtree" },
    ]);
  });
}

test("session shutdown does not cancel a completed formal review", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  runtime.results.get("operation-1")?.resolve({
    body: "done",
    byteCount: 4,
    digest: `sha256:${"ab".repeat(32)}`,
  });
  await new Promise(setImmediate);
  await value.shutdown("quit");

  assert.equal(runtime.cancellations.length, 0);
});

test("session shutdown does not cancel a failed formal review", async (context) => {
  const runtime = new PendingRuntime();
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  runtime.results
    .get("operation-1")
    ?.reject(new OperationFailedError("operation-1", "agent_failed"));
  await new Promise(setImmediate);
  await value.shutdown("quit");

  assert.equal(runtime.cancellations.length, 0);
});

test("formal review shutdown keeps the Runtime open until cancellation is classified", async (context) => {
  const runtime = new PendingRuntime();
  const classification = deferred<CancellationResult>();
  runtime.cancellationResponse = classification.promise;
  const value = await fixture(runtime);
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  const shutdown = value.shutdown("quit");
  await new Promise(setImmediate);

  assert.equal(runtime.closeCount, 0);
  classification.resolve({ cancellationEpoch: 1, state: "cancelled" });
  await shutdown;
});

test("project extension registers pions_review_decision", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    value.tools.get("pions_review_decision")?.name,
    "pions_review_decision"
  );
});

test("pions_review_decision accepts no Coordinator identity or credential", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  const parameters = value.tools.get("pions_review_decision")?.parameters as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), [
    "decision",
    "operationId",
    "receiptDigest",
  ]);
});

test("pions_review_decision submits authorization for the owned Operation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  await value.decide("authorize");

  assert.equal(value.runtime.authorizationDecisions[0]?.kind, "authorize");
});

test("pions_review_decision submits rejection for the owned Operation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  await value.decide("reject");

  assert.equal(value.runtime.authorizationDecisions[0]?.kind, "reject");
});

test("pions_review_decision binds the decision to the Operation identifier", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  await value.decide();

  assert.equal(
    value.runtime.authorizationDecisions[0]?.operationId,
    "operation-1"
  );
});

test("pions_review_decision binds the decision to the inspected Startup receipt", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  await value.decide();

  assert.equal(
    value.runtime.authorizationDecisions[0]?.receiptDigest,
    `sha256:${"ef".repeat(32)}`
  );
});

test("pions_review_decision derives a stable decision identifier from the Pi tool call", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  await value.decide();
  await value.decide();

  assert.equal(
    value.runtime.authorizationDecisions[0]?.decisionId,
    value.runtime.authorizationDecisions[1]?.decisionId
  );
});

test("pions_review_decision uses the trusted Coordinator credential", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  await value.decide();

  assert.equal(
    value.runtime.authorizationCredentials[0],
    COORDINATOR_CREDENTIAL
  );
});

test("pions_review_decision returns the Runtime decision outcome", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.equal(
    (await value.decide()).content[0]?.text,
    "[Operation: operation-1; decision: accepted; gate: authorized]"
  );
});

test("pions_review_decision does not expose the Coordinator identity", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.deepEqual((await value.decide()).details, {
    status: "accepted",
    gate: "authorized",
  });
});

test("pions_review_decision fails closed without trusted Coordinator configuration", async (context) => {
  const value = await fixture(new FakeRuntime(), {}, false, {
    enableCoordinator: false,
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  await assert.rejects(
    value.decide(),
    (error) =>
      error instanceof WorkerConfigurationError &&
      error.reason === "unsupported_capability"
  );
});

test("pions_review_decision refuses an Operation not owned by the current session", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(
    value.decide(),
    /Operation is not owned by the current Pi session/u
  );
});

test("pions_review_decision refuses an Operation owned by another Pi session", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  value.setSessionId("pi-session-2");

  await assert.rejects(
    value.decide(),
    /Operation is not owned by the current Pi session/u
  );
});

test("pions_review does not pass the Coordinator credential to the Worker", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("Worker prompt was not stored");

  assert.equal(
    (await readFile(promptRef, "utf8")).includes(COORDINATOR_CREDENTIAL),
    false
  );
});

test("pions_review passes the trusted Start authorization authenticator to the Runtime", async (context) => {
  let authenticator: StartAuthorizationAuthenticator | undefined;
  const runtime = new FakeRuntime();
  const value = await fixture(runtime, {
    runtimeFactory: (options) => {
      authenticator = options.startAuthorizationAuthenticator;
      return runtime;
    },
  });
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.equal(authenticator, START_AUTHORIZATION_AUTHENTICATOR);
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

test("a newly requested formal review has no accepted Start instruction", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.review();

  assert.equal(
    ((await value.inspect()).details as OperationSnapshot)
      .startInstructionAcceptance,
    undefined
  );
});

test("pions_operation returns the persisted Start gate", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    ((await value.inspect()).details as OperationSnapshot).startAuthorization
      .gate,
    "waiting"
  );
});

test("pions_operation returns the authorization deadline", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    ((await value.inspect()).details as OperationSnapshot).startAuthorization
      .timing.deadline,
    "2026-04-01T00:01:00.000Z"
  );
});

test("pions_operation returns the persisted Startup receipt", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    ((await value.inspect()).details as OperationSnapshot).startAuthorization
      .receipt,
    SNAPSHOT.startAuthorization.receipt
  );
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

test("pions_operation returns the fixed Review subject", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    ((await value.inspect()).details as OperationSnapshot).startAuthorization
      .receipt?.reviewSubject,
    SNAPSHOT.startAuthorization.receipt?.reviewSubject
  );
});

test("pions_operation returns Cleanup diagnostics independently", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    ((await value.inspect()).details as OperationSnapshot).cleanupDiagnostics,
    [{ code: "pane_close_failed" }]
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
      { code: "pane_close_failed" },
      { code: "cleanup_record_unavailable" },
    ])
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.deepEqual(
    (
      (await value.execute()).details as PionsDelegateDetails
    ).cleanupDiagnostics.map(({ code }) => code),
    ["pane_close_failed", "cleanup_record_unavailable"]
  );
});

test("cleanup diagnostics do not change the accepted Result body", async (context) => {
  const value = await fixture(
    new FakeRuntime(undefined, [{ code: "pane_close_failed" }])
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    (await value.execute()).content[0]?.text,
    "review complete\n\n[Operation: operation-1]"
  );
});

test("cleanup diagnostics do not change the accepted Result byte count", async (context) => {
  const value = await fixture(
    new FakeRuntime(undefined, [{ code: "pane_close_failed" }])
  );
  context.after(() => rm(value.root, { recursive: true, force: true }));

  assert.equal(
    ((await value.execute()).details as PionsDelegateDetails).byteCount,
    15
  );
});

test("cleanup diagnostics do not change the accepted Result digest", async (context) => {
  const value = await fixture(
    new FakeRuntime(undefined, [{ code: "pane_close_failed" }])
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

test("project configuration overrides the review model", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      review: { model: { provider: "openai", id: "gpt-5.6-codex" } },
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
      review: { model: { provider: "openai", id: "gpt-5.6-codex" } },
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
    JSON.stringify({ review: { thinkingLevel: "low" } })
  );
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.model, {
    provider: "anthropic",
    id: "claude-opus-5",
  });
});

test("project configuration overrides the review thinking level", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({ review: { thinkingLevel: "low" } })
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
      review: {
        model: { provider: "anthropic", id: "claude-opus-5" },
        thinkingLevel: "xhigh",
      },
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
    JSON.stringify({ review: { apiKey: "secret" } })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "unknown_key"
  );
});

test("invalid review model providers are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      review: { model: { provider: "not a provider", id: "model" } },
    })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "invalid_provider"
  );
});

test("invalid review model identifiers are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({
      review: { model: { provider: "anthropic", id: "" } },
    })
  );

  await assert.rejects(
    value.execute(),
    (error) =>
      error instanceof ProjectConfigurationError &&
      error.reason === "invalid_model_id"
  );
});

test("invalid review thinking levels are rejected", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.root, ".pions.json"),
    JSON.stringify({ review: { thinkingLevel: "ultra" } })
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
      review: { model: { provider: "anthropic", id: "missing" } },
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
      review: { model: { provider: "anthropic", id: "claude-opus-5" } },
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
      review: { model: { provider: "anthropic", id: "claude-opus-5" } },
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
      review: { model: { provider: "anthropic", id: "missing" } },
    })
  );
  (value.context.modelRegistry as unknown as { find: () => undefined }).find =
    () => undefined;
  await value.execute().catch(() => undefined);

  assert.equal(value.runtime.spawnCount, 0);
});

test("unsafe Claude bridge MCP configuration fails before an Operation is spawned", async (context) => {
  const runtime = new FakeRuntime();
  const harness = await fixture(runtime);
  await writeFile(
    join(harness.root, ".pions.json"),
    JSON.stringify({
      review: { model: { provider: "claude-bridge", id: "claude-opus-5" } },
    })
  );
  await mkdir(join(harness.root, ".pi"));
  await writeFile(
    join(harness.root, ".pi", "claude-bridge.json"),
    JSON.stringify({
      provider: { strictMcpConfig: false },
    })
  );
  context.after(() => rm(harness.root, { recursive: true, force: true }));
  await harness.execute().catch(() => undefined);

  assert.equal(runtime.spawnCount, 0);
});

test("a Claude bridge version mismatch fails before an Operation is spawned", async (context) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "pions-bridge-version-"));
  const packagePath = join(packageRoot, "package.json");
  await writeFile(
    packagePath,
    JSON.stringify({ name: "pi-claude-bridge", version: "9.9.9" })
  );
  const runtime = new FakeRuntime();
  const harness = await fixture(runtime, {
    claudeBridgePackagePath: packagePath,
  });
  context.after(() =>
    Promise.all([
      rm(harness.root, { recursive: true, force: true }),
      rm(packageRoot, { recursive: true, force: true }),
    ])
  );
  await writeFile(
    join(harness.root, ".pions.json"),
    JSON.stringify({
      review: { model: { provider: "claude-bridge", id: "claude-opus-5" } },
    })
  );

  await assert.rejects(harness.execute(), /version 9\.9\.9.*expected 0\.7\.0/u);
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
  const repository = await mkdtemp(
    join(tmpdir(), "pions-external-repository-")
  );
  const harness = await fixture(new FakeRuntime(), {
    repositoryRoot: repository,
    extensionEntryPath: "missing-worker-extension.js",
    runtimeFactory: () => {
      throw new Error("runtime was created");
    },
  });
  context.after(() => rm(harness.root, { recursive: true, force: true }));
  context.after(() => rm(repository, { recursive: true, force: true }));

  await assert.rejects(
    harness.execute(),
    new RegExp(join(repository, "missing-worker-extension\\.js"))
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
  const repository = await mkdtemp(
    join(tmpdir(), "pions-external-repository-")
  );
  await writeFile(join(repository, "worker-extension.js"), "");
  let extensionEntryPath: string | undefined;
  const runtime = new FakeRuntime();
  const harness = await fixture(runtime, {
    repositoryRoot: repository,
    extensionEntryPath: "worker-extension.js",
    runtimeFactory: (options) => {
      extensionEntryPath = options.extensionEntryPath;
      return runtime;
    },
  });
  context.after(() => rm(harness.root, { recursive: true, force: true }));
  context.after(() => rm(repository, { recursive: true, force: true }));
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

test("delegation limits Worker tools to the review profile", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();

  assert.deepEqual(value.runtime.tasks[0]?.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
  ]);
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

test("Worker prompt begins with a read-oriented role without naming review", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("promptRef missing");

  assert.equal(
    (await readFile(promptRef, "utf8")).startsWith(
      "You are a read-oriented Worker with an independent context.\n"
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

test("Worker prompt states that bash policy is not isolation", async (context) => {
  const value = await fixture();
  context.after(() => rm(value.root, { recursive: true, force: true }));
  await value.execute();
  const promptRef = value.runtime.tasks[0]?.promptRef;
  if (promptRef === undefined) throw new Error("promptRef missing");

  assert.match(
    await readFile(promptRef, "utf8"),
    /bash.*not.*technical isolation/is
  );
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
    { operationId: "operation-1", scope: "subtree" },
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
      { operationId: "operation-1", scope: "subtree" },
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
    { operationId: "operation-1", scope: "subtree" },
    { operationId: "operation-2", scope: "subtree" },
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
  const artifactServices = runtimeArtifactStore(state, store);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "persisted result" },
      successfulExitConfirmed: true,
    }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
    artifacts: artifactServices.artifacts,
    artifactCredential: artifactServices.credential,
    synchronizeArtifactClock: artifactServices.synchronizeClock,
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
