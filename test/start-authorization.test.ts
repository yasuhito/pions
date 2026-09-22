import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/event-store/index.js";
import { makeResultFormatRegistry } from "../src/internal/result-format-registry.js";
import { makeSingleRunWorker } from "../src/internal/services.js";
import { OperationFailedError, RuntimeClosedError } from "../src/index.js";
import type {
  Worker,
  WorkerCancellationEvidence,
  WorkerRunHooks,
} from "../src/internal/services.js";
import { DEFAULT_MAX_RESULT_BYTE_COUNT } from "../src/internal/worker-configuration.js";
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

const resultFormats = makeResultFormatRegistry([
  {
    formatId: "test.formal-review-result",
    version: "1",
    normalizationId: "identity.v1",
    validator: {
      validatorId: "test.formal-review-result-validator",
      validatorVersion: "1",
      implementation: Buffer.from("test validator v1", "utf8"),
      validate: async () => ({ kind: "valid" }),
    },
  },
]);
const formalReviewResultFormat = resultFormats.pin({
  formatId: "test.formal-review-result",
  version: "1",
  expectations: { axis: "standards" },
});

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
  reviewSubjectId: "subject-1",
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
    maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
  };
}

async function formalReviewAdmissionFixture(
  _context: TestContext,
  options: {
    readonly reviewSubjectVerification?: "disabled" | "required";
    readonly resultFormatConfigured?: boolean;
  } = {}
) {
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const worker = new OpenCountingWorkerAdapter();
  const presentation = new FakePresentation();
  const runtime = makeTestRuntime({
    worker,
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation,
    store,
    ...(options.resultFormatConfigured === false
      ? {}
      : {
          formalReviewResultFormats: {
            registry: resultFormats,
            resultFormat: formalReviewResultFormat,
          },
        }),
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
    reviewSubjectId: "subject-1",
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
    (await handle.waitForStartupReceipt())?.reviewSubjectId,
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

test("a formal review without a trusted Result validator is rejected before Worker creation", async (context) => {
  const { runtime, reviewSubjectId } = await formalReviewAdmissionFixture(
    context,
    {
      resultFormatConfigured: false,
    }
  );

  await assert.rejects(
    runtime.spawn(
      {
        promptRef: "private://prompt/review",
        profile: "review",
        idempotencyKey: "review-without-result-validator",
      },
      { reviewSubjectId }
    ),
    { name: "WorkerConfigurationError", reason: "unsupported_capability" }
  );
});

test("a formal review Operation fixes its Review subject identifier", async (context) => {
  const { runtime, reviewSubjectId } =
    await formalReviewAdmissionFixture(context);
  const handle = await runtime.spawn(
    {
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    },
    { reviewSubjectId }
  );

  assert.equal(
    (await handle.waitForStartupReceipt())?.reviewSubjectId,
    reviewSubjectId
  );
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

  assert.equal(presentation.createdWorkspaceIds.length, 0);
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

test("an incomplete formal reviewer profile does not create a Workspace", async (context) => {
  const { runtime, reviewSubjectId, presentation } =
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
      { reviewSubjectId }
    )
    .catch(() => undefined);

  assert.equal(presentation.createdWorkspaceIds.length, 0);
});

test("an incomplete formal reviewer profile does not create a Worker", async (context) => {
  const { runtime, reviewSubjectId, worker } =
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
      { reviewSubjectId }
    )
    .catch(() => undefined);

  assert.equal(worker.openCount, 0);
});

test("a formal review Operation keeps its Review subject after creation", async (context) => {
  const { runtime, reviewSubjectId } =
    await formalReviewAdmissionFixture(context);
  const options = { reviewSubjectId };
  const handle = await runtime.spawn(
    {
      promptRef: "private://prompt/1",
      profile: "review",
      idempotencyKey: "task-1",
    },
    options
  );
  options.reviewSubjectId = "another-subject";

  assert.equal(
    (await handle.waitForStartupReceipt())?.reviewSubjectId,
    reviewSubjectId
  );
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

test("an expired Start authorization retains its owned workspace", async () => {
  const { inbox, handle, presentation } = await fixture({
    beforeCurrentAuthorization: (callNumber, clock) => {
      if (callNumber === 3) clock.advanceBy(60_000);
    },
  });
  await authorize(inbox);
  await handle.result().catch(() => undefined);

  assert.deepEqual(presentation.closedWorkspaceIds, []);
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
  // The first Runtime models a Pi process that died mid-flight. A crash never
  // closes, and close() would wait for the stalled Worker to settle.
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

test("an invalidated Start authorization retains its owned workspace", async () => {
  const { inbox, presentation } = await fixture({
    currentAuthority: (callNumber) =>
      callNumber < 4 ? "authorized" : "denied",
  });
  await authorize(inbox);

  assert.deepEqual(presentation.closedWorkspaceIds, []);
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

test("a rejected Start decision retains its owned workspace", async () => {
  const { inbox, handle, presentation } = await fixture();
  const startupReceipt = await handle.waitForStartupReceipt();
  await inbox.decide({
    operationId: handle.operationId,
    decisionId: "decision-1",
    kind: "reject",
    receiptDigest: startupReceipt!.digest,
  });
  await handle.result().catch(() => undefined);

  assert.deepEqual(presentation.closedWorkspaceIds, []);
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

class PersistedOperationStore extends InMemoryEventStore {
  operationIds(): Promise<ReadonlyArray<string>> {
    return this.listOperationIds();
  }
}

const lateTask = {
  promptRef: "private://late",
  profile: "coding",
  idempotencyKey: "late",
} as const;

async function closeOrderingFixture(
  _context: TestContext,
  worker: FakeWorkerAdapter = new FakeWorkerAdapter()
) {
  const events: Array<string> = [];
  const clock = new FakeClock(timestamps);
  const store = new PersistedOperationStore([], clock);
  const { runtime, handle, inbox } = await fixture({
    worker,
    store,
    clock,
  });
  void handle.result().then(
    () => events.push("execution:settled"),
    () => events.push("execution:settled")
  );
  const orderOf = (...names: ReadonlyArray<string>) =>
    events.filter((event) => names.includes(event));
  return { runtime, handle, inbox, store, events, orderOf };
}

async function stalledAfterStartGate(context: TestContext) {
  const worker = new PausedStartAcceptanceWorker();
  const ordering = await closeOrderingFixture(context, worker);
  await authorize(ordering.inbox);
  while ((await ordering.handle.read()).startDeliveryEntry === undefined) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const closing = ordering.runtime.close();
  void closing.then(() => ordering.events.push("runtime:closed"));
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return {
    ...ordering,
    closing,
    release() {
      ordering.events.push("worker:released");
      worker.acknowledgeStart();
    },
  };
}

test("an authorized execution whose Worker never acknowledges Start expires at the deadline", async () => {
  const { clock, inbox, handle } = await fixture({
    worker: new PausedStartAcceptanceWorker(),
  });
  await authorize(inbox);
  while ((await handle.read()).startDeliveryEntry === undefined) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  clock.advanceBy(60_000);
  for (let tick = 0; tick < 50; tick += 1) {
    if ((await handle.read()).state === "failed") break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(
    (await handle.read()).failureReason,
    "start_authorization_timed_out"
  );
});

test("Runtime close settles an execution waiting at the Start gate", async (context) => {
  const { runtime, orderOf } = await closeOrderingFixture(context);
  await runtime.close();

  assert.deepEqual(orderOf("execution:settled"), ["execution:settled"]);
});

test("Runtime close remains pending while an authorized execution is still running", async (context) => {
  const stalled = await stalledAfterStartGate(context);
  const closedBeforeRelease = stalled.events.includes("runtime:closed");
  stalled.release();
  await stalled.closing;

  assert.equal(closedBeforeRelease, false);
});

test("Runtime close completes only after a running execution settles", async (context) => {
  const stalled = await stalledAfterStartGate(context);
  stalled.release();
  await stalled.closing;

  assert.deepEqual(
    stalled.orderOf("worker:released", "execution:settled", "runtime:closed"),
    ["worker:released", "execution:settled", "runtime:closed"]
  );
});

test("Runtime close rejects a later spawn without persisting an Operation", async (context) => {
  const { runtime, store } = await closeOrderingFixture(context);
  await runtime.close();

  const rejection = await runtime.spawn(lateTask).then(
    () => undefined,
    (error: unknown) => error
  );
  assert.deepEqual(
    {
      rejectedAsClosed: rejection instanceof RuntimeClosedError,
      operationIds: await store.operationIds(),
    },
    { rejectedAsClosed: true, operationIds: ["operation-1"] }
  );
});

test("Runtime close rejects a spawn issued while an in-flight execution is still draining", async (context) => {
  const stalled = await stalledAfterStartGate(context);
  const late = stalled.runtime.spawn(lateTask).then(
    () => undefined,
    (error: unknown) => error
  );
  stalled.release();
  await stalled.closing;

  assert.deepEqual(
    {
      rejectedAsClosed: (await late) instanceof RuntimeClosedError,
      operationIds: await stalled.store.operationIds(),
    },
    { rejectedAsClosed: true, operationIds: ["operation-1"] }
  );
});

test("Runtime close completes after a failing execution settles", async (context) => {
  const ordering = await closeOrderingFixture(
    context,
    new FakeWorkerAdapter({ failure: "agent_failed" })
  );
  await authorize(ordering.inbox);
  const closing = ordering.runtime.close();
  const rejection = await ordering.handle.result().then(
    () => undefined,
    (error: unknown) => error
  );
  await closing;

  assert.deepEqual(
    {
      failed: rejection instanceof OperationFailedError,
      order: ordering.orderOf("execution:settled"),
    },
    { failed: true, order: ["execution:settled"] }
  );
});
