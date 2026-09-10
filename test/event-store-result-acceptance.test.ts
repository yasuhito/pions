import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Effect } from "effect";

import type {
  ResultAcceptancePreparationEvidence,
  ResultAcceptanceReservationRequest,
} from "../src/public.js";
import type { EventStore } from "../src/internal/event-store/index.js";
import { operationDirectoryKey, PrivateFileEventStore } from "../src/internal/event-store/index.js";
import type { OperationEvent } from "../src/internal/event-store/model.js";
import {
  FakeClock,
  InMemoryEventStore,
  advanceTestOperationToRunning,
} from "../src/internal/testing.js";
import { effectiveConfig, requestedConfig, retentionPolicy, workProductRequirements } from "./worker-protocol-fixtures.js";

const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as const;

function clock(): FakeClock {
  return new FakeClock(Array.from({ length: 30 }, (_, index) =>
    `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`,
  ));
}

function reservation(
  overrides: Partial<ResultAcceptanceReservationRequest> = {},
): ResultAcceptanceReservationRequest {
  const manifestValue = {
    formatId: "pions.result-acceptance-manifest.v1" as const,
    normalizationId: "pions.canonical-json.v1" as const,
    bodyArtifactId: "body-1",
    requirementSetId: workProductRequirements.requirementSetId,
    requirementSetDigest: workProductRequirements.digest,
    workProducts: [],
  };
  const manifestJson = JSON.stringify(manifestValue);
  return {
    preparationId: "preparation-1",
    operationId: "operation-1",
    acceptanceRequestId: "request-1",
    manifest: {
      json: manifestJson,
      bytes: Buffer.from(manifestJson, "utf8"),
      byteCount: Buffer.byteLength(manifestJson, "utf8"),
      digest: digest(manifestJson),
      value: manifestValue,
      totalByteCount: 8,
      artifactIds: ["body-1", "dependency-1"],
    },
    requirements: workProductRequirements,
    ...overrides,
  };
}

function evidence(
  request = reservation(),
  overrides: Partial<ResultAcceptancePreparationEvidence> = {},
): ResultAcceptancePreparationEvidence {
  const { digest: evidenceDigest, ...evidenceOverrides } = overrides;
  const unsigned = {
    formatId: "pions.result-acceptance-preparation.v1" as const,
    preparationId: request.preparationId,
    operationId: request.operationId,
    acceptanceRequestId: request.acceptanceRequestId,
    manifestDigest: request.manifest.digest,
    requirementsDigest: request.requirements.digest,
    bodyArtifactId: request.manifest.value.bodyArtifactId,
    workProducts: request.manifest.value.workProducts,
    artifactIds: request.manifest.artifactIds,
    totalByteCount: request.manifest.totalByteCount,
    acceptedArtifactRetentionMs: 60_000,
    retentionPolicyDigest: digest("retention"),
    ...evidenceOverrides,
  };
  return { ...unsigned, digest: evidenceDigest ?? digest(JSON.stringify(unsigned)) };
}

async function makeRunning(store: EventStore): Promise<void> {
  await Effect.runPromise(store.create({
    operationId: "operation-1",
    task: { promptRef: "private://prompt/1", profile: "coding", idempotencyKey: "task-1" },
    requestedConfig,
    effectiveConfig,
    workProductRequirements,
    resultRetentionPolicy: retentionPolicy("operation-1"),
    lineage: { rootOperationId: "operation-1", depth: 0 },
    startAuthorization: { configuredPolicy: "disabled", policy: "disabled", windowMs: 0, authorizedSubjectIds: [] },
  }));
  await advanceTestOperationToRunning(store, "operation-1");
}

async function runningStore(trace: Array<string> = []): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore(trace, clock());
  await makeRunning(store);
  return store;
}

