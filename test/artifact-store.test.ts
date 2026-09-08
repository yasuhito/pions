import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  ArtifactStoreOpenError,
  openArtifactStore,
  type ArtifactAuthorityDecision,
  type ArtifactPrincipal,
  type ArtifactRegistrationRequest,
  type ArtifactStore,
  type ArtifactStorePolicy,
} from "../src/index.js";
import {
  openArtifactStoreWithFaultInjection,
  type ArtifactStoreFaultPoint,
} from "../src/internal/artifact-store.js";

function digest(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const policy = {
  maxArtifactBytes: 1024,
  maxConcurrentRegistrations: 4,
  maxTemporaryBytes: 2048,
  maxDirectDependencies: 4,
  maxDependencyDepth: 4,
  maxDependencyCount: 8,
  maxRegistrationWindowMs: 60_000,
  maxRecoveryAttempts: 3,
  unusedArtifactRetentionMs: 1_000,
  reviewInputRetentionMs: 2_000,
  acceptedArtifactRetentionMs: 3_000,
  maxGarbageCollectionScan: 16,
  maxGarbageCollectionDeletes: 8,
  maxGarbageCollectionRecoveryAttempts: 3,
} as const;

class Principal implements ArtifactPrincipal {
  readonly subjectId = "worker-1";
  decision: ArtifactAuthorityDecision = "allowed";
  readonly deniedRetrievals = new Set<string>();

  canRegister(): Promise<ArtifactAuthorityDecision> {
    return Promise.resolve(this.decision);
  }
  canReference(): Promise<ArtifactAuthorityDecision> {
    return Promise.resolve(this.decision);
  }
  canRetrieve(artifactId: string): Promise<ArtifactAuthorityDecision> {
    return Promise.resolve(this.deniedRetrievals.has(artifactId) ? "denied" : this.decision);
  }
  canBindArtifactUse(): Promise<ArtifactAuthorityDecision> {
    return Promise.resolve(this.decision);
  }
  canPinArtifact(): Promise<ArtifactAuthorityDecision> {
    return Promise.resolve(this.decision);
  }
  canGarbageCollect(): Promise<ArtifactAuthorityDecision> {
    return Promise.resolve(this.decision);
  }
}

async function root(context: TestContext): Promise<string> {
  const path = join(tmpdir(), `pions-artifacts-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  context.after(() => rm(path, { recursive: true, force: true }));
  return join(path, "store");
}

function request(
  registrationId: string,
  body: string | Uint8Array,
  dependencies: ReadonlyArray<string> = [],
): ArtifactRegistrationRequest {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return {
    registrationId,
    expectedByteCount: bytes.byteLength,
    expectedDigest: digest(bytes),
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
    dependencies,
    deadline: "2026-09-07T10:01:00.000Z",
    recoveryBudget: 2,
  };
}

async function store(
  context: TestContext,
  options: {
    readonly principal?: Principal;
    readonly fault?: (point: ArtifactStoreFaultPoint) => void | Promise<void>;
    readonly rootDirectory?: string;
    readonly now?: () => Date;
    readonly storePolicy?: Readonly<ArtifactStorePolicy>;
  } = {},
): Promise<{ readonly store: ArtifactStore; readonly principal: Principal; readonly rootDirectory: string }> {
  const principal = options.principal ?? new Principal();
  const rootDirectory = options.rootDirectory ?? await root(context);
  const openOptions = {
    rootDirectory,
    policy: options.storePolicy ?? policy,
    now: options.now ?? (() => new Date("2026-09-07T10:00:00.000Z")),
    idGenerator: () => `artifact-${crypto.randomUUID()}`,
    authenticator: {
      authenticate: () => Promise.resolve(principal),
      restore: () => Promise.resolve(principal),
    },
  };
  const opened = options.fault === undefined
    ? await openArtifactStore(openOptions)
    : await openArtifactStoreWithFaultInjection(openOptions, options.fault);
  context.after(() => opened.close());
  return { store: opened, principal, rootDirectory };
}

async function register(store: ArtifactStore, registrationId: string, body: string) {
  const spec = request(registrationId, body);
  await store.startRegistration("credential", spec);
  return store.transfer("credential", registrationId, Buffer.from(body));
}

test("a prepared Artifact use binding becomes available only after its bytes and current authority are verified", async (context) => {
  const { store: artifacts } = await store(context);
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");

  const outcome = await artifacts.prepareUseBinding("credential", {
    bindingId: "use-1",
    operationId: "operation-1",
    artifactId: registered.artifact.artifactId,
    purpose: "review_subject",
    decisionId: "decision-1",
    authorityBasis: "review-policy-v1",
  });

  assert.equal(outcome.kind, "available");
});

test("a preparing Artifact use binding cannot retrieve bytes", async (context) => {
  let interrupted = false;
  const { store: artifacts } = await store(context, {
    fault: (point) => {
      if (!interrupted && point === "use_binding_parent_pin_persisted") {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    },
  });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  await artifacts.prepareUseBinding("credential", {
    bindingId: "use-1",
    operationId: "operation-1",
    artifactId: registered.artifact.artifactId,
    purpose: "review_subject",
    decisionId: "decision-1",
    authorityBasis: "review-policy-v1",
  }).catch(() => undefined);

  const outcome = await artifacts.retrieveForUseBinding("credential", "use-1");

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "conflict");
});

test("Artifact use binding authority is rechecked immediately before availability", async (context) => {
  class RevokingPrincipal extends Principal {
    private checks = 0;
    override canBindArtifactUse(): Promise<ArtifactAuthorityDecision> {
      this.checks += 1;
      return Promise.resolve(this.checks > 1 ? "revoked" : "allowed");
    }
  }
  const { store: artifacts } = await store(context, { principal: new RevokingPrincipal() });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");

  const outcome = await artifacts.prepareUseBinding("credential", {
    bindingId: "use-1",
    operationId: "operation-1",
    artifactId: registered.artifact.artifactId,
    purpose: "review_subject",
    decisionId: "decision-1",
    authorityBasis: "review-policy-v1",
  });

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "authority_revoked");
});

test("an Artifact use binding retention pin protects its parent and dependency from garbage collection", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  const dependency = await register(artifacts, "dependency-registration", "dependency");
  if (dependency.kind !== "registered") throw new Error("dependency registration failed");
  const parentSpec = request("parent-registration", "parent", [dependency.artifact.artifactId]);
  await artifacts.startRegistration("credential", parentSpec);
  const parent = await artifacts.transfer("credential", parentSpec.registrationId, Buffer.from("parent"));
  if (parent.kind !== "registered") throw new Error("parent registration failed");
  await artifacts.prepareUseBinding("credential", {
    bindingId: "use-1",
    operationId: "operation-1",
    artifactId: parent.artifact.artifactId,
    purpose: "review_subject",
    decisionId: "decision-1",
    authorityBasis: "review-policy-v1",
  });
  now = new Date("2026-09-07T10:01:00.000Z");

  const outcome = await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  assert.deepEqual(outcome.kind === "completed" ? outcome.deletedArtifactIds : undefined, []);
});

test("releasing one use does not release another Artifact use binding's retention pin", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  for (const bindingId of ["use-1", "use-2"]) {
    await artifacts.prepareUseBinding("credential", {
      bindingId,
      operationId: `operation-${bindingId}`,
      artifactId: registered.artifact.artifactId,
      purpose: "review_subject",
      decisionId: `decision-${bindingId}`,
      authorityBasis: "review-policy-v1",
    });
  }
  await artifacts.releaseUseBinding("credential", "use-1");
  now = new Date("2026-09-07T10:01:00.000Z");

  const outcome = await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  assert.deepEqual(outcome.kind === "completed" ? outcome.deletedArtifactIds : undefined, []);
});

test("garbage collection deletes bytes only after grace, retention, and pins end", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  await artifacts.prepareUseBinding("credential", {
    bindingId: "use-1",
    operationId: "operation-1",
    artifactId: registered.artifact.artifactId,
    purpose: "review_subject",
    decisionId: "decision-1",
    authorityBasis: "review-policy-v1",
  });
  await artifacts.releaseUseBinding("credential", "use-1");
  now = new Date("2026-09-07T10:01:00.000Z");

  const outcome = await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  assert.deepEqual(outcome.kind === "completed" ? outcome.deletedArtifactIds : undefined, [registered.artifact.artifactId]);
});

test("policy deletion remains distinct from missing bytes", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  now = new Date("2026-09-07T10:01:00.000Z");
  await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  const outcome = await artifacts.retrieve("credential", registered.artifact.artifactId);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "artifact_deleted");
});

test("garbage collection reports unprocessed artifacts separately from processing failure", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  await register(artifacts, "registration-1", "first");
  await register(artifacts, "registration-2", "second");
  now = new Date("2026-09-07T10:01:00.000Z");

  const outcome = await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 1,
    deletionBudget: 1,
    recoveryBudget: 2,
  });

  assert.equal(outcome.kind === "continuable" ? outcome.reason : undefined, "gc_unprocessed");
});

test("an Artifact use binding record protects bytes before its pin records are complete", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  let interrupted = false;
  const { store: artifacts } = await store(context, {
    now: () => now,
    fault: (point) => {
      if (!interrupted && point === "use_binding_record_persisted") {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    },
  });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  await artifacts.prepareUseBinding("credential", {
    bindingId: "use-1",
    operationId: "operation-1",
    artifactId: registered.artifact.artifactId,
    purpose: "review_subject",
    decisionId: "decision-1",
    authorityBasis: "review-policy-v1",
  }).catch(() => undefined);
  now = new Date("2026-09-07T10:01:00.000Z");

  const outcome = await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  assert.deepEqual(outcome.kind === "completed" ? outcome.deletedArtifactIds : undefined, []);
});

const recoverableDeletionFaults: ReadonlyArray<ArtifactStoreFaultPoint> = [
  "gc_eligibility_checked",
  "deletion_pending_persisted",
  "artifact_bytes_deleted",
  "deletion_committed",
];

for (const faultPoint of recoverableDeletionFaults) {
  test(`garbage collection recovers after interruption at ${faultPoint}`, async (context) => {
    const rootDirectory = await root(context);
    let now = new Date("2026-09-07T10:00:00.000Z");
    let interrupted = false;
    const first = await store(context, {
      rootDirectory,
      now: () => now,
      fault: (point) => {
        if (!interrupted && point === faultPoint) {
          interrupted = true;
          throw new Error("simulated interruption");
        }
      },
    });
    const registered = await register(first.store, "registration-1", "hello");
    if (registered.kind !== "registered") throw new Error("registration failed");
    now = new Date("2026-09-07T10:01:00.000Z");
    await first.store.collectGarbage("credential", {
      collectionId: "gc-1",
      scanBudget: 16,
      deletionBudget: 8,
      recoveryBudget: 2,
    }).catch(() => undefined);
    await first.store.close();
    const reopened = await store(context, { rootDirectory, now: () => now });
    await reopened.store.collectGarbage("credential", {
      collectionId: "gc-2",
      scanBudget: 16,
      deletionBudget: 8,
      recoveryBudget: 2,
    });

    const outcome = await reopened.store.retrieve("credential", registered.artifact.artifactId);

    assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "artifact_deleted");
  });
}

test("missing bytes without deletion pending are reported as corruption", async (context) => {
  const { store: artifacts, rootDirectory } = await store(context);
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  await rm(join(rootDirectory, "artifacts", `${registered.artifact.artifactId}.bin`));

  const outcome = await artifacts.retrieve("credential", registered.artifact.artifactId);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "stored_artifact_corrupt");
});

test("a deletion pending artifact remains pending when its storage cannot be inspected", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  let blockDeletion = false;
  const { store: artifacts, rootDirectory } = await store(context, {
    now: () => now,
    fault: (point) => {
      if (blockDeletion && point === "deletion_pending_persisted") {
        blockDeletion = false;
        throw new Error("simulated interruption");
      }
    },
  });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  now = new Date("2026-09-07T10:01:00.000Z");
  blockDeletion = true;
  await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  }).catch(() => undefined);
  const dataPath = join(rootDirectory, "artifacts", `${registered.artifact.artifactId}.bin`);
  await rm(dataPath);
  await mkdir(dataPath);

  const outcome = await artifacts.retrieve("credential", registered.artifact.artifactId);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "artifact_deletion_pending");
});

test("pin creation wins against a concurrent garbage collection decision", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  let announce!: () => void;
  let release!: () => void;
  const announced = new Promise<void>((resolve) => { announce = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const { store: artifacts } = await store(context, {
    now: () => now,
    fault: async (point) => {
      if (point === "use_binding_record_persisted") {
        announce();
        await paused;
      }
    },
  });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  now = new Date("2026-09-07T10:01:00.000Z");
  const binding = artifacts.prepareUseBinding("credential", {
    bindingId: "use-1",
    operationId: "operation-1",
    artifactId: registered.artifact.artifactId,
    purpose: "review_subject",
    decisionId: "decision-1",
    authorityBasis: "review-policy-v1",
  });
  await announced;
  const collection = artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });
  release();
  await binding;

  const outcome = await collection;

  assert.deepEqual(outcome.kind === "completed" ? outcome.deletedArtifactIds : undefined, []);
});

test("an explicit indefinite pin protects an artifact until explicitly released", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  await artifacts.createRetentionPin("credential", {
    pinId: "pin-1",
    artifactId: registered.artifact.artifactId,
    ownerId: "coordinator-1",
    purpose: "legal-hold",
    retention: "indefinite",
  });
  now = new Date("2026-09-07T10:01:00.000Z");
  await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  const outcome = await artifacts.retrieve("credential", registered.artifact.artifactId);

  assert.equal(outcome.kind, "retrieved");
});

test("an unfinished registration protects its dependency closure", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  const dependency = await register(artifacts, "dependency-registration", "dependency");
  if (dependency.kind !== "registered") throw new Error("dependency registration failed");
  await artifacts.startRegistration("credential", request("parent-registration", "parent", [dependency.artifact.artifactId]));
  now = new Date("2026-09-07T10:01:00.000Z");

  const outcome = await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  assert.deepEqual(outcome.kind === "completed" ? outcome.deletedArtifactIds : undefined, []);
});

test("garbage collection continuation advances beyond retained earlier artifacts", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  const registrations = await Promise.all([
    register(artifacts, "registration-1", "first"),
    register(artifacts, "registration-2", "second"),
    register(artifacts, "registration-3", "third"),
  ]);
  now = new Date("2026-09-07T10:01:00.000Z");
  const first = await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 3,
    deletionBudget: 1,
    recoveryBudget: 2,
  });
  if (first.kind !== "continuable") throw new Error("expected unprocessed artifacts");
  const second = await artifacts.collectGarbage("credential", {
    collectionId: "gc-2",
    scanBudget: 3,
    deletionBudget: 3,
    recoveryBudget: 2,
    afterArtifactId: first.nextCursor,
  });
  if (second.kind === "failed") throw new Error(second.reason);

  assert.equal(first.deletedArtifactIds.length + second.deletedArtifactIds.length === 3 && registrations.every((result) => result.kind === "registered"), true);
});

test("garbage collection reports processing failure even when diagnostic persistence also fails", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts, rootDirectory } = await store(context, {
    now: () => now,
    fault: (point) => {
      if (point === "before_gc_diagnostic_persisted") throw new Error("diagnostic storage unavailable");
    },
  });
  await register(artifacts, "registration-1", "hello");
  now = new Date("2026-09-07T10:01:00.000Z");
  await writeFile(join(rootDirectory, "pins", "invalid.json"), "{");

  const outcome = await artifacts.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "gc_processing_unavailable");
});

const recoverableUseBindingFaults: ReadonlyArray<ArtifactStoreFaultPoint> = [
  "use_binding_record_persisted",
  "use_binding_retention_persisted",
  "use_binding_parent_pin_persisted",
  "use_binding_dependency_pin_persisted",
  "use_binding_available_persisted",
];

for (const faultPoint of recoverableUseBindingFaults) {
  test(`an Artifact use binding recovers after interruption at ${faultPoint}`, async (context) => {
    const rootDirectory = await root(context);
    let interrupted = false;
    const first = await store(context, {
      rootDirectory,
      fault: (point) => {
        if (!interrupted && point === faultPoint) {
          interrupted = true;
          throw new Error("simulated interruption");
        }
      },
    });
    const dependency = await register(first.store, "dependency-registration", "dependency");
    if (dependency.kind !== "registered") throw new Error("dependency registration failed");
    const parentSpec = request("parent-registration", "parent", [dependency.artifact.artifactId]);
    await first.store.startRegistration("credential", parentSpec);
    const parent = await first.store.transfer("credential", parentSpec.registrationId, Buffer.from("parent"));
    if (parent.kind !== "registered") throw new Error("parent registration failed");
    await first.store.prepareUseBinding("credential", {
      bindingId: "binding-1",
      operationId: "operation-1",
      artifactId: parent.artifact.artifactId,
      purpose: "review_subject",
      decisionId: "decision-1",
      authorityBasis: "review-policy-v1",
    }).catch(() => undefined);
    await first.store.close();

    const reopened = await store(context, { rootDirectory });
    const outcome = await reopened.store.useBindingStatus("credential", "binding-1");

    assert.equal(outcome.kind, "available");
  });
}

test("rejected Artifact use binding pin release resumes after an interruption", async (context) => {
  class RevokingPrincipal extends Principal {
    private checks = 0;
    override canBindArtifactUse(): Promise<ArtifactAuthorityDecision> {
      this.checks += 1;
      return Promise.resolve(this.checks > 1 ? "revoked" : "allowed");
    }
  }
  const rootDirectory = await root(context);
  const principal = new RevokingPrincipal();
  let now = new Date("2026-09-07T10:00:00.000Z");
  let interrupted = false;
  const first = await store(context, {
    rootDirectory,
    principal,
    now: () => now,
    fault: (point) => {
      if (!interrupted && point === "use_binding_rejection_persisted") {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    },
  });
  const registered = await register(first.store, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  await first.store.prepareUseBinding("credential", {
    bindingId: "binding-1",
    operationId: "operation-1",
    artifactId: registered.artifact.artifactId,
    purpose: "review_subject",
    decisionId: "decision-1",
    authorityBasis: "review-policy-v1",
  }).catch(() => undefined);
  await first.store.close();
  now = new Date("2026-09-07T10:01:00.000Z");
  const reopened = await store(context, { rootDirectory, principal, now: () => now });

  const outcome = await reopened.store.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  assert.deepEqual(outcome.kind === "completed" ? outcome.deletedArtifactIds : undefined, [registered.artifact.artifactId]);
});

test("explicit pin release resumes after an interruption", async (context) => {
  const rootDirectory = await root(context);
  let now = new Date("2026-09-07T10:00:00.000Z");
  let interrupted = false;
  const first = await store(context, {
    rootDirectory,
    now: () => now,
    fault: (point) => {
      if (!interrupted && point === "before_explicit_pin_records_released") {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    },
  });
  const registered = await register(first.store, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  await first.store.createRetentionPin("credential", {
    pinId: "pin-1",
    artifactId: registered.artifact.artifactId,
    ownerId: "coordinator-1",
    purpose: "legal-hold",
    retention: "indefinite",
  });
  await first.store.releaseRetentionPin("credential", "pin-1");
  await first.store.close();
  now = new Date("2026-09-07T10:01:00.000Z");
  const reopened = await store(context, { rootDirectory, now: () => now });

  const outcome = await reopened.store.collectGarbage("credential", {
    collectionId: "gc-1",
    scanBudget: 16,
    deletionBudget: 8,
    recoveryBudget: 2,
  });

  assert.deepEqual(outcome.kind === "completed" ? outcome.deletedArtifactIds : undefined, [registered.artifact.artifactId]);
});

test("a fixed byte sequence is registered under an identifier independent from its digest", async (context) => {
  const { store: artifacts } = await store(context);

  const outcome = await register(artifacts, "registration-1", "hello");

  assert.equal(outcome.kind === "registered" && outcome.artifact.artifactId !== outcome.artifact.digest, true);
});

test("a lost success response is recovered by the same registration request", async (context) => {
  const { store: artifacts } = await store(context);
  const spec = request("registration-1", "hello");
  await artifacts.startRegistration("credential", spec);
  const first = await artifacts.transfer("credential", spec.registrationId, Buffer.from("hello"));

  const replay = await artifacts.startRegistration("credential", spec);

  assert.equal(replay.kind === "registered" && first.kind === "registered" && replay.artifact.artifactId === first.artifact.artifactId, true);
});

test("authority revocation does not overwrite an already registered fact", async (context) => {
  const principal = new Principal();
  const { store: artifacts } = await store(context, { principal });
  const spec = request("registration-1", "hello");
  await artifacts.startRegistration("credential", spec);
  await artifacts.transfer("credential", spec.registrationId, Buffer.from("hello"));
  principal.decision = "revoked";
  await artifacts.startRegistration("credential", spec);
  principal.decision = "allowed";

  const status = await artifacts.registrationStatus("credential", spec.registrationId);

  assert.equal(status.kind, "registered");
});

test("a registration identifier cannot be reused for a different request", async (context) => {
  const { store: artifacts } = await store(context);
  await artifacts.startRegistration("credential", request("registration-1", "hello"));

  const conflict = await artifacts.startRegistration("credential", request("registration-1", "different"));

  assert.equal(conflict.kind === "failed" ? conflict.reason : undefined, "request_mismatch");
});

test("the UTF-8 result format rejects malformed input without rewriting it", async (context) => {
  const { store: artifacts } = await store(context);
  const bytes = Uint8Array.from([0xc3, 0x28]);
  const spec = { ...request("registration-1", bytes), formatId: "pions.result-body.v1" };
  await artifacts.startRegistration("credential", spec);

  const outcome = await artifacts.transfer("credential", spec.registrationId, bytes);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "invalid_format");
});

test("registration rechecks current authority before publication", async (context) => {
  const principal = new Principal();
  const { store: artifacts } = await store(context, { principal });
  await artifacts.startRegistration("credential", request("registration-1", "hello"));
  principal.decision = "revoked";

  const outcome = await artifacts.transfer("credential", "registration-1", Buffer.from("hello"));

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "authority_revoked");
});

test("retrieval verifies and returns the stored byte sequence", async (context) => {
  const { store: artifacts } = await store(context);
  const registered = await register(artifacts, "registration-1", "e\u0301\r\n");
  if (registered.kind !== "registered") throw new Error("registration failed");

  const retrieved = await artifacts.retrieve("credential", registered.artifact.artifactId);

  assert.equal(retrieved.kind === "retrieved" ? Buffer.from(retrieved.bytes).toString("hex") : undefined, "65cc810d0a");
});

test("retrieval does not reveal whether an unavailable identifier exists", async (context) => {
  const principal = new Principal();
  principal.decision = "denied";
  const { store: artifacts } = await store(context, { principal });

  const outcome = await artifacts.retrieve("credential", "absent-or-forbidden");

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "unauthorized");
});

test("a second writer cannot open the same storage root", async (context) => {
  const rootDirectory = await root(context);
  const first = await store(context, { rootDirectory });

  const opening = openArtifactStore({
    rootDirectory,
    policy,
    now: () => new Date("2026-09-07T10:00:00.000Z"),
    idGenerator: () => "artifact-2",
    authenticator: {
      authenticate: () => Promise.resolve(first.principal),
      restore: () => Promise.resolve(first.principal),
    },
  });

  await assert.rejects(opening, (error) => error instanceof ArtifactStoreOpenError && error.reason === "writer_locked");
});

test("an unsupported storage root is rejected without changing it", async (context) => {
  const rootDirectory = await root(context);
  await mkdir(rootDirectory, { recursive: true });
  await writeFile(join(rootDirectory, "root.json"), '{"schema":"pions-artifacts.v0"}\n');

  await assert.rejects(
    store(context, { rootDirectory }),
    (error) => error instanceof ArtifactStoreOpenError && error.reason === "unsupported_root",
  );
});

test("a corrupt registration record is reported without publishing it", async (context) => {
  const { store: artifacts, rootDirectory } = await store(context);
  const spec = request("registration-1", "hello");
  await artifacts.startRegistration("credential", spec);
  const recordPath = join(rootDirectory, "registrations", "registration-1.json");
  const record = JSON.parse(await readFile(recordPath, "utf8")) as { requestDigest: string };
  await writeFile(recordPath, `${JSON.stringify({ ...record, requestDigest: digest("different") })}\n`);

  const status = await artifacts.registrationStatus("credential", spec.registrationId);

  assert.equal(status.kind === "failed" ? status.reason : undefined, "storage_inspection_unavailable");
});

test("a prepared registration is committed with the same identifier after reopening", async (context) => {
  const rootDirectory = await root(context);
  let interrupted = false;
  const first = await store(context, {
    rootDirectory,
    fault: (point) => {
      if (!interrupted && point === "prepared_record_persisted") {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    },
  });
  const spec = request("registration-1", "hello");
  const started = await first.store.startRegistration("credential", spec);
  await first.store.transfer("credential", spec.registrationId, Buffer.from("hello")).catch(() => undefined);
  await first.store.close();

  const reopened = await store(context, { rootDirectory });
  const recovered = await reopened.store.registrationStatus("credential", spec.registrationId);

  assert.equal(recovered.kind === "registered" && started.kind === "continuable" ? recovered.artifact.artifactId === started.registration.artifactId : false, true);
});

const recoverableFaults: ReadonlyArray<ArtifactStoreFaultPoint> = [
  "temporary_bytes_persisted",
  "data_synced",
  "directory_synced",
  "prepared_record_persisted",
  "artifact_published",
  "registration_committed",
  "success_response",
];

for (const faultPoint of recoverableFaults) {
  test(`registration can continue after interruption at ${faultPoint}`, async (context) => {
    const rootDirectory = await root(context);
    let interrupted = false;
    const first = await store(context, {
      rootDirectory,
      fault: (point) => {
        if (!interrupted && point === faultPoint) {
          interrupted = true;
          throw new Error("simulated interruption");
        }
      },
    });
    const spec = request("registration-1", "hello");
    await first.store.startRegistration("credential", spec);
    await first.store.transfer("credential", spec.registrationId, Buffer.from("hello")).catch(() => undefined);
    await first.store.close();
    const reopened = await store(context, { rootDirectory });
    const status = await reopened.store.registrationStatus("credential", spec.registrationId);
    const recovered = status.kind === "continuable"
      ? await reopened.store.transfer("credential", spec.registrationId, Buffer.from("hello"))
      : status;

    assert.equal(recovered.kind, "registered");
  });
}

test("publication updates for parallel registrations are serialized", async (context) => {
  let publicationCount = 0;
  let firstPublished!: () => void;
  let release!: () => void;
  const published = new Promise<void>((resolve) => { firstPublished = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const { store: artifacts } = await store(context, {
    fault: async (point) => {
      if (point !== "artifact_published") return;
      publicationCount += 1;
      if (publicationCount === 1) {
        firstPublished();
        await paused;
      }
    },
  });
  await artifacts.startRegistration("credential", request("registration-1", "first"));
  await artifacts.startRegistration("credential", request("registration-2", "second"));
  const first = artifacts.transfer("credential", "registration-1", Buffer.from("first"));
  const second = artifacts.transfer("credential", "registration-2", Buffer.from("second"));
  await published;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const countWhileFirstPublicationWasPaused = publicationCount;
  release();
  await Promise.all([first, second]);

  assert.equal(countWhileFirstPublicationWasPaused, 1);
});

test("an incomplete transfer remains continuable from the beginning", async (context) => {
  const { store: artifacts } = await store(context);
  await artifacts.startRegistration("credential", request("registration-1", "hello"));

  const outcome = await artifacts.transfer("credential", "registration-1", Buffer.from("hell"));

  assert.equal(outcome.kind, "continuable");
});

test("a replacement transfer prevents the older transfer from publishing", async (context) => {
  const { store: artifacts } = await store(context);
  await artifacts.startRegistration("credential", request("registration-1", "hello"));
  let release!: () => void;
  let announce!: () => void;
  const announced = new Promise<void>((resolve) => { announce = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const oldTransfer = artifacts.transfer("credential", "registration-1", (async function* () {
    yield Buffer.from("he");
    announce();
    await paused;
    yield Buffer.from("llo");
  })());
  await announced;

  const replacement = artifacts.transfer("credential", "registration-1", Buffer.from("hello"));
  release();
  const old = await oldTransfer;
  await replacement;

  assert.equal(old.kind === "failed" ? old.reason : undefined, "conflict");
});

test("a replacement transfer waits until the older transfer has stopped", async (context) => {
  const { store: artifacts } = await store(context);
  await artifacts.startRegistration("credential", request("registration-1", "hello"));
  let release!: () => void;
  let announce!: () => void;
  const announced = new Promise<void>((resolve) => { announce = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const oldTransfer = artifacts.transfer("credential", "registration-1", (async function* () {
    yield Buffer.from("he");
    announce();
    await paused;
    yield Buffer.from("llo");
  })());
  await announced;
  const replacement = await artifacts.transfer("credential", "registration-1", Buffer.from("hello"));
  release();
  await oldTransfer;

  assert.equal(replacement.kind, "registered");
});

test("retrieval requires current permission for every dependency", async (context) => {
  const principal = new Principal();
  const { store: artifacts } = await store(context, { principal });
  const dependency = await register(artifacts, "dependency-registration", "dependency");
  if (dependency.kind !== "registered") throw new Error("dependency registration failed");
  const parentSpec = request("parent-registration", "parent", [dependency.artifact.artifactId]);
  await artifacts.startRegistration("credential", parentSpec);
  const parent = await artifacts.transfer("credential", parentSpec.registrationId, Buffer.from("parent"));
  if (parent.kind !== "registered") throw new Error("parent registration failed");
  principal.deniedRetrievals.add(dependency.artifact.artifactId);

  const outcome = await artifacts.retrieve("credential", parent.artifact.artifactId);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "unauthorized");
});

test("duplicate dependency references count once in the dependency closure", async (context) => {
  const constrainedPolicy = { ...policy, maxDependencyCount: 1 };
  const { store: artifacts } = await store(context, { storePolicy: constrainedPolicy });
  const dependency = await register(artifacts, "dependency-registration", "dependency");
  if (dependency.kind !== "registered") throw new Error("dependency registration failed");
  const spec = request("parent-registration", "parent", [
    dependency.artifact.artifactId,
    dependency.artifact.artifactId,
  ]);

  const outcome = await artifacts.startRegistration("credential", spec);

  assert.equal(outcome.kind, "continuable");
});

test("a dependency chain cannot exceed the fixed closure count", async (context) => {
  const constrainedPolicy = { ...policy, maxDependencyCount: 1 };
  const { store: artifacts } = await store(context, { storePolicy: constrainedPolicy });
  const leaf = await register(artifacts, "leaf-registration", "leaf");
  if (leaf.kind !== "registered") throw new Error("leaf registration failed");
  const middleSpec = request("middle-registration", "middle", [leaf.artifact.artifactId]);
  await artifacts.startRegistration("credential", middleSpec);
  const middle = await artifacts.transfer("credential", middleSpec.registrationId, Buffer.from("middle"));
  if (middle.kind !== "registered") throw new Error("middle registration failed");
  const parentSpec = request("parent-registration", "parent", [middle.artifact.artifactId]);

  const outcome = await artifacts.startRegistration("credential", parentSpec);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "limit_exceeded");
});

test("recovery budget cannot exceed its trusted policy limit", async (context) => {
  const { store: artifacts } = await store(context);
  const spec = { ...request("registration-1", "hello"), recoveryBudget: policy.maxRecoveryAttempts + 1 };

  const outcome = await artifacts.startRegistration("credential", spec);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "limit_exceeded");
});

test("a damaged prepared transfer exhausts its finite recovery budget", async (context) => {
  const rootDirectory = await root(context);
  let interrupted = false;
  const first = await store(context, {
    rootDirectory,
    fault: (point) => {
      if (!interrupted && point === "prepared_record_persisted") {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    },
  });
  const spec = { ...request("registration-1", "hello"), recoveryBudget: 1 };
  await first.store.startRegistration("credential", spec);
  await first.store.transfer("credential", spec.registrationId, Buffer.from("hello")).catch(() => undefined);
  const recordPath = join(rootDirectory, "registrations", "registration-1.json");
  const record = JSON.parse(await readFile(recordPath, "utf8")) as { temporaryFile: string };
  await writeFile(join(rootDirectory, "registrations", record.temporaryFile), "damaged");
  await first.store.close();

  const reopened = await store(context, { rootDirectory });
  const status = await reopened.store.registrationStatus("credential", spec.registrationId);

  assert.equal(status.kind === "failed" ? status.reason : undefined, "recovery_budget_exceeded");
});

test("an integrity mismatch is persisted as an aborted registration", async (context) => {
  const { store: artifacts } = await store(context);
  await artifacts.startRegistration("credential", request("registration-1", "hello"));
  await artifacts.transfer("credential", "registration-1", Buffer.from("HELLO"));

  const status = await artifacts.registrationStatus("credential", "registration-1");

  assert.equal(status.kind === "failed" ? status.reason : undefined, "input_integrity_mismatch");
});

test("a transfer cannot become prepared after its fixed deadline", async (context) => {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const { store: artifacts } = await store(context, { now: () => now });
  await artifacts.startRegistration("credential", request("registration-1", "hello"));
  const stream = (async function* () {
    yield Buffer.from("hello");
    now = new Date("2026-09-07T10:02:00.000Z");
  })();

  const outcome = await artifacts.transfer("credential", "registration-1", stream);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "deadline_expired");
});

test("a stalled stream is stopped at the fixed registration deadline", async (context) => {
  const { store: artifacts } = await store(context);
  const spec = { ...request("registration-1", "hello"), deadline: "2026-09-07T10:00:00.020Z" };
  await artifacts.startRegistration("credential", spec);
  const stalled = (async function* () {
    await new Promise<void>(() => undefined);
    yield Buffer.from("hello");
  })();

  const outcome = await artifacts.transfer("credential", spec.registrationId, stalled);

  assert.equal(outcome.kind === "failed" ? outcome.reason : undefined, "deadline_expired");
});

test("recovery rechecks the registering subject's current authority", async (context) => {
  const rootDirectory = await root(context);
  const principal = new Principal();
  let interrupted = false;
  const first = await store(context, {
    rootDirectory,
    principal,
    fault: (point) => {
      if (!interrupted && point === "prepared_record_persisted") {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    },
  });
  const spec = request("registration-1", "hello");
  await first.store.startRegistration("credential", spec);
  await first.store.transfer("credential", spec.registrationId, Buffer.from("hello")).catch(() => undefined);
  await first.store.close();
  principal.decision = "revoked";

  const reopened = await store(context, { rootDirectory, principal });
  const status = await reopened.store.registrationStatus("credential", spec.registrationId);

  assert.equal(status.kind === "failed" ? status.reason : undefined, "authority_revoked");
});

test("a partially published Artifact is finalized even if authority is later revoked", async (context) => {
  const rootDirectory = await root(context);
  const allowed = new Principal();
  let interrupted = false;
  const first = await store(context, {
    rootDirectory,
    principal: allowed,
    fault: (point) => {
      if (!interrupted && point === "artifact_published") {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    },
  });
  const spec = request("registration-1", "hello");
  await first.store.startRegistration("credential", spec);
  await first.store.transfer("credential", spec.registrationId, Buffer.from("hello")).catch(() => undefined);
  await first.store.close();
  const revoked = new Principal();
  revoked.decision = "revoked";
  const reopened = await openArtifactStore({
    rootDirectory,
    policy,
    now: () => new Date("2026-09-07T10:00:00.000Z"),
    authenticator: {
      authenticate: () => Promise.resolve(allowed),
      restore: () => Promise.resolve(revoked),
    },
  });
  context.after(() => reopened.close());

  const status = await reopened.registrationStatus("credential", spec.registrationId);

  assert.equal(status.kind, "registered");
});

test("a recovery attempt does no publication when its start record cannot be saved", async (context) => {
  const rootDirectory = await root(context);
  let transferInterrupted = false;
  const first = await store(context, {
    rootDirectory,
    fault: (point) => {
      if (!transferInterrupted && point === "prepared_record_persisted") {
        transferInterrupted = true;
        throw new Error("simulated transfer interruption");
      }
    },
  });
  const spec = { ...request("registration-1", "hello"), recoveryBudget: 1 };
  await first.store.startRegistration("credential", spec);
  await first.store.transfer("credential", spec.registrationId, Buffer.from("hello")).catch(() => undefined);
  await first.store.close();
  await store(context, {
    rootDirectory,
    fault: (point) => {
      if (point === "before_recovery_attempt_persisted") throw new Error("simulated attempt-record failure");
    },
  }).catch(() => undefined);

  const reopened = await store(context, { rootDirectory });
  const status = await reopened.store.registrationStatus("credential", spec.registrationId);

  assert.equal(status.kind, "registered");
});

test("an interrupted recovery attempt consumes budget before side effects", async (context) => {
  const rootDirectory = await root(context);
  let transferInterrupted = false;
  const first = await store(context, {
    rootDirectory,
    fault: (point) => {
      if (!transferInterrupted && point === "prepared_record_persisted") {
        transferInterrupted = true;
        throw new Error("simulated transfer interruption");
      }
    },
  });
  const spec = request("registration-1", "hello");
  await first.store.startRegistration("credential", spec);
  await first.store.transfer("credential", spec.registrationId, Buffer.from("hello")).catch(() => undefined);
  await first.store.close();
  await store(context, {
    rootDirectory,
    fault: (point) => {
      if (point === "recovery_attempt_persisted") throw new Error("simulated recovery interruption");
    },
  }).catch(() => undefined);

  const reopened = await store(context, { rootDirectory });
  const status = await reopened.store.registrationStatus("credential", spec.registrationId);

  assert.equal(status.kind, "registered");
});

test("publication on the final recovery attempt is not overwritten as unresolved", async (context) => {
  const rootDirectory = await root(context);
  let transferInterrupted = false;
  const first = await store(context, {
    rootDirectory,
    fault: (point) => {
      if (!transferInterrupted && point === "prepared_record_persisted") {
        transferInterrupted = true;
        throw new Error("simulated transfer interruption");
      }
    },
  });
  const spec = { ...request("registration-1", "hello"), recoveryBudget: 1 };
  await first.store.startRegistration("credential", spec);
  await first.store.transfer("credential", spec.registrationId, Buffer.from("hello")).catch(() => undefined);
  await first.store.close();
  await store(context, {
    rootDirectory,
    fault: (point) => {
      if (point === "artifact_published") throw new Error("simulated final-attempt interruption");
    },
  }).catch(() => undefined);

  const reopened = await store(context, { rootDirectory });
  const status = await reopened.store.registrationStatus("credential", spec.registrationId);

  assert.equal(status.kind, "registered");
});

test("tampering with a dependency prevents retrieval of its parent", async (context) => {
  const { store: artifacts, rootDirectory } = await store(context);
  const dependency = await register(artifacts, "dependency-registration", "dependency");
  if (dependency.kind !== "registered") throw new Error("dependency registration failed");
  const parentSpec = request("parent-registration", "parent", [dependency.artifact.artifactId]);
  await artifacts.startRegistration("credential", parentSpec);
  const parent = await artifacts.transfer("credential", parentSpec.registrationId, Buffer.from("parent"));
  if (parent.kind !== "registered") throw new Error("parent registration failed");
  const index = JSON.parse(await readFile(join(rootDirectory, "artifacts", `${dependency.artifact.artifactId}.json`), "utf8")) as { dataFile: string };
  await writeFile(join(rootDirectory, "artifacts", index.dataFile), "changed");

  const retrieved = await artifacts.retrieve("credential", parent.artifact.artifactId);

  assert.equal(retrieved.kind === "failed" ? retrieved.reason : undefined, "stored_artifact_corrupt");
});

test("corrupt storage status is persisted after verification fails", async (context) => {
  const { store: artifacts, rootDirectory } = await store(context);
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  const metadataPath = join(rootDirectory, "artifacts", `${registered.artifact.artifactId}.json`);
  const index = JSON.parse(await readFile(metadataPath, "utf8")) as { dataFile: string };
  await writeFile(join(rootDirectory, "artifacts", index.dataFile), "changed");
  await artifacts.retrieve("credential", registered.artifact.artifactId);

  const persisted = JSON.parse(await readFile(metadataPath, "utf8")) as { storageStatus: string };

  assert.equal(persisted.storageStatus, "corrupt");
});

test("tampering with stored bytes is reported as corruption", async (context) => {
  const { store: artifacts, rootDirectory } = await store(context);
  const registered = await register(artifacts, "registration-1", "hello");
  if (registered.kind !== "registered") throw new Error("registration failed");
  const index = JSON.parse(await readFile(join(rootDirectory, "artifacts", `${registered.artifact.artifactId}.json`), "utf8")) as { dataFile: string };
  await writeFile(join(rootDirectory, "artifacts", index.dataFile), "changed");

  const retrieved = await artifacts.retrieve("credential", registered.artifact.artifactId);

  assert.equal(retrieved.kind === "failed" ? retrieved.reason : undefined, "stored_artifact_corrupt");
});
