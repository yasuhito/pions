import { createHash } from "node:crypto";

import type {
  ResultAcceptanceProof,
  ResultDelivery,
} from "../src/internal/worker-protocol.js";
import type { Result } from "../src/public.js";
import type { AgentRunEvidence } from "../src/internal/services.js";

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
