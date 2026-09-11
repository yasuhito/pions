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
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  InMemoryEventStore,
  makeTestRuntime,
} from "../src/internal/testing.js";
import { ResultRetrievalError } from "../src/index.js";
import type {
  ArtifactFailureReason,
  ArtifactStore,
  OperationReader,
} from "../src/index.js";
import {
  retentionPolicy,
  workProductRequirements,
} from "./worker-protocol-fixtures.js";

const timestamps = Array.from(
  { length: 40 },
  (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
);

function fixture(
  options: {
    readonly paneClosureFails?: boolean;
    readonly paneInspection?: "matching" | "missing" | "unavailable";
    readonly authenticator?: {
      authenticate(credential: string): Promise<{
        readonly subjectId: string;
        currentAuthorization(
          operationId: string
        ): Promise<"authorized" | "denied" | "revoked" | "unknown">;
      }>;
    };
  } = {}
) {
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const presentation = new FakePresentation({
    ...(options.paneClosureFails === undefined
      ? {}
      : { paneClosureFails: options.paneClosureFails }),
    ...(options.paneInspection === undefined
      ? {}
      : { paneInspection: options.paneInspection }),
  });
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({ successfulExitConfirmed: true }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation,
    store,
    ...(options.authenticator === undefined
      ? {}
      : { startAuthorizationAuthenticator: options.authenticator }),
  });
  return { presentation, runtime, store };
}

async function recordWaitingOperation(
  store: EventStore,
  operationId: string,
  options: {
    readonly extraReceiptFields?: Readonly<Record<string, unknown>>;
  } = {}
): Promise<void> {
  const created = await Effect.runPromise(
    store.create({
      operationId,
      task: {
        promptRef: "private://prompt",
        profile: "coding",
        idempotencyKey: operationId,
      },
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
      startAuthorization: {
        configuredPolicy: "required",
        policy: "required",
        windowMs: 60_000,
        authorizedSubjectIds: ["reviewer-1"],
        receipt: {
          workspace: {
            workspaceId: `workspace:${operationId}`,
            normalizedPath: `/work/${operationId}`,
            baseRevision: "a".repeat(40),
            owner: { state: "known", ownerId: "launcher-1" },
            pionsMayDelete: false,
          },
          permissionManifest: {
            manifestId: `manifest:${operationId}`,
            digest: `sha256:${"cd".repeat(32)}`,
          },
          reviewSubject: {
            artifactId: `artifact:${operationId}`,
            byteCount: 10,
            digest: `sha256:${"ef".repeat(32)}`,
            format: "text/plain",
            normalization: "utf8",
          },
          reviewSubjectVerification: "disabled",
        },
      },
    })
  );
  await Effect.runPromise(
    store.advance(operationId, {
      type: "presentation_owned",
      presentation: { kind: "herdr_pane", paneId: "pane", ownedByPions: true },
    })
  );
  await Effect.runPromise(
    store.advance(operationId, { type: "operation_starting" })
  );
  await Effect.runPromise(
    store.advance(operationId, { type: "worker_launched" })
  );
  const identified = await Effect.runPromise(
    store.advance(operationId, {
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
    })
  );
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
    reviewSubjectVerification: "disabled" as const,
    configuredAuthorizationPolicy: "required" as const,
    authorizationPolicy: "required" as const,
    authorizationDeadline: created.operation.startAuthorizationTiming.deadline,
  };
  await Effect.runPromise(
    store.advance(operationId, {
      type: "startup_receipt_recorded",
      gate: "waiting",
      receipt: { ...receipt, ...options.extraReceiptFields },
    })
  );
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
    configuredPolicy: "disabled",
    policy: "disabled",
    authorizedSubjectIds: [],
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
    sequenceNumber: 18,
    recordedAt: "2026-09-06T10:00:18.000Z",
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
    ((await (await runtime.operation(handle.operationId)).read())
      .resultAcceptance?.eventSequenceNumber ?? 0) > 0,
    true
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

  assert.equal(
    (await (await reopened.operation("operation-1")).read()).state,
    "completed"
  );
});

