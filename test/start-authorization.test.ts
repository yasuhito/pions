import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/event-store/index.js";
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";
import type { WorkerCancellationEvidence, WorkerRunHooks } from "../src/internal/services.js";
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
  CurrentStartAuthorization,
  Runtime,
  StartAuthorizationInbox,
  WorkerProfilePolicy,
} from "../src/public.js";

const timestamps = Array.from({ length: 50 }, (_, index) =>
  new Date(Date.UTC(2026, 8, 6, 10, 0, index)).toISOString(),
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
  },
};

class PausedWorkerAdapter extends FakeWorkerAdapter {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  resume(): void {
    this.release();
  }

  protected override run(operation: Operation, hooks: Readonly<WorkerRunHooks>) {
    return Effect.promise(() => this.gate).pipe(
      Effect.flatMap(() => super.run(operation, hooks)),
    );
  }
}

class UnprovenStopWorkerAdapter extends FakeWorkerAdapter {
  protected override cancel(
    _operation: Operation,
    _cancellationEpoch: number,
  ): Effect.Effect<WorkerCancellationEvidence | undefined> {
    return Effect.succeed(undefined);
  }
}

function profile(policy: WorkerProfilePolicy["startAuthorization"]): WorkerProfilePolicy {
  return {
    modelCandidates: [{ provider: "test", id: "test-model" }],
    thinkingLevel: "medium",
    tools: ["read", "bash", "edit", "write"],
    resources: { resourceProofPolicy: "disabled" },
    startAuthorization: policy,
    workProductRequirements: BODY_ONLY_WORK_PRODUCT_REQUIREMENTS,
    acceptedArtifactRetentionMs: 86_400_000,
  };
}

async function fixture(options: {
  readonly policy?: WorkerProfilePolicy["startAuthorization"];
  readonly currentAuthority?: CurrentStartAuthorization;
  readonly beforeCurrentAuthorization?: (callNumber: number, clock: FakeClock) => void;
  readonly authenticationFails?: boolean;
  readonly worker?: FakeWorkerAdapter;
  readonly beforeReceipt?: () => void;
} = {}): Promise<{
  readonly runtime: Runtime;
  readonly inbox: StartAuthorizationInbox;
  readonly clock: FakeClock;
  readonly handle: Awaited<ReturnType<Runtime["spawn"]>>;
  readonly trace: ReadonlyArray<string>;
}> {
  const clock = new FakeClock(timestamps);
  const trace: Array<string> = [];
  let authorizationChecks = 0;
  const runtime = makeTestRuntime({
    worker: options.worker ?? new FakeWorkerAdapter({ trace }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore(trace, clock),
    startAuthorizationAuthenticator: {
      authenticate: async () => {
        if (options.authenticationFails === true) throw new Error("credential rejected");
        return {
          subjectId: "reviewer-1",
          currentAuthorization: async () => {
            authorizationChecks += 1;
            options.beforeCurrentAuthorization?.(authorizationChecks, clock);
            return options.currentAuthority ?? "authorized";
          },
        };
      },
    },
    configuration: {
      cwd: "/test/workspace",
      profiles: {
        review: profile(options.policy ?? {
          policy: "required",
          windowMs: 60_000,
          authorizedSubjectIds: ["reviewer-1"],
          receipt,
        }),
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

test("an authorized decision starts the waiting Operation", async () => {
  const { inbox, handle } = await fixture();
  await authorize(inbox);
  await handle.result();

  assert.equal((await handle.read()).state, "completed");
});

test("coordinator disconnection alone leaves the Start gate waiting", async () => {
  const { runtime, handle } = await fixture();
  await runtime.startAuthorizationInbox("credential");

  assert.equal((await handle.read()).startAuthorization.gate, "waiting");
});

test("the authorization decision is persisted before Worker execution begins", async () => {
  const { inbox, trace } = await fixture();
  await authorize(inbox);

  assert.equal(
    trace.findIndex((entry) => entry.includes("start_authorization_decided")) <
      trace.indexOf("worker-protocol:receive-result"),
    true,
  );
});

test("a retained and verified Review subject can pass both Start checks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-start-review-"));
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const artifactServices = runtimeArtifactStore(root, store, () => new Date("2026-09-06T10:00:00.000Z"));
  context.after(async () => {
    await artifactServices.artifacts.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from("review input", "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  await artifactServices.artifacts.startRegistration(artifactServices.credential, {
    registrationId: "review-registration-1",
    expectedByteCount: bytes.byteLength,
    expectedDigest: digest,
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
    dependencies: [],
    deadline: "2026-09-06T10:01:00.000Z",
    recoveryBudget: 1,
  });
  const registration = await artifactServices.artifacts.transfer(
    artifactServices.credential,
    "review-registration-1",
    bytes,
  );
  if (registration.kind !== "registered") throw new Error("Review subject registration failed");
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
    artifacts: artifactServices.artifacts,
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
        review: profile({
          policy: "required",
          windowMs: 60_000,
          authorizedSubjectIds: ["reviewer-1"],
          receipt: {
            ...receipt,
            reviewSubjectVerification: "required",
            reviewSubject: {
              artifactId: registration.artifact.artifactId,
              byteCount: registration.artifact.byteCount,
              digest: registration.artifact.digest,
              format: registration.artifact.formatId,
              normalization: registration.artifact.normalizationId,
            },
          },
        }),
      },
    },
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "review",
    idempotencyKey: "task-1",
  });
  await handle.waitForStartupReceipt();
  await authorize(await runtime.startAuthorizationInbox("credential"));
  const delivery = (await handle.read()).startInstructionDelivery;
  await handle.result().catch(() => undefined);

  assert.equal(delivery?.authorizationDecisionId, "decision-1");
});

