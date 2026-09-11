import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { makeResultRetrievalRuntime } from "./result-runtime.js";
import { makeVisibleRuntime } from "./visible-runtime.js";
import { BODY_ONLY_WORK_PRODUCT_REQUIREMENTS } from "./worker-configuration.js";
import {
  resolveClaudeBridgeExtension,
  resolveWorkerExtensionEntryPath,
  validateClaudeBridgePolicy,
} from "./worker-extension-entry.js";
import {
  OperationCancelledError,
  OperationUnknownError,
  ProjectConfigurationError,
  WorkerConfigurationError,
} from "../public.js";
import type {
  CancellationResult,
  CleanupDiagnostic,
  ModelReference,
  OperationCompletion,
  OperationHandle,
  Runtime,
  RuntimeReviewSubjectAuthority,
  StartAuthorizationAuthenticator,
  ThinkingLevel,
  WorkerProfilePolicy,
} from "../public.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REVIEW_PROFILE = "review";
const FORMAL_REVIEW_PROFILE = "formal-review";
const REVIEW_TOOLS = Object.freeze(["read", "grep", "find", "ls", "bash"]);
const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const PROJECT_CONFIG_FILE = ".pions.json";
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

interface ReviewProjectConfig {
  readonly model?: Readonly<ModelReference>;
  readonly thinkingLevel?: ThinkingLevel;
}

const DelegateParameters = Type.Object(
  {
    task: Type.String({
      minLength: 1,
      description: "Self-contained work to delegate",
    }),
  },
  { additionalProperties: false }
);

const FormalReviewParameters = Type.Object(
  {
    artifactId: Type.String({ minLength: 1 }),
    task: Type.String({
      minLength: 1,
      description: "Self-contained formal review task",
    }),
  },
  { additionalProperties: false }
);

const OperationParameters = Type.Object(
  { operationId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

const FormalReviewDecisionParameters = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
    receiptDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    decision: Type.Union([Type.Literal("authorize"), Type.Literal("reject")]),
  },
  { additionalProperties: false }
);

const ResultParameters = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

// A one-byte line is the worst case, so this byte budget also leaves four
// lines for the body boundary and continuation metadata.
const RESULT_TOOL_CHUNK_BYTES = DEFAULT_MAX_LINES - 4;

export interface PionsDelegateDetails {
  readonly operationId: string;
  readonly byteCount: number;
  readonly digest: `sha256:${string}`;
  readonly truncated: boolean;
  readonly cleanupDiagnostics: ReadonlyArray<Readonly<CleanupDiagnostic>>;
}

export interface PionsExtensionOptions {
  readonly runtime?: Runtime;
  readonly runtimeFactory?: typeof makeVisibleRuntime;
  readonly resultRuntimeFactory?: typeof makeResultRetrievalRuntime;
  readonly formalReview?: Readonly<{
    readonly profile: Readonly<WorkerProfilePolicy>;
    readonly reviewSubjectAuthority: RuntimeReviewSubjectAuthority;
    readonly coordinator?: Readonly<{
      readonly credential: string;
      readonly authenticator: StartAuthorizationAuthenticator;
    }>;
  }>;
  readonly repositoryRoot?: string;
  readonly stateBaseDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly extensionEntryPath?: string;
  readonly claudeBridgePackagePath?: string;
}

function opaqueDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function repositoryRoot(cwd: string): Promise<string> {
  let current = await realpath(cwd);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (await pathExists(join(current, ".git"))) return current;
    if (current === filesystemRoot) return await realpath(cwd);
    current = dirname(current);
  }
}

function userStateDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  home: string
): string {
  const configured = environment.XDG_STATE_HOME;
  return configured !== undefined && isAbsolute(configured)
    ? configured
    : join(home, ".local", "state");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(path, DIRECTORY_MODE);
}

