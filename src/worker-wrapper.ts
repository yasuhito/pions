import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  PiAgentFailedError,
  runPiAgentSession,
} from "./internal/pi-agent-backend.js";
import {
  WorkerProtocolPeer,
  decodeWorkerConfig,
} from "./internal/worker-protocol.js";
import type { WorkerProtocolEvent } from "./internal/worker-protocol.js";

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

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(config.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: config.cwd,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(config.cwd),
  });
  send({ type: "started", piSessionId: session.sessionId });

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
