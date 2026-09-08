import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import { openArtifactStore } from "./artifact-store.js";
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

function trustedPrincipal(subjectId: string): ArtifactPrincipal {
  return {
    subjectId,
    canRegister: async () => "allowed",
    canReference: async () => "allowed",
    canRetrieve: async () => "allowed",
    canBindArtifactUse: async () => "allowed",
    canPinArtifact: async () => "allowed",
    canPrepareResultAcceptance: async () => "allowed",
    canReconcileResultAcceptance: async () => "allowed",
    canGarbageCollect: async () => "allowed",
  };
}

export function runtimeArtifactStore(
  stateDirectory: string,
  store: EventStore,
  now?: () => Date,
): {
  readonly artifacts: ArtifactStore;
  readonly credential: string;
  readonly synchronizeClock: (timestamp: string) => void;
} {
  const credential = randomBytes(32).toString("hex");
  const principal = trustedPrincipal(`runtime.${randomUUID()}`);
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
  const opened = openArtifactStore({
    rootDirectory: join(stateDirectory, "artifacts"),
    policy,
    authenticator,
    resultAcceptanceRequirementsSource: sources.requirements,
    resultAcceptanceRetentionPolicySource: sources.retentionPolicy,
    resultAcceptanceEventEvidenceVerifier: sources.eventEvidence,
    now: now ?? (() => synchronizedNow),
  });
  return {
    credential,
    synchronizeClock: (timestamp) => { synchronizedNow = new Date(timestamp); },
    artifacts: {
      startRegistration: (...args) => opened.then((value) => value.startRegistration(...args)),
      transfer: (...args) => opened.then((value) => value.transfer(...args)),
      registrationStatus: (...args) => opened.then((value) => value.registrationStatus(...args)),
      retrieve: (...args) => opened.then((value) => value.retrieve(...args)),
      prepareUseBinding: (...args) => opened.then((value) => value.prepareUseBinding(...args)),
      useBindingStatus: (...args) => opened.then((value) => value.useBindingStatus(...args)),
      retrieveForUseBinding: (...args) => opened.then((value) => value.retrieveForUseBinding(...args)),
      releaseUseBinding: (...args) => opened.then((value) => value.releaseUseBinding(...args)),
      createRetentionPin: (...args) => opened.then((value) => value.createRetentionPin(...args)),
      releaseRetentionPin: (...args) => opened.then((value) => value.releaseRetentionPin(...args)),
      prepareResultAcceptance: (...args) => opened.then((value) => value.prepareResultAcceptance(...args)),
      resultAcceptancePreparationStatus: (...args) => opened.then((value) => value.resultAcceptancePreparationStatus(...args)),
      finalizeResultAcceptance: (...args) => opened.then((value) => value.finalizeResultAcceptance(...args)),
      abortResultAcceptance: (...args) => opened.then((value) => value.abortResultAcceptance(...args)),
      collectGarbage: (...args) => opened.then((value) => value.collectGarbage(...args)),
      close: () => opened.then((value) => value.close()),
    },
  };
}
