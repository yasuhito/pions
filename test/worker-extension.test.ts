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
import {
  effectiveConfig,
  resultAcceptanceProof,
} from "./worker-protocol-fixtures.js";

interface RegisteredHandlers {
  readonly session_start: Array<
    (event: unknown, context: ExtensionContext) => Promise<void>
  >;
  readonly message_end: Array<(event: { readonly message: unknown }) => void>;
  readonly agent_settled: Array<
    (event: unknown, context: ExtensionContext) => void
  >;
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

async function extensionResult(
  repeatBegin = false,
  reconnectAfterAcceptance = false,
  reconnectAfterCompletion = false
) {
  const root = await mkdtemp(join(tmpdir(), "pions-worker-extension-"));
  const socketPath = join(root, "worker.sock");
  const promptPath = join(root, "prompt.utf8");
  const configPath = join(root, "worker.v14.json");
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
  let shutdownCount = 0;
  let shutdownCountBeforeAcknowledgement = -1;
  let beginAcknowledgementCount = 0;
  let editorFactory:
    | ((...arguments_: Array<never>) => { handleInput?(data: string): void })
    | undefined;
  const api = {
    registerFlag: () => undefined,
    getFlag: () => configPath,
    getActiveTools: () => [...effectiveConfig.tools],
    sendUserMessage: (prompt: string) => {
      prompts.push(prompt);
    },
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
      setEditorComponent: (factory: typeof editorFactory) => {
        editorFactory = factory;
      },
    },
    abort: () => undefined,
    shutdown: () => {
      shutdownCount += 1;
    },
  } as unknown as ExtensionContext;

