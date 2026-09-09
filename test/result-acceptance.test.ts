import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Effect } from "effect";

import { makeResultAcceptance } from "../src/internal/result-acceptance.js";
import {
  resolveWorkProductRequirements,
  validateResultAcceptanceManifest,
} from "../src/internal/result-acceptance-manifest.js";
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";
import { FakeClock, InMemoryEventStore } from "../src/internal/testing.js";
import type {
  ResultAcceptancePreparationEvidence,
  ResultAcceptanceTransactionOutcome,
  WorkerProducedResult,
} from "../src/public.js";
import {
  effectiveConfig,
  requestedConfig,
  retentionPolicy,
  workProductRequirements,
} from "./worker-protocol-fixtures.js";

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
}

function produced(body = "finished", acceptanceRequestId = "request-1"): WorkerProducedResult {
  const bytes = Buffer.from(body, "utf8");
  return {
    acceptanceRequestId,
    body: {
      formatId: "pions.result-body.v1",
      normalizationId: "identity.v1",
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest(bytes),
      bytes,
    },
    workProducts: [],
  };
}

class PublicationRejectingStore extends InMemoryEventStore {
  preparationId?: string;

  override publishResultAcceptance(
    evidence: Readonly<ResultAcceptancePreparationEvidence>,
  ): Effect.Effect<ResultAcceptanceTransactionOutcome> {
    this.preparationId = evidence.preparationId;
    return Effect.succeed({ kind: "failed", terminal: true, reason: "manifest_conflict" });
  }
}

async function fixture(
  context: TestContext,
  storeFactory: (clock: FakeClock) => InMemoryEventStore = (clock) => new InMemoryEventStore([], clock),
  requirements = workProductRequirements,
) {
  const clock = new FakeClock(Array.from({ length: 30 }, (_, index) =>
    `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`,
  ));
  const store = storeFactory(clock);
  await Effect.runPromise(store.create({
    operationId: "operation-1",
    task: { promptRef: "private://prompt", profile: "coding", idempotencyKey: "task-1" },
    requestedConfig,
    effectiveConfig,
    workProductRequirements: requirements,
    resultRetentionPolicy: retentionPolicy("operation-1"),
    lineage: { rootOperationId: "operation-1", depth: 0 },
  }));
  await Effect.runPromise(store.advance("operation-1", { type: "operation_starting" }));
  await Effect.runPromise(store.advance("operation-1", { type: "worker_launched" }));
  await Effect.runPromise(store.advance("operation-1", { type: "automatic_operation_started" }));
  const root = await mkdtemp(join(tmpdir(), "pions-result-acceptance-"));
  const artifactServices = runtimeArtifactStore(root, store);
  context.after(async () => {
    await artifactServices.artifacts.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    store,
    artifacts: artifactServices.artifacts,
    credential: artifactServices.credential,
    synchronizeArtifactClock: artifactServices.synchronizeClock,
    acceptance: makeResultAcceptance({
      store,
      artifacts: artifactServices.artifacts,
      artifactCredential: artifactServices.credential,
      clock,
      synchronizeArtifactClock: artifactServices.synchronizeClock,
    }),
  };
}

test("Artifact Store denies Result use before the Event Store reserves the Operation", async (context) => {
  const { artifacts, credential, synchronizeArtifactClock } = await fixture(context);
  const now = "2026-09-06T10:01:00.000Z";
  synchronizeArtifactClock(now);
  const body = produced().body;
  const registration = await artifacts.startRegistration(credential, {
    registrationId: "unreserved-registration",
    expectedByteCount: body.expectedByteCount,
    expectedDigest: body.expectedDigest,
    formatId: body.formatId,
    normalizationId: body.normalizationId,
    dependencies: [],
    deadline: new Date(Date.parse(now) + 60_000).toISOString(),
    recoveryBudget: 3,
  });
  const registered = registration.kind === "continuable"
    ? await artifacts.transfer(credential, registration.registration.registrationId, body.bytes)
    : registration;
  if (registered.kind !== "registered") throw new Error("registration failed");
  const manifest = validateResultAcceptanceManifest({
    formatId: "pions.result-acceptance-manifest.v1",
    normalizationId: "pions.canonical-json.v1",
    bodyArtifactId: registered.artifact.artifactId,
    requirementSetId: workProductRequirements.requirementSetId,
    requirementSetDigest: workProductRequirements.digest,
    workProducts: [],
  }, workProductRequirements, [registered.artifact]);

  const outcome = await artifacts.prepareResultAcceptance(credential, {
    preparationId: "unreserved-preparation",
    operationId: "operation-1",
    acceptanceRequestId: "unreserved-request",
    manifestDigest: manifest.digest,
    requirementsDigest: workProductRequirements.digest,
    retentionPolicyDigest: retentionPolicy("operation-1").digest,
    manifest: manifest.value,
  });

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "unauthorized");
});

test("Result acceptance reports a missing Operation as not found", async (context) => {
  const { acceptance } = await fixture(context);

  const outcome = await Effect.runPromise(acceptance.accept("missing-operation", produced()));

  assert.equal(outcome.state === "failed" ? outcome.reason : undefined, "operation_not_found");
});

test("Result acceptance publishes only after Artifact Store preparation", async (context) => {
  const { acceptance } = await fixture(context);

  const outcome = await Effect.runPromise(acceptance.accept("operation-1", produced()));

  assert.equal(outcome.state, "accepted");
});

