import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_RESULT_BYTE_COUNT,
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
    maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
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
          maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
        },
        runtimeCwd: "/workspace",
      }),
    { name: "WorkerConfigurationError", reason: "tool_policy_violation" }
  );
});

const GENERAL_PROFILE: WorkerProfilePolicy = {
  intendedUse: "general",
  modelCandidates: [{ provider: "test", id: "test-model" }],
  thinkingLevel: "medium",
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  resources: { resourceProofPolicy: "disabled" },
  startAuthorization: { policy: "disabled" },
  maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
};

test("a general profile provides editing tools without a Start gate or resource proof", () => {
  assert.deepEqual(
    resolveWorkerConfig({
      requested: {},
      profile: GENERAL_PROFILE,
      runtimeCwd: "/workspace",
    }).tools,
    ["read", "write", "edit", "bash", "grep", "find", "ls"]
  );
});

test("a general profile cannot provide a tool outside the Pi built-in set", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: { ...GENERAL_PROFILE, tools: ["read", "pions_delegate"] },
        runtimeCwd: "/workspace",
      }),
    { name: "WorkerConfigurationError", reason: "tool_policy_violation" }
  );
});

test("a general profile runs in the Runtime working directory", () => {
  assert.equal(
    resolveWorkerConfig({
      requested: {},
      profile: GENERAL_PROFILE,
      runtimeCwd: "/workspace",
    }).cwd,
    "/workspace"
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

test("a formal reviewer candidate with required profile guarantees is accepted", () => {
  assert.doesNotThrow(() =>
    resolveWorkerConfig({
      requested: {},
      profile: candidateProfile("formal_reviewer", {
        startAuthorization: requiredAuthorization("required"),
      }),
      runtimeCwd: "/workspace",
    })
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
        maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
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