async function privateRoot(context: TestContext): Promise<string> {
  const root = join(tmpdir(), `pions-result-acceptance-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function storeFailure(effect: Effect.Effect<unknown, { readonly code: string }>) {
  return Effect.runPromise(Effect.flip(effect));
}

class FaultInjectedEventStore extends InMemoryEventStore {
  fault: "before_prepared" | "before_accepted" | "after_accepted" | undefined;

  protected override willAppend(event: OperationEvent): void {
    if (
      this.fault === "before_prepared" && event.type === "result_acceptance_prepared" ||
      this.fault === "before_accepted" && event.type === "result_accepted"
    ) throw new Error("injected interruption");
  }

  protected override didAppend(event: OperationEvent): void {
    super.didAppend(event);
    if (this.fault === "after_accepted" && event.type === "result_accepted") {
      throw new Error("injected response loss");
    }
  }
}

test("a prepared Result acceptance reserves the Operation without publishing a Result", async () => {
  const store = await runningStore();

  await Effect.runPromise(store.prepareResultAcceptance(reservation()));

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.result, undefined);
});

test("publishing matching Artifact Store evidence creates the accepted Result projection", async () => {
  const store = await runningStore();
  const request = reservation();
  await Effect.runPromise(store.prepareResultAcceptance(request));

  await Effect.runPromise(store.publishResultAcceptance(evidence(request)));

  assert.equal(
    (await Effect.runPromise(store.read("operation-1"))).operation.result?.acceptanceRequestId,
    "request-1",
  );
});

test("the same request and manifest returns the existing reservation", async () => {
  const store = await runningStore();
  const first = await Effect.runPromise(store.prepareResultAcceptance(reservation()));

  const retried = await Effect.runPromise(store.prepareResultAcceptance(reservation()));

  assert.deepEqual(retried, first);
});

test("the same request with another manifest is a request mismatch", async () => {
  const store = await runningStore();
  await Effect.runPromise(store.prepareResultAcceptance(reservation()));

  const outcome = await Effect.runPromise(store.prepareResultAcceptance(reservation({
    manifest: { ...reservation().manifest, digest: digest("other-manifest") },
  })));

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "request_mismatch");
});

test("another request with the same manifest joins the existing reservation", async () => {
  const store = await runningStore();
  await Effect.runPromise(store.prepareResultAcceptance(reservation()));

  const outcome = await Effect.runPromise(store.prepareResultAcceptance(reservation({
    preparationId: "preparation-2",
    acceptanceRequestId: "request-2",
  })));

  assert.equal(outcome.kind === "prepared" ? outcome.reservation.preparationId : undefined, "preparation-1");
});

test("another request with another manifest conflicts", async () => {
  const store = await runningStore();
  await Effect.runPromise(store.prepareResultAcceptance(reservation()));

  const outcome = await Effect.runPromise(store.prepareResultAcceptance(reservation({
    preparationId: "preparation-2",
    acceptanceRequestId: "request-2",
    manifest: { ...reservation().manifest, digest: digest("other-manifest") },
  })));

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "manifest_conflict");
});

test("mismatched Artifact Store evidence does not publish Result acceptance", async () => {
  const store = await runningStore();
  const request = reservation();
  await Effect.runPromise(store.prepareResultAcceptance(request));

  const outcome = await Effect.runPromise(store.publishResultAcceptance(evidence(request, {
    artifactIds: ["body-1"],
  })));

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "preparation_mismatch");
});

test("successful publication returns ACK evidence reconstructed from the accepted event", async () => {
  const store = await runningStore();
  const request = reservation();
  await Effect.runPromise(store.prepareResultAcceptance(request));

  const outcome = await Effect.runPromise(store.publishResultAcceptance(evidence(request)));

  assert.equal(
    outcome.kind === "accepted" ? outcome.eventEvidence.acceptedAt : undefined,
    (await Effect.runPromise(store.read("operation-1"))).operation.result?.acceptedAt,
  );
});

test("a retry after publication returns the persisted acceptance identifier", async () => {
  const store = await runningStore();
  const request = reservation();
  await Effect.runPromise(store.prepareResultAcceptance(request));
  const first = await Effect.runPromise(store.publishResultAcceptance(evidence(request)));

  const retried = await Effect.runPromise(store.publishResultAcceptance(evidence(request)));

  assert.deepEqual(retried, first);
});

test("a prepared reservation remains unpublished after restart", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  await Effect.runPromise(store.prepareResultAcceptance(reservation()));

  const reopened = new PrivateFileEventStore(root, clock());

  assert.equal((await Effect.runPromise(reopened.read("operation-1"))).operation.result, undefined);
});

test("a published acceptance keeps its identifier after restart", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  const request = reservation();
  await Effect.runPromise(store.prepareResultAcceptance(request));
  const accepted = await Effect.runPromise(store.publishResultAcceptance(evidence(request)));

  const reopened = new PrivateFileEventStore(root, clock());

  assert.equal(
    (await Effect.runPromise(reopened.read("operation-1"))).operation.result?.acceptanceId,
    accepted.kind === "accepted" ? accepted.acceptance.acceptanceId : undefined,
  );
});

test("a corrupt prepared reservation is not reconstructed as unaccepted", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  await Effect.runPromise(store.prepareResultAcceptance(reservation()));
  const path = join(root, operationDirectoryKey("operation-1"), "events.v18.json");
  const record = JSON.parse(await readFile(path, "utf8")) as {
    events: Array<{ type: string; reservation?: { manifestCanonicalJson: string } }>;
  };
  const prepared = record.events.find((event) => event.type === "result_acceptance_prepared");
  if (prepared?.reservation !== undefined) prepared.reservation.manifestCanonicalJson = "{}";
  await writeFile(path, JSON.stringify(record));

  const failure = await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"));

  assert.equal(failure.code, "corrupt_record");
});

test("an old Event Store root is rejected instead of initialized as the current schema", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  const directory = join(root, operationDirectoryKey("operation-1"));
  await rename(join(directory, "events.v18.json"), join(directory, "events.v10.json"));

  const failure = await storeFailure(new PrivateFileEventStore(root, clock()).read("operation-1"));

  assert.equal(failure.code, "unsupported_schema");
});

test("an interruption before reservation persistence leaves no reserved slot", async () => {
  const store = new FaultInjectedEventStore([], clock());
  await makeRunning(store);
  store.fault = "before_prepared";

  await Effect.runPromise(store.prepareResultAcceptance(reservation()));

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.resultAcceptanceReservation, undefined);
});

test("an interruption before acceptance persistence leaves the public projection empty", async () => {
  const store = new FaultInjectedEventStore([], clock());
  await makeRunning(store);
  const request = reservation();
  await Effect.runPromise(store.prepareResultAcceptance(request));
  store.fault = "before_accepted";

  await Effect.runPromise(store.publishResultAcceptance(evidence(request)));

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.result, undefined);
});

test("a retry after response loss returns the persisted acceptance", async () => {
  const store = new FaultInjectedEventStore([], clock());
  await makeRunning(store);
  const request = reservation();
  await Effect.runPromise(store.prepareResultAcceptance(request));
  store.fault = "after_accepted";
  await Effect.runPromise(store.publishResultAcceptance(evidence(request)));
  store.fault = undefined;

  const retried = await Effect.runPromise(store.publishResultAcceptance(evidence(request)));

  assert.equal(retried.kind, "accepted");
});

test("parallel conflicting reservations append only one preparation event", async () => {
  const trace: Array<string> = [];
  const store = await runningStore(trace);
  trace.length = 0;

  await Promise.all([
    Effect.runPromise(store.prepareResultAcceptance(reservation())),
    Effect.runPromise(store.prepareResultAcceptance(reservation({
      preparationId: "preparation-2",
      acceptanceRequestId: "request-2",
      manifest: { ...reservation().manifest, digest: digest("other-manifest") },
    }))),
  ]);

  assert.equal(trace.filter((entry) => entry.includes('"type":"result_acceptance_prepared"')).length, 1);
});
