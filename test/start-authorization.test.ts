import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/event-store/index.js";
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";
import { makeSingleRunWorker } from "../src/internal/services.js";
import type {
  Worker,
  WorkerCancellationEvidence,
  WorkerRunHooks,
} from "../src/internal/services.js";
import { BODY_ONLY_WORK_PRODUCT_REQUIREMENTS } from "../src/internal/worker-configuration.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  InMemoryEventStore,
  makeTestRuntime,
} from "../src/internal/testing.js";
import type {
  ArtifactFailureReason,
  ArtifactStore,
  ReviewSubjectRegistrationEvidence,
  CurrentStartAuthorization,
  Runtime,
  StartAuthorizationInbox,
  WorkerProfilePolicy,
} from "../src/public.js";

const timestamps = Array.from({ length: 50 }, (_, index) =>
  new Date(Date.UTC(2026, 8, 6, 10, 0, index)).toISOString()
);

const receipt = {
  workspace: {
    workspaceId: "workspace-1",
    normalizedPath: "/test/workspace",
    baseRevision: "a".repeat(40),
    owner: { state: "known" as const, ownerId: "launcher-1" },
    pionsMayDelete: false as const,
  },
  permissionManifest: {
    manifestId: "manifest-1",
    digest: `sha256:${"ab".repeat(32)}` as const,
  },
  reviewSubjectVerification: "disabled" as const,
  reviewSubject: {
    artifactId: "artifact-1",
    byteCount: 12,
    digest: `sha256:${"cd".repeat(32)}` as const,
    format: "text/plain",
    normalization: "identity.v1",
    registrationEvidenceId: "review-subject-evidence-1",
    registrationEvidenceDigest: `sha256:${"12".repeat(32)}` as const,
  },
};

class OpenCountingWorkerAdapter extends FakeWorkerAdapter {
  openCount = 0;

  override open(operation: Operation): Worker {
    this.openCount += 1;
    return super.open(operation);
  }
}

class PausedWorkerAdapter extends FakeWorkerAdapter {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  resume(): void {
    this.release();
  }

  protected override run(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>
  ) {
    return Effect.promise(() => this.gate).pipe(
      Effect.flatMap(() => super.run(operation, hooks))
    );
  }
}

class PausedStartAcceptanceWorker extends FakeWorkerAdapter {
  cancellationCount = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  acknowledgeStart(): void {
    this.release();
  }

  protected override cancel(
    operation: Operation,
    cancellationEpoch: number
  ): Effect.Effect<WorkerCancellationEvidence | undefined> {
    this.cancellationCount += 1;
    return super.cancel(operation, cancellationEpoch);
  }

  protected override run(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>
  ) {
    return super.run(operation, {
      ...hooks,
      startInstructionAccepted: (instruction) =>
        Effect.promise(() => this.gate).pipe(
          Effect.andThen(hooks.startInstructionAccepted(instruction))
        ),
    });
  }
}

class NotAcceptedRecoveryWorker extends FakeWorkerAdapter {
  recoveredDeliveryCount = 0;
  recoveryAttempted = false;

  override recover(operation: Operation): Worker {
    this.recoveryAttempted = true;
    return makeSingleRunWorker({
      run: (hooks) =>
        Effect.gen(this, function* () {
          const identity = operation.workerIdentity!;
          const instruction = yield* hooks.workerIdentified({
            processId: identity.processId,
            processInstanceId: identity.processInstanceId,
            processStartToken: identity.processStartToken,
            piSessionId: identity.piSessionId,
            observedConfig: operation.observedConfig!,
          });
          yield* hooks.startDeliveryAuthorityRevoked(
            instruction.dispatcherId,
            instruction.deliveryGeneration
          );
          yield* hooks.deliveryGenerationConfirmed({
            dispatcherId: instruction.dispatcherId,
            deliveryGeneration: instruction.deliveryGeneration,
            acceptanceState: "not_accepted",
          });
          yield* hooks.startDeliveryEntered(instruction);
          this.recoveredDeliveryCount += 1;
          return { state: "liveness-unproven" } as const;
        }),
      cancel: () => Effect.succeed(undefined),
    });
  }
}

class AdjustableWallClock extends FakeClock {
  expired = false;

  override now(): Effect.Effect<string> {
    return this.expired
      ? Effect.succeed("2026-09-06T11:00:00.000Z")
      : super.now();
  }
}

class UnreliableRecoveryClock extends FakeClock {
  override recoveredElapsedTimeIsReliable(): boolean {
    return false;
  }
}

class FailingReadStore extends InMemoryEventStore {
  failReads = false;

  protected override readRecord(
    operationId: string
  ): Promise<unknown | undefined> {
    if (this.failReads) return Promise.reject(new Error("read failed"));
    return super.readRecord(operationId);
  }
}

class UnprovenStopWorkerAdapter extends FakeWorkerAdapter {
  protected override cancel(
    _operation: Operation,
    _cancellationEpoch: number
  ): Effect.Effect<WorkerCancellationEvidence | undefined> {
    return Effect.succeed(undefined);
  }
}

