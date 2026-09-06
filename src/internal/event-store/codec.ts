import { Schema } from "effect";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./model.js";
import type { OperationEvent } from "./model.js";

export interface StoredOperationRecord {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly events: ReadonlyArray<OperationEvent>;
}

export class RecordDecodingError extends Error {
  constructor(
    readonly code: "corrupt_record" | "unsupported_schema",
    message: string,
  ) {
    super(message);
  }
}

const SafeInteger = Schema.Number.pipe(
  Schema.filter(Number.isSafeInteger, { message: () => "Expected a safe integer" }),
);
const Digest = Schema.String.pipe(
  Schema.filter((value) => value.startsWith("sha256:"), {
    message: () => "Expected a sha256 digest",
  }),
);

const EventMetadataFields = {
  eventId: Schema.String,
  operationId: Schema.String,
  seq: SafeInteger,
  timestamp: Schema.String,
  actorId: Schema.Literal(RUNTIME_ACTOR_ID),
  authority: Schema.Literal(OPERATION_AUTHORITY),
  schemaVersion: Schema.Literal(EVENT_SCHEMA_VERSION),
};

const Task = Schema.Struct({
  promptRef: Schema.String,
  profile: Schema.String,
  idempotencyKey: Schema.String,
});
const Lineage = Schema.Struct({
  rootOperationId: Schema.String,
  parentOperationId: Schema.optional(Schema.String),
  depth: SafeInteger,
});
const Presentation = Schema.Struct({
  kind: Schema.Literal("herdr_pane"),
  paneId: Schema.String,
  ownedByPions: Schema.Literal(true),
});
const WorkerIdentity = Schema.Struct({
  processInstanceId: Schema.String,
  piSessionId: Schema.String,
  paneId: Schema.String,
});
const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
  cost: Schema.Number,
});
const ToolUse = Schema.Struct({
  toolCallId: Schema.String,
  toolName: Schema.String,
  isError: Schema.Boolean,
});
const AgentRunEvidence = Schema.Struct({
  usage: Usage,
  toolUses: Schema.Array(ToolUse),
});
const ResultReference = Schema.Struct({
  location: Schema.String,
  byteCount: SafeInteger,
  digest: Digest,
  deliverySequenceNumber: SafeInteger,
});
const ResultConflict = Schema.Struct({
  acceptedDigest: Digest,
  conflictingDigest: Digest,
  deliverySequenceNumber: SafeInteger,
});
const FailureReason = Schema.Literal(
  "worker_start_failed",
  "worker_protocol_failed",
  "agent_failed",
  "descendant_failed",
);
const CancellationProof = Schema.Literal("acknowledgement", "worker-stop");

const OperationEventSchema = Schema.Union(
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_requested"),
    task: Task,
    lineage: Lineage,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("presentation_owned"),
    presentation: Presentation,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("child_attached"),
    childOperationId: Schema.String,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("child_settled"),
    childOperationId: Schema.String,
    outcome: Schema.Literal("succeeded", "failed"),
  }),
  Schema.Struct({ ...EventMetadataFields, type: Schema.Literal("operation_starting") }),
  Schema.Struct({ ...EventMetadataFields, type: Schema.Literal("worker_launched") }),
  Schema.Struct({ ...EventMetadataFields, type: Schema.Literal("operation_started") }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("worker_identified"),
    workerIdentity: WorkerIdentity,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("agent_settled"),
    evidence: AgentRunEvidence,
  }),
  Schema.Struct({ ...EventMetadataFields, type: Schema.Literal("operation_blocked") }),
  Schema.Struct({ ...EventMetadataFields, type: Schema.Literal("operation_unblocked") }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("result_persisted"),
    result: ResultReference,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("result_conflict_recorded"),
    conflict: ResultConflict,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("self_settled"),
    outcome: Schema.Literal("succeeded"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("self_settled"),
    outcome: Schema.Literal("failed"),
    reason: FailureReason,
  }),
  Schema.Struct({ ...EventMetadataFields, type: Schema.Literal("operation_completed") }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("cancellation_requested"),
    cancellationEpoch: SafeInteger,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("cancel_dispatched"),
    cancellationEpoch: SafeInteger,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("cancel_acknowledged"),
    cancellationEpoch: SafeInteger,
    proof: CancellationProof,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_cancelled"),
    cancellationEpoch: SafeInteger,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_unknown"),
    cancellationEpoch: SafeInteger,
    reason: Schema.Literal("cancel-unproven"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_failed"),
    reason: FailureReason,
  }),
);

const StoredOperationRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(EVENT_SCHEMA_VERSION),
  operationId: Schema.String,
  events: Schema.Array(OperationEventSchema),
});

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rejectUnsupportedSchema(value: unknown): void {
  const record = recordObject(value);
  const recordVersion = record?.schemaVersion;
  if (typeof recordVersion === "number" && recordVersion !== EVENT_SCHEMA_VERSION) {
    throw new RecordDecodingError(
      "unsupported_schema",
      `Unsupported record schema ${recordVersion}`,
    );
  }
  if (!Array.isArray(record?.events)) return;
  for (const value of record.events) {
    const eventVersion = recordObject(value)?.schemaVersion;
    if (typeof eventVersion === "number" && eventVersion !== EVENT_SCHEMA_VERSION) {
      throw new RecordDecodingError(
        "unsupported_schema",
        `Unsupported event schema ${eventVersion}`,
      );
    }
  }
}

export function decodeRecord(
  value: unknown,
  operationId: string,
): StoredOperationRecord {
  rejectUnsupportedSchema(value);

  let record: StoredOperationRecord;
  try {
    record = Schema.decodeUnknownSync(StoredOperationRecordSchema)(value) as StoredOperationRecord;
  } catch (error) {
    throw new RecordDecodingError(
      "corrupt_record",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (record.operationId !== operationId) {
    throw new RecordDecodingError(
      "corrupt_record",
      "Operation identifier does not match record path",
    );
  }
  for (const event of record.events) {
    if (
      event.eventId !== `${operationId}:${event.seq}` ||
      event.operationId !== operationId ||
      event.timestamp.length === 0
    ) {
      throw new RecordDecodingError("corrupt_record", "Invalid event envelope");
    }
  }
  return record;
}
