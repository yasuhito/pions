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
    message: string,
  ) {
    super(message);
  }
}

const SafeInteger = Schema.Number.pipe(
  Schema.filter(Number.isSafeInteger, { message: () => "Expected a safe integer" }),
);
const NonNegativeSafeInteger = SafeInteger.pipe(
  Schema.filter((value) => value >= 0, { message: () => "Expected a non-negative safe integer" }),
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
  promptRef: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
  ...RequestedWorkerConfigSchema.fields,
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
  processId: SafeInteger,
  processInstanceId: Schema.String,
  processStartToken: Schema.String,
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
const StartAuthorizationTiming = Schema.Struct({
  createdAt: Schema.String,
  windowMs: NonNegativeSafeInteger,
  deadline: Schema.String,
});
const WorkspaceReceipt = Schema.Struct({
  workspaceId: Schema.String,
  normalizedPath: Schema.String,
  baseRevision: Schema.String,
  owner: Schema.Union(
    Schema.Struct({ state: Schema.Literal("known"), ownerId: Schema.String }),
    Schema.Struct({ state: Schema.Literal("unknown") }),
  ),
  pionsMayDelete: Schema.Literal(false),
});
const PermissionManifestReceipt = Schema.Struct({
  manifestId: Schema.String,
  digest: Digest,
});
const ReviewSubjectReceipt = Schema.Struct({
  artifactId: Schema.String,
  byteCount: NonNegativeSafeInteger,
  digest: Digest,
  format: Schema.String,
  normalization: Schema.String,
});
const StartupReceipt = Schema.Struct({
  operationId: Schema.String,
  digest: Digest,
  recordedAt: Schema.String,
  workerIdentity: WorkerIdentity,
  requestedConfig: RequestedWorkerConfigSchema,
  effectiveConfig: EffectiveWorkerConfigSchema,
  observedConfig: ObservedWorkerConfigSchema,
  workspace: WorkspaceReceipt,
  permissionManifest: PermissionManifestReceipt,
  reviewSubject: ReviewSubjectReceipt,
  configuredAuthorizationPolicy: Schema.Literal("disabled", "optional", "required"),
  authorizationPolicy: Schema.Literal("disabled", "required"),
  authorizationDeadline: Schema.String,
});
const StartInstructionReference = Schema.Struct({
  workerProcessInstanceId: Schema.String,
  receiptDigest: Digest,
  authorizationDecisionId: Schema.optional(Schema.String),
  deliveryGeneration: NonNegativeSafeInteger,
});
const StartAuthorizationDecision = Schema.Struct({
  decisionId: Schema.String,
  kind: Schema.Literal("authorize", "reject"),
  actorId: Schema.String,
  receiptDigest: Digest,
  decidedAt: Schema.String,
});
const ResultConflict = Schema.Struct({
  acceptedDigest: Digest,
  conflictingDigest: Digest,
  deliverySequenceNumber: SafeInteger,
});
const FailureReason = Schema.Literal(
  "worker_start_failed",
  "worker_protocol_failed",
  "process-exited-without-result",
  "agent_failed",
  "model_mismatch",
  "thinking_level_mismatch",
  "model_not_found",
  "model_auth_unavailable",
  "unsupported_capability",
  "tool_policy_violation",
  "descendant_failed",
);
const CancellationProof = Schema.Literal("worker-stop");

const OperationEventSchema = Schema.Union(
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_requested"),
    task: Task,
    requestedConfig: RequestedWorkerConfigSchema,
    effectiveConfig: EffectiveWorkerConfigSchema,
    lineage: Lineage,
    startAuthorizationTiming: StartAuthorizationTiming,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("startup_receipt_recorded"),
    receipt: StartupReceipt,
    gate: Schema.Literal("not_required", "waiting"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_authorization_decided"),
    gate: Schema.Literal("authorized", "rejected"),
    decision: StartAuthorizationDecision,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_gate_closed"),
    gate: Schema.Literal("expired", "invalidated"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_instruction_dispatched"),
    instruction: StartInstructionReference,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_instruction_accepted"),
    instruction: StartInstructionReference,
    proof: Schema.Literal("authenticated-worker-acknowledgement"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("worker_stop_confirmed"),
    proof: Schema.Literal("worker-stop"),
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
  Schema.Struct({ ...EventMetadataFields, type: Schema.Literal("automatic_operation_started") }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("worker_identified"),
    workerIdentity: WorkerIdentity,
    observedConfig: ObservedWorkerConfigSchema,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("agent_settled"),
    evidence: AgentRunEvidence,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("presentation_cleanup_failed"),
    reason: Schema.Literal("pane_close_failed"),
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
    type: Schema.Literal("operation_unknown"),
    reason: Schema.Literal("liveness-unproven"),
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
