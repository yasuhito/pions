import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import pionsWorkerExtension from "../src/worker-extension.js";
import {
  HostProtocolPeer,
  encodeWorkerConfig,
} from "../src/internal/worker-protocol.js";
import type { WorkerConfig } from "../src/internal/worker-protocol.js";
import { effectiveConfig, resultDigest } from "./worker-protocol-fixtures.js";

interface RegisteredHandlers {
  readonly session_start: Array<(event: unknown, context: ExtensionContext) => Promise<void>>;
  readonly message_end: Array<(event: { readonly message: unknown }) => void>;
  readonly agent_settled: Array<(event: unknown, context: ExtensionContext) => void>;
  readonly tool_execution_end: Array<(event: unknown) => void>;
  readonly session_shutdown: Array<(event: unknown) => void>;
}

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "review finished" }],
  stopReason: "stop",
  usage: {
    input: 10,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
  },
  timestamp: 1,
};

async function extensionResult(): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "pions-worker-extension-"));
  const socketPath = join(root, "worker.sock");
  const promptPath = join(root, "prompt.utf8");
  const configPath = join(root, "worker.v6.json");
  const capability = "ab".repeat(32);
  const config: WorkerConfig = {
    operationId: "operation-1",
    capability,
    socketPath,
    promptPath,
    effectiveConfig,
  };
  await writeFile(promptPath, "private review task", { mode: 0o600 });
  await writeFile(configPath, encodeWorkerConfig(config), { mode: 0o600 });
  await chmod(root, 0o700);

  const handlers: RegisteredHandlers = {
    session_start: [],
    message_end: [],
    agent_settled: [],
    tool_execution_end: [],
    session_shutdown: [],
  };
  const prompts: Array<string> = [];
  let editorFactory: ((...arguments_: Array<never>) => { handleInput?(data: string): void }) | undefined;
  const api = {
    registerFlag: () => undefined,
    getFlag: () => configPath,
    getActiveTools: () => [...effectiveConfig.tools],
    sendUserMessage: (prompt: string) => { prompts.push(prompt); },
    on: (event: keyof RegisteredHandlers, handler: never) => {
      handlers[event].push(handler);
    },
  } as unknown as ExtensionAPI;
  pionsWorkerExtension(api);

  const context = {
    cwd: effectiveConfig.cwd,
    model: effectiveConfig.model,
    thinkingLevel: effectiveConfig.thinkingLevel,
    sessionManager: {
      getSessionId: () => "pi-session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      setEditorComponent: (factory: typeof editorFactory) => { editorFactory = factory; },
    },
    abort: () => undefined,
    shutdown: () => undefined,
  } as unknown as ExtensionContext;

  const peer = new HostProtocolPeer({ operationId: config.operationId, capability });
  let accepted!: Socket;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let resolveResult!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve) => { resolveResult = resolve; });
  const server = createServer((socket) => {
    accepted = socket;
    socket.on("data", (chunk: Buffer) => {
      for (const event of peer.receive(chunk)) {
        if (event.type === "started") resolveStarted();
        if (event.type === "results_received") resolveResult(event.reception.deliveries[0]);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    await handlers.session_start[0]?.({}, context);
    await started;
    accepted.write(peer.begin());
    while (prompts.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    handlers.message_end[0]?.({ message: assistant });
    handlers.agent_settled[0]?.({}, context);
    return await result;
  } finally {
    accepted?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    void editorFactory;
  }
}

test("Pi Worker extension returns the final settled assistant message", async () => {
  assert.deepEqual(await extensionResult(), {
    operationId: "operation-1",
    body: "review finished",
    digest: resultDigest("review finished"),
    sequenceNumber: 1,
  });
});
