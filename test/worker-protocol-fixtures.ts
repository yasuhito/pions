import { createHash } from "node:crypto";

import type {
  ResultAcceptanceProof,
  ResultDelivery,
} from "../src/internal/worker-protocol.js";
import type {
  EffectiveWorkerConfig,
  ObservedWorkerConfig,
  RequestedWorkerConfig,
  Result,
  WorkerProfilePolicy,
} from "../src/public.js";
import type { AgentRunEvidence } from "../src/internal/services.js";

export const requestedConfig: RequestedWorkerConfig = {};
export const effectiveConfig: EffectiveWorkerConfig = {
  model: { provider: "test", id: "test-model" },
  thinkingLevel: "medium",
  tools: ["read", "bash", "edit", "write"],
  cwd: "/test/workspace",
  modelPolicy: {
    candidates: [{ provider: "test", id: "test-model" }],
    attempted: [{ provider: "test", id: "test-model" }],
    maxAttempts: 1,
    fallback: "forbidden",
    aliases: [],
  },
};
export const observedConfig: ObservedWorkerConfig = {
  model: { state: "observed", value: { provider: "test", id: "test-model" } },
  thinkingLevel: { state: "unavailable" },
  tools: { state: "observed", value: ["read", "bash", "edit", "write"] },
  cwd: { state: "observed", value: "/test/workspace" },
};
export const profilePolicy: WorkerProfilePolicy = {
  modelCandidates: [{ provider: "test", id: "test-model" }],
  thinkingLevel: "medium",
  tools: ["read", "bash", "edit", "write"],
};

export const piSessionId = "pi-session-1";
export const agentRunEvidence: AgentRunEvidence = {
  usage: {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 17,
    cost: 0.33,
  },
  toolUses: [{ toolCallId: "call-1", toolName: "read", isError: false }],
};

export function resultDigest(body: string): Result["digest"] {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function resultAcceptanceProof(
  operationId: string,
  body = "finished",
  sequenceNumber = 1,
): ResultAcceptanceProof {
  const delivery: ResultDelivery = {
    operationId,
    body,
    digest: resultDigest(body),
    sequenceNumber,
  };
  return {
    operationId,
    digest: delivery.digest,
    sequenceNumber: delivery.sequenceNumber,
  } as ResultAcceptanceProof;
}
