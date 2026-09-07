import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PrivateFileEventStore } from "../src/internal/event-store/index.js";
import { EventStoreResourceEvidenceRepository } from "../src/internal/event-store-resource-evidence.js";
import { makeResourceProofController } from "../src/internal/resource-controller.js";
import { makeRuntime } from "../src/internal/runtime.js";
import { FakeClock, FakeIdGenerator, FakePresentation, FakeWorkerAdapter, InMemoryEventStore } from "../src/internal/testing.js";
import {
  normalizePermissionManifest,
  parseProofDocument,
  permissionManifestsMatch,
  validateWorkspaceScope,
} from "../src/index.js";
import type {
  PermissionConstraint,
  PermissionManifest,
  ResourceAdapter,
  ResourceAdapterRequest,
  ResourceAuthorityRegistration,
  ResourceProofEvidence,
} from "../src/index.js";

const manifest = (read: PermissionManifest["read"]): PermissionManifest => ({
  tools: ["read", "bash"],
  read,
  write: { kind: "none" },
  commands: "unrestricted",
  network: "none",
  externalResources: [{ authorityId: "launcher", selector: "repo", usage: "shared_read" }],
});

test("permission manifests match after set normalization", () => {
  const left = manifest({ kind: "literals", paths: ["src/b.ts", "src/a.ts"] });
  const right = { ...manifest({ kind: "literals", paths: ["src/a.ts", "src/b.ts"] }), tools: ["bash", "read"] };

  assert.equal(permissionManifestsMatch(left, right), true);
});

test("a broader effective permission manifest is rejected", () => {
  const requested = manifest({ kind: "literals", paths: ["src"] });
  const effective = manifest({ kind: "workspace" });

  assert.equal(permissionManifestsMatch(requested, effective), false);
});

test("a narrower effective permission manifest is rejected", () => {
  const requested = manifest({ kind: "workspace" });
  const effective = manifest({ kind: "literals", paths: ["src"] });

  assert.equal(permissionManifestsMatch(requested, effective), false);
});

test("conflicting use of one external resource is rejected", () => {
  const input: PermissionManifest = {
    ...manifest({ kind: "none" }),
    externalResources: [
      { authorityId: "launcher", selector: "repo", usage: "shared_read" },
      { authorityId: "launcher", selector: "repo", usage: "exclusive" },
    ],
  };

  assert.throws(() => normalizePermissionManifest(input), { name: "ResourceProofRejectedError", reason: "permission_contradiction" });
});

test("an absolute workspace literal is rejected", () => {
  assert.throws(() => normalizePermissionManifest(manifest({ kind: "literals", paths: ["/etc"] })), { name: "ResourceProofRejectedError", reason: "permission_mismatch" });
});

test("proof JSON with decoded duplicate keys is rejected", () => {
  assert.throws(() => parseProofDocument(Buffer.from('{"a":1,"\\u0061":2}')), { name: "ResourceProofRejectedError", reason: "invalid_proof" });
});

test("proof JSON with invalid UTF-8 is rejected", () => {
  assert.throws(() => parseProofDocument(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), { name: "ResourceProofRejectedError", reason: "invalid_proof" });
});

test("proof JSON with an isolated surrogate is rejected", () => {
  assert.throws(() => parseProofDocument(Buffer.from('{"x":"\\ud800"}')), { name: "ResourceProofRejectedError", reason: "invalid_proof" });
});

test("proof JSON is canonicalized", () => {
  assert.equal(parseProofDocument(Buffer.from('{"z":1,"a":[true,null]}')).json, '{"a":[true,null],"z":1}');
});

test("proof JSON at the raw byte limit is accepted", () => {
  const input = Buffer.concat([Buffer.alloc(2 * 1024 * 1024 - 4, 0x20), Buffer.from("null")]);

  assert.equal(parseProofDocument(input).json, "null");
});

