import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  PiAgentFailedError,
  runPiAgentSession,
} from "../src/internal/pi-agent-backend.js";

interface FakeAssistantMessage {
  readonly role: "assistant";
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly stopReason: "stop" | "error";
  readonly errorMessage?: string;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
    readonly cost: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly total: number;
    };
  };
}

function assistant(text: string): FakeAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    },
  };
}

class FakeSession {
  readonly sessionId = "pi-session-1";
  readonly messages: Array<FakeAssistantMessage> = [];
  private listener: ((event: AgentSessionEvent) => void) | undefined;

  constructor(private readonly events: ReadonlyArray<AgentSessionEvent>) {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  async prompt(_prompt: string): Promise<void> {
    for (const event of this.events) {
      if (event.type === "message_end" && event.message.role === "assistant") {
        this.messages.push(event.message as unknown as FakeAssistantMessage);
      }
      this.listener?.(event);
    }
  }

  dispose(): void {}
}

const settled = { type: "agent_settled" } as const;

function messageEnd(message: FakeAssistantMessage): AgentSessionEvent {
  return { type: "message_end", message } as unknown as AgentSessionEvent;
}

test("Pi backend waits through a retrying agent_end for agent_settled", async () => {
  const final = assistant("finished");
  const session = new FakeSession([
    { type: "agent_end", messages: [], willRetry: true },
    messageEnd(final),
    settled,
  ]);

  const result = await runPiAgentSession(session, "do work");

  assert.equal(result.body, "finished");
});

test("Pi backend records the Pi session identifier", async () => {
  const session = new FakeSession([messageEnd(assistant("finished")), settled]);

  const result = await runPiAgentSession(session, "do work");

  assert.equal(result.sessionId, "pi-session-1");
});

test("Pi backend obtains usage from the final assistant message", async () => {
  const session = new FakeSession([messageEnd(assistant("finished")), settled]);

  const result = await runPiAgentSession(session, "do work");

  assert.deepEqual(result.usage, {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 17,
    cost: 0.33,
  });
});

test("Pi backend obtains tool use from lifecycle events", async () => {
  const session = new FakeSession([
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false },
    { type: "tool_execution_end", toolCallId: "call-2", toolName: "bash", result: {}, isError: true },
    messageEnd(assistant("finished")),
    settled,
  ]);

  const result = await runPiAgentSession(session, "do work");

  assert.deepEqual(result.toolUses, [
    { toolCallId: "call-1", toolName: "read", isError: false },
    { toolCallId: "call-2", toolName: "bash", isError: true },
  ]);
});

async function settledFailure(): Promise<PiAgentFailedError> {
  const failed = {
    ...assistant("failed"),
    stopReason: "error" as const,
    errorMessage: "provider failed",
  };
  const session = new FakeSession([
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: true },
    messageEnd(failed),
    settled,
  ]);
  try {
    await runPiAgentSession(session, "do work");
  } catch (error) {
    if (error instanceof PiAgentFailedError) return error;
    throw error;
  }
  throw new Error("Expected the Pi session to fail");
}

test("Pi backend preserves the settled Pi failure", async () => {
  assert.equal((await settledFailure()).message, "provider failed");
});

test("Pi backend preserves usage from a settled Pi failure", async () => {
  assert.equal((await settledFailure()).evidence.usage.totalTokens, 17);
});

test("Pi backend preserves tool use from a settled Pi failure", async () => {
  assert.deepEqual((await settledFailure()).evidence.toolUses, [
    { toolCallId: "call-1", toolName: "read", isError: true },
  ]);
});

test("Pi backend rejects completion without agent_settled", async () => {
  const session = new FakeSession([messageEnd(assistant("not settled"))]);

  await assert.rejects(runPiAgentSession(session, "do work"), /agent_settled/);
});