test("Operation snapshot retrieves start instruction acceptance separately", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1");
  const receiptDigest = (await Effect.runPromise(store.read("operation-1")))
    .operation.startupReceipt!.digest;
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "start_authorization_decided",
      gate: "authorized",
      decision: {
        decisionId: "decision-1",
        kind: "authorize",
        actorId: "reviewer-1",
        receiptDigest,
        decidedAt: "2026-09-06T10:00:06.000Z",
      },
    })
  );
  const instruction = {
    dispatcherId: "pions-runtime",
    workerProcessInstanceId: "process:operation-1",
    receiptDigest,
    authorizationDecisionId: "decision-1",
    deliveryGeneration: 1,
  };
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "start_delivery_authority_acquired",
      instruction,
    })
  );
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "start_delivery_entered",
      instruction,
    })
  );
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "start_instruction_dispatched",
      instruction,
    })
  );
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "start_instruction_accepted",
      instruction,
      proof: "worker-durable-acceptance",
    })
  );
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "start_instruction_acknowledged",
      instruction,
      proof: "authenticated-worker-acknowledgement",
    })
  );

  assert.equal(
    (await (await runtime.operation("operation-1")).read())
      .startInstructionAcceptance?.acceptedAt,
    "2026-09-06T10:00:09.000Z"
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

  assert.equal(
    (await handle.read()).resultAcceptance?.acceptanceId.startsWith(
      "pions.result-acceptance.v1:"
    ),
    true
  );
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

test("Operation snapshot retrieves completed Presentation cleanup evidence", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal((await handle.read()).presentationCleanup?.state, "completed");
});

test("Operation snapshot retrieves cleanup diagnostics independently", async () => {
  const { runtime } = fixture({ paneClosureFails: true });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.deepEqual((await handle.read()).cleanupDiagnostics, [
    { code: "pane_close_failed" },
  ]);
});

test("a missing pane identity is retained as an unconfirmed cleanup", async () => {
  const { runtime } = fixture({ paneInspection: "missing" });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal((await handle.read()).presentationCleanup?.state, "unconfirmed");
});

test("an unavailable pane identity is reported independently from Result acceptance", async () => {
  const { runtime } = fixture({ paneInspection: "unavailable" });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.deepEqual((await handle.read()).cleanupDiagnostics, [
    { code: "pane_identity_unavailable" },
  ]);
});

test("persisted Startup receipt omits authentication secrets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-receipt-secret-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new PrivateFileEventStore(root, new FakeClock(timestamps));
  await recordWaitingOperation(store, "operation-1", {
    extraReceiptFields: { capability: "worker-secret" },
  });
  const record = await readFile(
    join(root, operationDirectoryKey("operation-1"), "events.v19.json"),
    "utf8"
  );

  assert.doesNotMatch(record, /worker-secret/);
});

test("Startup receipt omits other Operation authority", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1", {
    extraReceiptFields: { authority: { operationId: "other-operation" } },
  });
  const receipt = JSON.stringify(
    (await (await runtime.operation("operation-1")).read()).startAuthorization
      .receipt
  );

  assert.doesNotMatch(receipt, /other-operation/);
});

test("OperationReader waits for a Startup receipt through its read capability", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1");
  const reader = await runtime.operation("operation-1");

  assert.equal(
    (await reader.waitForStartupReceipt())?.operationId,
    "operation-1"
  );
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
    decidedAt: "2026-09-06T10:00:06.000Z",
  };
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "start_authorization_decided",
      gate: "authorized",
      decision,
    })
  );

  assert.deepEqual(
    (await (await runtime.operation("operation-1")).read()).startAuthorization
      .decision,
    { ...decision, decidedAt: "2026-09-06T10:00:06.000Z" }
  );
});

test("an authenticated subject can recover its waiting Operations from persistent records", async () => {
  const { runtime, store } = fixture({
    authenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        currentAuthorization: async (operationId) =>
          operationId === "allowed" ? "authorized" : "denied",
      }),
    },
  });
  await recordWaitingOperation(store, "allowed");
  await recordWaitingOperation(store, "other");
  const inbox = await runtime.startAuthorizationInbox(
    "authenticated-credential"
  );

  assert.deepEqual(
    (await inbox.listWaiting()).map(({ operationId }) => operationId),
    ["allowed"]
  );
});

test("recovery expires the original deadline without extending it", async () => {
  const storeClock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], storeClock);
  await recordWaitingOperation(store, "operation-1");
  const recoveredClock = new FakeClock([
    "2026-09-06T10:02:00.000Z",
    "2026-09-06T10:02:01.000Z",
    "2026-09-06T10:02:02.000Z",
  ]);
  const recovered = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock: recoveredClock,
    ids: new FakeIdGenerator([]),
    presentation: new FakePresentation(),
    store,
    startAuthorizationAuthenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        currentAuthorization: async () => "authorized",
      }),
    },
  });
  await (await recovered.startAuthorizationInbox("credential")).listWaiting();

  assert.equal(
    (await (await recovered.operation("operation-1")).read()).state,
    "unknown"
  );
});