function profile(
  policy: WorkerProfilePolicy["startAuthorization"],
  intendedUse: WorkerProfilePolicy["intendedUse"] = "reader"
): WorkerProfilePolicy {
  return {
    intendedUse,
    modelCandidates: [{ provider: "test", id: "test-model" }],
    thinkingLevel: "medium",
    tools: ["read", "bash"],
    resources: { resourceProofPolicy: "disabled" },
    startAuthorization: policy,
    workProductRequirements: BODY_ONLY_WORK_PRODUCT_REQUIREMENTS,
    acceptedArtifactRetentionMs: 86_400_000,
  };
}

async function formalReviewAdmissionFixture(
  context: TestContext,
  options: {
    readonly retrievalFailure?: ArtifactFailureReason;
    readonly bindingFailure?: ArtifactFailureReason;
    readonly reviewSubjectVerification?: "disabled" | "required";
    readonly trace?: Array<string>;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "pions-review-admission-"));
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const artifactServices = runtimeArtifactStore(
    root,
    store,
    () => new Date("2026-09-06T10:00:00.000Z"),
    undefined,
    {
      currentUse: async () =>
        options.bindingFailure === undefined ? "allowed" : "denied",
    }
  );
  context.after(async () => {
    await artifactServices.artifacts.close();
    await rm(root, { recursive: true, force: true });
  });
  const dependencyBytes = Buffer.from("review dependency", "utf8");
  const dependencyDigest =
    `sha256:${createHash("sha256").update(dependencyBytes).digest("hex")}` as const;
  await artifactServices.artifacts.startRegistration(
    artifactServices.credential,
    {
      registrationId: "review-dependency-registration",
      expectedByteCount: dependencyBytes.byteLength,
      expectedDigest: dependencyDigest,
      formatId: "pions.opaque.v1",
      normalizationId: "identity.v1",
      dependencies: [],
      deadline: "2026-09-06T10:01:00.000Z",
      recoveryBudget: 1,
    }
  );
  const dependencyRegistration = await artifactServices.artifacts.transfer(
    artifactServices.credential,
    "review-dependency-registration",
    dependencyBytes
  );
  if (dependencyRegistration.kind !== "registered")
    throw new Error("Review dependency registration failed");
  const bytes = Buffer.from("review input", "utf8");
  const digest =
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  await artifactServices.artifacts.startRegistration(
    artifactServices.credential,
    {
      registrationId: "review-registration",
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest,
      formatId: "pions.opaque.v1",
      normalizationId: "identity.v1",
      dependencies: [dependencyRegistration.artifact.artifactId],
      deadline: "2026-09-06T10:01:00.000Z",
      recoveryBudget: 1,
    }
  );
  const registration = await artifactServices.artifacts.transfer(
    artifactServices.credential,
    "review-registration",
    bytes
  );
  if (registration.kind !== "registered")
    throw new Error("Review subject registration failed");
  const evidenceWithoutDigest: Omit<
    ReviewSubjectRegistrationEvidence,
    "digest"
  > = {
    formatId: "pions.review-subject-registration-evidence.v1",
    evidenceId: "review-subject-evidence-1",
    issuerId: "test-review-subject-issuer",
    root: {
      artifactId: registration.artifact.artifactId,
      byteCount: registration.artifact.byteCount,
      digest: registration.artifact.digest,
      formatId: registration.artifact.formatId,
      normalizationId: registration.artifact.normalizationId,
      dependencies: [...registration.artifact.dependencies],
    },
    files: [
      {
        path: "docs/spec.md",
        artifactId: dependencyRegistration.artifact.artifactId,
        byteCount: dependencyRegistration.artifact.byteCount,
        digest: dependencyRegistration.artifact.digest,
        formatId: dependencyRegistration.artifact.formatId,
        normalizationId: dependencyRegistration.artifact.normalizationId,
      },
    ],
    collectionDigest: `sha256:${"12".repeat(32)}`,
    validator: { validatorId: "test-validator", version: "1" },
  };
  const evidence: ReviewSubjectRegistrationEvidence = {
    ...evidenceWithoutDigest,
    digest: `sha256:${createHash("sha256")
      .update(JSON.stringify(evidenceWithoutDigest))
      .digest("hex")}`,
  };
  const recorded =
    await artifactServices.artifacts.recordReviewSubjectRegistrationEvidence(
      artifactServices.credential,
      evidence
    );
  if (recorded.kind !== "resolved")
    throw new Error("Review subject registration evidence failed");
  const artifacts: ArtifactStore = new Proxy(artifactServices.artifacts, {
    get(target, property) {
      if (
        property === "resolveMetadata" &&
        options.retrievalFailure !== undefined
      ) {
        return async () => ({
          kind: "failed",
          terminal: true,
          reason: options.retrievalFailure!,
        });
      }
      if (property === "prepareUseBinding") {
        return async (
          ...args: Parameters<ArtifactStore["prepareUseBinding"]>
        ) => {
          options.trace?.push("retain");
          return target.prepareUseBinding(...args);
        };
      }
      if (property === "retrieveForUseBinding") {
        return async (
          ...args: Parameters<ArtifactStore["retrieveForUseBinding"]>
        ) => {
          options.trace?.push("verify");
          return target.retrieveForUseBinding(...args);
        };
      }
      const value = target[property as keyof ArtifactStore];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const worker = new OpenCountingWorkerAdapter();
  const presentation = new FakePresentation();
  const runtime = makeTestRuntime({
    worker,
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation,
    store,
    artifacts,
    artifactCredential: artifactServices.credential,
    synchronizeArtifactClock: artifactServices.synchronizeClock,
    startAuthorizationAuthenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        currentAuthorization: async () => "authorized",
      }),
    },
    configuration: {
      cwd: "/test/workspace",
      profiles: {
        review: profile(
          {
            policy: "required",
            windowMs: 60_000,
            authorizedSubjectIds: ["reviewer-1"],
            receipt: {
              workspace: receipt.workspace,
              permissionManifest: receipt.permissionManifest,
              reviewSubjectVerification:
                options.reviewSubjectVerification ?? "required",
            },
          },
          "formal_reviewer"
        ),
      },
    },
  });
  return {
    runtime,
    worker,
    presentation,
    artifacts,
    artifactCredential: artifactServices.credential,
    artifact: registration.artifact,
    artifactId: registration.artifact.artifactId,
    evidence,
  };
}

