import { createHash } from "node:crypto";

import type {
  ResultAcceptanceProof,
  ResultDelivery,
} from "../src/internal/worker-protocol.js";
import type { Result } from "../src/public.js";

export function resultDigest(body: string): Result["digest"] {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function resultAcceptanceProof(
  operationId: string,
  body = "finished",
  sequenceNumber = 1,
): ResultAcceptanceProof {
  const delivery: ResultDelivery = {
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
