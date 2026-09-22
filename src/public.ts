export interface ModelReference {
  readonly provider: string;
  readonly id: string;
}

export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RequestedWorkerConfig {
  readonly model?: Readonly<ModelReference>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools?: ReadonlyArray<string>;
  readonly cwd?: string;
}

export interface ModelSelectionPolicy {
  readonly candidates: ReadonlyArray<Readonly<ModelReference>>;
  readonly attempted: ReadonlyArray<Readonly<ModelReference>>;
  readonly maxAttempts: 1;
  readonly fallback: "forbidden";
  readonly aliases: ReadonlyArray<string>;
}

export interface EffectiveWorkerConfig {
  readonly model: Readonly<ModelReference>;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: ReadonlyArray<string>;
  readonly cwd: string;
  readonly maxResultByteCount: number;
  readonly modelPolicy: Readonly<ModelSelectionPolicy>;
}

export type ObservedSetting<Value> =
  | { readonly state: "observed"; readonly value: Value }
  | { readonly state: "unavailable" };

export interface ObservedWorkerConfig {
  readonly model: ObservedSetting<Readonly<ModelReference>>;
  readonly thinkingLevel: ObservedSetting<ThinkingLevel>;
  readonly tools: ObservedSetting<ReadonlyArray<string>>;
  readonly cwd: ObservedSetting<string>;
}

export type ResourceProofPolicy = "disabled" | "required";

export type WorkspaceAccessScope =
  | { readonly kind: "none" }
  | { readonly kind: "workspace" }
  | { readonly kind: "literals"; readonly paths: ReadonlyArray<string> };

export type ResourceUsage = "shared_read" | "exclusive";

export interface ExternalResourcePermission {
  readonly authorityId: string;
  readonly selector: string;
  readonly usage: ResourceUsage;
}

export interface PermissionManifest {
  readonly tools: ReadonlyArray<string>;
  readonly read: Readonly<WorkspaceAccessScope>;
  readonly write: Readonly<WorkspaceAccessScope>;
  readonly commands: "none" | "unrestricted";
  readonly network: "none" | "unrestricted";
  readonly externalResources: ReadonlyArray<
    Readonly<ExternalResourcePermission>
  >;
}

export interface ResourceProofRequirements {
  readonly authorityId: string;
  readonly authorityRegistrationId: string;
  readonly authorityGeneration: string;
  readonly normalizationVersion: string;
  readonly workspace: Readonly<ResourceWorkspace>;
  readonly permissionManifest: Readonly<PermissionManifest>;
  readonly cleanupPolicy: "automatic" | "coordinator_required";
  readonly cleanupTimeoutMs: number;
  readonly maxCleanupAttempts: number;
  readonly safetyCleanupOperations: ReadonlyArray<
    "inspect" | "revoke" | "release"
  >;
}

export type WorkerResourcePolicy =
  | { readonly resourceProofPolicy: "disabled" }
  | ({ readonly resourceProofPolicy: "required" } & ResourceProofRequirements);

export interface ConfiguredStartupReceiptPolicy {
  readonly workspace: Readonly<ResourceWorkspace>;
  readonly permissionManifest: Readonly<{
    readonly manifestId: string;
    readonly digest: `sha256:${string}`;
  }>;
  readonly reviewSubjectVerification: "disabled" | "required";
}

export interface StartupReceiptPolicy extends ConfiguredStartupReceiptPolicy {
  readonly reviewSubjectId?: string;
}

export type WorkerStartAuthorizationPolicy =
  | { readonly policy: "disabled" }
  | {
      readonly policy: "required";
      readonly windowMs: number;
      readonly authorizedSubjectIds: ReadonlyArray<string>;
      readonly receipt: Readonly<ConfiguredStartupReceiptPolicy>;
    }
  | { readonly policy: "optional"; readonly resolution: "disabled" }
  | {
      readonly policy: "optional";
      readonly resolution: "required";
      readonly windowMs: number;
      readonly authorizedSubjectIds: ReadonlyArray<string>;
      readonly receipt: Readonly<ConfiguredStartupReceiptPolicy>;
    };

export type WorkerProfileIntendedUse =
  "general" | "reader" | "formal_reviewer" | "writer" | "revision_retry";

export interface WorkerProfilePolicy {
  readonly intendedUse: WorkerProfileIntendedUse;
  readonly modelCandidates: ReadonlyArray<Readonly<ModelReference>>;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: ReadonlyArray<string>;
  readonly resources: Readonly<WorkerResourcePolicy>;
  readonly startAuthorization: Readonly<WorkerStartAuthorizationPolicy>;
  readonly maxResultByteCount: number;
}

export interface ResultFormatValidatorIdentity {
  readonly validatorId: string;
  readonly version: string;
  readonly digest: Sha256Digest;
}

export interface PinnedResultFormat {
  readonly formatId: string;
  readonly version: string;
  readonly normalizationId: string;
  readonly expectations: Readonly<Record<string, string>>;
  readonly validator: Readonly<ResultFormatValidatorIdentity>;
}

