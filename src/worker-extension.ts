import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { PiToolUse, PiUsage } from "./internal/services.js";
import { currentProcessStartToken } from "./internal/worker-process-control.js";
import {
  WorkerProtocolPeer,
  decodeWorkerConfig,
} from "./internal/worker-protocol.js";
import type {
  WorkerConfig,
  WorkerProtocolEvent,
} from "./internal/worker-protocol.js";

const CONFIG_FLAG = "pions-worker-config";

class ObservationOnlyEditor extends CustomEditor {
  override handleInput(_data: string): void {
    // The official TUI remains visible, but terminal input cannot alter the run.
  }
}

interface AssistantMessage {
  readonly role: "assistant";
  readonly content: ReadonlyArray<unknown>;
  readonly stopReason: string;
  readonly errorMessage?: string;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
    readonly cost: { readonly total: number };
  };
}

function assistantMessage(value: unknown): AssistantMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<AssistantMessage>;
  return candidate.role === "assistant" &&
      Array.isArray(candidate.content) &&
      typeof candidate.stopReason === "string" &&
      typeof candidate.usage?.input === "number" &&
      typeof candidate.usage.output === "number" &&
      typeof candidate.usage.cacheRead === "number" &&
      typeof candidate.usage.cacheWrite === "number" &&
      typeof candidate.usage.totalTokens === "number" &&
      typeof candidate.usage.cost?.total === "number"
    ? candidate as AssistantMessage
    : undefined;
}

function assistantText(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  return message.content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const text = part as { readonly type?: unknown; readonly text?: unknown };
    return text.type === "text" && typeof text.text === "string" ? [text.text] : [];
  }).join("\n");
}

function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function addUsage(total: PiUsage, message: AssistantMessage): PiUsage {
  return {
    input: total.input + message.usage.input,
    output: total.output + message.usage.output,
    cacheRead: total.cacheRead + message.usage.cacheRead,
    cacheWrite: total.cacheWrite + message.usage.cacheWrite,
    totalTokens: total.totalTokens + message.usage.totalTokens,
    cost: total.cost + message.usage.cost.total,
  };
}

class PiWorkerBridge {
  private socket: Socket | undefined;
  private protocol: WorkerProtocolPeer | undefined;
  private finalAssistant: AssistantMessage | undefined;
  private usage = emptyUsage();
  private readonly toolUses: Array<PiToolUse> = [];
  private began = false;
  private cancelled = false;
  private completionSent = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: Readonly<WorkerConfig>,
  ) {}

  async start(ctx: ExtensionContext): Promise<void> {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new ObservationOnlyEditor(tui, theme, keybindings));
    this.protocol = new WorkerProtocolPeer({
      operationId: this.config.operationId,
      capability: this.config.capability,
    });
    this.socket = connect(this.config.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("connect", resolve);
      this.socket!.once("error", reject);
    });
    this.socket.on("data", (chunk: Buffer) => this.receiveControl(chunk, ctx));
    this.socket.on("error", () => undefined);
    this.send({
      type: "hello",
      processId: process.pid,
      processInstanceId: randomBytes(32).toString("hex"),
      processStartToken: await currentProcessStartToken(),
    });
    this.send({
      type: "started",
      piSessionId: ctx.sessionManager.getSessionId(),
      observedConfig: {
        model: ctx.model === undefined
          ? { state: "unavailable" }
          : {
              state: "observed",
              value: { provider: ctx.model.provider, id: ctx.model.id },
            },
        thinkingLevel: ctx.thinkingLevel === undefined
          ? { state: "unavailable" }
          : { state: "observed", value: ctx.thinkingLevel },
        tools: { state: "observed", value: this.pi.getActiveTools() },
        cwd: { state: "observed", value: ctx.cwd },
      },
    });
  }

  recordAssistant(value: unknown): void {
    const message = assistantMessage(value);
    if (message === undefined) return;
    this.finalAssistant = message;
    this.usage = addUsage(this.usage, message);
  }

  recordToolUse(toolUse: PiToolUse): void {
    this.toolUses.push(toolUse);
  }

  settle(ctx: ExtensionContext): void {
    if (this.completionSent) return;
    if (this.cancelled) {
      this.completionSent = true;
      this.send({ type: "cancelled" });
      this.socket?.end(() => ctx.shutdown());
      return;
    }
    const body = assistantText(this.finalAssistant);
    if (
      this.finalAssistant === undefined ||
      this.finalAssistant.stopReason !== "stop" ||
      this.finalAssistant.errorMessage !== undefined ||
      body.length === 0
    ) {
      this.completionSent = true;
      this.send({
        type: "failed",
        errorMessage: this.finalAssistant?.errorMessage ??
          "Pi agent_settled without a successful semantic Result",
        usage: this.usage,
        toolUses: this.toolUses,
      });
      return;
    }
    this.completionSent = true;
    const bytes = Buffer.from(body, "utf8");
    this.send({
      type: "artifacts",
      result: {
        acceptanceRequestId: "result-1",
        body: {
          formatId: "pions.result-body.v1",
          normalizationId: "identity.v1",
          expectedByteCount: bytes.byteLength,
          expectedDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          bytes,
        },
        workProducts: [],
      },
    });
    this.send({ type: "done", usage: this.usage, toolUses: this.toolUses });
  }

  close(): void {
    this.socket?.end();
  }

  private receiveControl(chunk: Buffer, ctx: ExtensionContext): void {
    try {
      const reception = this.protocol!.receive(chunk);
      if (reception.cancellationRequested && !this.cancelled) {
        this.cancelled = true;
        if (this.began) ctx.abort();
        else this.settle(ctx);
      }
      if (reception.beginReceived && !this.cancelled && !this.began) {
        this.began = true;
        void this.begin(ctx).catch((error) => {
          if (this.completionSent) return;
          this.completionSent = true;
          this.send({
            type: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            usage: this.usage,
            toolUses: this.toolUses,
          });
        });
      }
      if (reception.acknowledgementsComplete) {
        this.socket?.end(() => ctx.shutdown());
      }
    } catch {
      this.socket?.destroy();
    }
  }

  private async begin(ctx: ExtensionContext): Promise<void> {
    const prompt = await readFile(this.config.promptPath, "utf8");
    if (this.cancelled) {
      this.settle(ctx);
      return;
    }
    this.pi.sendUserMessage(prompt);
  }

  private send(event: WorkerProtocolEvent): void {
    this.socket?.write(this.protocol!.send(event));
  }
}

export default function pionsWorkerExtension(pi: ExtensionAPI): void {
  pi.registerFlag(CONFIG_FLAG, {
    description: "Pions private Worker configuration path",
    type: "string",
  });
  let bridge: PiWorkerBridge | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const configPath = pi.getFlag(CONFIG_FLAG);
    if (typeof configPath !== "string" || configPath.length === 0) {
      throw new Error("Pions Worker configuration path is required");
    }
    const config = decodeWorkerConfig(await readFile(configPath, "utf8"));
    bridge = new PiWorkerBridge(pi, config);
    await bridge.start(ctx);
  });

  pi.on("message_end", (event) => {
    bridge?.recordAssistant(event.message);
  });

  pi.on("tool_execution_end", (event) => {
    bridge?.recordToolUse({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    bridge?.settle(ctx);
  });

  pi.on("session_shutdown", () => {
    bridge?.close();
  });
}
