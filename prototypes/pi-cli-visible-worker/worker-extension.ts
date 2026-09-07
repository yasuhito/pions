// THROWAWAY PROTOTYPE: Pi CLI visible worker feasibility only.
import { randomBytes } from "node:crypto";
import { readFile, appendFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { CustomEditor, type ExtensionAPI } from "/home/yasuhito/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { WorkerProtocolPeer } from "/home/yasuhito/Work/pions/dist/src/internal/worker-protocol.js";

class LockedEditor extends CustomEditor {
  override handleInput(_data: string): void {
    // Observation-only: deliberately discard every keyboard input.
  }
}

type Config = {
  operationId: string;
  capability: string;
  socketPath: string;
  promptPath: string;
  evidencePath: string;
  expected: { model: { provider: string; id: string }; thinkingLevel: string; tools: string[]; cwd: string };
  forceFailure?: boolean;
  launchGatePath?: string;
};

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

function processStartToken(stat: string): string {
  const end = stat.lastIndexOf(")");
  const token = stat.slice(end + 1).trim().split(/\s+/u)[19];
  if (!token) throw new Error("process start token unavailable");
  return token;
}

function assistantText(message: any): string {
  return Array.isArray(message?.content)
    ? message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n")
    : "";
}

function usageOf(message: any) {
  const usage = message?.usage;
  if (!usage) return emptyUsage;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)),
    cost: usage.cost?.total ?? usage.cost ?? 0,
  };
}

export default function (pi: ExtensionAPI) {
  const configPath = process.env.PIONS_PROTO_CONFIG;
  if (!configPath) throw new Error("PIONS_PROTO_CONFIG is required");
  let socket: Socket | undefined;
  let protocol: WorkerProtocolPeer | undefined;
  let finalAssistant: any;
  let settled = false;
  let cancellationRequested = false;
  const toolUses: Array<{ toolCallId: string; toolName: string; isError: boolean }> = [];
  const log = async (event: string, details: Record<string, unknown> = {}) => {
    const config = JSON.parse(await readFile(configPath, "utf8")) as Config;
    await appendFile(config.evidencePath, `${JSON.stringify({ at: Date.now(), actor: "extension", event, ...details })}\n`, { mode: 0o600 });
  };

  pi.on("session_start", async (_event, ctx) => {
    const config = JSON.parse(await readFile(configPath, "utf8")) as Config;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new LockedEditor(tui, theme, keybindings));
    ctx.ui.setStatus("pions-prototype", "observation-only input");

    protocol = new WorkerProtocolPeer({ operationId: config.operationId, capability: config.capability });
    socket = connect(config.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", resolve);
      socket!.once("error", reject);
    });
    socket.on("data", (bytes: Buffer) => {
      try {
        const reception = protocol!.receive(bytes);
        if (reception.cancellationRequested && !cancellationRequested) {
          cancellationRequested = true;
          void log("cancel_received");
          ctx.abort();
        }
        if (reception.acknowledgementsComplete) {
          void log("ack_received", { isIdle: ctx.isIdle() }).then(() => {
            socket!.end();
            ctx.shutdown();
          });
        }
      } catch (error) {
        void log("protocol_receive_error", { error: String(error) });
        socket!.destroy();
      }
    });
    socket.on("end", () => void log("socket_ended", { settled }));
    socket.on("error", (error) => void log("socket_error", { error: String(error) }));

    const activeTools = pi.getActiveTools();
    const observedConfig = {
      model: ctx.model ? { state: "observed" as const, value: { provider: ctx.model.provider, id: ctx.model.id } } : { state: "unavailable" as const },
      thinkingLevel: { state: "observed" as const, value: ctx.thinkingLevel },
      tools: { state: "observed" as const, value: activeTools },
      cwd: { state: "observed" as const, value: ctx.cwd },
    };
    socket.write(protocol.send({
      type: "hello",
      processId: process.pid,
      processInstanceId: randomBytes(32).toString("hex"),
      processStartToken: processStartToken(await readFile("/proc/self/stat", "utf8")),
    }));
    socket.write(protocol.send({ type: "started", piSessionId: ctx.sessionManager.getSessionId(), observedConfig }));
    await log("started", { pid: process.pid, sessionFile: ctx.sessionManager.getSessionFile(), observedConfig, promptPath: config.promptPath });

    const launch = async () => {
      if (config.launchGatePath) {
        await log("waiting_for_launch_gate", { launchGatePath: config.launchGatePath });
        while (true) {
          try {
            await readFile(config.launchGatePath);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        await log("launch_gate_observed");
      }
      const prompt = await readFile(config.promptPath, "utf8");
      await log("prompt_loaded", { bytes: Buffer.byteLength(prompt), argv: process.argv });
      pi.sendUserMessage(prompt);
    };
    if (config.launchGatePath) void launch();
    else await launch();
  });

  pi.on("message_end", async (event) => {
    if (event.message.role === "assistant") {
      finalAssistant = event.message;
      await log("assistant_finalized", { stopReason: (event.message as any).stopReason, text: assistantText(event.message) });
    }
  });

  pi.on("tool_execution_end", async (event) => {
    toolUses.push({ toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
    await log("tool_end", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    settled = true;
    await log("agent_settled", { cancellationRequested, stopReason: finalAssistant?.stopReason, isIdle: ctx.isIdle() });
    if (!socket || !protocol) return;
    if (cancellationRequested) {
      socket.write(protocol.send({ type: "cancelled" }));
      await log("cancelled_sent");
      return;
    }
    const body = assistantText(finalAssistant).trim();
    const usage = usageOf(finalAssistant);
    if (configPath && (JSON.parse(await readFile(configPath, "utf8")) as Config).forceFailure) {
      socket.write(protocol.send({ type: "failed", errorMessage: "prototype forced failure", usage, toolUses }));
      await log("failed_sent", { forced: true });
      return;
    }
    if (finalAssistant?.stopReason !== "stop" || body.length === 0) {
      socket.write(protocol.send({ type: "failed", errorMessage: finalAssistant?.errorMessage ?? `stopReason=${String(finalAssistant?.stopReason)}`, usage, toolUses }));
      await log("failed_sent", { forced: false });
      return;
    }
    socket.write(protocol.send({ type: "result", body, deliverySequenceNumber: 1 }));
    socket.write(protocol.send({ type: "done", usage, toolUses }));
    await log("result_sent", { body, waitingForAck: true });
  });

  pi.on("session_shutdown", async (event) => {
    await log("session_shutdown", { reason: event.reason });
  });
}
