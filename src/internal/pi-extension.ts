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

import {
  backgroundOwnerEntryPath,
  cancelBackgroundProcess,
  readBackgroundRequest,
  recoverBackgroundProcesses,
  startBackgroundProcess,
} from "./background-process.js";
import type { BackgroundOwnerRequest } from "./background-owner.js";
import { missingHerdrVariables } from "./herdr-presentation.js";
import { makePersistedOperationReader } from "./persisted-operation-reader.js";
import {
  backgroundOperationId,
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
  OperationCompletion,
  OperationHandle,
  OperationRuntime,
  TaskSpec,
  WorkerProfilePolicy,
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
  readonly persistedReaderFactory?: typeof makePersistedOperationReader;
  readonly repositoryRoot?: string;
  readonly stateBaseDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly extensionEntryPath?: string;
  readonly piAgentDirectory?: string;
  readonly resolveWorkerExtensionPackages?: WorkerExtensionPackageResolver;
  readonly backgroundProcessStarter?: typeof startBackgroundProcess;
  readonly backgroundOwnerEntryPath?: string;
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

interface PreparedWorkerCall {
  readonly task: TaskSpec;
  readonly runtime: OperationRuntime;
  readonly repositoryState: string;
  readonly normalizedRoot: string;
  readonly workerCwd: string;
  readonly workerProfile: WorkerProfilePolicy;
  readonly extensionEntryPath?: string;
}

class RuntimeOwnership {
  private readonly byRepository = new Map<string, OperationRuntime>();
  private readonly byConfig = new Map<string, OperationRuntime>();
  private readonly preparations = new Map<
    string,
    {
      readonly root: string;
      readonly promptDigest: string;
      readonly result: Promise<PreparedWorkerCall>;
    }
  >();
  private readonly recoveryOwners = new Map<string, OperationRuntime>();
  private readonly known = new Set<OperationRuntime>();
  private readonly admissions = new Set<Promise<unknown>>();
  private closing = false;

  assertOpen(): void {
    if (this.closing) throw new Error("Pions Runtime is shutting down");
  }

  async admit<Value>(work: () => Promise<Value>): Promise<Value> {
    this.assertOpen();
    const pending = Promise.resolve().then(work);
    this.admissions.add(pending);
    try {
      return await pending;
    } finally {
      this.admissions.delete(pending);
    }
  }

  async stopAdmissions(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.admissions]);
  }

  async recover(
    root: string,
    create: () => OperationRuntime
  ): Promise<ReadonlyArray<OperationHandle>> {
    this.assertOpen();
    let runtime = this.recoveryOwners.get(root);
    if (runtime === undefined) {
      runtime = create();
      this.recoveryOwners.set(root, runtime);
      this.byRepository.set(root, runtime);
      this.known.add(runtime);
    }
    await runtime.ready();
    this.assertOpen();
    return runtime.recoveredOperations?.() ?? [];
  }

  async forCall(
    root: string,
    callKey: string,
    promptDigest: string,
    prepare: () => Promise<PreparedWorkerCall>
  ): Promise<PreparedWorkerCall> {
    this.assertOpen();
    const existing = this.preparations.get(callKey);
    if (existing !== undefined) {
      if (existing.root !== root || existing.promptDigest !== promptDigest) {
        throw new Error(
          "Pions tool call was reused for a different task or repository"
        );
      }
      return existing.result;
    }
    const result = Promise.resolve().then(prepare);
    const entry = { root, promptDigest, result };
    this.preparations.set(callKey, entry);
    try {
      return await result;
    } catch (error) {
      if (this.preparations.get(callKey) === entry)
        this.preparations.delete(callKey);
      throw error;
    }
  }

  private async readyForCall(
    root: string,
    runtime: OperationRuntime
  ): Promise<void> {
    const owner = this.recoveryOwners.get(root);
    await owner?.ready();
    if (runtime !== owner) await runtime.ready();
  }

  async acquire(
    root: string,
    configKey: string,
    task: TaskSpec,
    create: (recoveryDisabled: boolean) => OperationRuntime
  ): Promise<{ readonly runtime: OperationRuntime; readonly task: TaskSpec }> {
    this.assertOpen();
    const runtime =
      this.byConfig.get(configKey) ?? create(this.recoveryOwners.has(root));
    if (!this.recoveryOwners.has(root)) this.recoveryOwners.set(root, runtime);
    this.byConfig.set(configKey, runtime);
    this.known.add(runtime);
    this.byRepository.set(root, runtime);
    await this.readyForCall(root, runtime);
    this.assertOpen();
    return { runtime, task };
  }

  reader(
    root: string,
    create: () => Pick<OperationRuntime, "operation">,
    override?: OperationRuntime
  ): Pick<OperationRuntime, "operation"> {
    this.assertOpen();
    if (override !== undefined) this.known.add(override);
    return override ?? this.byRepository.get(root) ?? create();
  }

  async closeAll(): Promise<ReadonlyArray<unknown>> {
    const outcomes = await Promise.allSettled(
      [...this.known].map((runtime) => runtime.close())
    );
    return outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
  }
}