async function writePrivatePrompt(path: string, body: string): Promise<void> {
  await privateDirectory(dirname(path));
  try {
    await writeFile(path, body, {
      encoding: "utf8",
      mode: FILE_MODE,
      flag: "wx",
    });
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    )) {
      throw error;
    }
  }
  await chmod(path, FILE_MODE);
}

function selectedModel(context: ExtensionContext): ModelReference {
  if (context.model === undefined) {
    throw new WorkerConfigurationError(
      "model_mismatch",
      "The delegating Pi session has no selected model"
    );
  }
  return { provider: context.model.provider, id: context.model.id };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKnownKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
  location: string
): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) {
    throw new ProjectConfigurationError(
      "unknown_key",
      `Unknown key ${JSON.stringify(unknown)} in ${location}`
    );
  }
}

function decodeProjectConfig(source: string): ReviewProjectConfig {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    throw new ProjectConfigurationError(
      "invalid_json",
      `${PROJECT_CONFIG_FILE} is not valid JSON`
    );
  }
  if (!isRecord(decoded)) {
    throw new ProjectConfigurationError(
      "invalid_shape",
      `${PROJECT_CONFIG_FILE} must contain an object`
    );
  }
  requireKnownKeys(decoded, ["review"], PROJECT_CONFIG_FILE);
  const review = decoded.review;
  if (!isRecord(review)) {
    throw new ProjectConfigurationError(
      "invalid_shape",
      "review must contain an object"
    );
  }
  requireKnownKeys(review, ["model", "thinkingLevel"], "review");

  let model: ModelReference | undefined;
  if (review.model !== undefined) {
    if (!isRecord(review.model)) {
      throw new ProjectConfigurationError(
        "invalid_shape",
        "review.model must contain an object"
      );
    }
    requireKnownKeys(review.model, ["provider", "id"], "review.model");
    if (
      typeof review.model.provider !== "string" ||
      !PROVIDER_PATTERN.test(review.model.provider)
    ) {
      throw new ProjectConfigurationError(
        "invalid_provider",
        "review.model.provider is invalid"
      );
    }
    if (
      typeof review.model.id !== "string" ||
      !MODEL_ID_PATTERN.test(review.model.id)
    ) {
      throw new ProjectConfigurationError(
        "invalid_model_id",
        "review.model.id is invalid"
      );
    }
    model = { provider: review.model.provider, id: review.model.id };
  }

  if (
    review.thinkingLevel !== undefined &&
    !isThinkingLevel(review.thinkingLevel)
  ) {
    throw new ProjectConfigurationError(
      "invalid_thinking_level",
      "review.thinkingLevel is invalid"
    );
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(review.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: review.thinkingLevel }),
  };
}