export type ResultFormatValidationFailureReason =
  | "invalid_encoding"
  | "invalid_json"
  | "duplicate_key"
  | "unknown_key"
  | "missing_key"
  | "invalid_verdict"
  | "invalid_finding"
  | "expectation_mismatch";

export type ResultFormatRejectionReason =
  | ResultFormatValidationFailureReason
  | "validator_identity_mismatch"
  | "validator_unavailable";

export interface ResultFormatRejectionEvidence {
  readonly formatId: string;
  readonly version: string;
  readonly validator: Readonly<ResultFormatValidatorIdentity>;
  readonly reason: ResultFormatRejectionReason;
}

export interface WorkerProducedResult {
  readonly acceptanceRequestId: string;
  readonly body: string;
  readonly expectedByteCount: number;
  readonly expectedDigest: Sha256Digest;
}

export interface TaskSpec extends RequestedWorkerConfig {
  readonly promptRef: string;
  readonly profile: string;
  readonly idempotencyKey: string;
}

export type WorkerConfigurationFailureReason =
  | "model_mismatch"
  | "thinking_level_mismatch"
  | "model_not_found"
  | "model_auth_unavailable"
  | "unsupported_capability"
  | "tool_policy_violation";

export class WorkerConfigurationError extends Error {
  override readonly name = "WorkerConfigurationError";

  constructor(
    readonly reason: WorkerConfigurationFailureReason,
    message: string
  ) {
    super(message);
  }
}

export type ProjectConfigurationFailureReason =
  | "invalid_json"
  | "unknown_key"
  | "invalid_shape"
  | "invalid_provider"
  | "invalid_model_id"
  | "invalid_thinking_level";

export class ProjectConfigurationError extends Error {
  override readonly name = "ProjectConfigurationError";

  constructor(
    readonly reason: ProjectConfigurationFailureReason,
    message: string
  ) {
    super(message);
  }
}

export interface ExternalReviewAllocation {
  readonly allocationId: string;
  readonly issuerId: string;
  readonly reviewSubjectId: string;
  readonly profileId: string;
  readonly expiresAt: string;
  readonly useLimit: number;
  readonly bundle: string;
  readonly handoff: string;
  readonly subjectVersion: string;
  readonly axis: string;
  readonly externalExecutionId: string;
}

export interface ExternalReviewAllocationRequest {
  readonly requestId: string;
  readonly allocation: Readonly<ExternalReviewAllocation>;
  readonly credential: string;
}

export type ExternalReviewAllocationAuthentication =
  "authenticated" | "denied" | "unknown";

export interface ExternalReviewAllocationAuthenticator {
  authenticate(
    allocation: Readonly<ExternalReviewAllocation>,
    credential: string
  ): Promise<ExternalReviewAllocationAuthentication>;
}

export interface ExternalReviewAllocationBinding extends ExternalReviewAllocation {
  readonly requestId: string;
  readonly operationId: string;
  readonly boundAt: string;
  readonly digest: Sha256Digest;
}

export type ExternalReviewAllocationFailureReason =
  | "invalid_allocation"
  | "issuer_authentication_failed"
  | "allocation_mismatch"
  | "request_mismatch"
  | "allocation_already_bound"
  | "expired"
  | "use_limit_exceeded"
  | "persistence_failed";

export class ExternalReviewAllocationError extends Error {
  override readonly name = "ExternalReviewAllocationError";

  constructor(
    readonly reason: ExternalReviewAllocationFailureReason,
    message: string
  ) {
    super(message);
  }
}

export class ExternalReviewAllocationRejoinedError extends Error {
  override readonly name = "ExternalReviewAllocationRejoinedError";

  constructor(readonly operationId: string) {
    super(`External review allocation already belongs to ${operationId}`);
  }
}

export interface SpawnOptions {
  readonly reviewSubjectId?: string;
  readonly externalReviewAllocation?: Readonly<ExternalReviewAllocationRequest>;
}

export interface Result {
  readonly body: string;
  readonly byteCount: number;
  readonly digest: `sha256:${string}`;
}

export type OperationState =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface OperationVersion {
  readonly sequenceNumber: number;
  readonly recordedAt: string;
}

export interface StartAuthorizationTiming {
  readonly createdAt: string;
  readonly windowMs: number;
  readonly deadline: string;
  readonly configuredPolicy: "disabled" | "optional" | "required";
  readonly policy: "disabled" | "required";
  readonly authorizedSubjectIds: ReadonlyArray<string>;
}

export type StartGateState =
  | "not_required"
  | "waiting"
  | "authorized"
  | "rejected"
  | "expired"
  | "invalidated";

