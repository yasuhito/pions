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
    // The Event Store publishes Result acceptance as Operation-owned UTF-8
    // text, so it never issues Artifact-backed preparation evidence.
    eventEvidenceSource: {
      read: async () => "unknown",
    },
    eventEvidence: {
      verify: async (evidence: Readonly<ResultAcceptanceEventEvidence>) => {
        const operation = await readOperation(store, evidence.operationId);
        if (operation === "unknown") return "unknown";
        return operation.result === undefined &&
          evidence.state === "not_accepted"
          ? "trusted"
          : "untrusted";
      },
    },
  };
}
