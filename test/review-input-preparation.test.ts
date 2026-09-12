import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { makeResourceProofController } from "../src/internal/resource-controller.js";
import { makeResultFormatRegistry } from "../src/internal/result-format-registry.js";
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
  ResultFormatValidationFailureReason,
  WorkerProfilePolicy,
} from "../src/public.js";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;

function reviewCollectionDigest(
  root: Uint8Array,
  files: ReadonlyArray<
    Readonly<{ readonly path: string; readonly bytes: Uint8Array }>
  >
): `sha256:${string}` {
  return digest(
    Buffer.from(
      JSON.stringify({
        root: digest(root),
        files: [...files]
          .sort((left, right) =>
            left.path < right.path ? -1 : left.path > right.path ? 1 : 0
          )
          .map(({ path, bytes }) => ({ path, digest: digest(bytes) })),
      }),
      "utf8"
    )
  );
}

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
      conflictControlId: "review-workspace-lock",
      noConflict: true as const,
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
  private readonly prepared = new Map<
    string,
    Awaited<ReturnType<ReviewInputPreparationConnection["prepare"]>>
  >();
  private inspectionMutation: "none" | "tamper" | "omit" | "add" | "unknown" =
    "none";

  constructor(
    private readonly addUnexpectedFile = false,
    private readonly tamperWrittenFile = false,
    private readonly omitWrittenFile = false,
    private readonly changeCollectionDigest = false,
    private readonly bindAnotherOperation = false
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
    const outcome = {
      kind: "prepared" as const,
      operationId: request.operationId,
      acquisitionId: request.acquisitionId,
      workspaceId: request.workspace.workspaceId,
      workspaceDedicatedToOperationId: this.bindAnotherOperation
        ? "another-operation"
        : request.operationId,
      collectionDigest: this.changeCollectionDigest
        ? (`sha256:${"ff".repeat(32)}` as const)
        : reviewCollectionDigest(request.root.bytes, request.files),
      writingClosed: true as const,
      files: this.addUnexpectedFile
        ? [...files, { path: "unregistered.txt", bytes: Buffer.from("extra") }]
        : this.tamperWrittenFile
          ? files.map((file, index) =>
              index === 0 ? { ...file, bytes: Buffer.from("tampered") } : file
            )
          : this.omitWrittenFile
            ? files.slice(1)
            : files,
    };
    this.prepared.set(request.workspace.workspaceId, outcome);
    return outcome;
  }

  tamperAfterPreparation(): void {
    this.inspectionMutation = "tamper";
  }

  omitAfterPreparation(): void {
    this.inspectionMutation = "omit";
  }

  addAfterPreparation(): void {
    this.inspectionMutation = "add";
  }

  makeInspectionUnknown(): void {
    this.inspectionMutation = "unknown";
  }

  async inspect(
    request: Parameters<ReviewInputPreparationConnection["inspect"]>[0]
  ) {
    const outcome = this.prepared.get(request.workspace.workspaceId);
    if (outcome?.kind !== "prepared") {
      return outcome ?? { kind: "unknown" as const };
    }
    if (this.inspectionMutation === "unknown") {
      return { kind: "unknown" as const };
    }
    const files =
      this.inspectionMutation === "tamper"
        ? outcome.files.map((file, index) =>
            index === 0
              ? { ...file, bytes: Buffer.from("changed later") }
              : file
          )
        : this.inspectionMutation === "omit"
          ? outcome.files.slice(1)
          : this.inspectionMutation === "add"
            ? [
                ...outcome.files,
                { path: "added-later.txt", bytes: Buffer.from("added") },
              ]
            : outcome.files;
    return {
      ...outcome,
      collectionDigest: reviewCollectionDigest(request.root.bytes, files),
      files,
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
    collectionDigest: reviewCollectionDigest(rootBytes, [
      { path: "docs/spec.md", bytes: dependencyBytes },
    ]),
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
    omitWrittenFile?: boolean;
    changeCollectionDigest?: boolean;
    bindAnotherOperation?: boolean;
    authorityTrust?: "trusted" | "revoked" | "unknown";
    authorityTrustFromCheck?: number;
    operationIds?: ReadonlyArray<string>;
    writeAccess?: boolean;
    resultFormatRejection?: ResultFormatValidationFailureReason;
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
    options.tamperWrittenFile,
    options.omitWrittenFile,
    options.changeCollectionDigest,
    options.bindAnotherOperation
  );
  let authorityTrustChecks = 0;
  let forcedAuthorityTrust: "trusted" | "revoked" | "unknown" | undefined;
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
            if (forcedAuthorityTrust !== undefined) return forcedAuthorityTrust;
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
  const resultFormats = makeResultFormatRegistry([
    {
      formatId: "test.formal-review-result",
      version: "1",
      normalizationId: "identity.v1",
      validator: {
        validatorId: "test.formal-review-result-validator",
        validatorVersion: "1",
        registrationArtifact: Buffer.from("test validator v1", "utf8"),
        validate: async () =>
          options.resultFormatRejection === undefined
            ? ({ kind: "valid" } as const)
            : ({
                kind: "invalid",
                reason: options.resultFormatRejection,
              } as const),
      },
    },
  ]);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock,
    ids: new FakeIdGenerator(options.operationIds ?? ["operation-1"]),
    presentation: new FakePresentation(),
    store,
    artifacts: artifactServices.artifacts,
    artifactCredential: artifactServices.credential,
    synchronizeArtifactClock: artifactServices.synchronizeClock,
    formalReviewResultFormats: {
      registry: resultFormats,
      resultFormat: resultFormats.pin({
        formatId: "test.formal-review-result",
        version: "1",
        expectations: { axis: "standards" },
      }),
    },
    resourceProofController,
    startAuthorizationAuthenticator: {
      authenticate: async () => ({
        subjectId: "coordinator-1",
        currentAuthorization: async () => "authorized" as const,
      }),
    },
    configuration: {
      cwd: workspacePath,
      profiles: { review: profile },
    },
  });
  context.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    runtime,
    artifact,
    connection,
    workspace,
    revokeAuthority: () => {
      forcedAuthorityTrust = "revoked";
    },
  };
}

