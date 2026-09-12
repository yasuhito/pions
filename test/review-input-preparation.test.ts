import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { makeResourceProofController } from "../src/internal/resource-controller.js";
import {
  parseProofDocument,
  permissionManifestDocument,
} from "../src/internal/resource-proof.js";
import { reviewSubjectRegistrationEvidenceDigest } from "../src/internal/review-subject-registration-evidence.js";
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  InMemoryEventStore,
  makeTestRuntime,
} from "../src/internal/testing.js";
import type {
  ArtifactMetadata,
  ArtifactStore,
  PermissionConstraint,
  PermissionManifest,
  ResourceAdapter,
  ResourceAdapterRequest,
  ResourceProofEvidence,
  ReviewInputPreparationConnection,
  ReviewSubjectRegistrationEvidence,
  WorkerProfilePolicy,
} from "../src/public.js";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;

class ReviewResourceAdapter implements ResourceAdapter {
  private proofDigest = `sha256:${"00".repeat(32)}` as const;

  async normalizeSelector(selector: string) {
    return { namespace: "review", selector, conflictScopes: [selector] };
  }

  async acquire(request: Readonly<ResourceAdapterRequest>) {
    const workspaceEvidence = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "workspace-proof",
        authorityId: "review-launcher",
        authorityRegistrationId: "review-launcher-registration-1",
        authorityGeneration: "generation-1",
        operationId: request.operationId,
        workspace: request.workspace,
      })
    );
    const guarantees = (constraints: ReadonlyArray<PermissionConstraint>) =>
      constraints.map((constraint) => ({
        authorityId: "review-launcher",
        operationId: request.operationId,
        workerProcessInstanceId: request.workerProcessInstanceId,
        permissionManifestDigest: request.permissionManifestDigest,
        constraint,
        method: `test-${constraint}`,
        scope: constraint,
        checkedAt: "2026-09-12T10:00:00.000Z",
        generation: "lease-1",
        result: "satisfied" as const,
        basis: "test resource authority",
      }));
    const constraints: ReadonlyArray<PermissionConstraint> = [
      "tools",
      "read",
      "write",
      "commands",
      "network",
      "externalResources",
    ];
    const fields = {
      acquisitionId: request.acquisitionId,
      startAttemptId: request.startAttemptId,
      requestDigest: request.requestDigest,
      authorityId: "review-launcher",
      authorityRegistrationId: "review-launcher-registration-1",
      authorityGeneration: "generation-1",
      operationId: request.operationId,
      workerProcessInstanceId: request.workerProcessInstanceId,
      permissionManifestDigest: request.permissionManifestDigest,
      workspace: request.workspace,
      conflictControlId: "review-workspace-lock",
      noConflict: true,
      revocationOwner: "review-launcher",
      observations: guarantees(constraints),
      enforcements: guarantees(constraints),
      generation: "lease-1",
    };
    const evidence = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "resource-proof",
        ...fields,
        workspace: undefined,
        workspaceProofDigest: parseProofDocument(workspaceEvidence).digest,
      })
    );
    this.proofDigest = parseProofDocument(evidence).digest;
    return {
      ...fields,
      workspaceEvidence,
      evidence,
    } satisfies ResourceProofEvidence;
  }

  recover(request: Readonly<ResourceAdapterRequest>) {
    return this.acquire(request);
  }

  async inspect(request: Readonly<ResourceAdapterRequest>) {
    const fields = {
      validationId: `validation-${crypto.randomUUID()}`,
      acquisitionId: request.acquisitionId,
      startAttemptId: request.startAttemptId,
      state: "valid" as const,
      authorityId: "review-launcher",
      authorityRegistrationId: "review-launcher-registration-1",
      authorityGeneration: "generation-1",
      operationId: request.operationId,
      workerProcessInstanceId: request.workerProcessInstanceId,
      requestDigest: request.requestDigest,
      proofDigest: this.proofDigest,
      checkedAt: "2026-09-12T10:00:00.000Z",
      generation: "lease-1",
      handoffConfirmed: true,
      relatedExecutionAccessBlocked: true,
    };
    return {
      ...fields,
      evidence: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          kind: "resource-validation",
          ...fields,
        })
      ),
    };
  }

  async revokeAccess() {
    return "blocked" as const;
  }

  async release() {
    return "released" as const;
  }
}

class RecordingReviewInputConnection implements ReviewInputPreparationConnection {
  readonly received: Array<
    ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>
  > = [];
  private readonly workspaceOperations = new Map<string, string>();

  constructor(
    private readonly addUnexpectedFile = false,
    private readonly tamperWrittenFile = false
  ) {}

