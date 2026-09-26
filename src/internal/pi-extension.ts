import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { makeResultRetrievalRuntime } from "./result-runtime.js";
import {
  opaqueDigest,
  resolveRepositoryState,
  writePrivatePrompt,
} from "./repository-state.js";
import { makeVisibleRuntime } from "./visible-runtime.js";
import {
  decodeProjectWorkerConfig,
  delegatingWorkerSettings,
  projectWorkerProfile,
  selectProjectWorker,
  type ProjectWorkerConfig,
} from "./project-worker-configuration.js";
import { resolveWorkerExtensionEntryPath } from "./worker-extension-entry.js";
import {
  resolvePiExtensionPackages,
  workerExtensions,
  type WorkerExtensionPackageResolver,
} from "./worker-extensions.js";
import { OperationCancelledError, OperationUnknownError } from "./types.js";
import type {
  CancellationResult,
  CleanupDiagnostic,
  EffectiveWorkerConfig,
  OperationCompletion,
  OperationHandle,
  OperationRuntime,
} from "./types.js";

const WORKER_PROFILE = "worker";
const DelegateParameters = Type.Object(
  {
    task: Type.String({
      minLength: 1,
      description: "Self-contained work to delegate",
    }),
  },
  { additionalProperties: false }
);

const OperationParameters = Type.Object(
  { operationId: Type.String({ minLength: 1 }) },
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
  readonly runtime?: OperationRuntime;
  readonly runtimeFactory?: typeof makeVisibleRuntime;
  readonly resultRuntimeFactory?: typeof makeResultRetrievalRuntime;
  readonly repositoryRoot?: string;
  readonly stateBaseDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly extensionEntryPath?: string;
  readonly piAgentDirectory?: string;
  readonly resolveWorkerExtensionPackages?: WorkerExtensionPackageResolver;
}

