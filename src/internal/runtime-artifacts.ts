import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import { Effect } from "effect";

import {
  openArtifactStore,
  openArtifactStoreWithFaultInjection,
  type ArtifactStoreFaultPoint,
} from "./artifact-store.js";
import { eventStoreResultAcceptanceSources } from "./event-store-result-acceptance-sources.js";
import type { EventStore } from "./event-store/index.js";
import type { ArtifactAuthenticator, ArtifactPrincipal, ArtifactStore } from "../public.js";

const policy = {
  maxArtifactBytes: 1024 * 1024,
  maxConcurrentRegistrations: 16,
  maxTemporaryBytes: 16 * 1024 * 1024,
  maxDirectDependencies: 16,
  maxDependencyDepth: 8,
  maxDependencyCount: 128,
  maxRegistrationWindowMs: 60_000,
  maxRecoveryAttempts: 3,
  unusedArtifactRetentionMs: 86_400_000,
  reviewInputRetentionMs: 86_400_000,
  maxGarbageCollectionScan: 1_000,
  maxGarbageCollectionDeletes: 100,
  maxGarbageCollectionRecoveryAttempts: 3,
} as const;

function runtimePrincipal(subjectId: string, store: EventStore): ArtifactPrincipal {
  const canUseForResultAcceptance: ArtifactPrincipal["canPrepareResultAcceptance"] =
    async (request, artifactId) => {
      const stored = await Effect.runPromise(Effect.either(store.read(request.operationId)));
      if (stored._tag === "Left") {
        return stored.left.code === "not_found" ? "denied" : "unknown";
      }
      const reservation = stored.right.operation.resultAcceptanceReservation;
      return reservation?.preparationId === request.preparationId &&
          reservation.acceptanceRequestId === request.acceptanceRequestId &&
          reservation.manifestDigest === request.manifestDigest &&
          reservation.artifactIds.includes(artifactId)
        ? "allowed"
        : "denied";
    };
  return {
    subjectId,
    canRegister: async () => "allowed",
    canReference: async () => "allowed",
    canRetrieve: async () => "allowed",
    canBindArtifactUse: async () => "allowed",
    canPinArtifact: async () => "allowed",
    canPrepareResultAcceptance: canUseForResultAcceptance,
    canReconcileResultAcceptance: async () => "allowed",
    canGarbageCollect: async () => "allowed",
  };
}

export function runtimeArtifactStore(
  stateDirectory: string,
  store: EventStore,
  now?: () => Date,
  fault?: (point: ArtifactStoreFaultPoint) => void | Promise<void>,
): {
  readonly artifacts: ArtifactStore;
  readonly credential: string;
  readonly synchronizeClock: (timestamp: string) => void;
} {
  const credential = randomBytes(32).toString("hex");
  const principal = runtimePrincipal(`runtime.${randomUUID()}`, store);
  const authenticator: ArtifactAuthenticator = {
    authenticate: async (value) => {
      if (value !== credential) throw new Error("invalid artifact credential");
      return principal;
    },
    restore: async (subjectId) => {
      if (subjectId !== principal.subjectId) throw new Error("unknown artifact principal");
      return principal;
    },
  };
  const sources = eventStoreResultAcceptanceSources(store);
  let synchronizedNow = new Date();
  const options = {
    rootDirectory: join(stateDirectory, "artifacts"),
    policy,
    authenticator,
    resultAcceptanceRequirementsSource: sources.requirements,
    resultAcceptanceRetentionPolicySource: sources.retentionPolicy,
    resultAcceptanceEventEvidenceVerifier: sources.eventEvidence,
    resultAcceptanceEventEvidenceSource: sources.eventEvidenceSource,
    now: now ?? (() => synchronizedNow),
  };
  let opened: Promise<ArtifactStore> | undefined;
  let closed = false;
  const open = (): Promise<ArtifactStore> => {
    if (closed) return Promise.reject(new Error("Runtime Artifact Store is closed"));
    opened ??= fault === undefined
      ? openArtifactStore(options)
      : openArtifactStoreWithFaultInjection(options, fault);
    return opened;
  };
  return {
    credential,
    synchronizeClock: (timestamp) => { synchronizedNow = new Date(timestamp); },
    artifacts: {
      startRegistration: (...args) => open().then((value) => value.startRegistration(...args)),
      transfer: (...args) => open().then((value) => value.transfer(...args)),
      registrationStatus: (...args) => open().then((value) => value.registrationStatus(...args)),
      retrieve: (...args) => open().then((value) => value.retrieve(...args)),
      prepareUseBinding: (...args) => open().then((value) => value.prepareUseBinding(...args)),
      useBindingStatus: (...args) => open().then((value) => value.useBindingStatus(...args)),
      retrieveForUseBinding: (...args) => open().then((value) => value.retrieveForUseBinding(...args)),
      releaseUseBinding: (...args) => open().then((value) => value.releaseUseBinding(...args)),
      createRetentionPin: (...args) => open().then((value) => value.createRetentionPin(...args)),
      releaseRetentionPin: (...args) => open().then((value) => value.releaseRetentionPin(...args)),
      prepareResultAcceptance: (...args) => open().then((value) => value.prepareResultAcceptance(...args)),
      resultAcceptancePreparationStatus: (...args) => open().then((value) => value.resultAcceptancePreparationStatus(...args)),
      finalizeResultAcceptance: (...args) => open().then((value) => value.finalizeResultAcceptance(...args)),
      abortResultAcceptance: (...args) => open().then((value) => value.abortResultAcceptance(...args)),
      collectGarbage: (...args) => open().then((value) => value.collectGarbage(...args)),
      close: () => {
        closed = true;
        return opened?.then((value) => value.close()) ?? Promise.resolve();
      },
    },
  };
}