async function fixture(
  options: {
    readonly policy?: WorkerProfilePolicy["startAuthorization"];
    readonly intendedUse?: WorkerProfilePolicy["intendedUse"];
    readonly currentAuthority?:
      | CurrentStartAuthorization
      | ((callNumber: number) => CurrentStartAuthorization);
    readonly beforeCurrentAuthorization?: (
      callNumber: number,
      clock: FakeClock
    ) => void;
    readonly authenticationFails?: boolean;
    readonly worker?: FakeWorkerAdapter;
    readonly beforeReceipt?: () => void;
    readonly store?: InMemoryEventStore;
    readonly clock?: FakeClock;
  } = {}
): Promise<{
  readonly runtime: Runtime;
  readonly inbox: StartAuthorizationInbox;
  readonly clock: FakeClock;
  readonly handle: Awaited<ReturnType<Runtime["spawn"]>>;
  readonly trace: ReadonlyArray<string>;
  readonly presentation: FakePresentation;
}> {
  const clock = options.clock ?? new FakeClock(timestamps);
  const trace: Array<string> = [];
  let authorizationChecks = 0;
  const presentation = new FakePresentation();
  const runtime = makeTestRuntime({
    worker: options.worker ?? new FakeWorkerAdapter({ trace }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation,
    store: options.store ?? new InMemoryEventStore(trace, clock),
    startAuthorizationAuthenticator: {
      authenticate: async () => {
        if (options.authenticationFails === true)
          throw new Error("credential rejected");
        return {
          subjectId: "reviewer-1",
          currentAuthorization: async () => {
            authorizationChecks += 1;
            options.beforeCurrentAuthorization?.(authorizationChecks, clock);
            return typeof options.currentAuthority === "function"
              ? options.currentAuthority(authorizationChecks)
              : (options.currentAuthority ?? "authorized");
          },
        };
      },
    },
    configuration: {
      cwd: "/test/workspace",
      profiles: {
        review: profile(
          options.policy ?? {
            policy: "required",
            windowMs: 60_000,
            authorizedSubjectIds: ["reviewer-1"],
            receipt,
          },
          options.intendedUse
        ),
      },
    },
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "review",
    idempotencyKey: "task-1",
  });
  options.beforeReceipt?.();
  await handle.waitForStartupReceipt();
  return {
    runtime,
    inbox: await runtime.startAuthorizationInbox("credential"),
    clock,
    handle,
    trace,
    presentation,
  };
}

async function authorize(inbox: StartAuthorizationInbox) {
  const waiting = (await inbox.listWaiting())[0];
  if (waiting === undefined) throw new Error("No waiting Operation");
  return inbox.decide({
    operationId: waiting.operationId,
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: waiting.receipt.digest,
  });
}

test("a required Start gate remains waiting before a decision", async () => {
  const { handle } = await fixture();

  assert.equal((await handle.read()).startAuthorization.gate, "waiting");
});

test("a non-review Startup receipt does not invent a Review subject", async () => {
  const { handle } = await fixture();

  assert.equal(
    (await handle.waitForStartupReceipt())?.reviewSubject,
    undefined
  );
});

test("an authorized decision starts the waiting Operation", async () => {
  const { inbox, handle } = await fixture();
  await authorize(inbox);
  await handle.result();

  assert.equal((await handle.read()).state, "completed");
});

test("an Operation remains starting until the Worker acknowledges begin", async () => {
  const worker = new PausedStartAcceptanceWorker();
  const { inbox, handle } = await fixture({ worker });
  await authorize(inbox);

  assert.equal((await handle.read()).state, "starting");
  worker.acknowledgeStart();
});

test("cancellation before Start delivery authority prevents begin delivery", async () => {
  const { handle } = await fixture();

  await handle.cancel({ scope: "subtree" });

  assert.equal((await handle.read()).startDeliveryAuthority, undefined);
});

test("cancellation after begin dispatch stops the possibly started Worker", async () => {
  const worker = new PausedStartAcceptanceWorker();
  const { inbox, handle } = await fixture({ worker });
  await authorize(inbox);

  await handle.cancel({ scope: "subtree" });

  assert.equal(worker.cancellationCount, 1);
  worker.acknowledgeStart();
});

test("Start delivery authority acquisition is persisted independently", async () => {
  const { inbox, handle } = await fixture();
  await authorize(inbox);
  await handle.result();

  assert.equal(
    (await handle.read()).startDeliveryAuthority?.dispatcherId,
    "pions-runtime"
  );
});

test("Start delivery entry is persisted independently", async () => {
  const { inbox, handle } = await fixture();
  await authorize(inbox);
  await handle.result();

  assert.equal(
    (await handle.read()).startDeliveryEntry?.dispatcherId,
    "pions-runtime"
  );
});

test("Worker durable Start acceptance is persisted independently", async () => {
  const { inbox, handle } = await fixture();
  await authorize(inbox);
  await handle.result();

  assert.equal(
    (await handle.read()).startInstructionAcceptance?.proof,
    "worker-durable-acceptance"
  );
});

test("Worker begin acknowledgement is persisted independently", async () => {
  const { inbox, handle } = await fixture();
  await authorize(inbox);
  await handle.result();

  assert.equal(
    (await handle.read()).startInstructionAcknowledgement?.proof,
    "authenticated-worker-acknowledgement"
  );
});

test("coordinator disconnection alone leaves the Start gate waiting", async () => {
  const { runtime, handle } = await fixture();
  await runtime.startAuthorizationInbox("credential");

  assert.equal((await handle.read()).startAuthorization.gate, "waiting");
});

test("the authorization decision is persisted before Worker execution begins", async () => {
  const { inbox, handle, trace } = await fixture();
  await authorize(inbox);
  await handle.result();

  assert.equal(
    trace.findIndex((entry) => entry.includes("start_authorization_decided")) <
      trace.indexOf("worker-protocol:receive-result"),
    true
  );
});

test("a formal review Operation fixes its registered Artifact as the Review subject", async (context) => {
  const { runtime, artifact, evidence } =
    await formalReviewAdmissionFixture(context);
  const handle = await runtime.spawn(
    {
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    },
    { reviewSubjectArtifactId: artifact.artifactId }
  );

  assert.deepEqual((await handle.waitForStartupReceipt())?.reviewSubject, {
    artifactId: artifact.artifactId,
    byteCount: artifact.byteCount,
    digest: artifact.digest,
    format: artifact.formatId,
    normalization: artifact.normalizationId,
    registrationEvidenceId: evidence.evidenceId,
    registrationEvidenceDigest: evidence.digest,
  });
});

for (const [description, reason] of [
  ["an unregistered", "unauthorized"],
  ["an unavailable", "storage_inspection_unavailable"],
  ["a deleted", "artifact_deleted"],
  ["a corrupt", "stored_artifact_corrupt"],
] as const) {
  test(`${description} Review subject does not publish a Start authorization request`, async (context) => {
    const { runtime, artifactId } = await formalReviewAdmissionFixture(
      context,
      {
        retrievalFailure: reason,
      }
    );
    await runtime
      .spawn(
        {
          promptRef: "private://prompt/1",
          profile: "review",
          idempotencyKey: "task-1",
        },
        { reviewSubjectArtifactId: artifactId }
      )
      .catch(() => undefined);
    const inbox = await runtime.startAuthorizationInbox("credential");

    assert.equal((await inbox.listWaiting()).length, 0);
  });
}

test("an unauthorized Review subject does not publish a Start authorization request", async (context) => {
  const { runtime, artifactId } = await formalReviewAdmissionFixture(context, {
    bindingFailure: "unauthorized",
  });
  const handle = await runtime.spawn(
    {
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    },
    { reviewSubjectArtifactId: artifactId }
  );
  await handle.waitForStartupReceipt();
  const inbox = await runtime.startAuthorizationInbox("credential");

  assert.equal((await inbox.listWaiting()).length, 0);
});

test("a Review subject dependency closure is retained before authorization publication", async (context) => {
  const { runtime, artifactId, artifacts, artifactCredential } =
    await formalReviewAdmissionFixture(context);
  const handle = await runtime.spawn(
    {
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    },
    { reviewSubjectArtifactId: artifactId }
  );
  await handle.waitForStartupReceipt();
  const binding = await artifacts.useBindingStatus(
    artifactCredential,
    "operation-1.review-subject"
  );

  assert.equal(
    binding.kind === "available"
      ? binding.binding.dependencyClosure.length
      : undefined,
    1
  );
});

test("a Review subject is retained before its integrity is verified", async (context) => {
  const trace: Array<string> = [];
  const { runtime, artifactId } = await formalReviewAdmissionFixture(context, {
    trace,
  });
  const handle = await runtime.spawn(
    {
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    },
    { reviewSubjectArtifactId: artifactId }
  );
  await handle.waitForStartupReceipt();

  assert.deepEqual(trace.slice(0, 2), ["retain", "verify"]);
});

test("a formal review Operation requires an operation-specific Review subject", async (context) => {
  const { runtime, presentation } = await formalReviewAdmissionFixture(context);
  await runtime
    .spawn({
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    })
    .catch(() => undefined);

  assert.equal(presentation.createdPaneIds.length, 0);
});

test("a formal review Operation without a Review subject does not create a Worker", async (context) => {
  const { runtime, worker } = await formalReviewAdmissionFixture(context);
  await runtime
    .spawn({
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    })
    .catch(() => undefined);

  assert.equal(worker.openCount, 0);
});

test("an incomplete formal reviewer profile does not create a Pane", async (context) => {
  const { runtime, artifactId, presentation } =
    await formalReviewAdmissionFixture(context, {
      reviewSubjectVerification: "disabled",
    });
  await runtime
    .spawn(
      {
        promptRef: "private://prompt/1",
        profile: "review",
        idempotencyKey: "task-1",
      },
      { reviewSubjectArtifactId: artifactId }
    )
    .catch(() => undefined);

  assert.equal(presentation.createdPaneIds.length, 0);
});

test("an incomplete formal reviewer profile does not create a Worker", async (context) => {
  const { runtime, artifactId, worker } = await formalReviewAdmissionFixture(
    context,
    { reviewSubjectVerification: "disabled" }
  );
  await runtime
    .spawn(
      {
        promptRef: "private://prompt/1",
        profile: "review",
        idempotencyKey: "task-1",
      },
      { reviewSubjectArtifactId: artifactId }
    )
    .catch(() => undefined);

  assert.equal(worker.openCount, 0);
});

test("a formal review Operation keeps its Review subject after creation", async (context) => {
  const { runtime, artifactId } = await formalReviewAdmissionFixture(context);
  const options = { reviewSubjectArtifactId: artifactId };
  const handle = await runtime.spawn(
    {
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    },
    options
  );
  options.reviewSubjectArtifactId = "another-artifact";

  assert.equal(
    (await handle.waitForStartupReceipt())?.reviewSubject?.artifactId,
    artifactId
  );
});

test("a formal reviewer does not begin when its Review subject fails immediate revalidation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-start-revalidation-"));
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const artifactServices = runtimeArtifactStore(
    root,
    store,
    () => new Date("2026-09-06T10:00:00.000Z"),
    undefined,
    { currentUse: async () => "allowed" }
  );
  context.after(async () => {
    await artifactServices.artifacts.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from("review input", "utf8");
  const digest =
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  await artifactServices.artifacts.startRegistration(
    artifactServices.credential,
    {
      registrationId: "review-registration-1",
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest,
      formatId: "pions.opaque.v1",
      normalizationId: "identity.v1",
      dependencies: [],
      deadline: "2026-09-06T10:01:00.000Z",
      recoveryBudget: 1,
    }
  );
  const registration = await artifactServices.artifacts.transfer(
    artifactServices.credential,
    "review-registration-1",
    bytes
  );
  if (registration.kind !== "registered")
    throw new Error("Review subject registration failed");
  const rootMetadata = {
    artifactId: registration.artifact.artifactId,
    byteCount: registration.artifact.byteCount,
    digest: registration.artifact.digest,
    formatId: registration.artifact.formatId,
    normalizationId: registration.artifact.normalizationId,
    dependencies: [...registration.artifact.dependencies],
  };
  const evidenceWithoutDigest: Omit<
    ReviewSubjectRegistrationEvidence,
    "digest"
  > = {
    formatId: "pions.review-subject-registration-evidence.v1",
    evidenceId: "review-subject-evidence-1",
    issuerId: "test-review-subject-issuer",
    root: rootMetadata,
    files: [],
    collectionDigest: `sha256:${"12".repeat(32)}`,
    validator: { validatorId: "test-validator", version: "1" },
  };
  const evidence: ReviewSubjectRegistrationEvidence = {
    ...evidenceWithoutDigest,
    digest: `sha256:${createHash("sha256")
      .update(JSON.stringify(evidenceWithoutDigest))
      .digest("hex")}`,
  };
  const recorded =
    await artifactServices.artifacts.recordReviewSubjectRegistrationEvidence(
      artifactServices.credential,
      evidence
    );
  if (recorded.kind !== "resolved")
    throw new Error("Review subject registration evidence failed");
  let retrievalCount = 0;
  const artifacts: ArtifactStore = new Proxy(artifactServices.artifacts, {
    get(target, property) {
      if (property === "retrieveForUseBinding") {
        return async (credential: string, bindingId: string) => {
          retrievalCount += 1;
          if (retrievalCount === 2) {
            return {
              kind: "failed",
              terminal: false,
              reason: "storage_inspection_unavailable",
            } as const;
          }
          return target.retrieveForUseBinding(credential, bindingId);
        };
      }
      const value = target[property as keyof ArtifactStore];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
    artifacts,
    artifactCredential: artifactServices.credential,
    synchronizeArtifactClock: artifactServices.synchronizeClock,
    startAuthorizationAuthenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        currentAuthorization: async () => "authorized",
      }),
    },
    configuration: {
      cwd: "/test/workspace",
      profiles: {
        review: profile(
          {
            policy: "required",
            windowMs: 60_000,
            authorizedSubjectIds: ["reviewer-1"],
            receipt: {
              ...receipt,
              reviewSubjectVerification: "required",
            },
          },
          "formal_reviewer"
        ),
      },
    },
  });
  const handle = await runtime.spawn(
    {
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    },
    { reviewSubjectArtifactId: registration.artifact.artifactId }
  );
  await handle.waitForStartupReceipt();
  await authorize(await runtime.startAuthorizationInbox("credential"));

  assert.equal((await handle.read()).startInstructionDelivery, undefined);
});