  async prepare(
    request: Parameters<ReviewInputPreparationConnection["prepare"]>[0]
  ) {
    const assignedOperation = this.workspaceOperations.get(
      request.workspace.workspaceId
    );
    if (
      assignedOperation !== undefined &&
      assignedOperation !== request.operationId
    ) {
      return { kind: "denied" as const };
    }
    this.workspaceOperations.set(
      request.workspace.workspaceId,
      request.operationId
    );
    const files = request.files.map((file) => ({
      path: file.path,
      bytes: file.bytes.slice(),
    }));
    this.received.push(files);
    return {
      kind: "prepared" as const,
      operationId: request.operationId,
      acquisitionId: request.acquisitionId,
      workspaceId: request.workspace.workspaceId,
      writingClosed: true as const,
      files: this.addUnexpectedFile
        ? [...files, { path: "unregistered.txt", bytes: Buffer.from("extra") }]
        : this.tamperWrittenFile
          ? files.map((file, index) =>
              index === 0 ? { ...file, bytes: Buffer.from("tampered") } : file
            )
          : files,
    };
  }
}

async function registerReviewSubject(
  artifacts: ArtifactStore,
  credential: string
): Promise<Readonly<ArtifactMetadata>> {
  const dependencyBytes = Buffer.from("fixed specification", "utf8");
  const dependencyStart = await artifacts.startRegistration(credential, {
    registrationId: "dependency-registration",
    expectedByteCount: dependencyBytes.byteLength,
    expectedDigest: digest(dependencyBytes),
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
    dependencies: [],
    deadline: "2026-09-12T10:01:00.000Z",
    recoveryBudget: 1,
  });
  if (dependencyStart.kind === "failed")
    throw new Error(
      `dependency start failed: ${JSON.stringify(dependencyStart)}`
    );
  const dependency = await artifacts.transfer(
    credential,
    "dependency-registration",
    dependencyBytes
  );
  if (dependency.kind !== "registered")
    throw new Error(
      `dependency registration failed: ${JSON.stringify(dependency)}`
    );
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  await artifacts.startRegistration(credential, {
    registrationId: "root-registration",
    expectedByteCount: rootBytes.byteLength,
    expectedDigest: digest(rootBytes),
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
    dependencies: [dependency.artifact.artifactId],
    deadline: "2026-09-12T10:01:00.000Z",
    recoveryBudget: 1,
  });
  const root = await artifacts.transfer(
    credential,
    "root-registration",
    rootBytes
  );
  if (root.kind !== "registered") throw new Error("root registration failed");
  const withoutDigest: Omit<ReviewSubjectRegistrationEvidence, "digest"> = {
    formatId: "pions.review-subject-registration-evidence.v1",
    evidenceId: "review-subject-evidence-1",
    issuerId: "test-issuer",
    validator: { validatorId: "test-validator", version: "1" },
    root: root.artifact,
    files: [
      {
        path: "docs/spec.md",
        artifactId: dependency.artifact.artifactId,
        byteCount: dependency.artifact.byteCount,
        digest: dependency.artifact.digest,
        formatId: dependency.artifact.formatId,
        normalizationId: dependency.artifact.normalizationId,
      },
    ],
    collectionDigest: `sha256:${"12".repeat(32)}`,
  };
  const evidence = {
    ...withoutDigest,
    digest: reviewSubjectRegistrationEvidenceDigest(withoutDigest),
  };
  const recorded = await artifacts.recordReviewSubjectRegistrationEvidence(
    credential,
    evidence
  );
  if (recorded.kind !== "resolved")
    throw new Error("evidence registration failed");
  return root.artifact;
}

