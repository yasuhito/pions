import { Schema } from "effect";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./model.js";
import type { OperationEvent } from "./model.js";
import {
  EffectiveWorkerConfigSchema,
  ObservedWorkerConfigSchema,
  RequestedWorkerConfigSchema,
} from "../worker-configuration.js";

export interface StoredOperationRecord {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly events: ReadonlyArray<OperationEvent>;
}

export class RecordDecodingError extends Error {
  constructor(
    readonly code: "corrupt_record" | "unsupported_schema",
    message: string
  ) {
    super(message);
  }
}

const SafeInteger = Schema.Number.pipe(
  Schema.filter(Number.isSafeInteger, {
    message: () => "Expected a safe integer",
  })
);
const NonNegativeSafeInteger = SafeInteger.pipe(
  Schema.filter((value) => value >= 0, {
    message: () => "Expected a non-negative safe integer",
  })
);
const Digest = Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/u));
const Metadata = {
  eventId: Schema.String,
  operationId: Schema.String,
  seq: SafeInteger,
  timestamp: Schema.String,
  actorId: Schema.Literal(RUNTIME_ACTOR_ID),
  authority: Schema.Literal(OPERATION_AUTHORITY),
  schemaVersion: Schema.Literal(EVENT_SCHEMA_VERSION),
};
const Task = Schema.Struct({
  promptRef: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
  ...RequestedWorkerConfigSchema.fields,
});
const Presentation = Schema.Struct({
  kind: Schema.Literal("herdr_workspace"),
  workspaceId: Schema.NonEmptyString,
  paneId: Schema.NonEmptyString,
  ownedByPions: Schema.Literal(true),
});
const WorkerIdentity = Schema.Struct({
  processId: SafeInteger,
  processInstanceId: Schema.NonEmptyString,
  processStartToken: Schema.NonEmptyString,
  piSessionId: Schema.NonEmptyString,
  paneId: Schema.NonEmptyString,
});
const StartInstructionReference = Schema.Struct({
  dispatcherId: Schema.NonEmptyString,
  workerProcessInstanceId: Schema.NonEmptyString,
  receiptDigest: Digest,
  deliveryGeneration: NonNegativeSafeInteger,
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
  errorMessage: Schema.optional(Schema.String),
});
const AcceptedResult = Schema.Struct({
  acceptanceId: Schema.String,
  operationId: Schema.String,
  acceptanceRequestId: Schema.String,
  acceptedAt: Schema.String,
  eventSequenceNumber: SafeInteger,
  byteCount: NonNegativeSafeInteger,
  digest: Digest,
});
const FailureReason = Schema.Literal(
  "worker_start_failed",
  "worker_protocol_failed",
  "process-exited-without-result",
  "agent_failed",
  "model_mismatch",
  "thinking_level_mismatch",
  "tool_policy_violation"
);
const CleanupDiagnostic = Schema.Literal(
  "workspace_close_failed",
  "workspace_identity_missing",
  "workspace_identity_unavailable",
  "cleanup_record_unavailable"
);

