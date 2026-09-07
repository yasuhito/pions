import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, stat, writeFile } from "node:fs/promises";
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

import { makeVisibleRuntime } from "./visible-runtime.js";
import { WorkerConfigurationError } from "../public.js";
import type {
  ModelReference,
  Runtime,
  ThinkingLevel,
  WorkerProfilePolicy,
} from "../public.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REVIEW_PROFILE = "review";
const REVIEW_TOOLS = Object.freeze(["read", "grep", "find", "ls", "bash"]);
const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

const DelegateParameters = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "Self-contained work to delegate",
  }),
}, { additionalProperties: false });

export interface PionsDelegateDetails {
  readonly operationId: string;
  readonly byteCount: number;
  readonly digest: `sha256:${string}`;
  readonly truncated: boolean;
}

export interface PionsExtensionOptions {
  readonly runtime?: Runtime;
  readonly runtimeFactory?: typeof makeVisibleRuntime;
  readonly repositoryRoot?: string;
  readonly stateBaseDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly wrapperEntryPath?: string;
}

function opaqueDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
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
  home: string,
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
    await writeFile(path, body, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  await chmod(path, FILE_MODE);
}

function selectedModel(context: ExtensionContext): ModelReference {
  if (context.model === undefined) {
    throw new WorkerConfigurationError("model_mismatch", "The delegating Pi session has no selected model");
  }
  return { provider: context.model.provider, id: context.model.id };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

function selectedThinkingLevel(context: ExtensionContext): ThinkingLevel {
  if (!isThinkingLevel(context.thinkingLevel)) {
    throw new WorkerConfigurationError(
      "unsupported_capability",
      "The delegating Pi session has no supported thinking level",
    );
  }
  return context.thinkingLevel;
}

function workerPrompt(task: string): string {
  return [
    "You are a read-oriented review Worker with an independent context.",
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

/** Install the project-local Pi delegation tool. */
export function installPionsExtension(
  pi: ExtensionAPI,
  options: PionsExtensionOptions = {},
): void {
  const runtimesByConfig = new Map<string, Runtime>();
  const runtimesByCall = new Map<string, Runtime>();

  pi.registerTool({
    name: "pions_delegate",
    label: "Pions Delegate",
    description: [
      "Use pions_delegate to delegate one self-contained task to a subagent with an independent context.",
      `The returned text is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the complete Result remains persisted by Operation identifier.`,
    ].join(" "),
    promptSnippet: "Use pions_delegate to start one read-oriented subagent with an independent context",
    promptGuidelines: [
      "Use pions_delegate when asked to launch or delegate to a subagent, or to investigate in an independent context.",
      "Compose independent pions_delegate calls in parallel rather than combining multiple tasks in one call.",
    ],
    parameters: DelegateParameters,
    async execute(toolCallId, parameters, _signal, _onUpdate, context) {
      if (!context.isProjectTrusted()) {
        throw new Error("pions_delegate requires a trusted project");
      }
      const model = selectedModel(context);
      const thinkingLevel = selectedThinkingLevel(context);
      const root = options.repositoryRoot ?? await repositoryRoot(context.cwd);
      const normalizedRoot = await realpath(root);
      const stateBase = options.stateBaseDirectory ?? userStateDirectory(
        options.environment ?? process.env,
        options.homeDirectory ?? homedir(),
      );
      const repositoryState = join(stateBase, "pions", "repositories", opaqueDigest(normalizedRoot));
      await privateDirectory(repositoryState);

      const idempotencyKey = `pi-tool:${opaqueDigest(`${context.sessionManager.getSessionId()}\0${toolCallId}`)}`;
      const promptRef = join(repositoryState, "requests", `${idempotencyKey.slice("pi-tool:".length)}.utf8`);
      await writePrivatePrompt(promptRef, workerPrompt(parameters.task));

      const profile: WorkerProfilePolicy = {
        modelCandidates: [model],
        thinkingLevel,
        tools: REVIEW_TOOLS,
      };
      const configKey = `${normalizedRoot}\0${model.provider}\0${model.id}\0${thinkingLevel}`;
      let runtime = options.runtime ?? runtimesByCall.get(idempotencyKey) ?? runtimesByConfig.get(configKey);
      if (runtime === undefined) {
        runtime = (options.runtimeFactory ?? makeVisibleRuntime)({
          cwd: normalizedRoot,
          stateDirectory: join(repositoryState, "runtime"),
          profiles: { [REVIEW_PROFILE]: profile },
          environment: options.environment ?? process.env,
          wrapperEntryPath: options.wrapperEntryPath ?? join(normalizedRoot, "dist", "src", "worker-wrapper.js"),
        });
        runtimesByConfig.set(configKey, runtime);
      }
      runtimesByCall.set(idempotencyKey, runtime);
      const handle = await runtime.spawn({
        promptRef,
        profile: REVIEW_PROFILE,
        idempotencyKey,
        model,
        thinkingLevel,
        tools: REVIEW_TOOLS,
        cwd: normalizedRoot,
      });
      const result = await handle.result();
      const truncation = truncateHead(result.body, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const text = truncation.truncated
        ? `${truncation.content}\n\n[Result truncated: complete Result persisted for Operation ${handle.operationId}.]`
        : truncation.content;
      return {
        content: [{ type: "text", text }],
        details: {
          operationId: handle.operationId,
          byteCount: result.byteCount,
          digest: result.digest,
          truncated: truncation.truncated,
        } satisfies PionsDelegateDetails,
      };
    },
  });
}