async function fixture(
  context: TestContext,
  options: Readonly<{
    addUnexpectedFile?: boolean;
    tamperWrittenFile?: boolean;
    authorityTrust?: "trusted" | "revoked" | "unknown";
    authorityTrustFromCheck?: number;
    operationIds?: ReadonlyArray<string>;
    writeAccess?: boolean;
  }> = {}
) {
  const root = await mkdtemp(join(tmpdir(), "pions-review-input-"));
  const workspacePath = join(root, "review-workspace");
  await mkdir(workspacePath);
  const clock = new FakeClock(
    Array.from({ length: 100 }, (_, index) =>
      new Date(Date.UTC(2026, 8, 12, 10, 0, index)).toISOString()
    )
  );
  const store = new InMemoryEventStore([], clock);
  const artifactServices = runtimeArtifactStore(
    root,
    store,
    () => new Date("2026-09-12T10:00:00.000Z"),
    undefined,
    { currentUse: async () => "allowed" }
  );
  const artifact = await registerReviewSubject(
    artifactServices.artifacts,
    artifactServices.credential
  );
  const workspace = {
    workspaceId: "review-workspace-1",
    normalizedPath: workspacePath,
    baseRevision: "revision-1",
    owner: { state: "known" as const, ownerId: "review-launcher" },
    pionsMayDelete: false as const,
  };
  const permissionManifest: PermissionManifest = {
    tools: ["read"],
    read: { kind: "workspace" },
    write:
      options.writeAccess === false ? { kind: "none" } : { kind: "workspace" },
    commands: "none",
    network: "none",
    externalResources: [],
  };
  const connection = new RecordingReviewInputConnection(
    options.addUnexpectedFile,
    options.tamperWrittenFile
  );
  let authorityTrustChecks = 0;
  const resourceProofController = makeResourceProofController({
    registrations: [
      {
        authorityId: "review-launcher",
        registrationId: "review-launcher-registration-1",
        generation: "generation-1",
        normalizationVersion: "selector-v1",
        issuer: {
          verify: async () => true,
          isCurrentlyTrusted: async () => {
            authorityTrustChecks += 1;
            return options.authorityTrust !== undefined &&
              authorityTrustChecks >= (options.authorityTrustFromCheck ?? 1)
              ? options.authorityTrust
              : "trusted";
          },
        },
        adapter: new ReviewResourceAdapter(),
        reviewInputPreparation: connection,
      },
    ],
  });
  const profile: WorkerProfilePolicy = {
    intendedUse: "formal_reviewer",
    modelCandidates: [{ provider: "test", id: "test-model" }],
    thinkingLevel: "medium",
    tools: ["read"],
    resources: {
      resourceProofPolicy: "required",
      authorityId: "review-launcher",
      authorityRegistrationId: "review-launcher-registration-1",
      authorityGeneration: "generation-1",
      normalizationVersion: "selector-v1",
      workspace,
      permissionManifest,
      cleanupPolicy: "coordinator_required",
      cleanupTimeoutMs: 1_000,
      maxCleanupAttempts: 2,
      safetyCleanupOperations: ["inspect", "revoke", "release"],
    },
    startAuthorization: {
      policy: "required",
      windowMs: 60_000,
      authorizedSubjectIds: ["coordinator-1"],
      receipt: {
        workspace,
        permissionManifest: {
          manifestId: "review-manifest-1",
          digest: permissionManifestDocument(permissionManifest).digest,
        },
        reviewSubjectVerification: "required",
      },
    },
    workProductRequirements: {
      body: {
        formatId: "pions.result-body.utf8.v1",
        normalizationId: "identity.v1",
        maxByteCount: 50_000,
      },
      workProducts: [],
      maxTotalByteCount: 50_000,
    },
    acceptedArtifactRetentionMs: 86_400_000,
  };
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock,
    ids: new FakeIdGenerator(options.operationIds ?? ["operation-1"]),
    presentation: new FakePresentation(),
    store,
    artifacts: artifactServices.artifacts,
    artifactCredential: artifactServices.credential,
    synchronizeArtifactClock: artifactServices.synchronizeClock,
    resourceProofController,
    configuration: { cwd: workspacePath, profiles: { review: profile } },
  });
  context.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, artifact, connection };
}

test("an untrusted review input authority receives no files", async (context) => {
  const { runtime, artifact, connection } = await fixture(context, {
    authorityTrust: "unknown",
    authorityTrustFromCheck: 3,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review the fixed subject",
      profile: "review",
      idempotencyKey: "review-untrusted",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.result().catch(() => undefined);

  assert.equal(connection.received.length, 0);
});

test("a review input target without current write authority is not written", async (context) => {
  const { runtime, artifact, connection } = await fixture(context, {
    writeAccess: false,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review without write authority",
      profile: "review",
      idempotencyKey: "review-no-write",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.result().catch(() => undefined);

  assert.equal(connection.received.length, 0);
});

test("a review execution workspace cannot be reused by another Operation", async (context) => {
  const { runtime, artifact } = await fixture(context, {
    operationIds: ["operation-1", "operation-2"],
  });
  const first = await runtime.spawn(
    {
      promptRef: "First review",
      profile: "review",
      idempotencyKey: "review-first",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await first.waitForStartupReceipt();
  const second = await runtime.spawn(
    {
      promptRef: "Second review",
      profile: "review",
      idempotencyKey: "review-second",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await second.result().catch(() => undefined);

  assert.equal((await second.read()).failureReason, "resource_proof_rejected");
});

test("a changed post-write byte sequence rejects review input preparation", async (context) => {
  const { runtime, artifact } = await fixture(context, {
    tamperWrittenFile: true,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review tampered input",
      profile: "review",
      idempotencyKey: "review-tampered",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.result().catch(() => undefined);

  assert.equal(
    (await operation.read()).failureReason,
    "resource_proof_rejected"
  );
});

test("an unexpected post-write file rejects review input preparation", async (context) => {
  const { runtime, artifact } = await fixture(context, {
    addUnexpectedFile: true,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review the fixed subject",
      profile: "review",
      idempotencyKey: "review-extra-file",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.result().catch(() => undefined);

  assert.equal(
    (await operation.read()).failureReason,
    "resource_proof_rejected"
  );
});

test("a formal review writes only its verified dependency closure before publishing the Startup receipt", async (context) => {
  const { runtime, artifact, connection } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review the fixed subject",
      profile: "review",
      idempotencyKey: "review-1",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();

  assert.deepEqual(connection.received, [
    [
      {
        path: "docs/spec.md",
        bytes: Buffer.from("fixed specification", "utf8"),
      },
    ],
  ]);
});