test("an optional policy resolved as disabled keeps automatic start", async () => {
  const { handle } = await fixture({
    policy: { policy: "optional", resolution: "disabled" },
  });
  await handle.result();

  assert.equal(
    (await handle.read()).startAuthorization.timing.policy,
    "disabled"
  );
});

test("the resolved optional policy is fixed at Operation creation", async () => {
  const { handle } = await fixture({
    policy: {
      policy: "optional",
      resolution: "required",
      windowMs: 60_000,
      authorizedSubjectIds: ["reviewer-1"],
      receipt,
    },
  });

  assert.equal(
    (await handle.read()).startAuthorization.timing.policy,
    "required"
  );
});

test("a resolved required policy is not disabled by later profile mutation", async () => {
  const worker = new PausedWorkerAdapter();
  const mutablePolicy = {
    policy: "optional" as const,
    resolution: "required" as const,
    windowMs: 60_000,
    authorizedSubjectIds: ["reviewer-1"],
    receipt,
  };
  const { handle } = await fixture({
    worker,
    policy: mutablePolicy,
    beforeReceipt: () => {
      Object.assign(mutablePolicy, { policy: "disabled" });
      worker.resume();
    },
  });

  assert.equal(
    (await handle.waitForStartupReceipt())?.authorizationPolicy,
    "required"
  );
});

