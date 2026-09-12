import { createHash } from "node:crypto";

import type {
  ArtifactDigest,
  ArtifactMetadata,
  ReviewSubjectRegistrationEvidence,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

export function reviewSubjectRegistrationEvidenceId(
  rootArtifactId: string
): string {
  return `review-subject-evidence-${createHash("sha256")
    .update(rootArtifactId, "utf8")
    .digest("hex")}`;
}

export function reviewSubjectRegistrationEvidenceDocument(
  evidence: Omit<ReviewSubjectRegistrationEvidence, "digest">
): Omit<ReviewSubjectRegistrationEvidence, "digest"> {
  return {
    formatId: evidence.formatId,
    evidenceId: evidence.evidenceId,
    issuerId: evidence.issuerId,
    root: {
      artifactId: evidence.root.artifactId,
      byteCount: evidence.root.byteCount,
      digest: evidence.root.digest,
      formatId: evidence.root.formatId,
      normalizationId: evidence.root.normalizationId,
      dependencies: [...evidence.root.dependencies],
    },
    files: evidence.files.map((file) => ({
      path: file.path,
      artifactId: file.artifactId,
      byteCount: file.byteCount,
      digest: file.digest,
      formatId: file.formatId,
      normalizationId: file.normalizationId,
    })),
    collectionDigest: evidence.collectionDigest,
    validator: {
      validatorId: evidence.validator.validatorId,
      version: evidence.validator.version,
    },
  };
}

export function reviewSubjectRegistrationEvidenceDigest(
  evidence: Omit<ReviewSubjectRegistrationEvidence, "digest">
): ArtifactDigest {
  return sha256Digest(
    JSON.stringify(reviewSubjectRegistrationEvidenceDocument(evidence))
  );
}

export function artifactMetadataMatches(
  actual: Readonly<ArtifactMetadata>,
  expected: Readonly<ArtifactMetadata>
): boolean {
  return (
    actual.artifactId === expected.artifactId &&
    actual.byteCount === expected.byteCount &&
    actual.digest === expected.digest &&
    actual.formatId === expected.formatId &&
    actual.normalizationId === expected.normalizationId &&
    actual.dependencies.length === expected.dependencies.length &&
    actual.dependencies.every(
      (dependency, index) => dependency === expected.dependencies[index]
    )
  );
}