test("proof JSON exceeding the raw byte limit is rejected", () => {
  const input = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);

  assert.throws(() => parseProofDocument(input), { name: "ResourceProofRejectedError", reason: "proof_limit_exceeded" });
});

test("proof JSON at the canonical byte limit is accepted", () => {
  const values = ["a".repeat(262_144), "b".repeat(262_144), "c".repeat(262_144), "d".repeat(262_131)];

  assert.equal(parseProofDocument(Buffer.from(JSON.stringify(values))).byteCount, 1024 * 1024);
});

test("proof JSON exceeding the canonical byte limit is rejected", () => {
  const values = ["a".repeat(262_144), "b".repeat(262_144), "c".repeat(262_144), "d".repeat(262_132)];

  assert.throws(() => parseProofDocument(Buffer.from(JSON.stringify(values))), { name: "ResourceProofRejectedError", reason: "proof_limit_exceeded" });
});

test("proof JSON at the string byte limit is accepted", () => {
  assert.equal((parseProofDocument(Buffer.from(JSON.stringify("a".repeat(256 * 1024)))).value as string).length, 256 * 1024);
});

test("a proof object key at the string byte limit is accepted", () => {
  const key = "k".repeat(256 * 1024);

  assert.equal(Object.keys(parseProofDocument(Buffer.from(JSON.stringify({ [key]: 1 }))).value as object)[0]?.length, 256 * 1024);
});

test("a proof object key exceeding the string byte limit is rejected", () => {
  const key = "k".repeat(256 * 1024 + 1);

  assert.throws(() => parseProofDocument(Buffer.from(JSON.stringify({ [key]: 1 }))), { name: "ResourceProofRejectedError", reason: "proof_limit_exceeded" });
});

test("proof JSON exceeding the string byte limit is rejected", () => {
  assert.throws(() => parseProofDocument(Buffer.from(JSON.stringify("a".repeat(256 * 1024 + 1)))), { name: "ResourceProofRejectedError", reason: "proof_limit_exceeded" });
});

test("proof JSON at the depth limit is accepted", () => {
  const input = `${"[".repeat(31)}0${"]".repeat(31)}`;

  assert.equal(parseProofDocument(Buffer.from(input)).byteCount, 63);
});

test("proof JSON exceeding the depth limit is rejected", () => {
  const input = `${"[".repeat(32)}0${"]".repeat(32)}`;

  assert.throws(() => parseProofDocument(Buffer.from(input)), { name: "ResourceProofRejectedError", reason: "proof_limit_exceeded" });
});

test("proof JSON at the element limit is accepted", () => {
  assert.equal((parseProofDocument(Buffer.from(JSON.stringify(Array(10_000).fill(0)))).value as Array<unknown>).length, 10_000);
});

test("proof JSON exceeding the element limit is rejected", () => {
  assert.throws(() => parseProofDocument(Buffer.from(JSON.stringify(Array(10_001).fill(0)))), { name: "ResourceProofRejectedError", reason: "proof_limit_exceeded" });
});

test("an internal symbolic link inside the allowed scope is accepted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pions-workspace-"));
  await mkdir(join(workspace, "actual"));
  await symlink("actual", join(workspace, "linked"));

  assert.equal(await validateWorkspaceScope(workspace, { kind: "literals", paths: ["linked", "actual"] }), true);
});

test("an internal symbolic link outside the declared literal scope is rejected", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pions-workspace-"));
  await mkdir(join(workspace, "actual"));
  await symlink("actual", join(workspace, "linked"));

  await assert.rejects(validateWorkspaceScope(workspace, { kind: "literals", paths: ["linked"] }), { name: "ResourceProofRejectedError", reason: "permission_mismatch" });
});

test("a symbolic link outside the workspace is rejected", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pions-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "pions-outside-"));
  await symlink(outside, join(workspace, "escape"));

  await assert.rejects(validateWorkspaceScope(workspace, { kind: "literals", paths: ["escape"] }), { name: "ResourceProofRejectedError", reason: "permission_mismatch" });
});