export interface StartupReceipt {
  readonly operationId: string;
  readonly digest: `sha256:${string}`;
  readonly recordedAt: string;
  readonly workerIdentity: Readonly<{
    readonly processId: number;
    readonly processInstanceId: string;
    readonly processStartToken: string;
    readonly piSessionId: string;
    readonly paneId: string;
  }>;
  readonly requestedConfig: Readonly<RequestedWorkerConfig>;
  readonly effectiveConfig: Readonly<EffectiveWorkerConfig>;
  readonly observedConfig: Readonly<ObservedWorkerConfig>;
  readonly workspace: Readonly<{
    readonly workspaceId: string;
    readonly normalizedPath: string;
    readonly baseRevision: string;
    readonly owner:
      | { readonly state: "known"; readonly ownerId: string }
      | { readonly state: "unknown" };
    readonly pionsMayDelete: false;
  }>;
  readonly permissionManifest: Readonly<{
    readonly manifestId: string;
    readonly digest: `sha256:${string}`;
  }>;
  readonly resourceEvidence?: Readonly<{
    readonly startAttemptId: string;
    readonly acquisitionId: string;
    readonly requestDigest: `sha256:${string}`;
    readonly proofDigest: `sha256:${string}`;
    readonly workspaceProofDigest: `sha256:${string}`;
    readonly acquisitionState: "held";
    readonly generation?: string;
  }>;
  readonly reviewSubjectId?: string;
  readonly reviewSubjectVerification: "disabled" | "required";
  readonly configuredAuthorizationPolicy: "disabled" | "optional" | "required";
  readonly authorizationPolicy: "disabled" | "required";
  readonly authorizationDeadline: string;
}

export interface StartAuthorizationDecisionRecord {
  readonly decisionId: string;
  readonly kind: "authorize" | "reject";
  readonly actorId: string;
  readonly receiptDigest: StartupReceipt["digest"];
  readonly decidedAt: string;
}

export interface StartAuthorizationDecisionAttemptRecord {
  readonly decisionId: string;
  readonly kind: "authorize" | "reject";
  readonly actorId: string;
  readonly receiptDigest: StartupReceipt["digest"];
  readonly reason: StartAuthorizationDecisionRejectionReason;
  readonly attemptedAt: string;
}

export interface StartAuthorizationSnapshot {
  readonly timing: Readonly<StartAuthorizationTiming>;
  readonly gate: StartGateState;
  readonly receipt?: Readonly<StartupReceipt>;
  readonly decision?: Readonly<StartAuthorizationDecisionRecord>;
  readonly rejectedDecisions: ReadonlyArray<
    Readonly<StartAuthorizationDecisionAttemptRecord>
  >;
}

export interface StartInstructionReference {
  readonly dispatcherId: string;
  readonly workerProcessInstanceId: string;
  readonly receiptDigest: StartupReceipt["digest"];
  readonly authorizationDecisionId?: string;
  readonly deliveryGeneration: number;
}

export interface StartDeliveryAuthorityEvidence extends StartInstructionReference {
  readonly acquiredAt: string;
}

export interface StartDeliveryEntryEvidence extends StartInstructionReference {
  readonly enteredAt: string;
}

export interface StartInstructionDeliveryEvidence extends StartInstructionReference {
  readonly dispatchedAt: string;
}

export interface StartInstructionAcceptanceEvidence extends StartInstructionReference {
  readonly acceptedAt: string;
  readonly proof: "worker-durable-acceptance";
}

export interface StartInstructionAcknowledgementEvidence extends StartInstructionReference {
  readonly acknowledgedAt: string;
  readonly proof:
    | "authenticated-worker-acknowledgement"
    | "authenticated-generation-acknowledgement";
}

export interface StartDeliveryHandoffEvidence {
  readonly previousDispatcherId: string;
  readonly previousDeliveryGeneration: number;
  readonly successorDispatcherId: string;
  readonly deliveryGeneration: number;
  readonly authorityRevokedAt: string;
  readonly workerGenerationConfirmedAt?: string;
  readonly acceptanceState?: "not_accepted" | "accepted" | "unknown";
}

export type ResultAcceptanceId = `pions.result-acceptance.v1:${string}`;

export interface ResultAcceptanceEvidence {
  readonly acceptedAt: string;
  readonly acceptanceId: ResultAcceptanceId;
  readonly byteCount: number;
  readonly digest: Sha256Digest;
  readonly eventSequenceNumber: number;
}

export interface StopConfirmationEvidence {
  readonly confirmedAt: string;
  readonly proof: "worker-stop";
}

export type CleanupDiagnosticCode =
  | "workspace_close_failed"
  | "workspace_identity_missing"
  | "workspace_identity_unavailable"
  | "cleanup_record_unavailable";

export interface CleanupDiagnostic {
  readonly code: CleanupDiagnosticCode;
}

