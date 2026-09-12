import type { ArtifactDigest, ReviewInputReadiness } from "../public.js";
import { sha256Digest } from "./result-digest.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