class FakeResourceAdapter implements ResourceAdapter {
  acquireCount = 0;
  inspectCount = 0;
  lastRequest?: Readonly<ResourceAdapterRequest>;
  lastProofDigest?: `sha256:${string}`;
  observedConstraints: ReadonlyArray<PermissionConstraint> = ["tools", "read", "write", "commands", "network", "externalResources"];

  async normalizeSelector(selector: string) {
    return { namespace: "test", selector, conflictScopes: [`test:${selector}`] };
  }

  async acquire(request: Readonly<ResourceAdapterRequest>): Promise<Readonly<ResourceProofEvidence>> {
    this.acquireCount += 1;
    this.lastRequest = request;
    const workspaceEvidence = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      kind: "workspace-proof",
      authorityId: "launcher",
      authorityRegistrationId: "launcher-registration-1",
      authorityGeneration: "generation-1",
      operationId: request.operationId,
      workspace: request.workspace,
    }));
    const guarantees = (constraints: ReadonlyArray<PermissionConstraint>) =>
      constraints.map((constraint) => ({
        authorityId: "launcher",
        operationId: request.operationId,
        workerProcessInstanceId: request.workerProcessInstanceId,
        permissionManifestDigest: request.permissionManifestDigest,
        constraint,
        method: `test-${constraint}`,
        scope: constraint,
        checkedAt: "2099-01-01T00:00:00.000Z",
        generation: "lease-1",
        result: "satisfied" as const,
        basis: "fake adapter evidence",
      }));
    const fields = {
      acquisitionId: request.acquisitionId,
      startAttemptId: request.startAttemptId,
      requestDigest: request.requestDigest,
      authorityId: "launcher",
      authorityRegistrationId: "launcher-registration-1",
      authorityGeneration: "generation-1",
      operationId: request.operationId,
      workerProcessInstanceId: request.workerProcessInstanceId,
      permissionManifestDigest: request.permissionManifestDigest,
      workspace: request.workspace,
      conflictControlId: "lock-manager-1",
      noConflict: true,
      revocationOwner: "launcher",
      observations: guarantees(this.observedConstraints),
      enforcements: guarantees(["tools", "read", "write", "commands", "network", "externalResources"]),
      generation: "lease-1",
    };
    const evidence = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      kind: "resource-proof",
      ...fields,
      workspace: undefined,
      workspaceProofDigest: parseProofDocument(workspaceEvidence).digest,
    }));
    this.lastProofDigest = parseProofDocument(evidence).digest;
    return { ...fields, workspaceEvidence, evidence };
  }

  async recover(request: Readonly<ResourceAdapterRequest>) {
    return this.acquire(request);
  }

  async inspect(request: Readonly<ResourceAdapterRequest>) {
    this.inspectCount += 1;
    const fields = {
      validationId: "validation-1",
      acquisitionId: request.acquisitionId,
      startAttemptId: request.startAttemptId,
      state: "valid" as const,
      authorityId: "launcher",
      authorityRegistrationId: "launcher-registration-1",
      authorityGeneration: "generation-1",
      operationId: request.operationId,
      workerProcessInstanceId: request.workerProcessInstanceId,
      requestDigest: request.requestDigest,
      proofDigest: this.lastProofDigest ?? `sha256:${"00".repeat(32)}` as const,
      checkedAt: "2099-01-01T00:00:00.000Z",
      generation: "lease-1",
      handoffConfirmed: true,
      relatedExecutionAccessBlocked: true,
    };
    return {
      ...fields,
      evidence: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "resource-validation", ...fields })),
    };
  }

  async revokeAccess() { return "blocked" as const; }
  async release() { return "released" as const; }
}

