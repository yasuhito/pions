import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type {
  EffectiveWorkerConfig,
  ObservedWorkerConfig,
  ThinkingLevel,
} from "../public.js";
import { WorkerConfigurationError } from "../public.js";

export interface PiUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface PiToolUse {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
}

export interface PiAgentResult {
  readonly sessionId: string;
  readonly body: string;
  readonly usage: Readonly<PiUsage>;
  readonly toolUses: ReadonlyArray<Readonly<PiToolUse>>;
}

export class PiAgentFailedError extends Error {
  override readonly name = "PiAgentFailedError";

  constructor(
    readonly sessionId: string,
    readonly evidence: Readonly<{
      readonly usage: Readonly<PiUsage>;
      readonly toolUses: ReadonlyArray<Readonly<PiToolUse>>;
    }>,
    message: string,
  ) {
    super(message);
  }
}

interface PiConfigurationSession {
  readonly model: { readonly provider: string; readonly id: string } | undefined;
  readonly thinkingLevel: ThinkingLevel;
  getActiveToolNames(): string[];
}

export function observePiAgentConfiguration(
  session: Readonly<PiConfigurationSession>,
  effective: Readonly<EffectiveWorkerConfig>,
  observedCwd: string,
): ObservedWorkerConfig {
  if (
    session.model?.provider !== effective.model.provider ||
    session.model.id !== effective.model.id
  ) {
    throw new WorkerConfigurationError("model_mismatch", "Pi selected a different model");
  }
  if (session.thinkingLevel !== effective.thinkingLevel) {
    throw new WorkerConfigurationError(
      "unsupported_capability",
      "Pi changed the requested thinking level",
    );
  }
  if (observedCwd !== effective.cwd) {
    throw new WorkerConfigurationError(
      "unsupported_capability",
      "Pi Worker started in a different working directory",
    );
  }
  const activeTools = session.getActiveToolNames();
  if (
    activeTools.length !== effective.tools.length ||
    activeTools.some((tool) => !effective.tools.includes(tool))
  ) {
    throw new WorkerConfigurationError(
      "tool_policy_violation",
      "Pi changed the configured tool set",
    );
  }
  return {
    model: { state: "observed", value: { ...session.model } },
    thinkingLevel: { state: "unavailable" },
    tools: { state: "observed", value: activeTools },
    cwd: { state: "observed", value: observedCwd },
  };
}

interface PiSession {
  readonly sessionId: string;
  readonly messages: ReadonlyArray<unknown>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(prompt: string): Promise<void>;
  dispose(): void;
}

interface AssistantOutcome {
  readonly body: string;
  readonly succeeded: boolean;
  readonly errorMessage?: string;
  readonly usage: Readonly<PiUsage>;
}

function assistantOutcome(message: unknown): AssistantOutcome | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const value = message as {
    readonly role?: unknown;
    readonly content?: unknown;
    readonly stopReason?: unknown;
    readonly errorMessage?: unknown;
    readonly usage?: unknown;
  };
  if (value.role !== "assistant" || !Array.isArray(value.content)) return undefined;
  const usage = value.usage as {
    readonly input?: unknown;
    readonly output?: unknown;
    readonly cacheRead?: unknown;
    readonly cacheWrite?: unknown;
    readonly totalTokens?: unknown;
    readonly cost?: { readonly total?: unknown };
  } | undefined;
  if (
    usage === undefined ||
    typeof usage.input !== "number" ||
    typeof usage.output !== "number" ||
    typeof usage.cacheRead !== "number" ||
    typeof usage.cacheWrite !== "number" ||
    typeof usage.totalTokens !== "number" ||
    typeof usage.cost?.total !== "number"
  ) return undefined;
  const body = value.content
    .filter((part): part is { readonly type: "text"; readonly text: string } =>
      typeof part === "object" && part !== null &&
      (part as { readonly type?: unknown }).type === "text" &&
      typeof (part as { readonly text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
  return {
    body,
    succeeded: value.stopReason === "stop" && value.errorMessage === undefined,
    ...(typeof value.errorMessage === "string"
      ? { errorMessage: value.errorMessage }
      : {}),
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
      cost: usage.cost.total,
    },
  };
}

const emptyUsage = (): PiUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});

/** Run exactly one prompt and derive semantic completion only from Pi session events. */
export async function runPiAgentSession(
  session: PiSession,
  prompt: string,
  observeEvent: (event: AgentSessionEvent) => void = () => undefined,
): Promise<PiAgentResult> {
  let settled = false;
  const toolUses: Array<PiToolUse> = [];
  const unsubscribe = session.subscribe((event) => {
    observeEvent(event);
    if (event.type === "agent_settled") settled = true;
    if (event.type === "tool_execution_end") {
      toolUses.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      });
    }
  });
  try {
    await session.prompt(prompt);
    if (!settled) throw new Error("Pi prompt ended without agent_settled");
    const outcomes = session.messages.flatMap((message) => {
      const outcome = assistantOutcome(message);
      return outcome === undefined ? [] : [outcome];
    });
    const usage = outcomes.reduce<PiUsage>((total, outcome) => ({
      input: total.input + outcome.usage.input,
      output: total.output + outcome.usage.output,
      cacheRead: total.cacheRead + outcome.usage.cacheRead,
      cacheWrite: total.cacheWrite + outcome.usage.cacheWrite,
      totalTokens: total.totalTokens + outcome.usage.totalTokens,
      cost: total.cost + outcome.usage.cost,
    }), emptyUsage());
    const final = outcomes.at(-1);
    if (final === undefined || !final.succeeded || final.body.length === 0) {
      throw new PiAgentFailedError(
        session.sessionId,
        { usage, toolUses },
        final?.errorMessage ?? "Pi agent_settled without a successful semantic Result",
      );
    }
    return {
      sessionId: session.sessionId,
      body: final.body,
      usage,
      toolUses,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}