test("a terminal Event Store publication failure aborts Artifact Store preparation", async (context) => {
  const { acceptance, artifacts, credential, store } = await fixture(
    context,
    (clock) => new PublicationRejectingStore([], clock),
  );
  await Effect.runPromise(acceptance.accept("operation-1", produced()));
  const preparationId = (store as PublicationRejectingStore).preparationId;
  if (preparationId === undefined) throw new Error("publication was not attempted");

  const status = await artifacts.resultAcceptancePreparationStatus(credential, preparationId);

  assert.equal(status.kind, "aborted");
});

test("Result acceptance records the body Artifact identifier", async (context) => {
  const { acceptance, store } = await fixture(context);
  await Effect.runPromise(acceptance.accept("operation-1", produced()));

  const snapshot = await Effect.runPromise(store.read("operation-1"));

  assert.equal(snapshot.operation.result?.bodyArtifactId.length === 0, false);
});

test("a repeated acceptance request returns the same acceptance identifier", async (context) => {
  const { acceptance } = await fixture(context);
  const first = await Effect.runPromise(acceptance.accept("operation-1", produced()));

  const repeated = await Effect.runPromise(acceptance.accept("operation-1", produced()));

  assert.equal(
    repeated.state === "accepted" && first.state === "accepted"
      ? repeated.proof.acceptanceId
      : undefined,
    first.state === "accepted" ? first.proof.acceptanceId : undefined,
  );
});

test("a replay with multiple work products under one key returns the accepted identifier", async (context) => {
  const requirements = resolveWorkProductRequirements({
    workProductRequirements: {
      body: workProductRequirements.body,
      workProducts: [{
        key: "attachment",
        formatId: "pions.opaque.v1",
        normalizationId: "identity.v1",
        minCount: 2,
        maxCount: 2,
        maxByteCount: 128,
      }],
      maxTotalByteCount: workProductRequirements.maxTotalByteCount,
    },
  });
  const { acceptance } = await fixture(context, undefined, requirements);
  const withAttachments = (): WorkerProducedResult => ({
    ...produced(),
    workProducts: ["first", "second"].map((value) => {
      const bytes = Buffer.from(value);
      return {
        key: "attachment",
        formatId: "pions.opaque.v1",
        normalizationId: "identity.v1",
        expectedByteCount: bytes.byteLength,
        expectedDigest: digest(bytes),
        bytes,
      };
    }),
  });
  const first = await Effect.runPromise(acceptance.accept("operation-1", withAttachments()));

  const replayed = await Effect.runPromise(acceptance.accept("operation-1", withAttachments()));

  assert.equal(
    replayed.state === "accepted" && first.state === "accepted" ? replayed.proof.acceptanceId : undefined,
    first.state === "accepted" ? first.proof.acceptanceId : undefined,
  );
});

test("the same acceptance request with different content is a request mismatch", async (context) => {
  const { acceptance } = await fixture(context);
  await Effect.runPromise(acceptance.accept("operation-1", produced("first")));

  const conflicting = await Effect.runPromise(
    acceptance.accept("operation-1", produced("second")),
  );

  assert.equal(conflicting.state === "failed" ? conflicting.reason : undefined, "request_mismatch");
});

test("another request with the same content returns the accepted identifier", async (context) => {
  const { acceptance } = await fixture(context);
  const first = await Effect.runPromise(acceptance.accept("operation-1", produced("same", "request-1")));

  const joined = await Effect.runPromise(
    acceptance.accept("operation-1", produced("same", "request-2")),
  );

  assert.equal(
    joined.state === "accepted" && first.state === "accepted" ? joined.proof.acceptanceId : undefined,
    first.state === "accepted" ? first.proof.acceptanceId : undefined,
  );
});

test("another request with different content is a manifest conflict", async (context) => {
  const { acceptance } = await fixture(context);
  await Effect.runPromise(acceptance.accept("operation-1", produced("first", "request-1")));

  const conflicting = await Effect.runPromise(
    acceptance.accept("operation-1", produced("second", "request-2")),
  );

  assert.equal(conflicting.state === "failed" ? conflicting.reason : undefined, "manifest_conflict");
});

test("a body with invalid UTF-8 is rejected before Result publication", async (context) => {
  const { acceptance, store } = await fixture(context);
  const bytes = Uint8Array.from([0xff]);
  const result: WorkerProducedResult = {
    acceptanceRequestId: "request-invalid",
    body: {
      formatId: "pions.result-body.v1",
      normalizationId: "identity.v1",
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest(bytes),
      bytes,
    },
    workProducts: [],
  };

  await Effect.runPromise(acceptance.accept("operation-1", result));

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.result, undefined);
});

test("an accepted body is retrieved from Artifact Store with verified integrity", async (context) => {
  const { acceptance, store, artifacts, credential } = await fixture(context);
  await Effect.runPromise(acceptance.accept("operation-1", produced()));
  const accepted = (await Effect.runPromise(store.read("operation-1"))).operation.result!;

  const retrieved = await artifacts.retrieve(credential, accepted.bodyArtifactId);

  assert.equal(retrieved.kind === "retrieved" ? Buffer.from(retrieved.bytes).toString("utf8") : undefined, "finished");
});