test("an unverifiable Review subject prevents authorization publication", async () => {
  const { handle } = await fixture({
    policy: {
      policy: "required",
      windowMs: 60_000,
      authorizedSubjectIds: ["reviewer-1"],
      receipt: { ...receipt, reviewSubjectVerification: "required" },
    },
  });

  assert.equal(await handle.waitForStartupReceipt(), undefined);
});

test("an optional policy resolved as disabled keeps automatic start", async () => {
  const { handle } = await fixture({
    policy: { policy: "optional", resolution: "disabled" },
  });
  await handle.result();

  assert.equal((await handle.read()).startAuthorization.timing.policy, "disabled");
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

  assert.equal((await handle.read()).startAuthorization.timing.policy, "required");
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

  assert.equal((await handle.waitForStartupReceipt())?.authorizationPolicy, "required");
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

  assert.equal(outcome.status === "rejected" ? outcome.reason : "accepted", "fixed_scope_denied");
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

  assert.equal(outcome.status === "rejected" ? outcome.reason : "accepted", "current_authority_denied");
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

  assert.equal(outcome.status === "rejected" ? outcome.reason : "accepted", "authority_revoked");
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

  assert.equal(outcome.status === "rejected" ? outcome.reason : "accepted", "authority_unknown");
});

test("a deadline crossed during pre-begin checks keeps the Worker stopped", async () => {
  const { inbox, handle } = await fixture({
    beforeCurrentAuthorization: (callNumber, clock) => {
      if (callNumber === 3) clock.advanceBy(60_000);
    },
  });
  await authorize(inbox);
  await handle.result().catch(() => undefined);

  assert.equal((await handle.read()).failureReason, "start_authorization_timed_out");
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

  assert.equal(outcome.status === "rejected" ? outcome.reason : "accepted", "decision_id_conflict");
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

  assert.equal((await handle.read()).startAuthorization.rejectedDecisions[0]?.reason, "decision_id_conflict");
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

test("an unproven stop after rejection leaves the Operation unknown", async () => {
  const { inbox, handle } = await fixture({ worker: new UnprovenStopWorkerAdapter() });
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

test("an elapsed authorization deadline fails with the fixed reason", async () => {
  const { clock, handle } = await fixture();
  clock.advanceBy(60_000);
  await handle.result().catch(() => undefined);

  assert.equal((await handle.read()).failureReason, "start_authorization_timed_out");
});