export interface PresentationCleanupEvidence {
  readonly cleanupId: string;
  readonly workspaceId: string;
  readonly state: "pending" | "completed" | "unconfirmed";
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export type ResourceAcquisitionState =
  "planned" | "acquiring" | "held" | "releasing" | "released" | "unresolved";

export type ResourceValidationState = "valid" | "invalid" | "unknown";

export type ResourceProofRejectionReason =
  | "invalid_profile"
  | "authority_unavailable"
  | "invalid_proof"
  | "proof_limit_exceeded"
  | "binding_mismatch"
  | "permission_mismatch"
  | "permission_contradiction"
  | "observation_missing"
  | "enforcement_missing"
  | "resource_conflict"
  | "authority_revoked"
  | "validation_unknown"
  | "handoff_unconfirmed"
  | "persistence_failed"
  | "cleanup_unresolved";

export interface CanonicalProofDocument {
  readonly json: string;
  readonly byteCount: number;
  readonly digest: `sha256:${string}`;
  readonly value: unknown;
}

export interface ResourceValidationEvidence {
  readonly validationId: string;
  readonly acquisitionId: string;
  readonly startAttemptId: string;
  readonly state: ResourceValidationState;
  readonly authorityId: string;
  readonly authorityRegistrationId: string;
  readonly authorityGeneration: string;
  readonly operationId: string;
  readonly workerProcessInstanceId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly proofDigest: `sha256:${string}`;
  readonly conflictControlId: string;
  readonly noConflict: true;
  readonly checkedAt: string;
  readonly validUntil?: string;
  readonly generation?: string;
  readonly handoffConfirmed: boolean;
  readonly relatedExecutionAccessBlocked: boolean;
  readonly evidence: Uint8Array;
}

export interface ResourceWorkspace {
  readonly workspaceId: string;
  readonly normalizedPath: string;
  readonly baseRevision: string;
  readonly owner:
    | { readonly state: "known"; readonly ownerId: string }
    | { readonly state: "unknown" };
  readonly pionsMayDelete: false;
}

export type PermissionConstraint =
  "tools" | "read" | "write" | "commands" | "network" | "externalResources";

export interface PermissionGuaranteeEvidence {
  readonly authorityId: string;
  readonly operationId: string;
  readonly workerProcessInstanceId: string;
  readonly permissionManifestDigest: `sha256:${string}`;
  readonly constraint: PermissionConstraint;
  readonly method: string;
  readonly scope: string;
  readonly checkedAt: string;
  readonly validUntil?: string;
  readonly generation?: string;
  readonly result: "satisfied";
  readonly basis: string;
}

export interface ResourceProofEvidence {
  readonly acquisitionId: string;
  readonly startAttemptId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly authorityId: string;
  readonly authorityRegistrationId: string;
  readonly authorityGeneration: string;
  readonly operationId: string;
  readonly workerProcessInstanceId: string;
  readonly permissionManifestDigest: `sha256:${string}`;
  readonly workspace: Readonly<ResourceWorkspace>;
  readonly workspaceEvidence: Uint8Array;
  readonly conflictControlId: string;
  readonly noConflict: boolean;
  readonly revocationOwner: string;
  readonly observations: ReadonlyArray<Readonly<PermissionGuaranteeEvidence>>;
  readonly enforcements: ReadonlyArray<Readonly<PermissionGuaranteeEvidence>>;
  readonly validUntil?: string;
  readonly generation?: string;
  readonly evidence: Uint8Array;
}

export interface CanonicalResourceRequest {
  readonly authorityId: string;
  readonly namespace: string;
  readonly normalizationVersion: string;
  readonly selector: string;
  readonly conflictScopes: ReadonlyArray<string>;
  readonly usage: ResourceUsage;
}

export interface ResourceAdapterRequest {
  readonly acquisitionId: string;
  readonly startAttemptId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly operationId: string;
  readonly workerProcessInstanceId: string;
  readonly permissionManifest: Readonly<PermissionManifest>;
  readonly workspace: Readonly<ResourceWorkspace>;
  readonly resources: ReadonlyArray<Readonly<CanonicalResourceRequest>>;
  readonly permissionManifestDigest: `sha256:${string}`;
}

export interface ResourceProofIssuer {
  verify(evidence: Uint8Array): Promise<boolean>;
  isCurrentlyTrusted(
    generation: string
  ): Promise<"trusted" | "revoked" | "unknown">;
}

export interface ResourceAdapter {
  normalizeSelector(
    selector: string,
    normalizationVersion: string
  ): Promise<
    Readonly<{
      readonly namespace: string;
      readonly selector: string;
      readonly conflictScopes: ReadonlyArray<string>;
    }>
  >;
  acquire(
    request: Readonly<ResourceAdapterRequest>
  ): Promise<Readonly<ResourceProofEvidence>>;
  recover(
    request: Readonly<ResourceAdapterRequest>
  ): Promise<Readonly<ResourceProofEvidence> | "released" | "unknown">;
  inspect(
    request: Readonly<ResourceAdapterRequest>
  ): Promise<Readonly<ResourceValidationEvidence>>;
  revokeAccess(
    request: Readonly<ResourceAdapterRequest>
  ): Promise<"blocked" | "unknown">;
  release(
    request: Readonly<ResourceAdapterRequest>
  ): Promise<"released" | "unknown">;
}

export type DeploymentMode = "non-production" | "production";

export interface ResourceAdapterIdentity {
  readonly adapterId: string;
  readonly version: string;
  readonly digest: Sha256Digest;
  readonly intendedUse: DeploymentMode;
}

export interface ResourceAuthorityRegistration {
  readonly authorityId: string;
  readonly registrationId: string;
  readonly generation: string;
  readonly normalizationVersion: string;
  readonly identity: Readonly<ResourceAdapterIdentity>;
  /** Exact bytes of the adapter implementation represented by identity.digest. */
  readonly implementation: Uint8Array;
  readonly issuer: ResourceProofIssuer;
  readonly adapter: ResourceAdapter;
}

export interface PersistedResourceValidation extends Omit<
  ResourceValidationEvidence,
  "evidence"
> {
  readonly evidence: Readonly<CanonicalProofDocument>;
}

export interface ResourceCleanupEvidence {
  readonly cleanupId: string;
  readonly actorId: string;
  readonly state: "running" | "completed" | "unresolved";
  readonly attempt: number;
}

export interface ResourceEvidenceSnapshot {
  readonly state: ResourceAcquisitionState;
  readonly acquisitionId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly proof?: Readonly<CanonicalProofDocument>;
  readonly workspaceProof?: Readonly<CanonicalProofDocument>;
  readonly validations: ReadonlyArray<Readonly<PersistedResourceValidation>>;
  readonly cleanupAttempts: number;
  readonly cleanup?: Readonly<ResourceCleanupEvidence>;
  readonly accessRevocation?: "blocked" | "unknown";
  readonly release?: "released" | "unknown";
  readonly diagnostic?: ResourceProofRejectionReason;
}

export interface ResourcePreparationRequest {
  readonly operationId: string;
  readonly workerProcessInstanceId: string;
  readonly startAttemptId: string;
  readonly workspace: Readonly<ResourceWorkspace>;
  readonly requestedManifest: Readonly<PermissionManifest>;
  readonly effectiveManifest: Readonly<PermissionManifest>;
  readonly requirements: Readonly<ResourceProofRequirements>;
}

export interface ResourceCleanupPrincipal {
  readonly subjectId: string;
  canCleanup(
    operationId: string,
    operations: ReadonlyArray<"inspect" | "revoke" | "release">
  ): Promise<boolean>;
}

export interface ResourceCleanupAuthenticator {
  authenticate(credential: string): Promise<Readonly<ResourceCleanupPrincipal>>;
}

export interface VersionedResourceEvidenceSnapshot {
  readonly version: number;
  readonly evidence: Readonly<ResourceEvidenceSnapshot>;
}

export interface ResourceProofController {
  prepare(
    request: Readonly<ResourcePreparationRequest>
  ): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  revalidate(
    operationId: string
  ): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  cleanup(
    operationId: string,
    credential: string
  ): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  read(
    operationId: string
  ): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
}

export class ResourceProofRejectedError extends Error {
  override readonly name = "ResourceProofRejectedError";