const controllerFixture = async () => {
  const adapter = new FakeResourceAdapter();
  const registration: ResourceAuthorityRegistration = {
    authorityId: "launcher",
    registrationId: "launcher-registration-1",
    generation: "generation-1",
    normalizationVersion: "selector-v1",
    issuer: {
      verify: async () => true,
      isCurrentlyTrusted: async () => "trusted",
    },
    adapter,
  };
  const controller = makeResourceProofController({
    registrations: [registration],
    cleanupAuthenticator: {
      authenticate: async () => ({ subjectId: "coordinator", canCleanup: async () => true }),
    },
  });
  const workspacePath = await mkdtemp(join(tmpdir(), "pions-controller-"));
  const permissionManifest = manifest({ kind: "workspace" });
  const request = {
    operationId: "operation-1",
    workerProcessInstanceId: "worker-1",
    startAttemptId: "operation-1:start:1",
    workspace: {
      workspaceId: "workspace-1",
      normalizedPath: workspacePath,
      baseRevision: "commit-1",
      owner: { state: "known" as const, ownerId: "launcher" },
      pionsMayDelete: false as const,
    },
    requestedManifest: permissionManifest,
    effectiveManifest: permissionManifest,
    requirements: {
      authorityId: "launcher",
      authorityRegistrationId: "launcher-registration-1",
      authorityGeneration: "generation-1",
      normalizationVersion: "selector-v1",
      workspace: {
        workspaceId: "workspace-1",
        normalizedPath: workspacePath,
        baseRevision: "commit-1",
        owner: { state: "known" as const, ownerId: "launcher" },
        pionsMayDelete: false as const,
      },
      permissionManifest,
      cleanupPolicy: "coordinator_required" as const,
      cleanupTimeoutMs: 1_000,
      maxCleanupAttempts: 2,
      safetyCleanupOperations: ["inspect", "revoke", "release"] as const,
    },
  };
  return { adapter, controller, registration, request };
};

test("a complete resource proof is persisted as held", async () => {
  const { controller, request } = await controllerFixture();

  assert.equal((await controller.prepare(request)).evidence.state, "held");
});

test("resource acquisition is idempotent for the same request", async () => {
  const { adapter, controller, request } = await controllerFixture();
  await controller.prepare(request);
  await controller.prepare(request);

  assert.equal(adapter.acquireCount, 1);
});

test("missing observation evidence rejects resource acquisition", async () => {
  const { adapter, controller, request } = await controllerFixture();
  adapter.observedConstraints = ["tools"];

  await assert.rejects(controller.prepare(request), { name: "ResourceProofRejectedError", reason: "observation_missing" });
});

test("a fresh validation is persisted before it is returned", async () => {
  const { controller, request } = await controllerFixture();
  await controller.prepare(request);

  assert.equal((await controller.revalidate(request.operationId)).evidence.validations.length, 1);
});

test("predelegated automatic cleanup releases the acquisition", async () => {
  const { controller, request } = await controllerFixture();
  const automatic = {
    ...request,
    requirements: { ...request.requirements, cleanupPolicy: "automatic" as const },
  };
  await controller.prepare(automatic);

  assert.equal((await controller.automaticCleanup(request.operationId)).evidence.state, "released");
});

test("authorized cleanup releases the acquisition", async () => {
  const { controller, request } = await controllerFixture();
  await controller.prepare(request);

  assert.equal((await controller.cleanup(request.operationId, "credential")).evidence.state, "released");
});

const unavailableRequiredRuntime = async () => {
  const { request } = await controllerFixture();
  const timestamps = Array(20).fill(0).map((_, index) => new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString());
  const clock = new FakeClock(timestamps);
  const presentation = new FakePresentation();
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter(),
    clock,
    ids: new FakeIdGenerator([request.operationId]),
    presentation,
    store: new InMemoryEventStore([], clock),
    configuration: {
      cwd: request.workspace.normalizedPath,
      profiles: {
        protected: {
          modelCandidates: [{ provider: "test", id: "test-model" }],
          thinkingLevel: "medium",
          tools: ["read", "bash"],
          resources: { resourceProofPolicy: "required", ...request.requirements },
        },
      },
    },
  });
  const handle = await runtime.spawn({ promptRef: "prompt", profile: "protected", idempotencyKey: "unavailable-resource" });
  return { handle, presentation };
};