const OperationEventSchema = Schema.Union(
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("operation_requested"),
    task: Task,
    requestedConfig: RequestedWorkerConfigSchema,
    effectiveConfig: EffectiveWorkerConfigSchema,
    maxResultByteCount: NonNegativeSafeInteger,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("presentation_owned"),
    presentation: Presentation,
  }),
  Schema.Struct({ ...Metadata, type: Schema.Literal("operation_starting") }),
  Schema.Struct({ ...Metadata, type: Schema.Literal("worker_launched") }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("worker_identified"),
    workerIdentity: WorkerIdentity,
    observedConfig: ObservedWorkerConfigSchema,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("start_delivery_authority_acquired"),
    instruction: StartInstructionReference,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("start_delivery_authority_revoked"),
    successorDispatcherId: Schema.NonEmptyString,
    deliveryGeneration: NonNegativeSafeInteger,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("start_delivery_generation_confirmed"),
    dispatcherId: Schema.NonEmptyString,
    deliveryGeneration: NonNegativeSafeInteger,
    acceptanceState: Schema.Literal("not_accepted", "accepted", "unknown"),
    acceptedInstruction: Schema.optional(StartInstructionReference),
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("start_delivery_entered"),
    instruction: StartInstructionReference,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("start_instruction_dispatched"),
    instruction: StartInstructionReference,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("start_instruction_accepted"),
    instruction: StartInstructionReference,
    proof: Schema.Literal("worker-durable-acceptance"),
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("start_instruction_acknowledged"),
    instruction: StartInstructionReference,
    proof: Schema.Literal(
      "authenticated-worker-acknowledgement",
      "authenticated-generation-acknowledgement"
    ),
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("result_accepted"),
    acceptance: AcceptedResult,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("worker_stop_confirmed"),
    proof: Schema.Literal("worker-stop"),
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("agent_settled"),
    evidence: AgentRunEvidence,
  }),
  Schema.Struct({ ...Metadata, type: Schema.Literal("operation_completed") }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("operation_failed"),
    reason: FailureReason,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("cancellation_requested"),
    cancellationEpoch: SafeInteger,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("cancel_dispatched"),
    cancellationEpoch: SafeInteger,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("cancel_acknowledged"),
    cancellationEpoch: SafeInteger,
    proof: Schema.Literal("worker-stop"),
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("operation_cancelled"),
    cancellationEpoch: SafeInteger,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("operation_unknown"),
    reason: Schema.Literal(
      "cancel-unproven",
      "start-acceptance-unknown",
      "liveness-unproven"
    ),
    cancellationEpoch: Schema.optional(SafeInteger),
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("presentation_cleanup_started"),
    cleanupId: Schema.NonEmptyString,
    workspaceId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("presentation_cleanup_completed"),
    cleanupId: Schema.NonEmptyString,
    workspaceId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...Metadata,
    type: Schema.Literal("presentation_cleanup_unconfirmed"),
    cleanupId: Schema.NonEmptyString,
    workspaceId: Schema.NonEmptyString,
    reason: CleanupDiagnostic,
  })
);

const StoredOperationRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(EVENT_SCHEMA_VERSION),
  operationId: Schema.String,
  events: Schema.Array(OperationEventSchema),
});

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rejectUnsupportedSchema(value: unknown): void {
  const record = object(value);
  if (
    typeof record?.schemaVersion === "number" &&
    record.schemaVersion !== EVENT_SCHEMA_VERSION
  )
    throw new RecordDecodingError(
      "unsupported_schema",
      `Unsupported record schema ${record.schemaVersion}`
    );
  if (!Array.isArray(record?.events)) return;
  for (const candidate of record.events) {
    const version = object(candidate)?.schemaVersion;
    if (typeof version === "number" && version !== EVENT_SCHEMA_VERSION)
      throw new RecordDecodingError(
        "unsupported_schema",
        `Unsupported event schema ${version}`
      );
  }
}

export function decodeRecord(
  value: unknown,
  operationId: string
): StoredOperationRecord {
  rejectUnsupportedSchema(value);
  let record: StoredOperationRecord;
  try {
    record = Schema.decodeUnknownSync(StoredOperationRecordSchema)(
      value
    ) as StoredOperationRecord;
  } catch (error) {
    throw new RecordDecodingError(
      "corrupt_record",
      error instanceof Error ? error.message : String(error)
    );
  }
  if (record.operationId !== operationId)
    throw new RecordDecodingError(
      "corrupt_record",
      "Operation identifier does not match record path"
    );
  for (const event of record.events) {
    if (
      event.eventId !== `${operationId}:${event.seq}` ||
      event.operationId !== operationId ||
      event.timestamp.length === 0
    )
      throw new RecordDecodingError("corrupt_record", "Invalid event envelope");
  }
  return record;
}