  constructor(
    readonly reason: ResourceProofRejectionReason,
    message: string
  ) {
    super(message);
  }
}

export interface RetryClearanceEvidence {
  readonly clearanceId: string;
  readonly failedOperationId: string;
  readonly affectedResourceIds: ReadonlyArray<string>;
  readonly workerStoppedOrAccessBlocked: true;
  readonly noConflict: true;
  readonly handoffConfirmed: true;
  readonly verifiedBy: string;
  readonly verifiedAt: string;
}

export type RevisionSeriesId = `pions.revision-series.v1:${string}`;

export interface RevisionReservation {
  readonly requestId: string;
  readonly kind: "revision" | "retry";
  readonly seriesId: RevisionSeriesId;
  readonly seriesOriginOperationId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly operationId: string;
  readonly targetOperationId: string;
  readonly targetResultId?: string;
  readonly targetResultDigest?: Sha256Digest;
  readonly retryOfOperationId?: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly maxAttempts: number;
  readonly resultAdoptionSubjectIds: ReadonlyArray<string>;
  readonly task: Readonly<TaskSpec>;
  readonly reservedAt: string;
  readonly retryClearanceId?: string;
}

export interface RevisionResultAdoptionRecord {
  readonly decisionId: string;
  readonly seriesId: RevisionSeriesId;
  readonly revisionNumber: number;
  readonly retryOperationId: string;
  readonly resultId: string;
  readonly resultDigest: Sha256Digest;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface RevisionSeriesSnapshot {
  readonly seriesId: RevisionSeriesId;
  readonly seriesOriginOperationId: string;
  readonly maxAttempts: number;
  readonly resultAdoptionSubjectIds: ReadonlyArray<string>;
  readonly reservations: ReadonlyArray<Readonly<RevisionReservation>>;
  readonly retryClearances: ReadonlyArray<Readonly<RetryClearanceEvidence>>;
  readonly adoptions: ReadonlyArray<Readonly<RevisionResultAdoptionRecord>>;
}

interface ReserveRevisionRequestBase {
  readonly requestId: string;
  readonly targetOperationId: string;
  readonly targetResultId: string;
  readonly targetResultDigest: Sha256Digest;
  readonly reason: string;
  readonly task: Readonly<TaskSpec>;
}

export type ReserveRevisionRequest = ReserveRevisionRequestBase &
  (
    | { readonly seriesId?: never; readonly maxAttempts: number }
    | { readonly seriesId: RevisionSeriesId; readonly maxAttempts?: never }
  );

export interface ReserveRetryRequest {
  readonly requestId: string;
  readonly seriesId: RevisionSeriesId;
  readonly failedOperationId: string;
  readonly reason: string;
  readonly task: Readonly<TaskSpec>;
  readonly clearance?: Readonly<RetryClearanceEvidence>;
}

export type RevisionReservationOutcome =
  | {
      readonly status: "reserved" | "idempotent";
      readonly reservation: Readonly<RevisionReservation>;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "not_found"
        | "request_conflict"
        | "invalid_target"
        | "limit_exceeded"
        | "retry_clearance_required"
        | "retry_clearance_invalid";
    };

export interface AdoptRevisionResultRequest {
  readonly decisionId: string;
  readonly seriesId: RevisionSeriesId;
  readonly revisionNumber: number;
  readonly retryOperationId: string;
  readonly resultId: string;
  readonly resultDigest: Sha256Digest;
}

export type RevisionResultAdoptionOutcome =
  | {
      readonly status: "adopted" | "idempotent";
      readonly adoption: Readonly<RevisionResultAdoptionRecord>;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "series_not_found"
        | "fixed_scope_denied"
        | "current_authority_denied"
        | "authority_revoked"
        | "authority_unknown"
        | "decision_conflict"
        | "invalid_successor"
        | "result_not_accepted";
    };

export type CurrentResultAdoptionAuthority =
  "authorized" | "denied" | "revoked" | "unknown";

export interface AuthenticatedRevisionCoordinator {
  readonly subjectId: string;
  fixedResultAdoptionSubjectIds(
    targetOperationId: string
  ): Promise<ReadonlyArray<string>>;
  currentResultAdoptionAuthority(
    seriesId: string
  ): Promise<CurrentResultAdoptionAuthority>;
}

export interface RetryClearanceVerifier {
  verify(evidence: Readonly<RetryClearanceEvidence>): Promise<boolean>;
}

export interface RevisionAuthenticator {
  authenticate(
    credential: string
  ): Promise<Readonly<AuthenticatedRevisionCoordinator>>;
}

export class RevisionAuthenticationError extends Error {
  override readonly name = "RevisionAuthenticationError";
}

export interface RevisionCoordinator {
  reserveRevision(
    request: Readonly<ReserveRevisionRequest>
  ): Promise<Readonly<RevisionReservationOutcome>>;
  reserveRetry(
    request: Readonly<ReserveRetryRequest>
  ): Promise<Readonly<RevisionReservationOutcome>>;
  adopt(
    request: Readonly<AdoptRevisionResultRequest>
  ): Promise<Readonly<RevisionResultAdoptionOutcome>>;
  read(seriesId: string): Promise<Readonly<RevisionSeriesSnapshot>>;
}

export interface WorkerIdentity {
  readonly processId: number;
  readonly processInstanceId: string;
  readonly processStartToken: string;
  readonly piSessionId: string;
  readonly paneId: string;
}

export interface WorkerExecutionUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface WorkerToolUseEvidence {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
}

export interface WorkerExecutionEvidence {
  readonly usage: Readonly<WorkerExecutionUsage>;
  readonly toolUses: ReadonlyArray<Readonly<WorkerToolUseEvidence>>;
}

export interface OperationSnapshot {
  readonly operationId: string;
  readonly version: Readonly<OperationVersion>;
  readonly state: OperationState;
  readonly unknownReason?:
    "cancel-unproven" | "start-acceptance-unknown" | "liveness-unproven";
  readonly failureReason?: OperationFailureReason;
  readonly workerIdentity?: Readonly<WorkerIdentity>;
  readonly effectiveConfig: Readonly<EffectiveWorkerConfig>;
  readonly observedConfig?: Readonly<ObservedWorkerConfig>;
  readonly workerExecutionEvidence?: Readonly<WorkerExecutionEvidence>;
  readonly startDeliveryAuthority?: Readonly<StartDeliveryAuthorityEvidence>;
  readonly startDeliveryEntry?: Readonly<StartDeliveryEntryEvidence>;
  readonly startInstructionDelivery?: Readonly<StartInstructionDeliveryEvidence>;
  readonly startInstructionAcceptance?: Readonly<StartInstructionAcceptanceEvidence>;
  readonly startInstructionAcknowledgement?: Readonly<StartInstructionAcknowledgementEvidence>;
  readonly startDeliveryHandoffs: ReadonlyArray<
    Readonly<StartDeliveryHandoffEvidence>
  >;
  readonly resultAcceptance?: Readonly<ResultAcceptanceEvidence>;
  readonly stopConfirmation?: Readonly<StopConfirmationEvidence>;
  readonly presentationCleanup?: Readonly<PresentationCleanupEvidence>;
  readonly cleanupDiagnostics: ReadonlyArray<Readonly<CleanupDiagnostic>>;
}

export type ResultReadOutcome =
  | {
      readonly kind: "retrieved";
      readonly acceptanceId: ResultAcceptanceId;
      readonly result: Readonly<Result>;
    }
  | {
      readonly kind: "not_accepted";
      readonly version: Readonly<OperationVersion>;
      readonly state: OperationState;
      readonly failureReason?: OperationFailureReason;
    };

export interface ResultChunk {
  readonly acceptanceId: ResultAcceptanceId;
  readonly body: string;
  readonly startByte: number;
  readonly totalByteCount: number;
  readonly digest: Sha256Digest;
  readonly nextCursor?: string;
}

export type ResultChunkReadOutcome =
  | { readonly kind: "retrieved"; readonly chunk: Readonly<ResultChunk> }
  | Exclude<ResultReadOutcome, { readonly kind: "retrieved" }>;

export class ResultCursorError extends Error {
  override readonly name = "ResultCursorError";