test("a receipt completed after its deadline is never published as waiting", async () => {
  const { inbox } = await fixture({
    policy: {
      policy: "required",
      windowMs: 1,
      authorizedSubjectIds: ["reviewer-1"],
      receipt,
    },
  });

  assert.equal((await inbox.listWaiting()).length, 0);
});

test("an unauthenticated inbox request has a closed authentication error", async () => {
  await assert.rejects(fixture({ authenticationFails: true }), {
    name: "StartAuthorizationAuthenticationError",
  });
});

test("a subject outside the fixed authorization scope is rejected", async () => {
  const { inbox, handle } = await fixture({
    policy: {
      policy: "required",
      windowMs: 60_000,
      authorizedSubjectIds: ["other-reviewer"],
      receipt,
    },
  });
  const startupReceipt = await handle.waitForStartupReceipt();
  const outcome = await inbox.decide({
    operationId: "operation-1",
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });

  assert.equal(
    outcome.status === "rejected" ? outcome.reason : "accepted",
    "fixed_scope_denied"
  );
});

test("an out-of-scope inbox cannot expire another subject's Operation", async () => {
  const clock = new AdjustableWallClock(timestamps);
  const { inbox, handle } = await fixture({
    clock,
    policy: {
      policy: "required",
      windowMs: 60_000,
      authorizedSubjectIds: ["reviewer-2"],
      receipt,
    },
  });
  clock.expired = true;

  await inbox.listWaiting();

  assert.equal((await handle.read()).state, "starting");
});