async function projectConfig(
  root: string
): Promise<ProjectWorkerConfig | undefined> {
  try {
    return decodeProjectWorkerConfig(
      await readFile(join(root, ".pions.json"), "utf8")
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

function workerPrompt(task: string): string {
  return [
    "You are a general-purpose Worker with an independent context.",
    "Follow the trusted project's AGENTS.md instructions.",
    "Do not load skills or prompt templates.",
    "Use only the tools available to you.",
    "You work in the same working directory as the delegating session; edits apply there directly, and Pions creates no worktree or branch for you.",
    "You cannot delegate further; complete the task yourself.",
    "Return a self-contained textual Result.",
    "",
    "Task:",
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
  readonly completion: Promise<Readonly<OperationCompletion>>;

  constructor(readonly handle: OperationHandle) {
    this.completion = handle.result();
  }

  cancel(): Promise<CancellationResult> {
    if (this.cancellation !== undefined) return this.cancellation;
    this.cancellation = this.handle.cancel({});
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
    const complete = () => this.complete(operation);
    void operation.completion.then(complete, complete);
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
  signal: AbortSignal | undefined
): Promise<Readonly<OperationCompletion>> {
  let notifyInterrupted!: () => void;
  const interrupted = new Promise<ResultOutcome>((resolve) => {
    notifyInterrupted = () => resolve({ type: "interrupted" });
  });
  const onAbort = () => notifyInterrupted();
  signal?.addEventListener("abort", onAbort, { once: true });

  const settled: Promise<ResultOutcome> = operation.completion.then(
    (completion) => ({ type: "result", completion }),
    (error: unknown) => ({ type: "failure", error })
  );
  if (signal?.aborted) notifyInterrupted();

  try {
    const outcome = await Promise.race([settled, interrupted]);
    if (outcome.type === "result") return outcome.completion;
    if (outcome.type === "failure") throw outcome.error;

    const cancellation = await operation.cancel();
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
  const runtimesByConfig = new Map<string, OperationRuntime>();
  const runtimesByRepository = new Map<string, OperationRuntime>();
  const runtimesByCall = new Map<string, OperationRuntime>();
  const knownRuntimes = new Set<OperationRuntime>();
  const operationLifetime = new OperationLifetime();
  let shuttingDown = false;

  async function resolveRepositoryContext(context: ExtensionContext): Promise<{
    readonly normalizedRoot: string;
    readonly repositoryState: string;
  }> {
    const { normalizedRoot, repositoryState } = await resolveRepositoryState({
      cwd: context.cwd,
      ...(options.repositoryRoot === undefined
        ? {}
        : { repositoryRoot: options.repositoryRoot }),
      ...(options.stateBaseDirectory === undefined
        ? {}
        : { stateBaseDirectory: options.stateBaseDirectory }),
      environment: options.environment ?? process.env,
      homeDirectory: options.homeDirectory ?? homedir(),
    });
    if (shuttingDown) throw new Error("Pions Runtime is shutting down");
    return { normalizedRoot, repositoryState };
  }

  async function useRepositoryRuntime<Value>(
    context: ExtensionContext,
    use: (runtime: OperationRuntime) => Promise<Value>
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

  pi.on("session_start", async (_event, context) => {
    if (!context.isProjectTrusted()) return;
    const { normalizedRoot, repositoryState } =
      await resolveRepositoryContext(context);
    let runtime = options.runtime ?? runtimesByRepository.get(normalizedRoot);
    if (runtime === undefined) {
      const workerCwd = await realpath(context.cwd);
      const runtimeStateDirectory = join(repositoryState, "runtime");
      runtime = (options.runtimeFactory ?? makeVisibleRuntime)({
        cwd: workerCwd,
        stateDirectory: runtimeStateDirectory,
        profiles: {},
        environment: options.environment ?? process.env,
        ...(options.extensionEntryPath === undefined
          ? {}
          : { extensionEntryPath: options.extensionEntryPath }),
      });
      runtimesByRepository.set(normalizedRoot, runtime);
    }
    knownRuntimes.add(runtime);
    await runtime.ready();
  });

  async function prepareWorkerCall(
    toolCallId: string,
    prompt: string,
    context: ExtensionContext
  ): Promise<{
    readonly idempotencyKey: string;
    readonly normalizedRoot: string;
    readonly promptRef: string;
    readonly workerCwd: string;
    readonly workerSettings: Pick<
      EffectiveWorkerConfig,
      "model" | "thinkingLevel" | "tools"
    >;
    readonly runtime: OperationRuntime;
  }> {
    const inherited = delegatingWorkerSettings(
      context.model,
      context.thinkingLevel
    );
    const { normalizedRoot, repositoryState } =
      await resolveRepositoryContext(context);
    const recoveredRuntime = runtimesByRepository.get(normalizedRoot);
    if (recoveredRuntime !== undefined) await recoveredRuntime.ready();
    const workerCwd = await realpath(context.cwd);
    const configured = await projectConfig(normalizedRoot);
    const registered =
      configured?.model === undefined
        ? undefined
        : context.modelRegistry.find(
            configured.model.provider,
            configured.model.id
          );
    const selection = selectProjectWorker({
      configured,
      inherited,
      registeredModel: registered,
      registeredModelAuthenticated:
        registered === undefined
          ? undefined
          : context.modelRegistry.hasConfiguredAuth(registered),
      registeredProviderIds: context.modelRegistry.getRegisteredProviderIds(),
    });
    const { model: workerModel, thinkingLevel: workerThinkingLevel } =
      selection;
    const extensions = await workerExtensions({
      sources: selection.extensionSources,
      cwd: workerCwd,
      piAgentDirectory: options.piAgentDirectory ?? getAgentDir(),
      resolvePackages:
        options.resolveWorkerExtensionPackages ?? resolvePiExtensionPackages,
    });
    const idempotencyKey = `pi-tool:${opaqueDigest(`${context.sessionManager.getSessionId()}\0${toolCallId}`)}`;
    const promptRef = join(
      repositoryState,
      "requests",
      `${idempotencyKey.slice("pi-tool:".length)}.utf8`
    );
    await writePrivatePrompt(promptRef, prompt);
    const workerProfile = projectWorkerProfile(selection, extensions);
    const runtimeStateDirectory = join(repositoryState, "runtime");
    const configKey = `${normalizedRoot}\0${workerCwd}\0${workerModel.provider}\0${workerModel.id}\0${workerThinkingLevel}\0${JSON.stringify(extensions)}`;
    if (shuttingDown) throw new Error("Pions Runtime is shutting down");
    let runtime = options.runtime;
    if (runtime === undefined) {
      const extensionEntryPath = resolveWorkerExtensionEntryPath({
        ...(options.extensionEntryPath === undefined
          ? {}
          : { explicitPath: options.extensionEntryPath }),
        cwd: workerCwd,
      });
      runtime =
        runtimesByCall.get(idempotencyKey) ?? runtimesByConfig.get(configKey);
      if (runtime === undefined) {
        runtime = (options.runtimeFactory ?? makeVisibleRuntime)({
          cwd: workerCwd,
          stateDirectory: runtimeStateDirectory,
          profiles: { [WORKER_PROFILE]: workerProfile },
          environment: options.environment ?? process.env,
          extensionEntryPath,
          ...(runtimesByRepository.has(normalizedRoot)
            ? { recovery: "disabled" as const }
            : {}),
        });
        runtimesByConfig.set(configKey, runtime);
        runtimesByRepository.set(normalizedRoot, runtime);
        knownRuntimes.add(runtime);
        await runtime.ready();
      }
    }
    runtimesByCall.set(idempotencyKey, runtime);
    runtimesByRepository.set(normalizedRoot, runtime);
    knownRuntimes.add(runtime);
    return {
      idempotencyKey,
      normalizedRoot,
      promptRef,
      workerCwd,
      workerSettings: {
        model: workerModel,
        thinkingLevel: workerThinkingLevel,
        tools: workerProfile.tools,
      },
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
    name: "pions_delegate",
    label: "Pions Delegate",
    description: [
      "Use pions_delegate to delegate one self-contained task to a subagent with an independent context.",
      `The returned text is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the complete Result remains persisted by Operation identifier.`,
    ].join(" "),
    promptSnippet:
      "Use pions_delegate to start one general-purpose subagent with an independent context",
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
        profile: WORKER_PROFILE,
        idempotencyKey: prepared.idempotencyKey,
        ...prepared.workerSettings,
        cwd: prepared.workerCwd,
      });
      const operation = operationLifetime.track(handle);
      const completion = await awaitOperation(operation, signal);
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
