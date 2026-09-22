import { Effect } from "effect";

import type { EventStore } from "./event-store/index.js";
import { sha256Digest } from "./result-digest.js";
import type { ResultFormatRegistry } from "./result-format-registry.js";
import type { ResultAcceptanceProof } from "./worker-protocol.js";
import type {
  AcceptedResult,
  PinnedResultFormat,
  ResultAcceptanceTransactionFailureReason,
  ResultFormatRejectionEvidence,
  WorkerProducedArtifact,
  WorkerProducedResult,
} from "../public.js";

export type ResultAcceptanceFailureReason =
  | ResultAcceptanceTransactionFailureReason
  | "input_integrity_mismatch"
  | "work_products_unsupported"
  | "result_format_rejected"
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
      readonly resultFormatRejection?: Readonly<ResultFormatRejectionEvidence>;
    };

export interface ResultAcceptance {
  accept(
    operationId: string,
    result: Readonly<WorkerProducedResult>
  ): Effect.Effect<ResultAcceptanceOutcome>;
}

interface ResultAcceptanceDependencies {
  readonly store: EventStore;
  readonly resultFormats?: ResultFormatRegistry;
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

/** Collects the declared body bytes and proves they match the Worker's own integrity claim. */
async function materializeBody(
  artifact: Readonly<WorkerProducedArtifact>
): Promise<Buffer | undefined> {
  const chunks: Array<Buffer> = [];
  let byteCount = 0;
  if (artifact.bytes instanceof Uint8Array) {
    chunks.push(Buffer.from(artifact.bytes));
    byteCount = artifact.bytes.byteLength;
  } else {
    for await (const chunk of artifact.bytes) {
      byteCount += chunk.byteLength;
      if (byteCount > artifact.expectedByteCount) return undefined;
      chunks.push(Buffer.from(chunk));
    }
  }
  const bytes = Buffer.concat(chunks);
  if (
    byteCount !== artifact.expectedByteCount ||
    sha256Digest(bytes) !== artifact.expectedDigest
  )
    return undefined;
  return bytes;
}

async function validateResultFormat(
  dependencies: ResultAcceptanceDependencies,
  resultFormat: Readonly<PinnedResultFormat>,
  bytes: Buffer
): Promise<ResultAcceptanceOutcome | undefined> {
  const validation =
    dependencies.resultFormats === undefined
      ? ({ kind: "invalid", reason: "validator_unavailable" } as const)
      : await dependencies.resultFormats.validate(
          resultFormat,
          Uint8Array.from(bytes)
        );
  if (validation.kind !== "invalid") return undefined;
  return {
    state: "failed",
    terminal: true,
    reason: "result_format_rejected",
    resultFormatRejection: {
      formatId: resultFormat.formatId,
      version: resultFormat.version,
      validator: structuredClone(resultFormat.validator),
      reason: validation.reason,
    },
  };
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
        if (produced.workProducts.length > 0) {
          return failed("work_products_unsupported");
        }
        const bytes = await materializeBody(produced.body);
        if (bytes === undefined) return failed("input_integrity_mismatch");
        const operation = stored.right.operation;
        // A resent request for an already accepted Result joins the persisted
        // acceptance and is never reinterpreted by a later validator.
        if (
          operation.result === undefined &&
          operation.resultFormat !== undefined
        ) {
          const rejection = await validateResultFormat(
            dependencies,
            operation.resultFormat,
            bytes
          );
          if (rejection !== undefined) return rejection;
        }
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