test("a rejected out-of-scope attempt does not append authorization audit events", async () => {
  const { runtime, inbox, handle } = await fixture({
    policy: {
      policy: "required",
      windowMs: 60_000,
      authorizedSubjectIds: ["reviewer-2"],
      receipt,
    },
  });
  const startupReceipt = await handle.waitForStartupReceipt();
  await inbox.decide({
    operationId: "operation-1",
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });

  const snapshot = await (await runtime.operation("operation-1")).read();
  assert.equal(snapshot.startAuthorization.rejectedDecisions.length, 0);
});

test("a subject without current authority is rejected", async () => {
  const { inbox, handle } = await fixture({ currentAuthority: "denied" });
  const startupReceipt = await handle.waitForStartupReceipt();
  const outcome = await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });

  assert.equal(
    outcome.status === "rejected" ? outcome.reason : "accepted",
    "current_authority_denied"
  );
});

test("a revoked subject is rejected distinctly", async () => {
  const { inbox, handle } = await fixture({ currentAuthority: "revoked" });
  const startupReceipt = await handle.waitForStartupReceipt();
  const outcome = await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });

  assert.equal(
    outcome.status === "rejected" ? outcome.reason : "accepted",
    "authority_revoked"
  );
});

test("an unknown current authority is rejected distinctly", async () => {
  const { inbox, handle } = await fixture({ currentAuthority: "unknown" });
  const startupReceipt = await handle.waitForStartupReceipt();
  const outcome = await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });

  assert.equal(
    outcome.status === "rejected" ? outcome.reason : "accepted",
    "authority_unknown"
  );
});

test("a deadline crossed during pre-begin checks keeps the Worker stopped", async () => {
  const { inbox, handle } = await fixture({
    beforeCurrentAuthorization: (callNumber, clock) => {
      if (callNumber === 3) clock.advanceBy(60_000);
    },
  });
  await authorize(inbox);
  await handle.result().catch(() => undefined);

  assert.equal(
    (await handle.read()).failureReason,
    "start_authorization_timed_out"
  );
});

test("an expired Start authorization retains its owned pane", async () => {
  const { inbox, handle, presentation } = await fixture({
    beforeCurrentAuthorization: (callNumber, clock) => {
      if (callNumber === 3) clock.advanceBy(60_000);
    },
  });
  await authorize(inbox);
  await handle.result().catch(() => undefined);

  assert.deepEqual(presentation.closedPaneIds, []);
});

