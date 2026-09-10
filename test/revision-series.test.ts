import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import type { Operation, OperationEvent } from "../src/internal/event-store/index.js";
import type { Worker, WorkerAdapter } from "../src/internal/services.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  InMemoryEventStore,
  makeTestRuntime,
} from "../src/internal/testing.js";
import type { RevisionAuthenticator, Runtime } from "../src/index.js";

class InterruptiblePresentation extends FakePresentation {
  failPreflight = false;

  override preflight(): Effect.Effect<void> {
    return this.failPreflight ? Effect.die(new Error("injected preflight interruption")) : Effect.void;
  }
}

class ClearanceFaultStore extends InMemoryEventStore {
  failClearance = false;

  protected override willAppend(event: OperationEvent): void {
    if (this.failClearance && event.type === "retry_clearance_recorded") {
      throw new Error("injected Retry clearance persistence failure");
    }
  }
}

class SequencedWorkerAdapter implements WorkerAdapter {
  private index = 0;

  constructor(private readonly failures: ReadonlyArray<"success" | "process-exited-without-result" | "liveness-unproven">) {}

  open(operation: Operation): Worker {
    const failure = this.failures[this.index++] ?? "success";
    return new FakeWorkerAdapter(
      failure === "success" ? { successfulExitConfirmed: true } : { failure }
    ).open(operation);
  }

  recover(operation: Operation): Worker {
    return this.open(operation);
  }
}

function authenticator(authority: () => "authorized" | "revoked" = () => "authorized"): RevisionAuthenticator {
  return {
    authenticate: async () => ({
      subjectId: "coordinator-1",
      fixedArtifactAcceptanceSubjectIds: async () => ["coordinator-1"],
      currentArtifactAcceptanceAuthority: async () => authority(),
    }),
  };
}

async function fixture(failures: ReadonlyArray<"success" | "process-exited-without-result" | "liveness-unproven"> = ["success", "success", "success"]) {
  const clock = new FakeClock(Array.from({ length: 120 }, (_, index) =>
    new Date(Date.parse("2026-09-06T10:00:00.000Z") + index * 1_000).toISOString(),
  ));
  const store = new InMemoryEventStore([], clock);
  const runtime = makeTestRuntime({
    worker: new SequencedWorkerAdapter(failures),
    clock,
    ids: new FakeIdGenerator(["original", "revision-1", "retry-1", "unused"]),
    presentation: new FakePresentation(),
    store,
    revisionAuthenticator: authenticator(),
    retryClearanceVerifier: { verify: async () => true },
  });
  const original = await runtime.spawn({
    promptRef: "private://original",
    profile: "coding",
    idempotencyKey: "original",
  });
  await original.result();
  const snapshot = await original.read();
  return { runtime, original, snapshot, store };
}

async function reserveFirst(runtime: Runtime, originalId: string, resultId: string, resultDigest: `sha256:${string}`) {
  const revisions = await runtime.revisions("credential");
  return revisions.reserveRevision({
    requestId: "revision-request-1",
    targetOperationId: originalId,
    targetResultId: resultId,
    targetResultDigest: resultDigest,
    reason: "レビュー指摘を反映する",
    maxAttempts: 3,
    task: {
      promptRef: "private://revision",
      profile: "coding",
      idempotencyKey: "revision-1",
    },
  });
}