  constructor(
    readonly operationId: string,
    readonly reason: "invalid" | "wrong_operation" | "result_mismatch"
  ) {
    super(`Result cursor rejected for Operation ${operationId}: ${reason}`);
  }
}

export interface OperationReader {
  readonly operationId: string;
  read(): Promise<Readonly<OperationSnapshot>>;
  readResult(): Promise<Readonly<ResultReadOutcome>>;
  readResultChunk(options: {
    readonly maxBytes: number;
    readonly cursor?: string;
  }): Promise<Readonly<ResultChunkReadOutcome>>;
}

export interface WaitingStartAuthorization {
  readonly operationId: string;
  readonly version: Readonly<OperationVersion>;
  readonly deadline: string;
  readonly receipt: Readonly<StartupReceipt>;
}

export interface StartAuthorizationDecisionRequest {
  readonly operationId: string;
  readonly decisionId: string;
  readonly kind: "authorize" | "reject";
  readonly receiptDigest: StartupReceipt["digest"];
}

export type StartAuthorizationDecisionRejectionReason =
  | "operation_not_found"
  | "fixed_scope_denied"
  | "current_authority_denied"
  | "authority_revoked"
  | "authority_unknown"
  | "receipt_mismatch"
  | "deadline_elapsed"
  | "decision_id_conflict"
  | "gate_closed";

export type StartAuthorizationDecisionOutcome =
  | {
      readonly status: "accepted" | "idempotent" | "duplicate";
      readonly decision: Readonly<StartAuthorizationDecisionRecord>;
      readonly gate: "authorized" | "rejected";
    }
  | {
      readonly status: "rejected";
      readonly reason: StartAuthorizationDecisionRejectionReason;
    };

export interface StartAuthorizationInbox {
  listWaiting(): Promise<ReadonlyArray<Readonly<WaitingStartAuthorization>>>;
  decide(
    request: Readonly<StartAuthorizationDecisionRequest>
  ): Promise<Readonly<StartAuthorizationDecisionOutcome>>;
}

export type CurrentStartAuthorization =
  "authorized" | "denied" | "revoked" | "unknown";

export interface AuthenticatedStartAuthorizer {
  readonly subjectId: string;
  currentAuthorization(operationId: string): Promise<CurrentStartAuthorization>;
}

export interface StartAuthorizationAuthenticator {
  authenticate(
    credential: string
  ): Promise<Readonly<AuthenticatedStartAuthorizer>>;
}

export interface StartAuthorizationAuthority {
  currentAuthorization(
    subjectId: string,
    operationId: string
  ): Promise<CurrentStartAuthorization>;
}

export class StartAuthorizationAuthenticationError extends Error {
  override readonly name = "StartAuthorizationAuthenticationError";
}

export type OperationFailureReason =
  | "worker_start_failed"
  | "worker_protocol_failed"
  | "process-exited-without-result"
  | "agent_failed"
  | "model_mismatch"
  | "thinking_level_mismatch"
  | "model_not_found"
  | "model_auth_unavailable"
  | "unsupported_capability"
  | "tool_policy_violation";

export class HerdrPreconditionError extends Error {
  override readonly name = "HerdrPreconditionError";