async function projectConfig(
  root: string
): Promise<ReviewProjectConfig | undefined> {
  try {
    return decodeProjectConfig(
      await readFile(join(root, PROJECT_CONFIG_FILE), "utf8")
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

function configuredModel(
  context: ExtensionContext,
  model: Readonly<ModelReference>
): ModelReference {
  const registered = context.modelRegistry.find(model.provider, model.id);
  if (registered === undefined) {
    throw new WorkerConfigurationError(
      "model_not_found",
      `Configured review model ${model.provider}/${model.id} was not found`
    );
  }
  if (!context.modelRegistry.hasConfiguredAuth(registered)) {
    throw new WorkerConfigurationError(
      "model_auth_unavailable",
      `Configured review model provider ${model.provider} is not authenticated`
    );
  }
  return { provider: registered.provider, id: registered.id };
}

function selectedThinkingLevel(context: ExtensionContext): ThinkingLevel {
  if (!isThinkingLevel(context.thinkingLevel)) {
    throw new WorkerConfigurationError(
      "unsupported_capability",
      "The delegating Pi session has no supported thinking level"
    );
  }
  return context.thinkingLevel;
}

function workerPrompt(task: string): string {
  return [
    "You are a read-oriented Worker with an independent context.",
    "Follow the trusted project's AGENTS.md instructions.",
    "Do not load skills, extensions, or prompt templates.",
    "Use only read, grep, find, ls, and bash. Use bash only for read-only investigation.",
    "The bash policy is an instruction, not technical isolation or a security sandbox.",
    "Return a self-contained textual Result.",
    "",
    "Task:",
    task,
  ].join("\n");
}

function formalReviewPrompt(
  task: string,
  tools: ReadonlyArray<string>
): string {
  return [
    "You are a formal-review Worker with an independent context.",
    "Follow the trusted project's AGENTS.md instructions.",
    "Do not load skills, extensions, or prompt templates.",
    `Use only the configured tools: ${tools.join(", ")}.`,
    "Return a self-contained textual Result.",
    "",
    "Review task:",
    task,
  ].join("\n");
}

function boundedResultBody(
  body: string,
  operationId: string
): { readonly text: string; readonly truncated: boolean } {
  const identity = `[Operation: ${operationId}]`;
  const initial = truncateHead(body, {
    maxLines: DEFAULT_MAX_LINES - 2,
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(`\n\n${identity}`, "utf8"),
  });
  const status = initial.truncated
    ? `[Result truncated]\n${identity}`
    : identity;
  if (!initial.truncated) {
    return { text: `${initial.content}\n\n${status}`, truncated: false };
  }
  const bounded = truncateHead(body, {
    maxLines: DEFAULT_MAX_LINES - 3,
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(`\n\n${status}`, "utf8"),
  });
  return { text: `${bounded.content}\n\n${status}`, truncated: true };
}

class TrackedOperation {
  private cancellation?: Promise<CancellationResult>;

  constructor(readonly handle: OperationHandle) {}

  cancel(): Promise<CancellationResult> {
    if (this.cancellation !== undefined) return this.cancellation;
    this.cancellation = this.handle.cancel({ scope: "subtree" });
    void this.cancellation.catch(() => undefined);
    return this.cancellation;
  }
}

class OperationLifetime {
  private readonly active = new Map<string, TrackedOperation>();

  track(handle: OperationHandle): TrackedOperation {
    const existing = this.active.get(handle.operationId);
    if (existing !== undefined) return existing;
    const operation = new TrackedOperation(handle);
    this.active.set(handle.operationId, operation);
    return operation;
  }

  complete(operation: TrackedOperation): void {
    if (this.active.get(operation.handle.operationId) === operation) {
      this.active.delete(operation.handle.operationId);
    }
  }

  async cancelAll(): Promise<void> {
    const outcomes = await Promise.allSettled(
      Array.from(this.active.values(), (operation) => operation.cancel())
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to classify all active Operation cancellations"
      );
    }
  }
}

type ResultOutcome =
  | {
      readonly type: "result";
      readonly completion: Readonly<OperationCompletion>;
    }
  | { readonly type: "failure"; readonly error: unknown }
  | { readonly type: "interrupted" };

async function awaitOperation(
  operation: TrackedOperation,
  lifetime: OperationLifetime,
  signal: AbortSignal | undefined
): Promise<Readonly<OperationCompletion>> {
  let notifyInterrupted!: () => void;
  const interrupted = new Promise<ResultOutcome>((resolve) => {
    notifyInterrupted = () => resolve({ type: "interrupted" });
  });
  const onAbort = () => notifyInterrupted();
  signal?.addEventListener("abort", onAbort, { once: true });

  const settled: Promise<ResultOutcome> = operation.handle.result().then(
    (completion) => ({ type: "result", completion }),
    (error: unknown) => ({ type: "failure", error })
  );
  if (signal?.aborted) notifyInterrupted();

  try {
    const outcome = await Promise.race([settled, interrupted]);
    if (outcome.type === "result") {
      lifetime.complete(operation);
      return outcome.completion;
    }
    if (outcome.type === "failure") {
      lifetime.complete(operation);
      throw outcome.error;
    }

    const cancellation = await operation.cancel();
    lifetime.complete(operation);
    if (cancellation.state === "unknown") {
      throw new OperationUnknownError(
        operation.handle.operationId,
        "cancel-unproven"
      );
    }
    throw new OperationCancelledError(operation.handle.operationId);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Install the project-local Pi delegation tool. */
export function installPionsExtension(
  pi: ExtensionAPI,
  options: PionsExtensionOptions = {}
): void {
  const runtimesByConfig = new Map<string, Runtime>();
  const runtimesByRepository = new Map<string, Runtime>();
  const runtimesByCall = new Map<string, Runtime>();
  const sessionOwnedFormalReviews = new Map<
    string,
    {
      readonly runtime: Runtime;
      readonly sessionId: string;
      readonly repositoryRoot: string;
    }
  >();
  const knownRuntimes = new Set<Runtime>();
  const operationLifetime = new OperationLifetime();
  let shuttingDown = false;

  async function resolveRepositoryContext(context: ExtensionContext): Promise<{
    readonly normalizedRoot: string;
    readonly repositoryState: string;
  }> {
    const root = options.repositoryRoot ?? (await repositoryRoot(context.cwd));
    const normalizedRoot = await realpath(root);
    const stateBase =
      options.stateBaseDirectory ??
      userStateDirectory(
        options.environment ?? process.env,
        options.homeDirectory ?? homedir()
      );
    const repositoryState = join(
      stateBase,
      "pions",
      "repositories",
      opaqueDigest(normalizedRoot)
    );
    await privateDirectory(repositoryState);
    if (shuttingDown) throw new Error("Pions Runtime is shutting down");
    return { normalizedRoot, repositoryState };
  }

  async function useRepositoryRuntime<Value>(
    context: ExtensionContext,
    use: (runtime: Runtime) => Promise<Value>
  ): Promise<Value> {
    const { normalizedRoot, repositoryState } =
      await resolveRepositoryContext(context);
    const existingRuntime =
      options.runtime ?? runtimesByRepository.get(normalizedRoot);
    const temporaryRuntime =
      existingRuntime === undefined
        ? (options.resultRuntimeFactory ?? makeResultRetrievalRuntime)({
            cwd: normalizedRoot,
            stateDirectory: join(repositoryState, "runtime"),
          })
        : undefined;
    const runtime = existingRuntime ?? temporaryRuntime!;
    if (temporaryRuntime === undefined) knownRuntimes.add(runtime);
    try {
      return await use(runtime);
    } finally {
      await temporaryRuntime?.close();
    }
  }

  async function prepareWorkerCall(
    toolCallId: string,
    prompt: string,
    context: ExtensionContext,
    requiredModel?: Readonly<ModelReference>
  ): Promise<{
    readonly idempotencyKey: string;
    readonly normalizedRoot: string;
    readonly promptRef: string;
    readonly readerModel: Readonly<ModelReference>;
    readonly readerThinkingLevel: ThinkingLevel;
    readonly runtime: Runtime;
  }> {
    const inheritedModel = selectedModel(context);
    const inheritedThinkingLevel = selectedThinkingLevel(context);
    const { normalizedRoot, repositoryState } =
      await resolveRepositoryContext(context);
    const configured = await projectConfig(normalizedRoot);
    const readerModel =
      configured?.model === undefined
        ? inheritedModel
        : configuredModel(context, configured.model);
    const usesClaudeBridge =
      readerModel.provider === "claude-bridge" ||
      requiredModel?.provider === "claude-bridge";
    const claudeBridge = usesClaudeBridge
      ? resolveClaudeBridgeExtension({
          ...(options.claudeBridgePackagePath === undefined
            ? {}
            : { packagePath: options.claudeBridgePackagePath }),
        })
      : undefined;
    if (claudeBridge !== undefined) {
      validateClaudeBridgePolicy({
        cwd: normalizedRoot,
        environment: options.environment ?? process.env,
        homeDirectory: options.homeDirectory ?? homedir(),
      });
    }
    const readerThinkingLevel =
      configured?.thinkingLevel ?? inheritedThinkingLevel;
    const idempotencyKey = `pi-tool:${opaqueDigest(`${context.sessionManager.getSessionId()}\0${toolCallId}`)}`;
    const promptRef = join(
      repositoryState,
      "requests",
      `${idempotencyKey.slice("pi-tool:".length)}.utf8`
    );
    await writePrivatePrompt(promptRef, prompt);
    const readerProfile: WorkerProfilePolicy = {
      intendedUse: "reader",
      modelCandidates: [readerModel],
      thinkingLevel: readerThinkingLevel,
      tools: REVIEW_TOOLS,
      resources: { resourceProofPolicy: "disabled" },
      startAuthorization: { policy: "disabled" },
      workProductRequirements: BODY_ONLY_WORK_PRODUCT_REQUIREMENTS,
      acceptedArtifactRetentionMs: 86_400_000,
    };
    const formalProfileDigest =
      options.formalReview === undefined
        ? "disabled"
        : opaqueDigest(JSON.stringify(options.formalReview.profile));
    const configKey = `${normalizedRoot}\0${readerModel.provider}\0${readerModel.id}\0${readerThinkingLevel}\0${claudeBridge?.sourceDigest ?? "builtin"}\0${formalProfileDigest}`;
    if (shuttingDown) throw new Error("Pions Runtime is shutting down");
    let runtime = options.runtime;
    if (runtime === undefined) {
      const extensionEntryPath = resolveWorkerExtensionEntryPath({
        ...(options.extensionEntryPath === undefined
          ? {}
          : { explicitPath: options.extensionEntryPath }),
        cwd: normalizedRoot,
      });
      runtime =
        runtimesByCall.get(idempotencyKey) ?? runtimesByConfig.get(configKey);
      if (runtime === undefined) {
        runtime = (options.runtimeFactory ?? makeVisibleRuntime)({
          cwd: normalizedRoot,
          stateDirectory: join(repositoryState, "runtime"),
          profiles: {
            [REVIEW_PROFILE]: readerProfile,
            ...(options.formalReview === undefined
              ? {}
              : { [FORMAL_REVIEW_PROFILE]: options.formalReview.profile }),
          },
          environment: options.environment ?? process.env,
          extensionEntryPath,
          ...(options.formalReview === undefined
            ? {}
            : {
                reviewSubjectAuthority:
                  options.formalReview.reviewSubjectAuthority,
                ...(options.formalReview.coordinator === undefined
                  ? {}
                  : {
                      startAuthorizationAuthenticator:
                        options.formalReview.coordinator.authenticator,
                    }),
              }),
        });
        runtimesByConfig.set(configKey, runtime);
      }
    }
    runtimesByCall.set(idempotencyKey, runtime);
    runtimesByRepository.set(normalizedRoot, runtime);
    knownRuntimes.add(runtime);
    return {
      idempotencyKey,
      normalizedRoot,
      promptRef,
      readerModel,
      readerThinkingLevel,
      runtime,
    };
  }

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const failures: Array<unknown> = [];
    try {
      await operationLifetime.cancelAll();
    } catch (error) {
      failures.push(error);
    }
    const closeOutcomes = await Promise.allSettled(
      [...knownRuntimes].map((runtime) => runtime.close())
    );
    failures.push(
      ...closeOutcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : []
      )
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to shut down the Pions Runtime"
      );
    }
  });

  pi.registerTool({
    name: "pions_result",
    label: "Pions Result",
    description:
      "Retrieve a verified persisted Result chunk for an Operation in the current trusted repository.",
    parameters: ResultParameters,
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      if (shuttingDown) throw new Error("Pions Runtime is shutting down");
      if (!context.isProjectTrusted()) {
        throw new Error("pions_result requires a trusted project");
      }
      return useRepositoryRuntime(context, async (runtime) => {
        let outcome;
        try {
          const reader = await runtime.operation(parameters.operationId);
          outcome = await reader.readResultChunk({
            maxBytes: RESULT_TOOL_CHUNK_BYTES,
            ...(parameters.cursor === undefined
              ? {}
              : { cursor: parameters.cursor }),
          });
        } catch {
          throw new Error("Result is unavailable in the current repository");
        }
        if (outcome.kind === "not_accepted") {
          return {
            content: [
              {
                type: "text" as const,
                text: `[Operation: ${parameters.operationId}; Result not accepted; state: ${outcome.state}]`,
              },
            ],
            details: outcome,
          };
        }
        const continuation =
          outcome.chunk.nextCursor === undefined
            ? `[Operation: ${parameters.operationId}; Result complete]`
            : `[Operation: ${parameters.operationId}; next cursor: ${outcome.chunk.nextCursor}]`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${outcome.chunk.body}\n\n${continuation}`,
            },
          ],
          details: outcome.chunk,
        };
      });
    },
  });

  pi.registerTool({
    name: "pions_operation",
    label: "Pions Operation",
    description:
      "Read the persisted state of an Operation in the current trusted repository without retrieving Result bytes.",
    parameters: OperationParameters,
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      if (shuttingDown) throw new Error("Pions Runtime is shutting down");
      if (!context.isProjectTrusted()) {
        throw new Error("pions_operation requires a trusted project");
      }
      return useRepositoryRuntime(context, async (runtime) => {
        let snapshot;
        try {
          const reader = await runtime.operation(parameters.operationId);
          snapshot = await reader.read();
        } catch {
          throw new Error("Operation is unavailable in the current repository");
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(snapshot, null, 2) },
          ],
          details: snapshot,
        };
      });
    },
  });

  pi.registerTool({
    name: "pions_review",
    label: "Pions Formal Review",
    description:
      "Create a non-waiting formal-review Operation for a registered Artifact and return its Operation identifier.",
    parameters: FormalReviewParameters,
    async execute(toolCallId, parameters, _signal, _onUpdate, context) {
      if (shuttingDown) throw new Error("Pions Runtime is shutting down");
      if (!context.isProjectTrusted()) {
        throw new Error("pions_review requires a trusted project");
      }
      const formalReview = options.formalReview;
      if (formalReview === undefined) {
        throw new WorkerConfigurationError(
          "unsupported_capability",
          "Formal review is not enabled by trusted configuration"
        );
      }
      const modelCandidate = formalReview.profile.modelCandidates[0];
      if (modelCandidate === undefined) {
        throw new WorkerConfigurationError(
          "unsupported_capability",
          "Formal review has no configured model"
        );
      }
      const model = configuredModel(context, modelCandidate);
      const prepared = await prepareWorkerCall(
        toolCallId,
        formalReviewPrompt(parameters.task, formalReview.profile.tools),
        context,
        model
      );
      const handle = await prepared.runtime.spawn(
        {
          promptRef: prepared.promptRef,
          profile: FORMAL_REVIEW_PROFILE,
          idempotencyKey: prepared.idempotencyKey,
          model,
          thinkingLevel: formalReview.profile.thinkingLevel,
          tools: formalReview.profile.tools,
          cwd: prepared.normalizedRoot,
        },
        { reviewSubjectArtifactId: parameters.artifactId }
      );
      sessionOwnedFormalReviews.set(handle.operationId, {
        runtime: prepared.runtime,
        sessionId: context.sessionManager.getSessionId(),
        repositoryRoot: prepared.normalizedRoot,
      });
      return {
        content: [
          { type: "text" as const, text: `[Operation: ${handle.operationId}]` },
        ],
        details: { operationId: handle.operationId },
      };
    },
  });

  pi.registerTool({
    name: "pions_review_decision",
    label: "Pions Formal Review Decision",
    description:
      "Authorize or reject the inspected Startup receipt for a formal-review Operation owned by this Pi session.",
    parameters: FormalReviewDecisionParameters,
    async execute(toolCallId, parameters, _signal, _onUpdate, context) {
      if (shuttingDown) throw new Error("Pions Runtime is shutting down");
      if (!context.isProjectTrusted()) {
        throw new Error("pions_review_decision requires a trusted project");
      }
      const coordinator = options.formalReview?.coordinator;
      if (coordinator === undefined) {
        throw new WorkerConfigurationError(
          "unsupported_capability",
          "Formal review decisions are not enabled by trusted Coordinator configuration"
        );
      }
      const ownedReview = sessionOwnedFormalReviews.get(parameters.operationId);
      const currentRepository = await resolveRepositoryContext(context);
      if (
        ownedReview === undefined ||
        ownedReview.sessionId !== context.sessionManager.getSessionId() ||
        ownedReview.repositoryRoot !== currentRepository.normalizedRoot
      ) {
        throw new Error("Operation is not owned by the current Pi session");
      }
      const inbox = await ownedReview.runtime.startAuthorizationInbox(
        coordinator.credential
      );
      const outcome = await inbox.decide({
        operationId: parameters.operationId,
        decisionId: `pi-decision:${opaqueDigest(`${context.sessionManager.getSessionId()}\0${toolCallId}`)}`,
        kind: parameters.decision,
        receiptDigest: parameters.receiptDigest as `sha256:${string}`,
      });
      const summary =
        outcome.status === "rejected"
          ? `[Operation: ${parameters.operationId}; decision: rejected; reason: ${outcome.reason}]`
          : `[Operation: ${parameters.operationId}; decision: ${outcome.status}; gate: ${outcome.gate}]`;
      return {
        content: [{ type: "text" as const, text: summary }],
        details:
          outcome.status === "rejected"
            ? { status: outcome.status, reason: outcome.reason }
            : { status: outcome.status, gate: outcome.gate },
      };
    },
  });

  pi.registerTool({
    name: "pions_delegate",
    label: "Pions Delegate",
    description: [
      "Use pions_delegate to delegate one self-contained task to a subagent with an independent context.",
      `The returned text is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the complete Result remains persisted by Operation identifier.`,
    ].join(" "),
    promptSnippet:
      "Use pions_delegate to start one read-oriented subagent with an independent context",
    promptGuidelines: [
      "Use pions_delegate when asked to launch or delegate to a subagent, or to investigate in an independent context.",
      "Compose independent pions_delegate calls in parallel rather than combining multiple tasks in one call.",
    ],
    parameters: DelegateParameters,
    async execute(toolCallId, parameters, signal, _onUpdate, context) {
      if (shuttingDown) throw new Error("Pions Runtime is shutting down");
      if (!context.isProjectTrusted()) {
        throw new Error("pions_delegate requires a trusted project");
      }
      const prepared = await prepareWorkerCall(
        toolCallId,
        workerPrompt(parameters.task),
        context
      );
      const handle = await prepared.runtime.spawn({
        promptRef: prepared.promptRef,
        profile: REVIEW_PROFILE,
        idempotencyKey: prepared.idempotencyKey,
        model: prepared.readerModel,
        thinkingLevel: prepared.readerThinkingLevel,
        tools: REVIEW_TOOLS,
        cwd: prepared.normalizedRoot,
      });
      const operation = operationLifetime.track(handle);
      const completion = await awaitOperation(
        operation,
        operationLifetime,
        signal
      );
      const bounded = boundedResultBody(
        completion.result.body,
        handle.operationId
      );
      return {
        content: [{ type: "text", text: bounded.text }],
        details: {
          operationId: handle.operationId,
          byteCount: completion.result.byteCount,
          digest: completion.result.digest,
          truncated: bounded.truncated,
          cleanupDiagnostics: completion.cleanupDiagnostics,
        } satisfies PionsDelegateDetails,
      };
    },
  });
}
