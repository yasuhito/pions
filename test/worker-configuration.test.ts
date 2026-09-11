import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BODY_ONLY_WORK_PRODUCT_REQUIREMENTS,
  configurationMismatch,
  resolveWorkerConfig,
} from "../src/internal/worker-configuration.js";
import { permissionManifestDocument } from "../src/internal/resource-proof.js";
import type { WorkerProfilePolicy } from "../src/public.js";
import { effectiveConfig, observedConfig } from "./worker-protocol-fixtures.js";

function candidateProfile(
  intendedUse: "formal_reviewer" | "writer" | "revision_retry",
  overrides: Record<string, unknown> = {}
) {
  return {
    intendedUse,
    modelCandidates: [{ provider: "test", id: "test-model" }],
    thinkingLevel: "medium",
    tools: ["read"],
    resources: { resourceProofPolicy: "disabled" },
    startAuthorization: { policy: "disabled" },
    workProductRequirements: BODY_ONLY_WORK_PRODUCT_REQUIREMENTS,
    acceptedArtifactRetentionMs: 86_400_000,
    ...overrides,
  } as WorkerProfilePolicy;
}

const writerPermissionManifest = {
  tools: ["read"],
  read: { kind: "workspace" as const },
  write: { kind: "workspace" as const },
  commands: "none" as const,
  network: "none" as const,
  externalResources: [],
};

const requiredAuthorization = (
  reviewSubjectVerification: "disabled" | "required",
  permissionManifestDigest = `sha256:${"ab".repeat(32)}` as const
) => ({
  policy: "required" as const,
  windowMs: 60_000,
  authorizedSubjectIds: ["coordinator-1"],
  receipt: {
    workspace: {
      workspaceId: "workspace-1",
      normalizedPath: "/workspace",
      baseRevision: "a".repeat(40),
      owner: { state: "known" as const, ownerId: "launcher-1" },
      pionsMayDelete: false as const,
    },
    permissionManifest: {
      manifestId: "manifest-1",
      digest: permissionManifestDigest,
    },
    reviewSubjectVerification,
    reviewSubject: {
      artifactId: "artifact-1",
      byteCount: 1,
      digest: `sha256:${"cd".repeat(32)}` as const,
      format: "pions.opaque.v1",
      normalization: "identity.v1",
    },
  },
});

test("observed thinking different from effective thinking is rejected", () => {
  const observed = {
    ...observedConfig,
    thinkingLevel: { state: "observed", value: "low" },
  } as const;

  assert.equal(
    configurationMismatch(effectiveConfig, observed),
    "thinking_level_mismatch"
  );
});

test("a profile without an explicit resource proof policy is rejected", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: {
          modelCandidates: [{ provider: "test", id: "test-model" }],
          thinkingLevel: "medium",
          tools: ["read"],
        } as never,
        runtimeCwd: "/workspace",
      }),
    { name: "ResourceProofRejectedError", reason: "invalid_profile" }
  );
});

test("a profile without explicit work product requirements is rejected", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: {
          modelCandidates: [{ provider: "test", id: "test-model" }],
          thinkingLevel: "medium",
          tools: ["read"],
          resources: { resourceProofPolicy: "disabled" },
        } as never,
        runtimeCwd: "/workspace",
      }),
    { name: "WorkProductRequirementsError", reason: "invalid_requirement" }
  );
});

test("a reader profile cannot bypass Writer guarantees by declaring an editing tool", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: {
          intendedUse: "reader",
          modelCandidates: [{ provider: "test", id: "test-model" }],
          thinkingLevel: "medium",
          tools: ["read", "write"],
          resources: { resourceProofPolicy: "disabled" },
          startAuthorization: { policy: "disabled" },
          workProductRequirements: BODY_ONLY_WORK_PRODUCT_REQUIREMENTS,
          acceptedArtifactRetentionMs: 86_400_000,
        },
        runtimeCwd: "/workspace",
      }),
    { name: "WorkerConfigurationError", reason: "tool_policy_violation" }
  );
});

test("a formal reviewer candidate without required Start authorization is rejected", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: candidateProfile("formal_reviewer"),
        runtimeCwd: "/workspace",
      }),
    { name: "WorkerConfigurationError", reason: "unsupported_capability" }
  );
});

test("a formal reviewer candidate without required Review subject verification is rejected", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: candidateProfile("formal_reviewer", {
          startAuthorization: requiredAuthorization("disabled"),
        }),
        runtimeCwd: "/workspace",
      }),
    { name: "WorkerConfigurationError", reason: "unsupported_capability" }
  );
});

test("a writer candidate without required resource proof is rejected", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: candidateProfile("writer", {
          startAuthorization: requiredAuthorization("required"),
        }),
        runtimeCwd: "/workspace",
      }),
    { name: "ResourceProofRejectedError", reason: "invalid_profile" }
  );
});

test("a writer candidate without a required Work product is rejected", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: candidateProfile("writer", {
          resources: {
            resourceProofPolicy: "required",
            authorityId: "launcher-1",
            authorityRegistrationId: "registration-1",
            authorityGeneration: "generation-1",
            normalizationVersion: "selector-v1",
            workspace: requiredAuthorization("required").receipt.workspace,
            permissionManifest: writerPermissionManifest,
            cleanupPolicy: "coordinator_required",
            cleanupTimeoutMs: 1_000,
            maxCleanupAttempts: 2,
            safetyCleanupOperations: ["inspect", "revoke", "release"],
          },
          startAuthorization: requiredAuthorization(
            "required",
            permissionManifestDocument(writerPermissionManifest).digest
          ),
        }),
        runtimeCwd: "/workspace",
      }),
    { name: "WorkerConfigurationError", reason: "unsupported_capability" }
  );
});

test("a writer candidate with all required guarantees is accepted", () => {
  const authorization = requiredAuthorization(
    "required",
    permissionManifestDocument(writerPermissionManifest).digest
  );
  assert.doesNotThrow(() =>
    resolveWorkerConfig({
      requested: {},
      profile: candidateProfile("writer", {
        resources: {
          resourceProofPolicy: "required",
          authorityId: "launcher-1",
          authorityRegistrationId: "registration-1",
          authorityGeneration: "generation-1",
          normalizationVersion: "selector-v1",
          workspace: authorization.receipt.workspace,
          permissionManifest: writerPermissionManifest,
          cleanupPolicy: "coordinator_required",
          cleanupTimeoutMs: 1_000,
          maxCleanupAttempts: 2,
          safetyCleanupOperations: ["inspect", "revoke", "release"],
        },
        startAuthorization: authorization,
        workProductRequirements: {
          body: BODY_ONLY_WORK_PRODUCT_REQUIREMENTS.body,
          workProducts: [
            {
              key: "patch",
              formatId: "pions.patch.v1",
              normalizationId: "identity.v1",
              minCount: 1,
              maxCount: 1,
              maxByteCount: 1_024,
            },
          ],
          maxTotalByteCount: 1_049_600,
        },
      }),
      runtimeCwd: "/workspace",
    })
  );
});

test("a Revision and Retry candidate uses the writer guarantees", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: candidateProfile("revision_retry", {
          startAuthorization: requiredAuthorization("required"),
        }),
        runtimeCwd: "/workspace",
      }),
    { name: "ResourceProofRejectedError", reason: "invalid_profile" }
  );
});

test("unavailable observed thinking is rejected", () => {
  const observed = {
    ...observedConfig,
    thinkingLevel: { state: "unavailable" },
  } as const;

  assert.equal(
    configurationMismatch(effectiveConfig, observed),
    "thinking_level_mismatch"
  );
});
