import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  AcceptedResult,
  ResultAcceptancePreparationEvidence,
  ResultAcceptanceReservation,
} from "../public.js";

export function manifestReservationIsConsistent(
  reservation: Readonly<ResultAcceptanceReservation>,
): boolean {
  try {
    const parsed = JSON.parse(reservation.manifestCanonicalJson) as unknown;
    const digest = `sha256:${createHash("sha256")
      .update(reservation.manifestCanonicalJson, "utf8")
      .digest("hex")}`;
    return digest === reservation.manifestDigest &&
      isDeepStrictEqual(parsed, reservation.manifest) &&
      reservation.requirementSetId === reservation.manifest.requirementSetId &&
      reservation.requirementsDigest === reservation.manifest.requirementSetDigest;
  } catch {
    return false;
  }
}

function preparationEvidenceDigest(
  evidence: Readonly<ResultAcceptancePreparationEvidence>,
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    formatId: evidence.formatId,
    preparationId: evidence.preparationId,
    operationId: evidence.operationId,
    acceptanceRequestId: evidence.acceptanceRequestId,
    manifestDigest: evidence.manifestDigest,
    requirementsDigest: evidence.requirementsDigest,
    bodyArtifactId: evidence.bodyArtifactId,
    workProducts: evidence.workProducts,
    artifactIds: evidence.artifactIds,
    totalByteCount: evidence.totalByteCount,
    acceptedArtifactRetentionMs: evidence.acceptedArtifactRetentionMs,
    retentionPolicyDigest: evidence.retentionPolicyDigest,
  }), "utf8").digest("hex")}`;
}

export function preparationEvidenceMatchesReservation(
  evidence: Readonly<ResultAcceptancePreparationEvidence>,
  reservation: Readonly<ResultAcceptanceReservation>,
): boolean {
  return evidence.formatId === "pions.result-acceptance-preparation.v1" &&
    evidence.preparationId === reservation.preparationId &&
    evidence.operationId === reservation.operationId &&
    evidence.acceptanceRequestId === reservation.acceptanceRequestId &&
    evidence.manifestDigest === reservation.manifestDigest &&
    evidence.requirementsDigest === reservation.requirementsDigest &&
    evidence.bodyArtifactId === reservation.manifest.bodyArtifactId &&
    isDeepStrictEqual(evidence.workProducts, reservation.manifest.workProducts) &&
    isDeepStrictEqual(evidence.artifactIds, reservation.artifactIds) &&
    evidence.totalByteCount === reservation.totalByteCount &&
    evidence.digest === preparationEvidenceDigest(evidence) &&
    Number.isSafeInteger(evidence.acceptedArtifactRetentionMs) &&
    evidence.acceptedArtifactRetentionMs >= 0;
}

export function resultAcceptanceIdentifier(
  reservation: Readonly<ResultAcceptanceReservation>,
): AcceptedResult["acceptanceId"] {
  const value = createHash("sha256")
    .update(`${reservation.operationId}\u0000${reservation.preparationId}\u0000${reservation.manifestDigest}`, "utf8")
    .digest("hex");
  return `pions.result-acceptance.v1:${value}`;
}
