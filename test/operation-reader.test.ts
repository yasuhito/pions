import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Effect } from "effect";

import {
  operationDirectoryKey,
  PrivateFileEventStore,
} from "../src/internal/event-store/index.js";
import type { EventStore } from "../src/internal/event-store/index.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  InMemoryEventStore,
  makeTestRuntime,
} from "../src/internal/testing.js";
import { retentionPolicy, workProductRequirements } from "./worker-protocol-fixtures.js";

const timestamps = Array.from({ length: 40 }, (_, index) =>
  `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`,
);

function fixture(options: {
  readonly paneClosureFails?: boolean;
  readonly authenticator?: {
    authenticate(credential: string): Promise<{
      readonly subjectId: string;
      canAuthorize(operationId: string): Promise<boolean>;
    }>;
  };
} = {}) {
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({ successfulExitConfirmed: true }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(options.paneClosureFails === undefined
      ? {}
      : { paneClosureFails: options.paneClosureFails }),
    store,
    ...(options.authenticator === undefined
      ? {}
      : { startAuthorizationAuthenticator: options.authenticator }),
  });
  return { runtime, store };
}

async function recordWaitingOperation(
  store: EventStore,
  operationId: string,
  options: {
    readonly extraReceiptFields?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<void> {
  const created = await Effect.runPromise(store.create({
    operationId,
    task: { promptRef: "private://prompt", profile: "coding", idempotencyKey: operationId },
    requestedConfig: {},
    effectiveConfig: {
      model: { provider: "fake", id: "model" },
      thinkingLevel: "high",
      tools: ["read"],
      cwd: "/work",
      modelPolicy: {
        candidates: [{ provider: "fake", id: "model" }],
        attempted: [{ provider: "fake", id: "model" }],
        maxAttempts: 1,
        fallback: "forbidden",
        aliases: [],
      },
    },
    workProductRequirements,
    resultRetentionPolicy: retentionPolicy(operationId),
    lineage: { rootOperationId: operationId, depth: 0 },
    authorizationWindowMs: 60_000,
  }));
  await Effect.runPromise(store.advance(operationId, {
    type: "presentation_owned",
    presentation: { kind: "herdr_pane", paneId: "pane", ownedByPions: true },
  }));
  await Effect.runPromise(store.advance(operationId, { type: "operation_starting" }));
  await Effect.runPromise(store.advance(operationId, { type: "worker_launched" }));
  const identified = await Effect.runPromise(store.advance(operationId, {
    type: "worker_identified",
    workerIdentity: {
      processId: 1234,
      processInstanceId: `process:${operationId}`,
      processStartToken: `start:${operationId}`,
      piSessionId: `session:${operationId}`,
      paneId: "pane",
    },
    observedConfig: {
      model: { state: "observed", value: { provider: "fake", id: "model" } },
      thinkingLevel: { state: "observed", value: "high" },
      tools: { state: "observed", value: ["read"] },
      cwd: { state: "observed", value: "/work" },
    },
  }));
  const operation = identified.operation;
  const receipt = {
    operationId,
    workerIdentity: operation.workerIdentity!,
    requestedConfig: operation.requestedConfig,
    effectiveConfig: operation.effectiveConfig,
    observedConfig: operation.observedConfig!,
    workspace: {
      workspaceId: `workspace:${operationId}`,
      normalizedPath: `/work/${operationId}`,
      baseRevision: "a".repeat(40),
      owner: { state: "known" as const, ownerId: "launcher-1" },
      pionsMayDelete: false as const,
    },
    permissionManifest: {
      manifestId: `manifest:${operationId}`,
      digest: `sha256:${"cd".repeat(32)}` as const,
    },
    reviewSubject: {
      artifactId: `artifact:${operationId}`,
      byteCount: 10,
      digest: `sha256:${"ef".repeat(32)}` as const,
      format: "text/plain",
      normalization: "utf8",
    },
    configuredAuthorizationPolicy: "required" as const,
    authorizationPolicy: "required" as const,
    authorizationDeadline: created.operation.startAuthorizationTiming.deadline,
  };
  await Effect.runPromise(store.advance(operationId, {
    type: "startup_receipt_recorded",
    gate: "waiting",
    receipt: { ...receipt, ...options.extraReceiptFields },
  }));
}

test("OperationHandle reads the fixed creation timing", async () => {
  const handle = await fixture().runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.deepEqual((await handle.read()).startAuthorization.timing, {
    createdAt: "2026-09-06T10:00:00.000Z",
    windowMs: 0,
    deadline: "2026-09-06T10:00:00.000Z",
  });
});

test("Operation snapshot identifies one coherent persisted version", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.deepEqual((await handle.read()).version, {
    sequenceNumber: 12,
    recordedAt: "2026-09-06T10:00:12.000Z",
  });
});

test("Operation lookup returns integrity evidence after its handle is lost", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal(
    ((await (await runtime.operation(handle.operationId)).read()).resultAcceptance?.eventSequenceNumber ?? 0) > 0,
    true,
  );
});