test("waiting Operation recovery returns its fixed deadline", async () => {
  const { runtime, store } = fixture({
    authenticator: {
      authenticate: async () => ({
        subjectId: "reviewer-1",
        currentAuthorization: async () => "authorized",
      }),
    },
  });
  await recordWaitingOperation(store, "allowed");
  const inbox = await runtime.startAuthorizationInbox(
    "authenticated-credential"
  );

  assert.equal(
    (await inbox.listWaiting())[0]?.deadline,
    "2026-09-06T10:01:00.000Z"
  );
});

test("OperationReader retrieves an accepted Result after its handle is lost", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal(
    (await (await runtime.operation(handle.operationId)).readResult()).kind,
    "retrieved"
  );
});

test("OperationReader returns the complete accepted Result body", async () => {
  const body = "先頭🌱末尾";
  const clock = new FakeClock(timestamps);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body },
      successfulExitConfirmed: true,
    }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore([], clock),
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const outcome = await handle.readResult();

  assert.equal(
    outcome.kind === "retrieved" ? outcome.result.body : undefined,
    body
  );
});

test("OperationReader returns the accepted Result byte count", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const outcome = await handle.readResult();

  assert.equal(
    outcome.kind === "retrieved" ? outcome.result.byteCount : -1,
    Buffer.byteLength("finished")
  );
});

test("result retrieval before acceptance returns the current snapshot version", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1");
  const reader = await runtime.operation("operation-1");
  const expected = (await reader.read()).version;
  const outcome = await reader.readResult();

  assert.deepEqual(
    outcome.kind === "not_accepted" ? outcome.version : undefined,
    expected
  );
});

test("result retrieval before acceptance returns the current Operation state", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1");
  const outcome = await (await runtime.operation("operation-1")).readResult();

  assert.equal(
    outcome.kind === "not_accepted" ? outcome.state : undefined,
    "starting"
  );
});

test("Operation snapshot exposes persisted Worker identity", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal(
    (await handle.read()).workerIdentity?.processInstanceId,
    "fake-process-instance"
  );
});

test("Operation snapshot exposes the fixed effective configuration", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal((await handle.read()).effectiveConfig.cwd, "/test/workspace");
});

test("Operation snapshot exposes persisted observed configuration", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.equal((await handle.read()).observedConfig?.model.state, "observed");
});

test("Operation snapshot exposes only bounded Worker execution evidence", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();

  assert.deepEqual((await handle.read()).workerExecutionEvidence, {
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: 0.33,
    },
    toolUses: [{ toolCallId: "fake-call", toolName: "read", isError: false }],
  });
});

test("ordered Result chunks concatenate to the complete Result", async () => {
  const body = "a🌱b🌍c";
  const clock = new FakeClock(timestamps);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body },
      successfulExitConfirmed: true,
    }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore([], clock),
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const parts: Array<string> = [];
  let cursor: string | undefined;
  do {
    const outcome = await handle.readResultChunk({
      maxBytes: 5,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (outcome.kind !== "retrieved")
      throw new Error("Result was not accepted");
    parts.push(outcome.chunk.body);
    cursor = outcome.chunk.nextCursor;
  } while (cursor !== undefined);

  assert.equal(parts.join(""), body);
});

test("the same result cursor returns the same chunk", async () => {
  const body = "abcdefghi";
  const clock = new FakeClock(timestamps);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body },
      successfulExitConfirmed: true,
    }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore([], clock),
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const first = await handle.readResultChunk({ maxBytes: 4 });
  if (first.kind !== "retrieved" || first.chunk.nextCursor === undefined)
    throw new Error("Missing cursor");
  const one = await handle.readResultChunk({
    maxBytes: 4,
    cursor: first.chunk.nextCursor,
  });
  const two = await handle.readResultChunk({
    maxBytes: 4,
    cursor: first.chunk.nextCursor,
  });

  assert.deepEqual(one, two);
});

test("a cursor from another Operation is rejected", async () => {
  const clock = new FakeClock(timestamps);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "abcdefghi" },
      successfulExitConfirmed: true,
    }),
    clock,
    ids: new FakeIdGenerator(["operation-1", "operation-2"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore([], clock),
  });
  const first = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  const second = await runtime.spawn({
    promptRef: "private://prompt/2",
    profile: "coding",
    idempotencyKey: "task-2",
  });
  await Promise.all([first.result(), second.result()]);
  const outcome = await first.readResultChunk({ maxBytes: 4 });
  if (outcome.kind !== "retrieved" || outcome.chunk.nextCursor === undefined)
    throw new Error("Missing cursor");

  await assert.rejects(
    second.readResultChunk({ maxBytes: 4, cursor: outcome.chunk.nextCursor }),
    { name: "ResultCursorError", reason: "wrong_operation" }
  );
});

