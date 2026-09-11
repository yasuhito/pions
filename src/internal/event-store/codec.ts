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
const Digest = Schema.String.pipe(
  Schema.filter((value) => value.startsWith("sha256:"), {
    message: () => "Expected a sha256 digest",
  })
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
const RevisionMembership = Schema.Struct({
  seriesId: Schema.NonEmptyString,
  revisionNumber: NonNegativeSafeInteger,
  attemptNumber: NonNegativeSafeInteger,
});
const Presentation = Schema.Struct({
  kind: Schema.Literal("herdr_pane"),
  paneId: Schema.String,
  ownedByPions: Schema.Literal(true),
});
const CleanupDiagnosticCode = Schema.Literal(
  "pane_close_failed",
  "pane_identity_missing",
  "pane_identity_unavailable",
  "cleanup_record_unavailable"
);
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
const ArtifactContentRequirement = Schema.Struct({
  formatId: Schema.String,
  normalizationId: Schema.String,
  maxByteCount: NonNegativeSafeInteger,
});
const WorkProductRequirement = Schema.Struct({
  key: Schema.String,
  formatId: Schema.String,
  normalizationId: Schema.String,
  maxByteCount: NonNegativeSafeInteger,
  minCount: NonNegativeSafeInteger,
  maxCount: NonNegativeSafeInteger,
});
const ResolvedWorkProductRequirements = Schema.Struct({
  requirementSetId: Schema.String,
  digest: Digest,
  canonicalJson: Schema.String,
  body: ArtifactContentRequirement,
  workProducts: Schema.Array(WorkProductRequirement),
  maxTotalByteCount: NonNegativeSafeInteger,
});
const ResultAcceptanceRetentionPolicy = Schema.Struct({
  formatId: Schema.Literal("pions.result-acceptance-retention-policy.v1"),
  operationId: Schema.String,
  acceptedArtifactRetentionMs: NonNegativeSafeInteger,
  digest: Digest,
});
const ResultAcceptanceManifestWorkProduct = Schema.Struct({
  key: Schema.String,
  artifactIds: Schema.Array(Schema.String),
});
const ResultAcceptanceManifest = Schema.Struct({
  formatId: Schema.Literal("pions.result-acceptance-manifest.v1"),
  normalizationId: Schema.Literal("pions.canonical-json.v1"),
  bodyArtifactId: Schema.String,
  requirementSetId: Schema.String,
  requirementSetDigest: Digest,
  workProducts: Schema.Array(ResultAcceptanceManifestWorkProduct),
});
const ResultAcceptanceReservation = Schema.Struct({
  preparationId: Schema.String,
  operationId: Schema.String,
  acceptanceRequestId: Schema.String,
  manifest: ResultAcceptanceManifest,
  manifestCanonicalJson: Schema.String,
  manifestDigest: Digest,
  requirementSetId: Schema.String,
  requirementsDigest: Digest,
  artifactIds: Schema.Array(Schema.String),
  totalByteCount: NonNegativeSafeInteger,
  preparedAt: Schema.String,
});
const ResultAcceptancePreparationEvidence = Schema.Struct({
  formatId: Schema.Literal("pions.result-acceptance-preparation.v1"),
  preparationId: Schema.String,
  operationId: Schema.String,
  acceptanceRequestId: Schema.String,
  manifestDigest: Digest,
  requirementsDigest: Digest,
  bodyArtifactId: Schema.String,
  workProducts: Schema.Array(ResultAcceptanceManifestWorkProduct),
  artifactIds: Schema.Array(Schema.String),
  totalByteCount: NonNegativeSafeInteger,
  acceptedArtifactRetentionMs: NonNegativeSafeInteger,
  retentionPolicyDigest: Digest,
  digest: Digest,
});
const AcceptedResult = Schema.Struct({
  acceptanceId: Schema.String,
  preparationId: Schema.String,
  operationId: Schema.String,
  acceptanceRequestId: Schema.String,
  acceptedAt: Schema.String,
  eventSequenceNumber: SafeInteger,
  manifestFormatId: Schema.Literal("pions.result-acceptance-manifest.v1"),
  manifestNormalizationId: Schema.Literal("pions.canonical-json.v1"),
  manifestDigest: Digest,
  requirementSetId: Schema.String,
  requirementsDigest: Digest,
  bodyArtifactId: Schema.String,
  workProducts: Schema.Array(ResultAcceptanceManifestWorkProduct),
  artifactIds: Schema.Array(Schema.String),
  preparationEvidence: ResultAcceptancePreparationEvidence,
  acceptedArtifactRetentionMs: NonNegativeSafeInteger,
  retentionPolicyDigest: Digest,
});
const StartAuthorizationTiming = Schema.Struct({
  createdAt: Schema.String,
  windowMs: NonNegativeSafeInteger,
  deadline: Schema.String,
  configuredPolicy: Schema.Literal("disabled", "optional", "required"),
  policy: Schema.Literal("disabled", "required"),
  authorizedSubjectIds: Schema.Array(Schema.String),
});
const WorkspaceReceipt = Schema.Struct({
  workspaceId: Schema.String,
  normalizedPath: Schema.String,
  baseRevision: Schema.String,
  owner: Schema.Union(
    Schema.Struct({ state: Schema.Literal("known"), ownerId: Schema.String }),
    Schema.Struct({ state: Schema.Literal("unknown") })
  ),
  pionsMayDelete: Schema.Literal(false),
});
const PermissionManifestReceipt = Schema.Struct({
  manifestId: Schema.String,
  digest: Digest,
});
const ResourceEvidenceReceipt = Schema.Struct({
  startAttemptId: Schema.String,
  acquisitionId: Schema.String,
  requestDigest: Digest,
  proofDigest: Digest,
  workspaceProofDigest: Digest,
  acquisitionState: Schema.Literal("held"),
  generation: Schema.optional(Schema.String),
});
const ReviewSubjectReceipt = Schema.Struct({
  artifactId: Schema.String,
  byteCount: NonNegativeSafeInteger,
  digest: Digest,
  format: Schema.String,
  normalization: Schema.String,
});
const StartupReceiptPolicy = Schema.Struct({
  workspace: WorkspaceReceipt,
  permissionManifest: PermissionManifestReceipt,
  reviewSubject: Schema.optional(ReviewSubjectReceipt),
  reviewSubjectVerification: Schema.Literal("disabled", "required"),
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
  resourceEvidence: Schema.optional(ResourceEvidenceReceipt),
  reviewSubject: Schema.optional(ReviewSubjectReceipt),
  reviewSubjectVerification: Schema.Literal("disabled", "required"),
  configuredAuthorizationPolicy: Schema.Literal(
    "disabled",
    "optional",
    "required"
  ),
  authorizationPolicy: Schema.Literal("disabled", "required"),
  authorizationDeadline: Schema.String,
});
const StartInstructionReference = Schema.Struct({
  dispatcherId: Schema.String,
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
const StartAuthorizationDecisionAttempt = Schema.Struct({
  decisionId: Schema.String,
  kind: Schema.Literal("authorize", "reject"),
  actorId: Schema.String,
  receiptDigest: Digest,
  reason: Schema.Literal(
    "operation_not_found",
    "fixed_scope_denied",
    "current_authority_denied",
    "authority_revoked",
    "authority_unknown",
    "receipt_mismatch",
    "deadline_elapsed",
    "decision_id_conflict",
    "gate_closed"
  ),
  attemptedAt: Schema.String,
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
  "resource_proof_rejected",
  "start_rejected",
  "start_authorization_timed_out",
  "start_authorization_invalidated",
  "descendant_failed"
);
const CancellationProof = Schema.Literal("worker-stop");
const WorkspaceAccessScope = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("workspace") }),
  Schema.Struct({
    kind: Schema.Literal("literals"),
    paths: Schema.Array(Schema.String),
  })
);
const ResourceWorkspace = Schema.Struct({
  workspaceId: Schema.String,
  normalizedPath: Schema.String,
  baseRevision: Schema.String,
  owner: Schema.Union(
    Schema.Struct({ state: Schema.Literal("known"), ownerId: Schema.String }),
    Schema.Struct({ state: Schema.Literal("unknown") })
  ),
  pionsMayDelete: Schema.Literal(false),
});
const ExternalResourcePermission = Schema.Struct({
  authorityId: Schema.String,
  selector: Schema.String,
  usage: Schema.Literal("shared_read", "exclusive"),
});
const PermissionManifest = Schema.Struct({
  tools: Schema.Array(Schema.String),
  read: WorkspaceAccessScope,
  write: WorkspaceAccessScope,
  commands: Schema.Literal("none", "unrestricted"),
  network: Schema.Literal("none", "unrestricted"),
  externalResources: Schema.Array(ExternalResourcePermission),
});
const ResourceRequirements = Schema.Struct({
  authorityId: Schema.String,
  authorityRegistrationId: Schema.String,
  authorityGeneration: Schema.String,
  normalizationVersion: Schema.String,
  workspace: ResourceWorkspace,
  permissionManifest: PermissionManifest,
  cleanupPolicy: Schema.Literal("automatic", "coordinator_required"),
  cleanupTimeoutMs: SafeInteger,
  maxCleanupAttempts: SafeInteger,
  safetyCleanupOperations: Schema.Array(
    Schema.Literal("inspect", "revoke", "release")
  ),
});
const ResourcePreparationRequest = Schema.Struct({
  operationId: Schema.String,
  workerProcessInstanceId: Schema.String,
  startAttemptId: Schema.String,
  workspace: ResourceWorkspace,
  requestedManifest: PermissionManifest,
  effectiveManifest: PermissionManifest,
  requirements: ResourceRequirements,
});
const CanonicalResourceRequest = Schema.Struct({
  authorityId: Schema.String,
  namespace: Schema.String,
  normalizationVersion: Schema.String,
  selector: Schema.String,
  conflictScopes: Schema.Array(Schema.String),
  usage: Schema.Literal("shared_read", "exclusive"),
});
const CanonicalProofDocument = Schema.Struct({
  json: Schema.String,
  byteCount: NonNegativeSafeInteger,
  digest: Digest,
  value: Schema.Unknown,
});
const PersistedResourceValidation = Schema.Struct({
  validationId: Schema.String,
  acquisitionId: Schema.String,
  startAttemptId: Schema.String,
  state: Schema.Literal("valid", "invalid", "unknown"),
  authorityId: Schema.String,
  authorityRegistrationId: Schema.String,
  authorityGeneration: Schema.String,
  operationId: Schema.String,
  workerProcessInstanceId: Schema.String,
  requestDigest: Digest,
  proofDigest: Digest,
  checkedAt: Schema.String,
  validUntil: Schema.optional(Schema.String),
  generation: Schema.optional(Schema.String),
  handoffConfirmed: Schema.Boolean,
  relatedExecutionAccessBlocked: Schema.Boolean,
  evidence: CanonicalProofDocument,
});
const ResourceCleanupEvidence = Schema.Struct({
  cleanupId: Schema.String,
  actorId: Schema.String,
  state: Schema.Literal("running", "completed", "unresolved"),
  attempt: SafeInteger,
});
const ResourceEvidenceSnapshot = Schema.Struct({
  state: Schema.Literal(
    "planned",
    "acquiring",
    "held",
    "releasing",
    "released",
    "unresolved"
  ),
  acquisitionId: Schema.String,
  requestDigest: Digest,
  proof: Schema.optional(CanonicalProofDocument),
  workspaceProof: Schema.optional(CanonicalProofDocument),
  validations: Schema.Array(PersistedResourceValidation),
  cleanupAttempts: NonNegativeSafeInteger,
  cleanup: Schema.optional(ResourceCleanupEvidence),
  accessRevocation: Schema.optional(Schema.Literal("blocked", "unknown")),
  release: Schema.optional(Schema.Literal("released", "unknown")),
  diagnostic: Schema.optional(
    Schema.Literal(
      "invalid_profile",
      "authority_unavailable",
      "invalid_proof",
      "proof_limit_exceeded",
      "binding_mismatch",
      "permission_mismatch",
      "permission_contradiction",
      "observation_missing",
      "enforcement_missing",
      "resource_conflict",
      "authority_revoked",
      "validation_unknown",
      "handoff_unconfirmed",
      "persistence_failed",
      "cleanup_unresolved"
    )
  ),
});
const PersistedResourceRecord = Schema.Struct({
  version: SafeInteger,
  request: ResourcePreparationRequest,
  registrationGeneration: Schema.String,
  canonicalResources: Schema.Array(CanonicalResourceRequest),
  snapshot: ResourceEvidenceSnapshot,
});
const RetryClearanceEvidence = Schema.Struct({
  clearanceId: Schema.NonEmptyString,
  failedOperationId: Schema.NonEmptyString,
  affectedResourceIds: Schema.Array(Schema.NonEmptyString),
  workerStoppedOrAccessBlocked: Schema.Literal(true),
  noConflict: Schema.Literal(true),
  handoffConfirmed: Schema.Literal(true),
  verifiedBy: Schema.NonEmptyString,
  verifiedAt: Schema.NonEmptyString,
});
const RevisionReservation = Schema.Struct({
  requestId: Schema.NonEmptyString,
  kind: Schema.Literal("revision", "retry"),
  seriesId: Schema.NonEmptyString,
  seriesOriginOperationId: Schema.NonEmptyString,
  revisionNumber: NonNegativeSafeInteger,
  attemptNumber: NonNegativeSafeInteger,
  operationId: Schema.NonEmptyString,
  targetOperationId: Schema.NonEmptyString,
  targetResultId: Schema.optional(Schema.NonEmptyString),
  targetResultDigest: Schema.optional(Digest),
  retryOfOperationId: Schema.optional(Schema.NonEmptyString),
  reason: Schema.NonEmptyString,
  requestedBy: Schema.NonEmptyString,
  maxAttempts: NonNegativeSafeInteger,
  artifactAcceptanceSubjectIds: Schema.Array(Schema.NonEmptyString),
  task: Task,
  reservedAt: Schema.NonEmptyString,
  retryClearanceId: Schema.optional(Schema.NonEmptyString),
});
const RevisionResultAdoption = Schema.Struct({
  decisionId: Schema.NonEmptyString,
  seriesId: Schema.NonEmptyString,
  revisionNumber: NonNegativeSafeInteger,
  retryOperationId: Schema.NonEmptyString,
  resultId: Schema.NonEmptyString,
  resultDigest: Digest,
  decidedBy: Schema.NonEmptyString,
  decidedAt: Schema.NonEmptyString,
});

const OperationEventSchema = Schema.Union(
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_requested"),
    task: Task,
    requestedConfig: RequestedWorkerConfigSchema,
    effectiveConfig: EffectiveWorkerConfigSchema,
    workProductRequirements: ResolvedWorkProductRequirements,
    resultRetentionPolicy: ResultAcceptanceRetentionPolicy,
    lineage: Lineage,
    revisionMembership: Schema.optional(RevisionMembership),
    startAuthorizationTiming: StartAuthorizationTiming,
    startupReceiptPolicy: Schema.optional(StartupReceiptPolicy),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("startup_receipt_recorded"),
    receipt: StartupReceipt,
    gate: Schema.Literal("not_required", "waiting", "expired"),
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
    type: Schema.Literal("start_authorization_decision_rejected"),
    attempt: StartAuthorizationDecisionAttempt,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_delivery_authority_acquired"),
    instruction: StartInstructionReference,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_delivery_authority_revoked"),
    successorDispatcherId: Schema.NonEmptyString,
    deliveryGeneration: Schema.Number,
    writerOwnership: Schema.Struct({
      pid: Schema.Number,
      processStartToken: Schema.NonEmptyString,
    }),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_delivery_generation_confirmed"),
    dispatcherId: Schema.NonEmptyString,
    deliveryGeneration: Schema.Number,
    acceptanceState: Schema.Literal("not_accepted", "accepted", "unknown"),
    acceptedInstruction: Schema.optional(StartInstructionReference),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_delivery_entered"),
    instruction: StartInstructionReference,
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
    proof: Schema.Literal("worker-durable-acceptance"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("start_instruction_acknowledged"),
    instruction: StartInstructionReference,
    proof: Schema.Literal(
      "authenticated-worker-acknowledgement",
      "authenticated-generation-acknowledgement"
    ),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("resource_evidence_recorded"),
    record: PersistedResourceRecord,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("worker_stop_confirmed"),
    proof: Schema.Literal("worker-stop"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("retry_clearance_recorded"),
    clearance: RetryClearanceEvidence,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("revision_reserved"),
    reservation: RevisionReservation,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("revision_result_adopted"),
    adoption: RevisionResultAdoption,
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
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_starting"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("worker_launched"),
  }),
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
    type: Schema.Literal("presentation_cleanup_started"),
    cleanupId: Schema.NonEmptyString,
    paneId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("presentation_cleanup_completed"),
    cleanupId: Schema.NonEmptyString,
    paneId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("presentation_cleanup_unconfirmed"),
    cleanupId: Schema.NonEmptyString,
    paneId: Schema.NonEmptyString,
    reason: CleanupDiagnosticCode,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_blocked"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_unblocked"),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("result_acceptance_prepared"),
    reservation: ResultAcceptanceReservation,
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("result_accepted"),
    acceptance: AcceptedResult,
    preparationEvidence: ResultAcceptancePreparationEvidence,
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
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_completed"),
  }),
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
    failureReason: Schema.optional(
      Schema.Literal(
        "start_rejected",
        "start_authorization_timed_out",
        "start_authorization_invalidated"
      )
    ),
  }),
  Schema.Struct({
    ...EventMetadataFields,
    type: Schema.Literal("operation_failed"),
    reason: FailureReason,
  })
);

const StoredOperationRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(EVENT_SCHEMA_VERSION),
  operationId: Schema.String,
  events: Schema.Array(OperationEventSchema),
});

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rejectUnsupportedSchema(value: unknown): void {
  const record = recordObject(value);
  const recordVersion = record?.schemaVersion;
  if (
    typeof recordVersion === "number" &&
    recordVersion !== EVENT_SCHEMA_VERSION
  ) {
    throw new RecordDecodingError(
      "unsupported_schema",
      `Unsupported record schema ${recordVersion}`
    );
  }
  if (!Array.isArray(record?.events)) return;
  for (const value of record.events) {
    const eventVersion = recordObject(value)?.schemaVersion;
    if (
      typeof eventVersion === "number" &&
      eventVersion !== EVENT_SCHEMA_VERSION
    ) {
      throw new RecordDecodingError(
        "unsupported_schema",
        `Unsupported event schema ${eventVersion}`
      );
    }
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

  if (record.operationId !== operationId) {
    throw new RecordDecodingError(
      "corrupt_record",
      "Operation identifier does not match record path"
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