test("an unavailable required adapter returns a durably failed Operation", async () => {
  const { handle } = await unavailableRequiredRuntime();

  assert.equal((await handle.read()).failureReason, "resource_proof_rejected");
});

test("an unavailable required adapter creates no pane", async () => {
  const { presentation } = await unavailableRequiredRuntime();

  assert.equal(presentation.createdPaneIds.length, 0);
});

test("a required Runtime profile revalidates the acquisition before execution", async () => {
  const { adapter, controller, request } = await controllerFixture();
  const timestamps = Array(30).fill(0).map((_, index) => new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString());
  const clock = new FakeClock(timestamps);
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter(),
    clock,
    ids: new FakeIdGenerator([request.operationId]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore([], clock),
    resourceProofController: controller,
    configuration: {
      cwd: request.workspace.normalizedPath,
      profiles: {
        protected: {
          modelCandidates: [{ provider: "test", id: "test-model" }],
          thinkingLevel: "medium",
          tools: ["read", "bash"],
          resources: { resourceProofPolicy: "required", ...request.requirements },
        },
      },
    },
  });
  const handle = await runtime.spawn({ promptRef: "prompt", profile: "protected", idempotencyKey: "required-resource-test" });
  await handle.result();

  assert.equal(adapter.inspectCount, 1);
});

test("resource evidence is reconstructed from a reopened Operation event store", async () => {
  const { registration, request } = await controllerFixture();
  const directory = await mkdtemp(join(tmpdir(), "pions-resource-events-"));
  const timestamps = Array(30).fill(0).map((_, index) => new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString());
  const clock = new FakeClock(timestamps);
  const store = new PrivateFileEventStore(directory, clock);
  const controller = makeResourceProofController({
    registrations: [registration],
    repository: new EventStoreResourceEvidenceRepository(store),
  });
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter(),
    clock,
    ids: new FakeIdGenerator([request.operationId]),
    presentation: new FakePresentation(),
    store,
    resourceProofController: controller,
    configuration: {
      cwd: request.workspace.normalizedPath,
      profiles: {
        protected: {
          modelCandidates: [{ provider: "test", id: "test-model" }],
          thinkingLevel: "medium",
          tools: ["read", "bash"],
          resources: { resourceProofPolicy: "required", ...request.requirements },
        },
      },
    },
  });
  await (await runtime.spawn({ promptRef: "prompt", profile: "protected", idempotencyKey: "persistent-resource" })).result();
  const reopenedStore = new PrivateFileEventStore(directory, new FakeClock([]));
  const reopened = makeResourceProofController({
    registrations: [registration],
    repository: new EventStoreResourceEvidenceRepository(reopenedStore),
  });

  assert.equal((await reopened.read(request.operationId)).evidence.state, "held");
});

test("Runtime Operation snapshots expose persisted resource evidence", async () => {
  const { registration, request } = await controllerFixture();
  const timestamps = Array(20).fill(0).map((_, index) => new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString());
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const controller = makeResourceProofController({
    registrations: [registration],
    repository: new EventStoreResourceEvidenceRepository(store),
  });
  const runtime = makeRuntime({
    worker: new FakeWorkerAdapter(),
    clock,
    ids: new FakeIdGenerator([request.operationId]),
    presentation: new FakePresentation(),
    store,
    resourceProofController: controller,
    configuration: {
      cwd: request.workspace.normalizedPath,
      profiles: {
        protected: {
          modelCandidates: [{ provider: "test", id: "test-model" }],
          thinkingLevel: "medium",
          tools: ["read", "bash"],
          resources: { resourceProofPolicy: "required", ...request.requirements },
        },
      },
    },
  });
  const handle = await runtime.spawn({ promptRef: "prompt", profile: "protected", idempotencyKey: "resource-test" });
  await handle.result();

  assert.equal((await handle.read()).resourceEvidence?.evidence.state, "held");
});
