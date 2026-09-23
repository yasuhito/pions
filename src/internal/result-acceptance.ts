import { Effect } from "effect";

import type { EventStore } from "./event-store/index.js";
import { sha256Digest } from "./result-digest.js";
import type { ResultAcceptanceProof } from "./worker-protocol.js";
import type {
  AcceptedResult,
  ResultAcceptanceTransactionFailureReason,
  WorkerProducedResult,
} from "./types.js";

export type ResultAcceptanceFailureReason =
  | ResultAcceptanceTransactionFailureReason
  | "input_integrity_mismatch"
  | "cancelled";

export type ResultAcceptanceOutcome =
  | {
      readonly state: "accepted";
      readonly proof: Readonly<ResultAcceptanceProof>;
    }
  | {
      readonly state: "continuable";
      readonly reason: "write_failed";
    }
  | {
      readonly state: "failed";
      readonly terminal: true;
      readonly reason: ResultAcceptanceFailureReason;
    };

export interface ResultAcceptance {
  accept(
    operationId: string,
    result: Readonly<WorkerProducedResult>
  ): Effect.Effect<ResultAcceptanceOutcome>;
}

interface ResultAcceptanceDependencies {
  readonly store: EventStore;
}

function failed(
  reason: ResultAcceptanceFailureReason
): ResultAcceptanceOutcome {
  return { state: "failed", terminal: true, reason };
}

function acceptanceProof(
  acceptance: Readonly<AcceptedResult>
): ResultAcceptanceProof {
  return {
    operationId: acceptance.operationId,
    acceptanceId: acceptance.acceptanceId,
    digest: acceptance.digest,
    eventSequenceNumber: acceptance.eventSequenceNumber,
  } as ResultAcceptanceProof;
}

/** Encodes the final answer exactly once and proves the Worker's integrity claim. */
function materializeBody(
  result: Readonly<WorkerProducedResult>
): Buffer | undefined {
  const bytes = Buffer.from(result.body, "utf8");
  if (
    new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== result.body ||
    bytes.byteLength !== result.expectedByteCount ||
    sha256Digest(bytes) !== result.expectedDigest
  )
    return undefined;
  return bytes;
}

export function makeResultAcceptance(
  dependencies: ResultAcceptanceDependencies
): ResultAcceptance {
  return {
    accept: (operationId, produced) =>
      Effect.promise(async () => {
        const stored = await Effect.runPromise(
          Effect.either(dependencies.store.read(operationId))
        );
        if (stored._tag === "Left") {
          return failed(
            stored.left.code === "not_found"
              ? "operation_not_found"
              : stored.left.code === "unsupported_schema"
                ? "unsupported_schema"
                : "corrupt_record"
          );
        }
        const bytes = materializeBody(produced);
        if (bytes === undefined) return failed("input_integrity_mismatch");
        const outcome = await Effect.runPromise(
          dependencies.store.acceptResult({
            operationId,
            acceptanceRequestId: produced.acceptanceRequestId,
            bytes,
          })
        );
        if (outcome.kind === "accepted") {
          return {
            state: "accepted",
            proof: acceptanceProof(outcome.acceptance),
          };
        }
        if (outcome.kind === "continuable") {
          return { state: "continuable", reason: outcome.reason };
        }
        return failed(outcome.reason);
      }),
  };
}