async function requiredAuthorizationRecovery(
  recoveredAt: string,
  currentAuthorization: CurrentStartAuthorization
) {
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const firstWorker = new PausedStartAcceptanceWorker();
  const first = await fixture({ worker: firstWorker, store, clock });
  await authorize(first.inbox);
  while ((await first.handle.read()).startDeliveryEntry === undefined) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await first.runtime.close();
  const recoveredWorker = new NotAcceptedRecoveryWorker();
  const recovered = makeTestRuntime({
    worker: recoveredWorker,
    clock: new FakeClock(Array.from({ length: 40 }, () => recoveredAt)),
    ids: new FakeIdGenerator([]),
    presentation: new FakePresentation(),
    store,
    startAuthorizationAuthenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        currentAuthorization: async () => "authorized",
      }),
    },
    startAuthorizationAuthority: {
      currentAuthorization: async () => currentAuthorization,
    },
    configuration: {
      cwd: "/test/workspace",
      profiles: {
        review: profile({
          policy: "required",
          windowMs: 60_000,
          authorizedSubjectIds: ["reviewer-1"],
          receipt,
        }),
      },
    },
  });
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (
      recoveredWorker.recoveryAttempted &&
      (await first.handle.read()).failureReason !== undefined
    )
      break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const operation = await first.handle.read();
  firstWorker.acknowledgeStart();
  await recovered.close();
  return { operation, recoveredWorker };
}

test("expired required authorization prevents recovery redispatch", async () => {
  const { recoveredWorker } = await requiredAuthorizationRecovery(
    "2026-09-06T11:00:00.000Z",
    "authorized"
  );

  assert.equal(recoveredWorker.recoveredDeliveryCount, 0);
});

test("expired required authorization keeps its failure classification during recovery", async () => {
  const { operation } = await requiredAuthorizationRecovery(
    "2026-09-06T11:00:00.000Z",
    "authorized"
  );

  assert.equal(operation.failureReason, "start_authorization_timed_out");
});

test("revoked Start authorization prevents recovery redispatch", async () => {
  const { recoveredWorker } = await requiredAuthorizationRecovery(
    "2026-09-06T10:00:30.000Z",
    "revoked"
  );

  assert.equal(recoveredWorker.recoveredDeliveryCount, 0);
});

test("revoked Start authorization keeps its failure classification during recovery", async () => {
  const { operation } = await requiredAuthorizationRecovery(
    "2026-09-06T10:00:30.000Z",
    "revoked"
  );

  assert.equal(operation.failureReason, "start_authorization_invalidated");
});

test("resending the same decision is idempotent", async () => {
  const { inbox, handle } = await fixture();
  const startupReceipt = await handle.waitForStartupReceipt();
  const request = {
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "authorize" as const,
    receiptDigest: startupReceipt!.digest,
  };
  await inbox.decide(request);
  const outcome = await inbox.decide(request);

  assert.equal(outcome.status, "idempotent");
});

test("the same decision content under another ID is distinguished without another transition", async () => {
  const { inbox, handle } = await fixture();
  const startupReceipt = await handle.waitForStartupReceipt();
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });
  const outcome = await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-2",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });

  assert.equal(outcome.status, "duplicate");
});

test("the same decision ID with different content is a conflict", async () => {
  const { inbox, handle } = await fixture();
  const startupReceipt = await handle.waitForStartupReceipt();
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });
  const outcome = await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "reject",
    receiptDigest: startupReceipt!.digest,
  });

  assert.equal(
    outcome.status === "rejected" ? outcome.reason : "accepted",
    "decision_id_conflict"
  );
});

test("a decision read failure is not reported as a missing Operation", async () => {
  const store = new FailingReadStore();
  const { inbox } = await fixture({ store });
  store.failReads = true;

  await assert.rejects(
    inbox.decide({
      operationId: "operation-1",
      decisionId: "decision-1",
      kind: "authorize",
      receiptDigest: "sha256:receipt",
    }),
    /persistence failed/u
  );
});

test("another decision ID with an old receipt is rejected distinctly", async () => {
  const { inbox } = await fixture();
  await authorize(inbox);

  const outcome = await inbox.decide({
    operationId: "operation-1",
    decisionId: "decision-2",
    kind: "authorize",
    receiptDigest: "sha256:old-receipt",
  });

  assert.equal(
    outcome.status === "rejected" ? outcome.reason : "accepted",
    "receipt_mismatch"
  );
});

test("repeating the same conflicting attempt appends one authorization audit event", async () => {
  const { inbox, handle } = await fixture();
  await authorize(inbox);
  const conflict = {
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "reject" as const,
    receiptDigest: "sha256:different" as const,
  };

  await inbox.decide(conflict);
  await inbox.decide(conflict);

  assert.equal(
    (await handle.read()).startAuthorization.rejectedDecisions.length,
    1
  );
});

test("a conflicting decision is retained in the authorization audit", async () => {
  const { inbox, handle } = await fixture();
  const startupReceipt = await handle.waitForStartupReceipt();
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "reject",
    receiptDigest: startupReceipt!.digest,
  });

  assert.equal(
    (await handle.read()).startAuthorization.rejectedDecisions[0]?.reason,
    "decision_id_conflict"
  );
});

