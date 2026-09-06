import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import {
  CHILD_PROTOCOL_VERSION,
  DEFAULT_MAX_FIRST_FRAME_BYTES,
  resultDigest,
} from "./internal/child-protocol.js";
import type {
  WorkerConfig,
  WorkerOutboundFrame,
} from "./internal/child-protocol.js";

function assistantOutcome(message: unknown): { readonly text: string; readonly succeeded: boolean } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as {
    readonly role?: unknown;
    readonly content?: unknown;
    readonly stopReason?: unknown;
    readonly errorMessage?: unknown;
  };
  if (record.role !== "assistant" || !Array.isArray(record.content)) return undefined;
  const text = record.content
    .filter((part): part is { readonly type: "text"; readonly text: string } =>
      typeof part === "object" && part !== null &&
      (part as { readonly type?: unknown }).type === "text" &&
      typeof (part as { readonly text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
  return text.length === 0
    ? undefined
    : {
        text,
        succeeded: record.stopReason === "stop" && record.errorMessage === undefined,
      };
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error("Worker configuration path is required");
  const config = JSON.parse(await readFile(configPath, "utf8")) as WorkerConfig;
  await readFile(config.promptPath);
  const socket = connect(config.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const processInstanceId = randomBytes(32).toString("hex");
  let sequenceNumber = 1;
  if (config.protocolVersion !== CHILD_PROTOCOL_VERSION) throw new Error("Unsupported child protocol version");
  const send = (frame: WorkerOutboundFrame): void => {
    socket.write(`${JSON.stringify({
      protocolVersion: config.protocolVersion,
      operationId: config.operationId,
      capability: config.capability,
      sequenceNumber: sequenceNumber++,
      ...frame,
    })}\n`);
  };
  send({ type: "hello", processInstanceId });
  send({ type: "started" });

  const child = spawn("pi", [
    "--mode", "json", "--print", "--no-extensions", "--no-skills",
    ...config.agentArgs,
    `@${config.promptPath}`,
  ], { cwd: config.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let assistantResult: string | undefined;
  let assistantSucceeded = false;
  let settled = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    process.stdout.write(chunk);
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { readonly type?: unknown; readonly message?: unknown };
        const outcome = assistantOutcome(event.message);
        if (outcome !== undefined) {
          assistantResult = outcome.text;
          assistantSucceeded = outcome.succeeded;
        }
        if (event.type === "agent_settled") settled = true;
      } catch {
        // Pi terminal output is displayed, but only JSON events can become semantic evidence.
      }
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(chunk);
    if (Buffer.byteLength(stderr, "utf8") < 1024 * 1024) stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  if (exitCode !== 0 || !settled || !assistantSucceeded || assistantResult === undefined) {
    const errorPath = join(dirname(configPath), "error.utf8");
    await writeFile(errorPath, stderr || "Pi exited without an agent_settled Result", { mode: 0o600 });
    await chmod(errorPath, 0o600);
    throw new Error("Pi exited without authenticated semantic completion");
  }
  const digest = resultDigest(assistantResult);
  send({ type: "result", body: assistantResult, digest, deliverySequenceNumber: 1 });
  send({ type: "done" });
  await new Promise<void>((resolve, reject) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, "utf8") > DEFAULT_MAX_FIRST_FRAME_BYTES) {
        reject(new Error("ChildChannel acknowledgement exceeds the frame limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const ack = JSON.parse(buffered.slice(0, newline)) as { readonly type?: unknown };
      if (ack.type === "ack") resolve();
      else reject(new Error("Worker received an invalid acknowledgement"));
    });
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("ChildChannel disconnected before ACK")));
  });
  socket.end();
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
