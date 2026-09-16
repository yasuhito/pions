import type { ArtifactDigest, ReviewInputReadiness } from "../public.js";
import { canonicalJson } from "./canonical-json.js";
import { sha256Digest } from "./result-digest.js";

export type ReviewInputReadinessDocument = Omit<
  ReviewInputReadiness,
  "readinessId" | "digest"
>;

export function reviewInputReadinessDigest(
  readiness: Readonly<ReviewInputReadinessDocument>
): ArtifactDigest {
  return sha256Digest(canonicalJson(readiness));
}

export function makeReviewInputReadiness(
  document: Readonly<ReviewInputReadinessDocument>
): Readonly<ReviewInputReadiness> {
  const digest = reviewInputReadinessDigest(document);
  return Object.freeze({
    ...structuredClone(document),
    readinessId: `pions.review-input-readiness.v1:${digest.slice("sha256:".length)}`,
    digest,
  });
}

export function validReviewInputReadiness(
  readiness: Readonly<ReviewInputReadiness>
): boolean {
  const { readinessId, digest, ...document } = readiness;
  return (
    digest === reviewInputReadinessDigest(document) &&
    readinessId ===
      `pions.review-input-readiness.v1:${digest.slice("sha256:".length)}`
  );
}