async function preparedReadiness(context: TestContext, key: string) {
  const { runtime, artifact, workspace } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: `Review ${key}`,
      profile: "review",
      idempotencyKey: key,
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  return {
    readiness: (await operation.waitForStartupReceipt())?.reviewInputReadiness,
    workspace,
  };
}

async function authorizeReview(
  runtime: Awaited<ReturnType<typeof fixture>>["runtime"]
): Promise<void> {
  const inbox = await runtime.startAuthorizationInbox("credential");
  const waiting = (await inbox.listWaiting())[0];
  if (waiting === undefined) throw new Error("No waiting formal review");
  await inbox.decide({
    operationId: waiting.operationId,
    decisionId: "review-decision",
    kind: "authorize",
    receiptDigest: waiting.receipt.digest,
  });
}

async function rejectedFormalReview(
  context: TestContext,
  reason: ResultFormatValidationFailureReason
) {
  const { runtime, artifact } = await fixture(context, {
    resultFormatRejection: reason,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review the fixed subject",
      profile: "review",
      idempotencyKey: `rejected-${reason}`,
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();
  await authorizeReview(runtime);
  await operation.result().catch(() => undefined);
  return operation;
}

test("a formal review fixes its trusted Result format at Operation creation", async (context) => {
  const { runtime, artifact } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review the fixed subject",
      profile: "review",
      idempotencyKey: "fixed-result-format",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();

  const snapshot = await operation.read();

  assert.deepEqual(snapshot.resultFormat, {
    formatId: "test.formal-review-result",
    version: "1",
    normalizationId: "identity.v1",
    expectations: { axis: "standards" },
    validator: {
      validatorId: "test.formal-review-result-validator",
      version: "1",
      digest: digest(Buffer.from("test validator v1", "utf8")),
    },
  });
});

test("a Result format rejection is a typed Operation failure", async (context) => {
  const operation = await rejectedFormalReview(context, "invalid_json");

  const snapshot = await operation.read();

  assert.equal(snapshot.failureReason, "result_format_rejected");
});

test("a Result format rejection preserves its typed rejection evidence", async (context) => {
  const operation = await rejectedFormalReview(context, "invalid_json");

  const snapshot = await operation.read();

  assert.equal(snapshot.resultFormatRejection?.reason, "invalid_json");
});

test("a Result format rejection leaves no retrievable Result", async (context) => {
  const operation = await rejectedFormalReview(context, "duplicate_key");

  const outcome = await operation.readResult();

  assert.equal(outcome.kind, "not_accepted");
});

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

test("a Review input destination dedicated to another Operation rejects preparation", async (context) => {
  const { runtime, artifact } = await fixture(context, {
    bindAnotherOperation: true,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review input bound elsewhere",
      profile: "review",
      idempotencyKey: "review-dedicated-elsewhere",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.result().catch(() => undefined);

  assert.equal(
    (await operation.read()).failureReason,
    "resource_proof_rejected"
  );
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

test("a missing post-write dependency rejects review input preparation", async (context) => {
  const { runtime, artifact } = await fixture(context, {
    omitWrittenFile: true,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review input with a missing dependency",
      profile: "review",
      idempotencyKey: "review-missing-file",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.result().catch(() => undefined);

  assert.equal(
    (await operation.read()).failureReason,
    "resource_proof_rejected"
  );
});

test("a changed collection digest rejects review input preparation", async (context) => {
  const { runtime, artifact } = await fixture(context, {
    changeCollectionDigest: true,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review input with another collection digest",
      profile: "review",
      idempotencyKey: "review-collection-digest",
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

test("failed Review input preparation publishes no Startup receipt", async (context) => {
  const { runtime, artifact } = await fixture(context, {
    tamperWrittenFile: true,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review unready input",
      profile: "review",
      idempotencyKey: "review-no-receipt",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.result().catch(() => undefined);

  assert.equal((await operation.read()).startAuthorization.receipt, undefined);
});

test("failed Review input preparation is classified separately from Worker start failure", async (context) => {
  const { runtime, artifact } = await fixture(context, {
    tamperWrittenFile: true,
  });
  const operation = await runtime.spawn(
    {
      promptRef: "Review unready input classification",
      profile: "review",
      idempotencyKey: "review-preparation-classification",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.result().catch(() => undefined);

  assert.equal(
    (await operation.read()).failureReason,
    "resource_proof_rejected"
  );
});

test("a formal review publishes immutable Review input readiness in its Startup receipt", async (context) => {
  const { runtime, artifact } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review the fixed subject",
      profile: "review",
      idempotencyKey: "review-readiness",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  const receipt = await operation.waitForStartupReceipt();

  assert.match(
    receipt?.reviewInputReadiness?.readinessId ?? "",
    /^pions\.review-input-readiness\.v1:[0-9a-f]{64}$/
  );
});

test("Review input readiness binds the inspected Resource authority", async (context) => {
  const { readiness } = await preparedReadiness(context, "review-authority");

  assert.equal(readiness?.authorityId, "review-launcher");
});

test("Review input readiness binds the inspected authority registration", async (context) => {
  const { readiness } = await preparedReadiness(
    context,
    "review-authority-registration"
  );

  assert.equal(
    readiness?.authorityRegistrationId,
    "review-launcher-registration-1"
  );
});

test("Review input readiness binds the inspected authority generation", async (context) => {
  const { readiness } = await preparedReadiness(
    context,
    "review-authority-generation"
  );

  assert.equal(readiness?.authorityGeneration, "generation-1");
});

test("Review input readiness binds the inspected write permission", async (context) => {
  const { runtime, artifact } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review write-bound input",
      profile: "review",
      idempotencyKey: "review-write-binding",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  const readiness = (await operation.waitForStartupReceipt())
    ?.reviewInputReadiness;

  assert.deepEqual(readiness?.writePermission, { kind: "workspace" });
});

test("Review input readiness binds the inspected Permission manifest", async (context) => {
  const { runtime, artifact } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review manifest-bound input",
      profile: "review",
      idempotencyKey: "review-manifest-binding",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  const readiness = (await operation.waitForStartupReceipt())
    ?.reviewInputReadiness;

  assert.equal(
    readiness?.permissionManifestDigest,
    permissionManifestDocument({
      tools: ["read"],
      read: { kind: "workspace" },
      write: { kind: "workspace" },
      commands: "none",
      network: "none",
      externalResources: [],
    }).digest
  );
});

test("Review input readiness binds its Workspace identifier", async (context) => {
  const { readiness, workspace } = await preparedReadiness(
    context,
    "review-workspace-binding"
  );

  assert.equal(readiness?.workspaceId, workspace.workspaceId);
});

test("Review input readiness binds its Worker input path", async (context) => {
  const { readiness, workspace } = await preparedReadiness(
    context,
    "review-input-path-binding"
  );

  assert.equal(readiness?.inputPath, workspace.normalizedPath);
});

test("Review input readiness binds its Resource acquisition", async (context) => {
  const { runtime, artifact } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review acquisition-bound input",
      profile: "review",
      idempotencyKey: "review-acquisition-binding",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  const readiness = (await operation.waitForStartupReceipt())
    ?.reviewInputReadiness;

  assert.match(readiness?.acquisitionId ?? "", /^[0-9a-f]{64}$/);
});

test("a current Review input reaches Start instruction delivery", async (context) => {
  const { runtime, artifact } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review current input",
      profile: "review",
      idempotencyKey: "review-current-input",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();
  await authorizeReview(runtime);
  await operation.result().catch(() => undefined);

  assert.notEqual((await operation.read()).startInstructionDelivery, undefined);
});

test("an uninspectable Review input after readiness prevents Start instruction delivery", async (context) => {
  const { runtime, artifact, connection } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review uninspectable input",
      profile: "review",
      idempotencyKey: "review-uninspectable-input",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();
  connection.makeInspectionUnknown();
  await authorizeReview(runtime);
  await operation.result().catch(() => undefined);

  assert.equal((await operation.read()).startInstructionDelivery, undefined);
});

test("Resource protection revoked after readiness prevents Start instruction delivery", async (context) => {
  const { runtime, artifact, revokeAuthority } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review input after protection revocation",
      profile: "review",
      idempotencyKey: "review-revoked-protection",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();
  revokeAuthority();
  await authorizeReview(runtime);
  await operation.result().catch(() => undefined);

  assert.equal((await operation.read()).startInstructionDelivery, undefined);
});

test("a changed byte sequence after readiness prevents Start instruction delivery", async (context) => {
  const { runtime, artifact, connection } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review input changed after readiness",
      profile: "review",
      idempotencyKey: "review-late-change",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();
  connection.tamperAfterPreparation();
  await authorizeReview(runtime);
  await operation.result().catch(() => undefined);

  assert.equal((await operation.read()).startInstructionDelivery, undefined);
});

test("a missing dependency after readiness prevents Start instruction delivery", async (context) => {
  const { runtime, artifact, connection } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review input missing after readiness",
      profile: "review",
      idempotencyKey: "review-late-missing",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();
  connection.omitAfterPreparation();
  await authorizeReview(runtime);
  await operation.result().catch(() => undefined);

  assert.equal((await operation.read()).startInstructionDelivery, undefined);
});

test("an extra file after readiness prevents Start instruction delivery", async (context) => {
  const { runtime, artifact, connection } = await fixture(context);
  const operation = await runtime.spawn(
    {
      promptRef: "Review input added after readiness",
      profile: "review",
      idempotencyKey: "review-late-extra",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );
  await operation.waitForStartupReceipt();
  connection.addAfterPreparation();
  await authorizeReview(runtime);
  await operation.result().catch(() => undefined);

  assert.equal((await operation.read()).startInstructionDelivery, undefined);
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