  constructor(readonly missingVariables: ReadonlyArray<string>) {
    super(`Herdr environment is unavailable: ${missingVariables.join(", ")}`);
  }
}

export type SpawnRejectionReason =
  | "parent_not_found"
  | "cancellation_in_progress"
  | "parent_terminal"
  | "depth_limit_exceeded"
  | "child_limit_exceeded"
  | "live_descendant_limit_exceeded";

export type CancellationRejectionReason = "stale_epoch" | "future_epoch";

export class CancellationRejectedError extends Error {
  override readonly name = "CancellationRejectedError";

  constructor(
    readonly reason: CancellationRejectionReason,
    readonly cancellationEpoch: number
  ) {
    super(`Cancellation epoch ${cancellationEpoch} rejected: ${reason}`);
  }
}

export class OperationCancelledError extends Error {
  override readonly name = "OperationCancelledError";

  constructor(readonly operationId: string) {
    super(`Operation ${operationId} was cancelled`);
  }
}

export class OperationUnknownError extends Error {
  override readonly name = "OperationUnknownError";

  constructor(
    readonly operationId: string,
    readonly reason:
      "cancel-unproven" | "start-acceptance-unknown" | "liveness-unproven"
  ) {
    super(`Operation ${operationId} has unknown outcome: ${reason}`);
  }
}

export class SpawnRejectedError extends Error {
  override readonly name = "SpawnRejectedError";

