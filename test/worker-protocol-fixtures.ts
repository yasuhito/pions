import { createHash } from "node:crypto";

import type { ResultAcceptanceProof } from "../src/internal/worker-protocol.js";
import type {
  EffectiveWorkerConfig,
  ObservedWorkerConfig,
  RequestedWorkerConfig,
  Result,
  WorkerProfilePolicy,
} from "../src/public.js";
import type { AgentRunEvidence } from "../src/internal/services.js";
import { DEFAULT_MAX_RESULT_BYTE_COUNT } from "../src/internal/worker-configuration.js";

export const requestedConfig: RequestedWorkerConfig = {};
export const effectiveConfig: EffectiveWorkerConfig = {
  model: { provider: "test", id: "test-model" },
  thinkingLevel: "medium",
  tools: ["read", "bash"],
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
  thinkingLevel: { state: "observed", value: "medium" },
  tools: { state: "observed", value: ["read", "bash"] },
  cwd: { state: "observed", value: "/test/workspace" },
};
export const profilePolicy: WorkerProfilePolicy = {
  intendedUse: "reader",
  modelCandidates: [{ provider: "test", id: "test-model" }],
  thinkingLevel: "medium",
  tools: ["read", "bash"],
  resources: { resourceProofPolicy: "disabled" },
  startAuthorization: { policy: "disabled" },
  maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
};
export const maxResultByteCount = profilePolicy.maxResultByteCount;

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
  _body = "finished",
  eventSequenceNumber = 1
): ResultAcceptanceProof {
  return {
    operationId,
    acceptanceId: `pions.result-acceptance.v1:${"a".repeat(64)}`,
    digest: resultDigest("finished"),
    eventSequenceNumber,
  } as unknown as ResultAcceptanceProof;
}