test("a modified result cursor is rejected", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const outcome = await handle.readResultChunk({ maxBytes: 4 });
  if (outcome.kind !== "retrieved" || outcome.chunk.nextCursor === undefined)
    throw new Error("Missing cursor");
  const cursor = `${outcome.chunk.nextCursor.slice(0, -1)}x`;

  await assert.rejects(handle.readResultChunk({ maxBytes: 4, cursor }), {
    name: "ResultCursorError",
  });
});

async function retrievalFailureFixture(
  reason?: ArtifactFailureReason | "throw"
): Promise<{
  readonly reader: OperationReader;
  readonly retentionPinCount: () => number;
  readonly close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pions-result-retrieval-"));
  const clock = new FakeClock(timestamps);
  const store = new InMemoryEventStore([], clock);
  const artifactServices = runtimeArtifactStore(root, store);
  let fail = false;
  let retentionPinCount = 0;
  const artifacts: ArtifactStore = new Proxy(artifactServices.artifacts, {
    get(target, property) {
      if (property === "createRetentionPin") {
        return (...args: Parameters<ArtifactStore["createRetentionPin"]>) => {
          retentionPinCount += 1;
          return target.createRetentionPin(...args);
        };
      }
      if (property === "retrieve") {
        return async (...args: Parameters<ArtifactStore["retrieve"]>) => {
          if (fail) {
            if (reason === "throw") throw new Error("storage unavailable");
            return { kind: "failed", terminal: true, reason } as const;
          }
          return target.retrieve(...args);
        };
      }
      const value = target[property as keyof ArtifactStore];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({ successfulExitConfirmed: true }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
    artifacts,
    artifactCredential: artifactServices.credential,
    synchronizeArtifactClock: artifactServices.synchronizeClock,
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  fail = reason !== undefined;
  return {
    reader: await runtime.operation("operation-1"),
    retentionPinCount: () => retentionPinCount,
    close: async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("corrupt accepted Result storage has a typed retrieval reason", async (context) => {
  const value = await retrievalFailureFixture("stored_artifact_corrupt");
  context.after(value.close);

  await assert.rejects(
    value.reader.readResult(),
    (error) =>
      error instanceof ResultRetrievalError &&
      error.reason === "stored_artifact_corrupt"
  );
});

test("policy-deleted accepted Result storage is distinct from non-acceptance", async (context) => {
  const value = await retrievalFailureFixture("artifact_deleted");
  context.after(value.close);

  await assert.rejects(
    value.reader.readResult(),
    (error) =>
      error instanceof ResultRetrievalError &&
      error.reason === "artifact_deleted"
  );
});

test("revoked Result retrieval authority is distinct from non-acceptance", async (context) => {
  const value = await retrievalFailureFixture("authority_revoked");
  context.after(value.close);

  await assert.rejects(
    value.reader.readResult(),
    (error) =>
      error instanceof ResultRetrievalError &&
      error.reason === "authority_revoked"
  );
});

test("unavailable Result storage inspection is distinct from non-acceptance", async (context) => {
  const value = await retrievalFailureFixture("throw");
  context.after(value.close);

  await assert.rejects(
    value.reader.readResult(),
    (error) =>
      error instanceof ResultRetrievalError &&
      error.reason === "storage_inspection_unavailable"
  );
});

test("Result reads do not append Operation events", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const before = (await handle.read()).version;
  await handle.readResult();
  await handle.readResultChunk({ maxBytes: 4 });

  assert.deepEqual((await handle.read()).version, before);
});

async function reopenedResultFixture(): Promise<{
  readonly root: string;
  readonly reader: OperationReader;
  readonly cursor: string;
  readonly close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pions-reopened-result-"));
  const state = join(root, "runtime");
  const firstClock = new FakeClock(timestamps);
  const firstStore = new PrivateFileEventStore(state, firstClock);
  const firstArtifacts = runtimeArtifactStore(state, firstStore);
  const first = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body: "abcdefghi" },
      successfulExitConfirmed: true,
    }),
    clock: firstClock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: firstStore,
    artifacts: firstArtifacts.artifacts,
    artifactCredential: firstArtifacts.credential,
    synchronizeArtifactClock: firstArtifacts.synchronizeClock,
  });
  const handle = await first.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const firstChunk = await handle.readResultChunk({ maxBytes: 4 });
  if (
    firstChunk.kind !== "retrieved" ||
    firstChunk.chunk.nextCursor === undefined
  )
    throw new Error("Missing cursor");
  await first.close();

  const reopenedClock = new FakeClock(timestamps);
  const reopenedStore = new PrivateFileEventStore(state, reopenedClock);
  const reopenedArtifacts = runtimeArtifactStore(state, reopenedStore);
  const reopened = makeTestRuntime({
    worker: new FakeWorkerAdapter(),
    clock: reopenedClock,
    ids: new FakeIdGenerator([]),
    presentation: new FakePresentation(),
    store: reopenedStore,
    artifacts: reopenedArtifacts.artifacts,
    artifactCredential: reopenedArtifacts.credential,
    synchronizeArtifactClock: reopenedArtifacts.synchronizeClock,
  });
  return {
    root,
    reader: await reopened.operation("operation-1"),
    cursor: firstChunk.chunk.nextCursor,
    close: async () => {
      await reopened.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a reopened Runtime retrieves the same complete Result", async (context) => {
  const value = await reopenedResultFixture();
  context.after(value.close);
  const outcome = await value.reader.readResult();

  assert.equal(
    outcome.kind === "retrieved" ? outcome.result.body : undefined,
    "abcdefghi"
  );
});

test("a result cursor returns the same chunk after Runtime restart", async (context) => {
  const value = await reopenedResultFixture();
  context.after(value.close);

  assert.equal(
    (await value.reader.readResultChunk({ maxBytes: 4, cursor: value.cursor }))
      .kind === "retrieved"
      ? (
          (await value.reader.readResultChunk({
            maxBytes: 4,
            cursor: value.cursor,
          })) as { kind: "retrieved"; chunk: { body: string } }
        ).chunk.body
      : undefined,
    "efgh"
  );
});

test("the complete retrieved Result preserves its verified digest", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  const completion = await handle.result();
  const outcome = await handle.readResult();

  assert.equal(
    outcome.kind === "retrieved" ? outcome.result.digest : undefined,
    completion.result.digest
  );
});