  constructor(
    readonly reason: SpawnRejectionReason,
    readonly parentOperationId: string
  ) {
    super(`Child Operation rejected for ${parentOperationId}: ${reason}`);
  }
}

export class RuntimeClosedError extends Error {
  override readonly name = "RuntimeClosedError";

  constructor() {
    super("Runtime is closing; new Operations are rejected");
  }
}

export class OperationFailedError extends Error {
  override readonly name = "OperationFailedError";

  constructor(
    readonly operationId: string,
    readonly reason: OperationFailureReason
  ) {
    super(`Operation ${operationId} failed: ${reason}`);
  }
}

export type PersistenceFailureReason =
  | "write_failed"
  | "incomplete_record"
  | "corrupt_record"
  | "unsupported_schema";

export class OperationPersistenceError extends Error {
  override readonly name = "OperationPersistenceError";

  constructor(
    readonly operationId: string,
    readonly reason: PersistenceFailureReason
  ) {
    super(`Operation ${operationId} persistence failed: ${reason}`);
  }
}

export class ResultRetrievalError extends Error {
  override readonly name = "ResultRetrievalError";

  constructor(
    readonly operationId: string,
    readonly reason: ResultRetrievalFailureReason
  ) {
    super(`Result retrieval failed for Operation ${operationId}: ${reason}`);
  }
}

export type ResultRetrievalFailureReason =
  | "result_not_accepted"
  | "stored_result_corrupt"
  | "storage_inspection_unavailable";

export interface CancelOptions {
  readonly scope: "subtree";
  readonly cancellationEpoch?: number;
  readonly timeoutMs?: number;
}

export interface CancellationResult {
  readonly cancellationEpoch: number;
  readonly state: "cancelled" | "unknown";
  readonly reason?: "cancel-unproven";
}

export interface OperationCompletion {
  readonly result: Readonly<Result>;
  readonly presentationCleanup?: Readonly<PresentationCleanupEvidence>;
  readonly cleanupDiagnostics: ReadonlyArray<Readonly<CleanupDiagnostic>>;
}

export interface OperationHandle extends OperationReader {
  result(): Promise<Readonly<OperationCompletion>>;
  cancel(options: CancelOptions): Promise<CancellationResult>;
}

export interface Runtime {
  spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle>;
  operation(operationId: string): Promise<OperationReader>;
  startAuthorizationInbox(credential: string): Promise<StartAuthorizationInbox>;
  revisions(credential: string): Promise<RevisionCoordinator>;
  resourceProofs(): ResourceProofController;
  close(): Promise<void>;
}

export type Sha256Digest = `sha256:${string}`;

/** The immutable Result an Operation owns after acceptance: exact bytes, count, digest, identifier. */
export interface AcceptedResult {
  readonly acceptanceId: ResultAcceptanceId;
  readonly operationId: string;
  readonly acceptanceRequestId: string;
  readonly acceptedAt: string;
  readonly eventSequenceNumber: number;
  readonly byteCount: number;
  readonly digest: Sha256Digest;
}

export type ResultAcceptanceTransactionFailureReason =
  | "operation_not_found"
  | "request_mismatch"
  | "result_conflict"
  | "invalid_operation_state"
  | "invalid_utf8"
  | "limit_exceeded"
  | "corrupt_record"
  | "unsupported_schema";

export type ResultAcceptanceTransactionOutcome =
  | {
      readonly kind: "accepted";
      readonly acceptance: Readonly<AcceptedResult>;
    }
  | {
      readonly kind: "continuable";
      readonly reason: "write_failed";
    }
  | {
      readonly kind: "failed";
      readonly terminal: true;
      readonly reason: ResultAcceptanceTransactionFailureReason;
    };