test("Operation lookup reconstructs a snapshot after the persistent store is reopened", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-operation-reader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstClock = new FakeClock(timestamps);
  const first = makeTestRuntime({
    worker: new FakeWorkerAdapter({ successfulExitConfirmed: true }),
    clock: firstClock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new PrivateFileEventStore(root, firstClock),
  });
  const handle = await first.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const reopenedClock = new FakeClock(timestamps);
  const reopened = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock: reopenedClock,
    ids: new FakeIdGenerator([]),
    presentation: new FakePresentation(),
    store: new PrivateFileEventStore(root, reopenedClock),
  });

  assert.equal((await (await reopened.operation("operation-1")).read()).state, "completed");
});

test("Operation snapshot retrieves start instruction acceptance separately", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1");
  const receiptDigest = (await Effect.runPromise(store.read("operation-1")))
    .operation.startupReceipt!.digest;
  await Effect.runPromise(store.advance("operation-1", {
    type: "start_authorization_decided",
    gate: "authorized",
    decision: {
      decisionId: "decision-1",
      kind: "authorize",
      actorId: "reviewer-1",
      receiptDigest,
    },
  }));
  const instruction = {
    workerProcessInstanceId: "process:operation-1",
    receiptDigest,
    authorizationDecisionId: "decision-1",
    deliveryGeneration: 1,
  };
  await Effect.runPromise(store.advance("operation-1", {
    type: "start_instruction_dispatched",
    instruction,
  }));
  await Effect.runPromise(store.advance("operation-1", {
    type: "start_instruction_accepted",
    instruction,
    proof: "authenticated-worker-acknowledgement",
  }));

  assert.equal(
    (await (await runtime.operation("operation-1")).read()).startInstructionAcceptance?.acceptedAt,
    "2026-09-06T10:00:08.000Z",
  );
});

test("Operation snapshot retrieves Result acceptance separately", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal((await handle.read()).resultAcceptance?.acceptanceId.startsWith("pions.result-acceptance.v1:"), true);
});

test("Operation snapshot retrieves stop confirmation separately", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal((await handle.read()).stopConfirmation?.proof, "worker-stop");
});

test("Operation snapshot retrieves cleanup diagnostics independently", async () => {
  const { runtime } = fixture({ paneClosureFails: true });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.deepEqual((await handle.read()).cleanupDiagnostics, [{ code: "pane_close_failed" }]);
});

test("persisted Startup receipt omits authentication secrets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-receipt-secret-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new PrivateFileEventStore(root, new FakeClock(timestamps));
  await recordWaitingOperation(store, "operation-1", {
    extraReceiptFields: { capability: "worker-secret" },
  });
  const record = await readFile(
    join(root, operationDirectoryKey("operation-1"), "events.v13.json"),
    "utf8",
  );

  assert.doesNotMatch(record, /worker-secret/);
});

test("Startup receipt omits other Operation authority", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1", {
    extraReceiptFields: { authority: { operationId: "other-operation" } },
  });
  const receipt = JSON.stringify(
    (await (await runtime.operation("operation-1")).read()).startAuthorization.receipt,
  );

  assert.doesNotMatch(receipt, /other-operation/);
});

test("OperationReader waits for a Startup receipt through its read capability", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1");
  const reader = await runtime.operation("operation-1");

  assert.equal((await reader.waitForStartupReceipt())?.operationId, "operation-1");
});

test("Operation lookup returns a persisted start authorization decision", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1");
  const receiptDigest = (await Effect.runPromise(store.read("operation-1")))
    .operation.startupReceipt!.digest;
  const decision = {
    decisionId: "decision-1",
    kind: "authorize" as const,
    actorId: "reviewer-1",
    receiptDigest,
  };
  await Effect.runPromise(store.advance("operation-1", {
    type: "start_authorization_decided",
    gate: "authorized",
    decision,
  }));

  assert.deepEqual(
    (await (await runtime.operation("operation-1")).read()).startAuthorization.decision,
    { ...decision, decidedAt: "2026-09-06T10:00:06.000Z" },
  );
});

test("an authenticated subject can recover its waiting Operations from persistent records", async () => {
  const { runtime, store } = fixture({
    authenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        canAuthorize: async (operationId) => operationId === "allowed",
      }),
    },
  });
  await recordWaitingOperation(store, "allowed");
  await recordWaitingOperation(store, "other");
  const inbox = await runtime.startAuthorizationInbox("authenticated-credential");

  assert.deepEqual((await inbox.listWaiting()).map(({ operationId }) => operationId), ["allowed"]);
});

test("waiting Operation recovery returns its fixed deadline", async () => {
  const { runtime, store } = fixture({
    authenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        canAuthorize: async () => true,
      }),
    },
  });
  await recordWaitingOperation(store, "allowed");
  const inbox = await runtime.startAuthorizationInbox("authenticated-credential");

  assert.equal((await inbox.listWaiting())[0]?.deadline, "2026-09-06T10:01:00.000Z");
});