async function waitForState(runtime: Runtime, operationId: string, expected: string): Promise<void> {
  let actual = "unread";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      actual = (await (await runtime.operation(operationId)).read()).state;
      if (actual === expected) return;
    } catch {
      actual = "not_found";
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Operation ${operationId} reached ${actual}, not ${expected}`);
}

test("Revision予約は元Resultと系列上限を結び付けて永続化する", async () => {
  const { runtime, original, snapshot } = await fixture();
  const outcome = await reserveFirst(
    runtime,
    original.operationId,
    snapshot.resultAcceptance!.acceptanceId,
    snapshot.resultAcceptance!.manifestDigest,
  );

  assert.equal(outcome.status === "reserved" ? outcome.reservation.seriesId : outcome.status, "pions.revision-series.v1:original");
});

test("同じRevision依頼の再送は同じ予約へ合流する", async () => {
  const { runtime, original, snapshot } = await fixture();
  await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);
  const repeated = await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);

  assert.equal(repeated.status, "idempotent");
});

test("同じRevision依頼IDの異なる内容は競合する", async () => {
  const { runtime, original, snapshot } = await fixture();
  await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);
  const revisions = await runtime.revisions("credential");
  const conflict = await revisions.reserveRevision({
    requestId: "revision-request-1",
    targetOperationId: original.operationId,
    targetResultId: snapshot.resultAcceptance!.acceptanceId,
    targetResultDigest: snapshot.resultAcceptance!.manifestDigest,
    reason: "異なる理由",
    maxAttempts: 3,
    task: { promptRef: "private://other", profile: "coding", idempotencyKey: "other" },
  });

  assert.deepEqual(conflict, { status: "rejected", reason: "request_conflict" });
});

test("unknownのRetryは安全証明なしでは予約しない", async () => {
  const { runtime, original, snapshot } = await fixture(["success", "liveness-unproven"]);
  const revision = await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);
  if (revision.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, revision.reservation.operationId, "unknown");
  const outcome = await (await runtime.revisions("credential")).reserveRetry({
    requestId: "retry-request-1",
    seriesId: revision.reservation.seriesId,
    failedOperationId: revision.reservation.operationId,
    reason: "状態不明から安全に再試行する",
    task: { promptRef: "private://retry", profile: "coding", idempotencyKey: "retry-1" },
  });

  assert.deepEqual(outcome, { status: "rejected", reason: "retry_clearance_required" });
});

test("Retry clearanceを永続化してからunknownのRetryを予約する", async () => {
  const { runtime, original, snapshot } = await fixture(["success", "liveness-unproven", "success"]);
  const revision = await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);
  if (revision.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, revision.reservation.operationId, "unknown");
  const outcome = await (await runtime.revisions("credential")).reserveRetry({
    requestId: "retry-request-1",
    seriesId: revision.reservation.seriesId,
    failedOperationId: revision.reservation.operationId,
    reason: "状態不明から安全に再試行する",
    clearance: {
      clearanceId: "clearance-1",
      failedOperationId: revision.reservation.operationId,
      affectedResourceIds: ["workspace:writer"],
      workerStoppedOrAccessBlocked: true,
      noConflict: true,
      handoffConfirmed: true,
      verifiedBy: "resource-adapter-1",
      verifiedAt: "2026-09-06T10:01:00.000Z",
    },
    task: { promptRef: "private://retry", profile: "coding", idempotencyKey: "retry-1" },
  });

  assert.equal(outcome.status === "reserved" ? outcome.reservation.retryClearanceId : outcome.status, "clearance-1");
});

test("系列全体の上限に達した後は次のRevisionを予約しない", async () => {
  const { runtime, original, snapshot } = await fixture();
  const revisions = await runtime.revisions("credential");
  const first = await revisions.reserveRevision({
    requestId: "revision-request-1",
    targetOperationId: original.operationId,
    targetResultId: snapshot.resultAcceptance!.acceptanceId,
    targetResultDigest: snapshot.resultAcceptance!.manifestDigest,
    reason: "唯一の改訂",
    maxAttempts: 1,
    task: { promptRef: "private://revision", profile: "coding", idempotencyKey: "revision-1" },
  });
  if (first.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, first.reservation.operationId, "completed");
  const accepted = (await (await runtime.operation(first.reservation.operationId)).read()).resultAcceptance!;
  const outcome = await revisions.reserveRevision({
    requestId: "revision-request-2",
    seriesId: first.reservation.seriesId,
    targetOperationId: first.reservation.operationId,
    targetResultId: accepted.acceptanceId,
    targetResultDigest: accepted.manifestDigest,
    reason: "上限を超える改訂",
    task: { promptRef: "private://revision-2", profile: "coding", idempotencyKey: "revision-2" },
  });

  assert.deepEqual(outcome, { status: "rejected", reason: "limit_exceeded" });
});

test("Retry clearanceの保存失敗時はRetryを予約しない", async () => {
  const clock = new FakeClock(Array.from({ length: 120 }, (_, index) =>
    new Date(Date.parse("2026-09-06T12:00:00.000Z") + index * 1_000).toISOString()
  ));
  const store = new ClearanceFaultStore([], clock);
  const runtime = makeTestRuntime({
    worker: new SequencedWorkerAdapter(["success", "liveness-unproven"]),
    clock,
    ids: new FakeIdGenerator(["original", "revision-1", "retry-1"]),
    presentation: new FakePresentation(),
    store,
    revisionAuthenticator: authenticator(),
    retryClearanceVerifier: { verify: async () => true },
  });
  const original = await runtime.spawn({ promptRef: "private://original", profile: "coding", idempotencyKey: "original" });
  await original.result();
  const accepted = (await original.read()).resultAcceptance!;
  const revision = await reserveFirst(runtime, original.operationId, accepted.acceptanceId, accepted.manifestDigest);
  if (revision.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, revision.reservation.operationId, "unknown");
  store.failClearance = true;
  await (await runtime.revisions("credential")).reserveRetry({
    requestId: "retry-request-1",
    seriesId: revision.reservation.seriesId,
    failedOperationId: revision.reservation.operationId,
    reason: "保存失敗する再試行",
    clearance: {
      clearanceId: "clearance-1",
      failedOperationId: revision.reservation.operationId,
      affectedResourceIds: ["workspace:writer"],
      workerStoppedOrAccessBlocked: true,
      noConflict: true,
      handoffConfirmed: true,
      verifiedBy: "resource-adapter-1",
      verifiedAt: "2026-09-06T12:01:00.000Z",
    },
    task: { promptRef: "private://retry", profile: "coding", idempotencyKey: "retry-1" },
  }).catch(() => undefined);
  const series = await (await runtime.revisions("credential")).read(revision.reservation.seriesId);

  assert.equal(series.reservations.length, 1);
});

test("予約後にOperation作成が中断しても再起動時に作成を再開する", async () => {
  const clock = new FakeClock(Array.from({ length: 160 }, (_, index) =>
    new Date(Date.parse("2026-09-06T13:00:00.000Z") + index * 1_000).toISOString()
  ));
  const store = new InMemoryEventStore([], clock);
  const presentation = new InterruptiblePresentation();
  const firstRuntime = makeTestRuntime({
    worker: new SequencedWorkerAdapter(["success"]),
    clock,
    ids: new FakeIdGenerator(["original", "revision-1"]),
    presentation,
    store,
    revisionAuthenticator: authenticator(),
  });
  const original = await firstRuntime.spawn({ promptRef: "private://original", profile: "coding", idempotencyKey: "original" });
  await original.result();
  const accepted = (await original.read()).resultAcceptance!;
  presentation.failPreflight = true;
  await reserveFirst(firstRuntime, original.operationId, accepted.acceptanceId, accepted.manifestDigest).catch(() => undefined);
  const recovered = makeTestRuntime({
    worker: new SequencedWorkerAdapter(["success"]),
    clock,
    ids: new FakeIdGenerator([]),
    presentation: new FakePresentation(),
    store,
    revisionAuthenticator: authenticator(),
  });
  await waitForState(recovered, "revision-1", "completed");

  assert.equal((await (await recovered.operation("revision-1")).read()).state, "completed");
});

test("Retry成功は別の成果物採否判断で系列へ採用する", async () => {
  const { runtime, original, snapshot } = await fixture();
  const revision = await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);
  if (revision.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, revision.reservation.operationId, "completed");
  const result = (await (await runtime.operation(revision.reservation.operationId)).read()).resultAcceptance!;
  const outcome = await (await runtime.revisions("credential")).adopt({
    decisionId: "adoption-1",
    seriesId: revision.reservation.seriesId,
    revisionNumber: 1,
    retryOperationId: revision.reservation.operationId,
    resultId: result.acceptanceId,
    resultDigest: result.manifestDigest,
  });

  assert.equal(outcome.status === "adopted" ? outcome.adoption.resultId : outcome.status, result.acceptanceId);
});

test("直接RevisionのResultから次のRevisionを同じ系列へ予約する", async () => {
  const { runtime, original, snapshot } = await fixture();
  const first = await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);
  if (first.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, first.reservation.operationId, "completed");
  const result = (await (await runtime.operation(first.reservation.operationId)).read()).resultAcceptance!;
  const revisions = await runtime.revisions("credential");
  const second = await revisions.reserveRevision({
    requestId: "revision-request-2",
    seriesId: first.reservation.seriesId,
    targetOperationId: first.reservation.operationId,
    targetResultId: result.acceptanceId,
    targetResultDigest: result.manifestDigest,
    reason: "追加のレビュー指摘を反映する",
    task: { promptRef: "private://revision-2", profile: "coding", idempotencyKey: "revision-2" },
  });

  assert.equal(second.status === "reserved" ? second.reservation.revisionNumber : second.status, 2);
});

test("系列メンバーを別系列の起点にして上限を初期化できない", async () => {
  const { runtime, original, snapshot } = await fixture();
  const first = await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);
  if (first.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, first.reservation.operationId, "completed");
  const accepted = (await (await runtime.operation(first.reservation.operationId)).read()).resultAcceptance!;
  const fork = await (await runtime.revisions("credential")).reserveRevision({
    requestId: "fork-request",
    targetOperationId: first.reservation.operationId,
    targetResultId: accepted.acceptanceId,
    targetResultDigest: accepted.manifestDigest,
    reason: "別系列へ分岐する",
    maxAttempts: 10,
    task: { promptRef: "private://fork", profile: "coding", idempotencyKey: "fork" },
  });

  assert.deepEqual(fork, { status: "rejected", reason: "invalid_target" });
});

test("同じ成果物採否判断の再送は同じ採用へ合流する", async () => {
  const { runtime, original, snapshot } = await fixture();
  const revision = await reserveFirst(runtime, original.operationId, snapshot.resultAcceptance!.acceptanceId, snapshot.resultAcceptance!.manifestDigest);
  if (revision.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, revision.reservation.operationId, "completed");
  const result = (await (await runtime.operation(revision.reservation.operationId)).read()).resultAcceptance!;
  const request = {
    decisionId: "adoption-1",
    seriesId: revision.reservation.seriesId,
    revisionNumber: 1,
    retryOperationId: revision.reservation.operationId,
    resultId: result.acceptanceId,
    resultDigest: result.manifestDigest,
  } as const;
  const revisions = await runtime.revisions("credential");
  await revisions.adopt(request);
  const repeated = await revisions.adopt(request);

  assert.equal(repeated.status, "idempotent");
});

test("失効した成果物採否主体の採用を拒否する", async () => {
  const state = { authority: "authorized" as "authorized" | "revoked" };
  const clock = new FakeClock(Array.from({ length: 120 }, (_, index) =>
    new Date(Date.parse("2026-09-06T11:00:00.000Z") + index * 1_000).toISOString()
  ));
  const runtime = makeTestRuntime({
    worker: new SequencedWorkerAdapter(["success", "success"]),
    clock,
    ids: new FakeIdGenerator(["original", "revision-1"]),
    presentation: new FakePresentation(),
    store: new InMemoryEventStore([], clock),
    revisionAuthenticator: authenticator(() => state.authority),
    retryClearanceVerifier: { verify: async () => true },
  });
  const original = await runtime.spawn({ promptRef: "private://original", profile: "coding", idempotencyKey: "original" });
  await original.result();
  const accepted = (await original.read()).resultAcceptance!;
  const revision = await reserveFirst(runtime, original.operationId, accepted.acceptanceId, accepted.manifestDigest);
  if (revision.status === "rejected") throw new Error("Revision was not reserved");
  await waitForState(runtime, revision.reservation.operationId, "completed");
  const result = (await (await runtime.operation(revision.reservation.operationId)).read()).resultAcceptance!;
  state.authority = "revoked";
  const outcome = await (await runtime.revisions("credential")).adopt({
    decisionId: "adoption-1",
    seriesId: revision.reservation.seriesId,
    revisionNumber: 1,
    retryOperationId: revision.reservation.operationId,
    resultId: result.acceptanceId,
    resultDigest: result.manifestDigest,
  });

  assert.deepEqual(outcome, { status: "rejected", reason: "authority_revoked" });
});
