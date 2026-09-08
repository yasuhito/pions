import { Effect } from "effect";

import type {
  ResultAcceptanceEventEvidence,
  ResultAcceptanceEventEvidenceVerifier,
  ResultAcceptanceRequirementsSource,
  ResultAcceptanceRetentionPolicySource,
} from "../public.js";
import type { EventStore } from "./event-store/index.js";

export function eventStoreResultAcceptanceSources(store: EventStore): {
  readonly requirements: ResultAcceptanceRequirementsSource;
  readonly retentionPolicy: ResultAcceptanceRetentionPolicySource;
  readonly eventEvidence: ResultAcceptanceEventEvidenceVerifier;
} {
  return {
    requirements: {
      read: async (operationId) => {
        try {
          return (await Effect.runPromise(store.read(operationId))).operation.workProductRequirements;
        } catch {
          return "unknown";
        }
      },
    },
    retentionPolicy: {
      read: async (operationId) => {
        try {
          return (await Effect.runPromise(store.read(operationId))).operation.resultRetentionPolicy;
        } catch {
          return "unknown";
        }
      },
    },
    eventEvidence: {
      verify: async (evidence: Readonly<ResultAcceptanceEventEvidence>) => {
        try {
          const result = (await Effect.runPromise(store.read(evidence.operationId))).operation.result;
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
        } catch {
          return "unknown";
        }
      },
    },
  };
}
