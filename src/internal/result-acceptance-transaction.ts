import type {
  AcceptedResult,
  ResultAcceptanceRetentionPolicyEvidence,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function resultAcceptanceRetentionPolicy(
  operationId: string,
  acceptedArtifactRetentionMs: number
): ResultAcceptanceRetentionPolicyEvidence {
  const value = {
    formatId: "pions.result-acceptance-retention-policy.v1" as const,
    operationId,
    acceptedArtifactRetentionMs,
  };
  return {
    ...value,
    digest: sha256Digest(JSON.stringify(value)),
  };
}

/**
 * The Result acceptance identifier is derived from the Operation, the
 * acceptance request and the exact accepted bytes, so a resent request joins
 * the same acceptance and different content can never share its identifier.
 */
export function resultAcceptanceIdentifier(
  acceptance: Pick<
    AcceptedResult,
    "operationId" | "acceptanceRequestId" | "byteCount" | "digest"
  >
): AcceptedResult["acceptanceId"] {
  const digest = sha256Digest(
    `${acceptance.operationId}\u0000${acceptance.acceptanceRequestId}\u0000${acceptance.byteCount}\u0000${acceptance.digest}`
  );
  return `pions.result-acceptance.v1:${digest.slice("sha256:".length)}`;
}

/** Structural integrity of a persisted acceptance, independent of the body bytes. */
export function acceptedResultIsConsistent(
  acceptance: Readonly<AcceptedResult>,
  maxByteCount: number
): boolean {
  return (
    acceptance.acceptanceRequestId.length > 0 &&
    Number.isSafeInteger(acceptance.byteCount) &&
    acceptance.byteCount >= 0 &&
    acceptance.byteCount <= maxByteCount &&
    DIGEST.test(acceptance.digest) &&
    acceptance.acceptanceId === resultAcceptanceIdentifier(acceptance)
  );
}
