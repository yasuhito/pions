import { Effect } from "effect";

import type {
  ResultAcceptanceEventEvidence,
  ResultAcceptanceEventEvidenceSource,
  ResultAcceptanceEventEvidenceVerifier,
  ResultAcceptanceRequirementsSource,
  ResultAcceptanceRetentionPolicySource,
} from "../public.js";
import type { EventStore, Operation } from "./event-store/index.js";

async function readOperation(
  store: EventStore,
  operationId: string
): Promise<Readonly<Operation> | "unknown"> {
  const stored = await Effect.runPromise(
    Effect.either(store.read(operationId))
  );
  return stored._tag === "Left" ? "unknown" : stored.right.operation;
}

export function eventStoreResultAcceptanceSources(store: EventStore): {
  readonly requirements: ResultAcceptanceRequirementsSource;
  readonly retentionPolicy: ResultAcceptanceRetentionPolicySource;
  readonly eventEvidence: ResultAcceptanceEventEvidenceVerifier;
  readonly eventEvidenceSource: ResultAcceptanceEventEvidenceSource;
} {
  return {
    requirements: {
      read: async (operationId) => {
        const operation = await readOperation(store, operationId);
        return operation === "unknown"
          ? "unknown"
          : operation.workProductRequirements;
      },
    },
    retentionPolicy: {
      read: async (operationId) => {
        const operation = await readOperation(store, operationId);
        return operation === "unknown"
          ? "unknown"
          : operation.resultRetentionPolicy;
      },
    },
    eventEvidenceSource: {
      read: async (operationId, preparationId) => {
        const operation = await readOperation(store, operationId);
        const result = operation === "unknown" ? undefined : operation.result;
        if (result === undefined || result.preparationId !== preparationId)
          return "unknown";
        return {
          preparationId: result.preparationId,
          operationId: result.operationId,
          acceptanceRequestId: result.acceptanceRequestId,
          manifestDigest: result.manifestDigest,
          evidenceDigest: result.preparationEvidence.digest,
          state: "accepted",
          observedAt: result.acceptedAt,
          acceptedAt: result.acceptedAt,
        };
      },
    },
    eventEvidence: {
      verify: async (evidence: Readonly<ResultAcceptanceEventEvidence>) => {
        const operation = await readOperation(store, evidence.operationId);
        if (operation === "unknown") return "unknown";
        const result = operation.result;
        if (result === undefined) {
          return evidence.state === "not_accepted" ? "trusted" : "untrusted";
        }
        return evidence.state === "accepted" &&
          evidence.preparationId === result.preparationId &&
          evidence.acceptanceRequestId === result.acceptanceRequestId &&
          evidence.manifestDigest === result.manifestDigest &&
          evidence.evidenceDigest === result.preparationEvidence.digest &&
          evidence.acceptedAt === result.acceptedAt
          ? "trusted"
          : "untrusted";
      },
    },
  };
}