test("authorization audit entries are immutable", async () => {
  const { inbox, handle } = await fixture();
  await authorize(inbox);
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "reject",
    receiptDigest: "sha256:different",
  });

  assert.equal(
    Object.isFrozen(
      (await handle.read()).startAuthorization.rejectedDecisions[0]
    ),
    true
  );
});

test("authority loss during pre-begin revalidation invalidates the Operation", async () => {
  const { inbox, handle } = await fixture({
    currentAuthority: (callNumber) =>
      callNumber < 4 ? "authorized" : "denied",
  });

  await authorize(inbox);

  assert.equal(
    (await handle.read()).failureReason,
    "start_authorization_invalidated"
  );
});

test("an invalidated Start authorization retains its owned pane", async () => {
  const { inbox, presentation } = await fixture({
    currentAuthority: (callNumber) =>
      callNumber < 4 ? "authorized" : "denied",
  });
  await authorize(inbox);

  assert.deepEqual(presentation.closedPaneIds, []);
});

test("unproven stop after authorization invalidation retains the failure reason", async () => {
  const { inbox, handle } = await fixture({
    worker: new UnprovenStopWorkerAdapter(),
    currentAuthority: (callNumber) =>
      callNumber < 4 ? "authorized" : "denied",
  });

  await authorize(inbox);

  assert.equal(
    (await handle.read()).failureReason,
    "start_authorization_invalidated"
  );
});

test("a rejected Start decision fails with the fixed reason after Worker stop", async () => {
  const { inbox, handle } = await fixture();
  const startupReceipt = await handle.waitForStartupReceipt();
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "reject",
    receiptDigest: startupReceipt!.digest,
  });
  await handle.result().catch(() => undefined);

  assert.equal((await handle.read()).failureReason, "start_rejected");
});

test("a rejected Start decision retains its owned pane", async () => {
  const { inbox, handle, presentation } = await fixture();
  const startupReceipt = await handle.waitForStartupReceipt();
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "reject",
    receiptDigest: startupReceipt!.digest,
  });
  await handle.result().catch(() => undefined);

  assert.deepEqual(presentation.closedPaneIds, []);
});

test("an unproven stop after rejection leaves the Operation unknown", async () => {
  const { inbox, handle } = await fixture({
    worker: new UnprovenStopWorkerAdapter(),
  });
  const startupReceipt = await handle.waitForStartupReceipt();
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "reject",
    receiptDigest: startupReceipt!.digest,
  });
  await handle.result().catch(() => undefined);

  assert.equal((await handle.read()).state, "unknown");
});

test("cancellation remains available while authorization is waiting", async () => {
  const { handle } = await fixture();
  await handle.cancel({ scope: "subtree" });

  assert.equal((await handle.read()).state, "cancelled");
});

test("a recovered authorization decision without a Worker leaves the Operation unknown", async () => {
  const store = new InMemoryEventStore();
  const { handle } = await fixture({ store });
  const startupReceipt = await handle.waitForStartupReceipt();
  const recovered = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock: new FakeClock(timestamps),
    ids: new FakeIdGenerator(["unused-operation"]),
    presentation: new FakePresentation(),
    store,
    startAuthorizationAuthenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        currentAuthorization: async () => "authorized",
      }),
    },
    configuration: {
      cwd: "/test/workspace",
      profiles: {
        review: profile({
          policy: "required",
          windowMs: 60_000,
          authorizedSubjectIds: ["reviewer-1"],
          receipt,
        }),
      },
    },
  });
  const inbox = await recovered.startAuthorizationInbox("credential");

  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "authorize",
    receiptDigest: startupReceipt!.digest,
  });

  assert.equal(
    (await (await recovered.operation(handle.operationId)).read()).state,
    "unknown"
  );
});

test("recovery with an unreliable elapsed-time source expires the authorization", async () => {
  const store = new InMemoryEventStore();
  await fixture({ store });
  const recovered = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock: new UnreliableRecoveryClock(timestamps),
    ids: new FakeIdGenerator(["unused-operation"]),
    presentation: new FakePresentation(),
    store,
    startAuthorizationAuthenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        currentAuthorization: async () => "authorized",
      }),
    },
    configuration: {
      cwd: "/test/workspace",
      profiles: {
        review: profile({
          policy: "required",
          windowMs: 60_000,
          authorizedSubjectIds: ["reviewer-1"],
          receipt,
        }),
      },
    },
  });
  const inbox = await recovered.startAuthorizationInbox("credential");

  await inbox.listWaiting();

  assert.equal(
    (await (await recovered.operation("operation-1")).read()).state,
    "unknown"
  );
});

test("an unproven stop after authorization timeout leaves the Operation unknown", async () => {
  const { clock, handle } = await fixture({
    worker: new UnprovenStopWorkerAdapter(),
  });
  clock.advanceBy(60_000);

  await handle.result().catch(() => undefined);

  assert.equal((await handle.read()).state, "unknown");
});

test("an elapsed authorization deadline fails with the fixed reason", async () => {
  const { clock, handle } = await fixture();
  clock.advanceBy(60_000);
  await handle.result().catch(() => undefined);

  assert.equal(
    (await handle.read()).failureReason,
    "start_authorization_timed_out"
  );
});