  let peer = new HostProtocolPeer({
    operationId: config.operationId,
    capability,
  });
  let accepted!: Socket;
  let reconnecting = false;
  let connectionInterrupted = false;
  let completionConnectionInterrupted = false;
  let instruction!: Parameters<HostProtocolPeer["begin"]>[0];
  let resolveStarted!: () => void;
  let workerProcessInstanceId = "";
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveResult!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve) => {
    resolveResult = resolve;
  });
  const server = createServer((socket) => {
    accepted = socket;
    socket.on("data", (chunk: Buffer) => {
      for (const event of peer.receive(chunk)) {
        if (event.type === "started") {
          workerProcessInstanceId = event.processInstanceId;
          resolveStarted();
          if (reconnecting) {
            accepted.write(peer.updateDeliveryGeneration(2, "dispatcher-2"));
          }
        }
        if (event.type === "start_instruction_accepted") {
          if (reconnectAfterAcceptance && !connectionInterrupted) {
            connectionInterrupted = true;
            reconnecting = true;
            const instruction = event.instruction;
            accepted.destroy();
            server.close(() => {
              peer = new HostProtocolPeer({
                operationId: config.operationId,
                capability,
              });
              peer.restoreStartDelivery(instruction);
              server.listen(socketPath);
            });
          } else {
            accepted.write(
              peer.acknowledgeStartInstructionAcceptance(event.instruction)
            );
          }
        }
        if (event.type === "delivery_generation_updated") {
          peer.completeDispatcherHandoff("dispatcher-2");
        }
        if (event.type === "start_instruction_acknowledged") {
          beginAcknowledgementCount += 1;
        }
        if (event.type === "result_received") {
          if (reconnectAfterCompletion && !completionConnectionInterrupted) {
            completionConnectionInterrupted = true;
            reconnecting = true;
            accepted.destroy();
            server.close(() => {
              peer = new HostProtocolPeer({
                operationId: config.operationId,
                capability,
              });
              peer.restoreStartDelivery(instruction);
              server.listen(socketPath);
            });
          } else {
            shutdownCountBeforeAcknowledgement = shutdownCount;
            resolveResult(event.result);
            accepted.write(
              peer.acknowledgeResult(resultAcceptanceProof(config.operationId))
                .bytes
            );
          }
        }
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
    instruction = {
      dispatcherId: "pions-runtime",
      workerProcessInstanceId,
      receiptDigest: `sha256:${"e".repeat(64)}` as const,
      deliveryGeneration: 1,
      deadline: "2099-01-01T00:00:00.000Z",
    };
    accepted.write(peer.begin(instruction));
    if (repeatBegin) accepted.write(peer.begin(instruction));
    while (prompts.length === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const expectedBeginAcknowledgements = reconnectAfterAcceptance
      ? 0
      : repeatBegin
        ? 2
        : 1;
    while (beginAcknowledgementCount < expectedBeginAcknowledgements) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    handlers.message_end[0]?.({ message: assistant });
    handlers.agent_settled[0]?.({}, context);
    const delivery = await result;
    while (shutdownCount === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      beginAcknowledgementCount,
      delivery,
      promptCount: prompts.length,
      shutdownCountBeforeAcknowledgement,
      shutdownCount,
    };
  } finally {
    accepted?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    void editorFactory;
  }
}

test("Pi Worker extension returns the final settled assistant message", async () => {
  const delivery = await extensionResult();
  assert.equal(
    Buffer.from(
      (delivery.delivery as { body: { bytes: Uint8Array } }).body.bytes
    ).toString("utf8"),
    "review finished"
  );
});

test("Pi Worker extension injects a repeated begin prompt only once", async () => {
  assert.equal((await extensionResult(true)).promptCount, 1);
});

test("Pi Worker extension reconnects without reinjecting an accepted prompt", async () => {
  assert.equal((await extensionResult(false, true)).promptCount, 1);
});

test("Pi Worker extension recovers Result delivery after connection loss", async () => {
  const delivery = await extensionResult(false, false, true);

  assert.equal(
    Buffer.from(
      (delivery.delivery as { body: { bytes: Uint8Array } }).body.bytes
    ).toString("utf8"),
    "review finished"
  );
});

test("Pi Worker extension acknowledges every repeated begin", async () => {
  assert.equal((await extensionResult(true)).beginAcknowledgementCount, 2);
});

test("Pi Worker extension does not request shutdown before Result acknowledgement", async () => {
  assert.equal((await extensionResult()).shutdownCountBeforeAcknowledgement, 0);
});

test("Pi Worker extension requests normal shutdown after Result acknowledgement", async () => {
  assert.equal((await extensionResult()).shutdownCount, 1);
});

async function extensionCancellation(phase: "before-begin" | "during-run") {
  const root = await mkdtemp(join(tmpdir(), "pions-worker-cancellation-"));
  const socketPath = join(root, "worker.sock");
  const promptPath = join(root, "prompt.utf8");
  const configPath = join(root, "worker.v14.json");
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
  let abortCount = 0;
  let shutdownCount = 0;
  let cancellationCount = 0;
  const api = {
    registerFlag: () => undefined,
    getFlag: () => configPath,
    getActiveTools: () => [...effectiveConfig.tools],
    sendUserMessage: (prompt: string) => {
      prompts.push(prompt);
    },
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
    ui: { setEditorComponent: () => undefined },
    abort: () => {
      abortCount += 1;
    },
    shutdown: () => {
      shutdownCount += 1;
    },
  } as unknown as ExtensionContext;

  const peer = new HostProtocolPeer({
    operationId: config.operationId,
    capability,
  });
  let accepted!: Socket;
  let resolveStarted!: () => void;
  let workerProcessInstanceId = "";
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const server = createServer((socket) => {
    accepted = socket;
    socket.on("data", (chunk: Buffer) => {
      for (const event of peer.receive(chunk)) {
        if (event.type === "started") {
          workerProcessInstanceId = event.processInstanceId;
          resolveStarted();
        }
        if (event.type === "worker_cancelled") {
          cancellationCount += 1;
          resolveCancelled();
        }
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
    if (phase === "during-run") {
      accepted.write(
        peer.begin({
          dispatcherId: "pions-runtime",
          workerProcessInstanceId,
          receiptDigest: `sha256:${"e".repeat(64)}`,
          deliveryGeneration: 1,
          deadline: "2099-01-01T00:00:00.000Z",
        })
      );
      while (prompts.length === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    accepted.write(peer.requestCancellation() ?? Buffer.alloc(0));
    if (phase === "before-begin") {
      await cancelled;
    } else {
      while (abortCount === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const cancellationCountBeforeSettle = cancellationCount;
    handlers.agent_settled[0]?.({}, context);
    await cancelled;
    while (shutdownCount === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      abortCount,
      cancellationCountBeforeSettle,
      promptCount: prompts.length,
      shutdownCount,
    };
  } finally {
    accepted?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test("cancellation before begin starts no Pi prompt", async () => {
  assert.equal((await extensionCancellation("before-begin")).promptCount, 0);
});

test("cancellation during a Pi run aborts the current execution", async () => {
  assert.equal((await extensionCancellation("during-run")).abortCount, 1);
});

test("Pi Worker extension acknowledges cancellation only after interruption settles", async () => {
  assert.equal(
    (await extensionCancellation("during-run")).cancellationCountBeforeSettle,
    0
  );
});

test("Pi Worker extension requests normal shutdown for a cancelled run", async () => {
  assert.equal((await extensionCancellation("during-run")).shutdownCount, 1);
});
