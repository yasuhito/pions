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
import { BODY_ONLY_WORK_PRODUCT_REQUIREMENTS } from "../src/internal/worker-configuration.js";
import { resolveWorkProductRequirements } from "../src/internal/result-acceptance-manifest.js";
import { resultAcceptanceRetentionPolicy } from "../src/internal/result-acceptance-transaction.js";

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
  thinkingLevel: { state: "observed", value: "medium" },
  tools: { state: "observed", value: ["read", "bash", "edit", "write"] },
  cwd: { state: "observed", value: "/test/workspace" },
};
export const profilePolicy: WorkerProfilePolicy = {
  modelCandidates: [{ provider: "test", id: "test-model" }],
  thinkingLevel: "medium",
  tools: ["read", "bash", "edit", "write"],
  resources: { resourceProofPolicy: "disabled" },
  startAuthorization: { policy: "disabled" },
  workProductRequirements: BODY_ONLY_WORK_PRODUCT_REQUIREMENTS,
  acceptedArtifactRetentionMs: 86_400_000,
};
export const workProductRequirements = resolveWorkProductRequirements(profilePolicy);
export const retentionPolicy = (operationId: string) =>
  resultAcceptanceRetentionPolicy(operationId, profilePolicy.acceptedArtifactRetentionMs);

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
  eventSequenceNumber = 1,
): ResultAcceptanceProof {
  return {
    operationId,
    acceptanceId: `pions.result-acceptance.v1:${"a".repeat(64)}`,
    manifestDigest: resultDigest("manifest"),
    eventSequenceNumber,
  } as unknown as ResultAcceptanceProof;
}