test("each Result chunk respects the requested byte maximum", async () => {
  const { runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const outcome = await handle.readResultChunk({ maxBytes: 4 });

  assert.ok(
    outcome.kind === "retrieved" && Buffer.byteLength(outcome.chunk.body) <= 4
  );
});

test("an invalid cursor is rejected even when the target Result is not accepted", async () => {
  const { runtime, store } = fixture();
  await recordWaitingOperation(store, "operation-1");

  await assert.rejects(
    (await runtime.operation("operation-1")).readResultChunk({
      maxBytes: 4,
      cursor: "modified",
    }),
    { name: "ResultCursorError" }
  );
});

test("Result reads do not repeat Presentation cleanup", async () => {
  const { presentation, runtime } = fixture();
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const before = presentation.closedPaneIds.length;
  await handle.readResult();
  await handle.readResultChunk({ maxBytes: 4 });

  assert.equal(presentation.closedPaneIds.length, before);
});

test("complete Result retrieval does not add retention pins", async (context) => {
  const value = await retrievalFailureFixture();
  context.after(value.close);
  const before = value.retentionPinCount();
  await value.reader.readResult();

  assert.equal(value.retentionPinCount(), before);
});

test("chunked Result retrieval does not add retention pins", async (context) => {
  const value = await retrievalFailureFixture();
  context.after(value.close);
  const before = value.retentionPinCount();
  await value.reader.readResultChunk({ maxBytes: 4 });

  assert.equal(value.retentionPinCount(), before);
});

test("a corrupt complete artifact prevents returning a Result chunk", async (context) => {
  const value = await retrievalFailureFixture("stored_artifact_corrupt");
  context.after(value.close);

  await assert.rejects(
    value.reader.readResultChunk({ maxBytes: 4 }),
    (error) =>
      error instanceof ResultRetrievalError &&
      error.reason === "stored_artifact_corrupt"
  );
});

test("every Result chunk is valid UTF-8", async () => {
  const body = "a🌱b🌍c";
  const clock = new FakeClock(timestamps);
  const runtime = makeTestRuntime({
    worker: new FakeWorkerAdapter({
      messages: { body },
      successfulExitConfirmed: true,
    }),
    clock,
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore([], clock),
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt/1",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result();
  const chunks: Array<string> = [];
  let cursor: string | undefined;
  do {
    const outcome = await handle.readResultChunk({
      maxBytes: 5,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (outcome.kind !== "retrieved")
      throw new Error("Result was not accepted");
    chunks.push(outcome.chunk.body);
    cursor = outcome.chunk.nextCursor;
  } while (cursor !== undefined);

  assert.ok(
    chunks.every(
      (chunk) => Buffer.from(chunk, "utf8").toString("utf8") === chunk
    )
  );
});
