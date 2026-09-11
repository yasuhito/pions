import {
  ResultAcceptanceManifestError,
  WorkProductRequirementsError,
  type ArtifactContentRequirement,
  type ArtifactDigest,
  type ArtifactMetadata,
  type CanonicalResultAcceptanceManifestDocument,
  type ResolvedWorkProductRequirements,
  type ResultAcceptanceManifest,
  type ResultAcceptanceManifestWorkProduct,
  type ValidatedResultAcceptanceManifest,
  type WorkerProfilePolicy,
  type WorkProductRequirement,
  type WorkProductRequirementsPolicy,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

const MANIFEST_FORMAT_ID = "pions.result-acceptance-manifest.v1" as const;
const CANONICAL_JSON_NORMALIZATION_ID = "pions.canonical-json.v1" as const;
const REQUIREMENT_SET_ID_PREFIX =
  "pions.work-product-requirements.v1:" as const;

function isNonEmptyAscii(value: string): boolean {
  return (
    value.length > 0 &&
    [...value].every((character) => character.codePointAt(0)! <= 0x7f)
  );
}

function digest(bytes: Uint8Array): ArtifactDigest {
  return sha256Digest(bytes);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactKeys(value: object, expected: ReadonlyArray<string>): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort(compare);
  const sortedExpected = [...expected].sort(compare);
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError("Canonical JSON numbers must be safe integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compare)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Value is not canonical JSON data");
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validContentRequirement(requirement: unknown): boolean {
  if (requirement === null || typeof requirement !== "object") return false;
  const value = requirement as Partial<ArtifactContentRequirement>;
  return (
    typeof value.formatId === "string" &&
    value.formatId.length > 0 &&
    typeof value.normalizationId === "string" &&
    value.normalizationId.length > 0 &&
    nonNegativeSafeInteger(value.maxByteCount)
  );
}

function cloneContentRequirement(
  requirement: Readonly<ArtifactContentRequirement>
): ArtifactContentRequirement {
  return Object.freeze({
    formatId: requirement.formatId,
    normalizationId: requirement.normalizationId,
    maxByteCount: requirement.maxByteCount,
  });
}

function failRequirements(
  reason: WorkProductRequirementsError["reason"],
  message: string
): never {
  throw new WorkProductRequirementsError(reason, message);
}

function resolveRequirementsPolicy(
  policy: Readonly<WorkProductRequirementsPolicy>
): ResolvedWorkProductRequirements {
  if (
    policy === undefined ||
    policy === null ||
    typeof policy !== "object" ||
    !hasExactKeys(policy, ["body", "workProducts", "maxTotalByteCount"]) ||
    !validContentRequirement(policy.body) ||
    !hasExactKeys(policy.body, [
      "formatId",
      "normalizationId",
      "maxByteCount",
    ]) ||
    !nonNegativeSafeInteger(policy.maxTotalByteCount) ||
    !Array.isArray(policy.workProducts)
  ) {
    failRequirements(
      "invalid_requirement",
      "Work product requirements are incomplete"
    );
  }
  const seen = new Set<string>();
  const workProducts = policy.workProducts
    .map((requirement: unknown): WorkProductRequirement => {
      if (requirement === null || typeof requirement !== "object") {
        failRequirements(
          "invalid_key",
          "Work product keys must be non-empty ASCII"
        );
      }
      const candidate = requirement as Partial<WorkProductRequirement>;
      if (
        typeof candidate.key !== "string" ||
        !isNonEmptyAscii(candidate.key)
      ) {
        failRequirements(
          "invalid_key",
          "Work product keys must be non-empty ASCII"
        );
      }
      if (seen.has(candidate.key))
        failRequirements(
          "duplicate_key",
          `Duplicate work product key: ${candidate.key}`
        );
      seen.add(candidate.key);
      if (
        !hasExactKeys(requirement, [
          "key",
          "formatId",
          "normalizationId",
          "minCount",
          "maxCount",
          "maxByteCount",
        ]) ||
        !validContentRequirement(candidate) ||
        !nonNegativeSafeInteger(candidate.minCount) ||
        !nonNegativeSafeInteger(candidate.maxCount) ||
        candidate.minCount > candidate.maxCount
      ) {
        failRequirements(
          "invalid_requirement",
          `Invalid requirement for work product key: ${candidate.key}`
        );
      }
      const valid = candidate as WorkProductRequirement;
      return Object.freeze({
        key: valid.key,
        formatId: valid.formatId,
        normalizationId: valid.normalizationId,
        minCount: valid.minCount,
        maxCount: valid.maxCount,
        maxByteCount: valid.maxByteCount,
      });
    })
    .sort((left, right) => compare(left.key, right.key));
  const value = {
    body: cloneContentRequirement(policy.body),
    workProducts: Object.freeze(workProducts),
    maxTotalByteCount: policy.maxTotalByteCount,
  };
  const json = canonicalJson(value);
  const requirementDigest = digest(Buffer.from(json, "utf8"));
  return Object.freeze({
    ...value,
    requirementSetId: `${REQUIREMENT_SET_ID_PREFIX}${requirementDigest.slice("sha256:".length)}`,
    digest: requirementDigest,
    canonicalJson: json,
  });
}

export function resolveWorkProductRequirements(
  profile: Pick<Readonly<WorkerProfilePolicy>, "workProductRequirements">
): ResolvedWorkProductRequirements {
  return resolveRequirementsPolicy(profile.workProductRequirements);
}

function failManifest(
  reason: ResultAcceptanceManifestError["reason"],
  message: string
): never {
  throw new ResultAcceptanceManifestError(reason, message);
}

function normalizeManifest(
  input: Readonly<ResultAcceptanceManifest>
): ResultAcceptanceManifest {
  if (input === null || typeof input !== "object") {
    failManifest(
      "invalid_manifest",
      "Result acceptance manifest is incomplete"
    );
  }
  if (
    !hasExactKeys(input, [
      "formatId",
      "normalizationId",
      "bodyArtifactId",
      "requirementSetId",
      "requirementSetDigest",
      "workProducts",
    ])
  ) {
    failManifest(
      "unknown_field",
      "Result acceptance manifest fields do not match its version"
    );
  }
  if (
    !Array.isArray(input.workProducts) ||
    typeof input.bodyArtifactId !== "string" ||
    input.bodyArtifactId.length === 0 ||
    typeof input.requirementSetId !== "string" ||
    typeof input.requirementSetDigest !== "string"
  ) {
    failManifest(
      "invalid_manifest",
      "Result acceptance manifest is incomplete"
    );
  }
  if (input.formatId !== MANIFEST_FORMAT_ID)
    failManifest(
      "unsupported_format",
      "Unsupported result acceptance manifest format"
    );
  if (input.normalizationId !== CANONICAL_JSON_NORMALIZATION_ID) {
    failManifest(
      "unsupported_normalization",
      "Unsupported result acceptance manifest normalization"
    );
  }
  const seenKeys = new Set<string>();
  const workProducts = input.workProducts
    .map((entry): ResultAcceptanceManifestWorkProduct => {
      if (entry === null || typeof entry !== "object") {
        failManifest(
          "invalid_manifest",
          "A work product manifest entry is invalid"
        );
      }
      if (!hasExactKeys(entry, ["key", "artifactIds"])) {
        failManifest(
          "unknown_field",
          "Work product manifest fields do not match its version"
        );
      }
      if (
        typeof entry.key !== "string" ||
        !isNonEmptyAscii(entry.key) ||
        !Array.isArray(entry.artifactIds) ||
        entry.artifactIds.some(
          (artifactId: unknown) =>
            typeof artifactId !== "string" || artifactId.length === 0
        )
      ) {
        failManifest(
          "invalid_manifest",
          "A work product manifest entry is invalid"
        );
      }
      if (seenKeys.has(entry.key))
        failManifest(
          "duplicate_key",
          `Duplicate work product key: ${entry.key}`
        );
      seenKeys.add(entry.key);
      if (new Set(entry.artifactIds).size !== entry.artifactIds.length) {
        failManifest(
          "duplicate_artifact",
          `Duplicate artifact for work product key: ${entry.key}`
        );
      }
      return Object.freeze({
        key: entry.key,
        artifactIds: Object.freeze([...entry.artifactIds].sort(compare)),
      });
    })
    .sort((left, right) => compare(left.key, right.key));
  return Object.freeze({
    formatId: MANIFEST_FORMAT_ID,
    normalizationId: CANONICAL_JSON_NORMALIZATION_ID,
    bodyArtifactId: input.bodyArtifactId,
    requirementSetId: input.requirementSetId,
    requirementSetDigest: input.requirementSetDigest,
    workProducts: Object.freeze(workProducts),
  });
}

export function resultAcceptanceManifestDocument(
  input: Readonly<ResultAcceptanceManifest>
): CanonicalResultAcceptanceManifestDocument {
  const value = normalizeManifest(input);
  const json = canonicalJson(value);
  const canonicalBytes = Buffer.from(json, "utf8");
  const byteCount = canonicalBytes.byteLength;
  const manifestDigest = digest(canonicalBytes);
  return Object.freeze({
    json,
    get bytes() {
      return Buffer.from(canonicalBytes);
    },
    byteCount,
    digest: manifestDigest,
    value,
  });
}

function verifyArtifact(
  artifact: Readonly<ArtifactMetadata>,
  requirement: Readonly<ArtifactContentRequirement>
): void {
  if (artifact.formatId !== requirement.formatId) {
    failManifest(
      "artifact_format_mismatch",
      `Artifact format does not satisfy its requirement: ${artifact.artifactId}`
    );
  }
  if (artifact.normalizationId !== requirement.normalizationId) {
    failManifest(
      "artifact_normalization_mismatch",
      `Artifact normalization does not satisfy its requirement: ${artifact.artifactId}`
    );
  }
  if (
    !nonNegativeSafeInteger(artifact.byteCount) ||
    artifact.byteCount > requirement.maxByteCount
  ) {
    failManifest(
      "artifact_size_exceeded",
      `Artifact exceeds its byte limit: ${artifact.artifactId}`
    );
  }
}

export function validateResultAcceptanceManifest(
  input: Readonly<ResultAcceptanceManifest>,
  requirements: Readonly<ResolvedWorkProductRequirements>,
  artifacts: ReadonlyArray<Readonly<ArtifactMetadata>>
): ValidatedResultAcceptanceManifest {
  const document = resultAcceptanceManifestDocument(input);
  let expectedRequirements: ResolvedWorkProductRequirements;
  try {
    expectedRequirements = resolveRequirementsPolicy({
      body: requirements.body,
      workProducts: requirements.workProducts,
      maxTotalByteCount: requirements.maxTotalByteCount,
    });
  } catch {
    failManifest(
      "requirement_set_mismatch",
      "Resolved requirement set is inconsistent"
    );
  }
  if (
    expectedRequirements.requirementSetId !== requirements.requirementSetId ||
    expectedRequirements.digest !== requirements.digest ||
    expectedRequirements.canonicalJson !== requirements.canonicalJson ||
    document.value.requirementSetId !== requirements.requirementSetId ||
    document.value.requirementSetDigest !== requirements.digest
  ) {
    failManifest(
      "requirement_set_mismatch",
      "Manifest refers to a different requirement set"
    );
  }
  const artifactById = new Map<string, Readonly<ArtifactMetadata>>();
  for (const artifact of artifacts) {
    if (artifactById.has(artifact.artifactId))
      failManifest(
        "duplicate_artifact",
        `Duplicate artifact metadata: ${artifact.artifactId}`
      );
    artifactById.set(artifact.artifactId, artifact);
  }
  const requireArtifact = (artifactId: string): Readonly<ArtifactMetadata> => {
    const artifact = artifactById.get(artifactId);
    if (artifact === undefined)
      failManifest("artifact_not_found", `Artifact not found: ${artifactId}`);
    return artifact;
  };
  verifyArtifact(
    requireArtifact(document.value.bodyArtifactId),
    requirements.body
  );

  const requirementByKey = new Map(
    requirements.workProducts.map((requirement) => [
      requirement.key,
      requirement,
    ])
  );
  const entryByKey = new Map(
    document.value.workProducts.map((entry) => [entry.key, entry])
  );
  for (const entry of document.value.workProducts) {
    const requirement = requirementByKey.get(entry.key);
    if (requirement === undefined)
      failManifest(
        "undeclared_key",
        `Undeclared work product key: ${entry.key}`
      );
    if (entry.artifactIds.length < requirement.minCount) {
      failManifest(
        "work_product_count_below_minimum",
        `Work product count is below its minimum: ${entry.key}`
      );
    }
    if (entry.artifactIds.length > requirement.maxCount) {
      failManifest(
        "work_product_count_exceeded",
        `Work product count exceeds its maximum: ${entry.key}`
      );
    }
    for (const artifactId of entry.artifactIds)
      verifyArtifact(requireArtifact(artifactId), requirement);
  }
  for (const requirement of requirements.workProducts) {
    if (!entryByKey.has(requirement.key) && requirement.minCount > 0) {
      failManifest(
        "missing_required_work_product",
        `Required work product is missing: ${requirement.key}`
      );
    }
  }

  const roots = [
    document.value.bodyArtifactId,
    ...document.value.workProducts.flatMap((entry) => entry.artifactIds),
  ];
  const counted = new Set<string>();
  const visiting = new Set<string>();
  let totalByteCount = 0;
  const visit = (artifactId: string): void => {
    if (counted.has(artifactId)) return;
    if (visiting.has(artifactId))
      failManifest(
        "artifact_dependency_cycle",
        `Artifact dependency cycle at: ${artifactId}`
      );
    visiting.add(artifactId);
    const artifact = requireArtifact(artifactId);
    if (!nonNegativeSafeInteger(artifact.byteCount)) {
      failManifest(
        "artifact_size_exceeded",
        `Artifact has an invalid byte count: ${artifactId}`
      );
    }
    for (const dependency of artifact.dependencies) visit(dependency);
    visiting.delete(artifactId);
    counted.add(artifactId);
    totalByteCount += artifact.byteCount;
    if (
      !Number.isSafeInteger(totalByteCount) ||
      totalByteCount > requirements.maxTotalByteCount
    ) {
      failManifest(
        "total_size_exceeded",
        "Result acceptance set exceeds its total byte limit"
      );
    }
  };
  for (const root of roots) visit(root);

  return Object.freeze({
    ...document,
    totalByteCount,
    artifactIds: Object.freeze([...counted].sort(compare)),
  });
}
