import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  PiAgentFailedError,
  observePiAgentConfiguration,
  runPiAgentSession,
} from "./internal/pi-agent-backend.js";
import {
  WorkerProtocolPeer,
  decodeWorkerConfig,
} from "./internal/worker-protocol.js";
import type { WorkerProtocolEvent } from "./internal/worker-protocol.js";
import { WorkerConfigurationError } from "./public.js";

function displayEvent(event: AgentSessionEvent): void {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
    return;
  }
  if (event.type === "tool_execution_start") {
    process.stdout.write(`\n[tool] ${event.toolName}\n`);
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error("Worker configuration path is required");
  const config = decodeWorkerConfig(await readFile(configPath, "utf8"));
  const prompt = await readFile(config.promptPath, "utf8");
  const socket = connect(config.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const processInstanceId = randomBytes(32).toString("hex");
  const protocol = new WorkerProtocolPeer({
    operationId: config.operationId,
    capability: config.capability,
  });
  const send = (event: WorkerProtocolEvent): void => {
    socket.write(protocol.send(event));
  };
  send({ type: "hello", processInstanceId });

  let session;
  try {
    const agentDir = getAgentDir();
    const services = await createAgentSessionServices({
      cwd: config.effectiveConfig.cwd,
      agentDir,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
      },
    });
    const model = services.modelRuntime.getModel(
      config.effectiveConfig.model.provider,
      config.effectiveConfig.model.id,
    );
    if (model === undefined) {
      throw new WorkerConfigurationError("model_mismatch", "Exact configured model is unavailable");
    }
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(config.effectiveConfig.cwd),
      model,
      thinkingLevel: config.effectiveConfig.thinkingLevel,
      tools: [...config.effectiveConfig.tools],
    });
    session = created.session;
    if (created.modelFallbackMessage !== undefined) {
      session.dispose();
      throw new WorkerConfigurationError("model_mismatch", "Pi reported a model fallback");
    }
    observePiAgentConfiguration(session, config.effectiveConfig, process.cwd());
  } catch (error) {
    session?.dispose();
    const reason = error instanceof WorkerConfigurationError
      ? error.reason
      : "unsupported_capability";
    send({ type: "configuration_failed", reason });
    socket.end();
    return;
  }
  send({
    type: "started",
    piSessionId: session.sessionId,
    observedConfig: observePiAgentConfiguration(
      session,
      config.effectiveConfig,
      process.cwd(),
    ),
  });

  let result;
  try {
    result = await runPiAgentSession(session, prompt, displayEvent);
  } catch (error) {
    if (!(error instanceof PiAgentFailedError)) throw error;
    send({
      type: "failed",
      errorMessage: error.message,
      usage: error.evidence.usage,
      toolUses: error.evidence.toolUses,
    });
    socket.end();
    return;
  }
  send({ type: "result", body: result.body, deliverySequenceNumber: 1 });
  send({ type: "done", usage: result.usage, toolUses: result.toolUses });
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      try {
        if (protocol.receive(chunk).acknowledgementsComplete) resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("Worker protocol disconnected before ACK")));
  });
  socket.end();
}

void main().catch(async (error) => {
  const configPath = process.argv[2];
  if (configPath !== undefined) {
    const errorPath = join(dirname(configPath), "error.utf8");
    await writeFile(errorPath, String(error), { mode: 0o600 }).catch(() => undefined);
    await chmod(errorPath, 0o600).catch(() => undefined);
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