/** Install the project-local Pi delegation tool. */
export function installPionsExtension(
  pi: ExtensionAPI,
  options: PionsExtensionOptions = {}
): void {
  const ownership = new RuntimeOwnership();
  const operationLifetime = new OperationLifetime();

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
    ownership.assertOpen();
    return { normalizedRoot, repositoryState };
  }

  async function useRepositoryRuntime<Value>(
    context: ExtensionContext,
    use: (runtime: Pick<OperationRuntime, "operation">) => Promise<Value>
  ): Promise<Value> {
    const { normalizedRoot, repositoryState } =
      await resolveRepositoryContext(context);
    const reader = ownership.reader(
      normalizedRoot,
      () =>
        (options.persistedReaderFactory ?? makePersistedOperationReader)({
          stateDirectory: join(repositoryState, "runtime"),
        }),
      options.runtime
    );
    return use(reader);
  }

  pi.on("session_start", async (_event, context) => {
    if (!context.isProjectTrusted()) return;
    // Outside Herdr nothing can be recovered, so startup stays silent; an
    // explicit tool call still reports the missing Herdr environment.
    if (missingHerdrVariables(options.environment ?? process.env).length > 0)
      return;
    await ownership.admit(async () => {
      const { normalizedRoot, repositoryState } =
        await resolveRepositoryContext(context);
      const workerCwd = await realpath(context.cwd);
      const recovered = await ownership.recover(
        normalizedRoot,
        () =>
          options.runtime ??
          (options.runtimeFactory ?? makeVisibleRuntime)({
            cwd: workerCwd,
            stateDirectory: join(repositoryState, "runtime"),
            profiles: {},
            environment: options.environment ?? process.env,
            ...(options.extensionEntryPath === undefined
              ? {}
              : { extensionEntryPath: options.extensionEntryPath }),
          })
      );
      for (const handle of recovered) operationLifetime.track(handle);
      await recoverBackgroundProcesses({
        repositoryRoot: normalizedRoot,
        repositoryState,
        entryPath:
          options.backgroundOwnerEntryPath ??
          backgroundOwnerEntryPath(
            resolveWorkerExtensionEntryPath({
              ...(options.extensionEntryPath === undefined
                ? {}
                : { explicitPath: options.extensionEntryPath }),
              cwd: workerCwd,
            })
          ),
        environment: options.environment ?? process.env,
        ...(options.backgroundProcessStarter === undefined
          ? {}
          : { start: options.backgroundProcessStarter }),
      });
    });
  });

  async function prepareWorkerCall(
    toolCallId: string,
    prompt: string,
    context: ExtensionContext,
    background = false
  ): Promise<PreparedWorkerCall> {
    const { normalizedRoot, repositoryState } =
      await resolveRepositoryContext(context);
    const idempotencyKey = `${background ? "pi-background" : "pi-tool"}:${opaqueDigest(`${context.sessionManager.getSessionId()}\0${toolCallId}`)}`;
    return ownership.forCall(
      normalizedRoot,
      idempotencyKey,
      opaqueDigest(prompt),
      async () => {
        const inherited = delegatingWorkerSettings(
          context.model,
          context.thinkingLevel
        );
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
          registeredProviderIds:
            context.modelRegistry.getRegisteredProviderIds(),
        });
        const { model: workerModel, thinkingLevel: workerThinkingLevel } =
          selection;
        const extensions = await workerExtensions({
          sources: selection.extensionSources,
          cwd: workerCwd,
          piAgentDirectory: options.piAgentDirectory ?? getAgentDir(),
          resolvePackages:
            options.resolveWorkerExtensionPackages ??
            resolvePiExtensionPackages,
        });
        const promptRef = join(
          repositoryState,
          "requests",
          `${idempotencyKey.slice(idempotencyKey.indexOf(":") + 1)}.utf8`
        );
        await writePrivatePrompt(promptRef, prompt);
        const workerProfile = projectWorkerProfile(selection, extensions);
        const runtimeStateDirectory = join(repositoryState, "runtime");
        const configKey = JSON.stringify([
          normalizedRoot,
          workerCwd,
          workerModel,
          workerThinkingLevel,
          extensions,
        ]);
        const extensionEntryPath =
          options.runtime === undefined
            ? resolveWorkerExtensionEntryPath({
                ...(options.extensionEntryPath === undefined
                  ? {}
                  : { explicitPath: options.extensionEntryPath }),
                cwd: workerCwd,
              })
            : undefined;
        const selectedTask: TaskSpec = {
          ...(background ? { background: true as const } : {}),
          promptRef,
          profile: WORKER_PROFILE,
          idempotencyKey,
          model: workerModel,
          thinkingLevel: workerThinkingLevel,
          tools: workerProfile.tools,
          cwd: workerCwd,
        };
        const acquired = await ownership.acquire(
          normalizedRoot,
          configKey,
          selectedTask,
          (recoveryDisabled) => {
            if (options.runtime !== undefined) return options.runtime;
            if (extensionEntryPath === undefined)
              throw new Error("Pions Worker extension entry is unavailable");
            return (options.runtimeFactory ?? makeVisibleRuntime)({
              cwd: workerCwd,
              stateDirectory: runtimeStateDirectory,
              profiles: { [WORKER_PROFILE]: workerProfile },
              environment: options.environment ?? process.env,
              extensionEntryPath,
              ...(recoveryDisabled ? { recovery: "disabled" as const } : {}),
            });
          }
        );
        return {
          ...acquired,
          repositoryState,
          normalizedRoot,
          workerCwd,
          workerProfile,
          ...(extensionEntryPath === undefined ? {} : { extensionEntryPath }),
        };
      }
    );
  }

  pi.on("session_shutdown", async () => {
    const failures: Array<unknown> = [];
    await ownership.stopAdmissions();
    try {
      await operationLifetime.cancelAll();
    } catch (error) {
      failures.push(error);
    }
    failures.push(...(await ownership.closeAll()));
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
      ownership.assertOpen();
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
      ownership.assertOpen();
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
      ownership.assertOpen();
      if (!context.isProjectTrusted()) {
        throw new Error("pions_delegate requires a trusted project");
      }
      const operation = await ownership.admit(async () => {
        const prepared = await prepareWorkerCall(
          toolCallId,
          workerPrompt(parameters.task),
          context
        );
        ownership.assertOpen();
        const handle = await prepared.runtime.spawn(prepared.task);
        return operationLifetime.track(handle);
      });
      const completion = await awaitOperation(operation, signal);
      const bounded = boundedResultBody(
        completion.result.body,
        operation.handle.operationId
      );
      return {
        content: [{ type: "text", text: bounded.text }],
        details: {
          operationId: operation.handle.operationId,
          byteCount: completion.result.byteCount,
          digest: completion.result.digest,
          truncated: bounded.truncated,
          cleanupDiagnostics: completion.cleanupDiagnostics,
        } satisfies PionsDelegateDetails,
      };
    },
  });

  pi.registerTool({
    name: "pions_cancel",
    label: "Pions Cancel",
    description:
      "Request cancellation of a background Operation by identifier in the current trusted repository, and wait for a confirmed cancellation or explicit uncertainty.",
    parameters: OperationParameters,
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      ownership.assertOpen();
      if (!context.isProjectTrusted())
        throw new Error("pions_cancel requires a trusted project");
      return ownership.admit(async () => {
        const { normalizedRoot, repositoryState } =
          await resolveRepositoryContext(context);
        const workerCwd = await realpath(context.cwd);
        const outcome = await cancelBackgroundProcess({
          repositoryRoot: normalizedRoot,
          repositoryState,
          operationId: parameters.operationId,
          entryPath:
            options.backgroundOwnerEntryPath ??
            backgroundOwnerEntryPath(
              resolveWorkerExtensionEntryPath({
                ...(options.extensionEntryPath === undefined
                  ? {}
                  : { explicitPath: options.extensionEntryPath }),
                cwd: workerCwd,
              })
            ),
          environment: options.environment ?? process.env,
          ...(options.backgroundProcessStarter === undefined
            ? {}
            : { start: options.backgroundProcessStarter }),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `[Operation: ${parameters.operationId}; state: ${outcome.state}]`,
            },
          ],
          details: { operationId: parameters.operationId, ...outcome },
        };
      });
    },
  });

  pi.registerTool({
    name: "pions_background",
    label: "Pions Background",
    description:
      "Start one independent Worker without waiting for its Result. Use pions_operation and pions_result with the returned Operation identifier to check it later.",
    promptSnippet:
      "Use pions_background only when work should continue after this Pi session exits",
    promptGuidelines: [
      "Use pions_background when explicitly asked to start work without waiting or to keep it running after this session exits.",
      "Use pions_operation and pions_result to check its state and answer later; use pions_cancel to stop it explicitly.",
    ],
    parameters: DelegateParameters,
    async execute(toolCallId, parameters, _signal, _onUpdate, context) {
      ownership.assertOpen();
      if (!context.isProjectTrusted())
        throw new Error("pions_background requires a trusted project");
      return ownership.admit(async () => {
        const { normalizedRoot, repositoryState } =
          await resolveRepositoryContext(context);
        const idempotencyKey = `pi-background:${opaqueDigest(`${context.sessionManager.getSessionId()}\0${toolCallId}`)}`;
        const operationId = backgroundOperationId(
          normalizedRoot,
          idempotencyKey
        );
        const prompt = workerPrompt(parameters.task);
        const saved = await readBackgroundRequest({
          repositoryRoot: normalizedRoot,
          repositoryState,
          operationId,
        });
        let request: BackgroundOwnerRequest;
        if (saved !== undefined) {
          const promptRef = join(
            repositoryState,
            "requests",
            `${idempotencyKey.slice("pi-background:".length)}.utf8`
          );
          if (
            saved.task.idempotencyKey !== idempotencyKey ||
            saved.task.promptRef !== promptRef ||
            (await readFile(promptRef, "utf8")) !== prompt
          )
            throw new Error("Background Operation request has different work");
          request = saved;
        } else {
          const prepared = await prepareWorkerCall(
            toolCallId,
            prompt,
            context,
            true
          );
          request = {
            operationId,
            task: prepared.task,
            runtime: {
              cwd: prepared.workerCwd,
              stateDirectory: join(repositoryState, "runtime"),
              profiles: { [WORKER_PROFILE]: prepared.workerProfile },
              ...(prepared.extensionEntryPath === undefined
                ? {}
                : { extensionEntryPath: prepared.extensionEntryPath }),
            },
          };
        }
        const started = await (
          options.backgroundProcessStarter ?? startBackgroundProcess
        )({
          repositoryState,
          entryPath:
            options.backgroundOwnerEntryPath ??
            backgroundOwnerEntryPath(
              request.runtime.extensionEntryPath ??
                resolveWorkerExtensionEntryPath({ cwd: request.runtime.cwd })
            ),
          environment: options.environment ?? process.env,
          request,
        });
        if (started !== operationId)
          throw new Error("Background owner returned another Operation");
        return {
          content: [
            {
              type: "text" as const,
              text: `[Operation: ${operationId}; started; Result not yet accepted]`,
            },
          ],
          details: { operationId },
        };
      });
    },
  });
}
