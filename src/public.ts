export interface ModelReference {
  readonly provider: string;
  readonly id: string;
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

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
  readonly externalResources: ReadonlyArray<Readonly<ExternalResourcePermission>>;
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
  readonly safetyCleanupOperations: ReadonlyArray<"inspect" | "revoke" | "release">;
}

export type WorkerResourcePolicy =
  | { readonly resourceProofPolicy: "disabled" }
  | ({ readonly resourceProofPolicy: "required" } & ResourceProofRequirements);

export interface ArtifactContentRequirement {
  readonly formatId: string;
  readonly normalizationId: string;
  readonly maxByteCount: number;
}

export interface WorkProductRequirement extends ArtifactContentRequirement {
  readonly key: string;
  readonly minCount: number;
  readonly maxCount: number;
}

export interface WorkProductRequirementsPolicy {
  readonly body: Readonly<ArtifactContentRequirement>;
  readonly workProducts: ReadonlyArray<Readonly<WorkProductRequirement>>;
  readonly maxTotalByteCount: number;
}

export interface ResolvedWorkProductRequirements extends WorkProductRequirementsPolicy {
  readonly requirementSetId: `pions.work-product-requirements.v1:${string}`;
  readonly digest: ArtifactDigest;
  readonly canonicalJson: string;
}

export interface WorkerProfilePolicy {
  readonly modelCandidates: ReadonlyArray<Readonly<ModelReference>>;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: ReadonlyArray<string>;
  readonly resources: Readonly<WorkerResourcePolicy>;
  readonly workProductRequirements: Readonly<WorkProductRequirementsPolicy>;
}

export type WorkProductRequirementsFailureReason =
  | "invalid_key"
  | "duplicate_key"
  | "invalid_requirement";

export class WorkProductRequirementsError extends Error {
  override readonly name = "WorkProductRequirementsError";

  constructor(readonly reason: WorkProductRequirementsFailureReason, message: string) {
    super(message);
  }
}

export interface ResultAcceptanceManifestWorkProduct {
  readonly key: string;
  readonly artifactIds: ReadonlyArray<string>;
}

export interface ResultAcceptanceManifest {
  readonly formatId: "pions.result-acceptance-manifest.v1";
  readonly normalizationId: "pions.canonical-json.v1";
  readonly bodyArtifactId: string;
  readonly requirementSetId: ResolvedWorkProductRequirements["requirementSetId"];
  readonly requirementSetDigest: ArtifactDigest;
  readonly workProducts: ReadonlyArray<Readonly<ResultAcceptanceManifestWorkProduct>>;
}

export interface CanonicalResultAcceptanceManifestDocument {
  readonly json: string;
  readonly bytes: Uint8Array;
  readonly byteCount: number;
  readonly digest: ArtifactDigest;
  readonly value: Readonly<ResultAcceptanceManifest>;
}

export interface ValidatedResultAcceptanceManifest extends CanonicalResultAcceptanceManifestDocument {
  readonly totalByteCount: number;
  readonly artifactIds: ReadonlyArray<string>;
}

export type ResultAcceptanceManifestFailureReason =
  | "invalid_manifest"
  | "unsupported_format"
  | "unsupported_normalization"
  | "duplicate_key"
  | "duplicate_artifact"
  | "unknown_field"
  | "requirement_set_mismatch"
  | "undeclared_key"
  | "missing_required_work_product"
  | "work_product_count_below_minimum"
  | "work_product_count_exceeded"
  | "artifact_not_found"
  | "artifact_format_mismatch"
  | "artifact_normalization_mismatch"
  | "artifact_size_exceeded"
  | "total_size_exceeded"
  | "artifact_dependency_cycle";

export class ResultAcceptanceManifestError extends Error {
  override readonly name = "ResultAcceptanceManifestError";

  constructor(readonly reason: ResultAcceptanceManifestFailureReason, message: string) {
    super(message);
  }
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
    message: string,
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
    message: string,
  ) {
    super(message);
  }
}

export interface SpawnOptions {
  readonly parentOperationId?: string;
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
  | "blocked"
  | "self_settled"
  | "draining_descendants"
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
    readonly owner: { readonly state: "known"; readonly ownerId: string } | { readonly state: "unknown" };
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
  readonly reviewSubject: Readonly<{
    readonly artifactId: string;
    readonly byteCount: number;
    readonly digest: `sha256:${string}`;
    readonly format: string;
    readonly normalization: string;
  }>;
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

export interface StartAuthorizationSnapshot {
  readonly timing: Readonly<StartAuthorizationTiming>;
  readonly gate: StartGateState;
  readonly receipt?: Readonly<StartupReceipt>;
  readonly decision?: Readonly<StartAuthorizationDecisionRecord>;
}

export interface StartInstructionReference {
  readonly workerProcessInstanceId: string;
  readonly receiptDigest: StartupReceipt["digest"];
  readonly authorizationDecisionId?: string;
  readonly deliveryGeneration: number;
}

export interface StartInstructionDeliveryEvidence extends StartInstructionReference {
  readonly dispatchedAt: string;
}

export interface StartInstructionAcceptanceEvidence extends StartInstructionReference {
  readonly acceptedAt: string;
  readonly proof: "authenticated-worker-acknowledgement";
}

export interface ResultAcceptanceEvidence {
  readonly acceptedAt: string;
  readonly deliverySequenceNumber: number;
  readonly byteCount: number;
  readonly digest: Result["digest"];
}

export interface StopConfirmationEvidence {
  readonly confirmedAt: string;
  readonly proof: "worker-stop";
}

export interface CleanupDiagnostic {
  readonly code: "pane_close_failed";
}

export type ResourceAcquisitionState =
  | "planned"
  | "acquiring"
  | "held"
  | "releasing"
  | "released"
  | "unresolved";

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
  readonly owner: { readonly state: "known"; readonly ownerId: string } | { readonly state: "unknown" };
  readonly pionsMayDelete: false;
}

export type PermissionConstraint = "tools" | "read" | "write" | "commands" | "network" | "externalResources";

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
  isCurrentlyTrusted(generation: string): Promise<"trusted" | "revoked" | "unknown">;
}

export interface ResourceAdapter {
  normalizeSelector(selector: string, normalizationVersion: string): Promise<Readonly<{
    readonly namespace: string;
    readonly selector: string;
    readonly conflictScopes: ReadonlyArray<string>;
  }>>;
  acquire(request: Readonly<ResourceAdapterRequest>): Promise<Readonly<ResourceProofEvidence>>;
  recover(request: Readonly<ResourceAdapterRequest>): Promise<Readonly<ResourceProofEvidence> | "released" | "unknown">;
  inspect(request: Readonly<ResourceAdapterRequest>): Promise<Readonly<ResourceValidationEvidence>>;
  revokeAccess(request: Readonly<ResourceAdapterRequest>): Promise<"blocked" | "unknown">;
  release(request: Readonly<ResourceAdapterRequest>): Promise<"released" | "unknown">;
}

export interface ResourceAuthorityRegistration {
  readonly authorityId: string;
  readonly registrationId: string;
  readonly generation: string;
  readonly normalizationVersion: string;
  readonly issuer: ResourceProofIssuer;
  readonly adapter: ResourceAdapter;
}

export interface PersistedResourceValidation extends Omit<ResourceValidationEvidence, "evidence"> {
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
  canCleanup(operationId: string, operations: ReadonlyArray<"inspect" | "revoke" | "release">): Promise<boolean>;
}

export interface ResourceCleanupAuthenticator {
  authenticate(credential: string): Promise<Readonly<ResourceCleanupPrincipal>>;
}

export interface VersionedResourceEvidenceSnapshot {
  readonly version: number;
  readonly evidence: Readonly<ResourceEvidenceSnapshot>;
}

export interface ResourceProofController {
  prepare(request: Readonly<ResourcePreparationRequest>): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  revalidate(operationId: string): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  cleanup(operationId: string, credential: string): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  read(operationId: string): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
}

export class ResourceProofRejectedError extends Error {
  override readonly name = "ResourceProofRejectedError";

  constructor(readonly reason: ResourceProofRejectionReason, message: string) {
    super(message);
  }
}

export interface OperationSnapshot {
  readonly operationId: string;
  readonly version: Readonly<OperationVersion>;
  readonly state: OperationState;
  readonly failureReason?: OperationFailureReason;
  readonly startAuthorization: Readonly<StartAuthorizationSnapshot>;
  readonly startInstructionDelivery?: Readonly<StartInstructionDeliveryEvidence>;
  readonly startInstructionAcceptance?: Readonly<StartInstructionAcceptanceEvidence>;
  readonly resultAcceptance?: Readonly<ResultAcceptanceEvidence>;
  readonly stopConfirmation?: Readonly<StopConfirmationEvidence>;
  readonly cleanupDiagnostics: ReadonlyArray<Readonly<CleanupDiagnostic>>;
  readonly resourceEvidence?: Readonly<VersionedResourceEvidenceSnapshot>;
}

export interface OperationReader {
  readonly operationId: string;
  read(): Promise<Readonly<OperationSnapshot>>;
  /** Returns undefined after a profile without an external Start gate terminates. */
  waitForStartupReceipt(): Promise<Readonly<StartupReceipt> | undefined>;
}

export interface WaitingStartAuthorization {
  readonly operationId: string;
  readonly version: Readonly<OperationVersion>;
  readonly deadline: string;
  readonly receipt: Readonly<StartupReceipt>;
}

export interface StartAuthorizationInbox {
  listWaiting(): Promise<ReadonlyArray<Readonly<WaitingStartAuthorization>>>;
}

export interface AuthenticatedStartAuthorizer {
  readonly subjectId: string;
  canAuthorize(operationId: string): Promise<boolean>;
}

export interface StartAuthorizationAuthenticator {
  authenticate(credential: string): Promise<Readonly<AuthenticatedStartAuthorizer>>;
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
  | "tool_policy_violation"
  | "descendant_failed"
  | "resource_proof_rejected";

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
    readonly cancellationEpoch: number,
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
    readonly reason: "cancel-unproven" | "liveness-unproven",
  ) {
    super(`Operation ${operationId} has unknown outcome: ${reason}`);
  }
}

export class SpawnRejectedError extends Error {
  override readonly name = "SpawnRejectedError";

  constructor(
    readonly reason: SpawnRejectionReason,
    readonly parentOperationId: string,
  ) {
    super(`Child Operation rejected for ${parentOperationId}: ${reason}`);
  }
}

export class OperationFailedError extends Error {
  override readonly name = "OperationFailedError";

  constructor(
    readonly operationId: string,
    readonly reason: OperationFailureReason,
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
    readonly reason: PersistenceFailureReason,
  ) {
    super(`Operation ${operationId} persistence failed: ${reason}`);
  }
}

export class ResultConflictError extends Error {
  override readonly name = "ResultConflictError";

  constructor(
    readonly operationId: string,
    readonly acceptedDigest: Result["digest"],
    readonly conflictingDigest: Result["digest"],
  ) {
    super(`Conflicting Result for Operation ${operationId}`);
  }
}

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

export interface OperationHandle extends OperationReader {
  result(): Promise<Result>;
  cancel(options: CancelOptions): Promise<CancellationResult>;
}

export interface Runtime {
  spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle>;
  operation(operationId: string): Promise<OperationReader>;
  startAuthorizationInbox(credential: string): Promise<StartAuthorizationInbox>;
  resourceProofs(): ResourceProofController;
}

export type ArtifactDigest = `sha256:${string}`;

export interface ArtifactMetadata {
  readonly artifactId: string;
  readonly byteCount: number;
  readonly digest: ArtifactDigest;
  readonly formatId: string;
  readonly normalizationId: string;
  readonly dependencies: ReadonlyArray<string>;
}

export interface ArtifactRegistrationRequest {
  readonly registrationId: string;
  readonly expectedByteCount: number;
  readonly expectedDigest: ArtifactDigest;
  readonly formatId: string;
  readonly normalizationId: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly deadline: string;
  readonly recoveryBudget: number;
}

export interface ArtifactRegistrationSnapshot {
  readonly registrationId: string;
  readonly artifactId: string;
  readonly state: "receiving" | "prepared";
}

export type ArtifactFailureReason =
  | "unauthorized"
  | "authority_revoked"
  | "authority_unavailable"
  | "request_mismatch"
  | "conflict"
  | "limit_exceeded"
  | "deadline_expired"
  | "transfer_incomplete"
  | "invalid_format"
  | "input_integrity_mismatch"
  | "stored_artifact_corrupt"
  | "artifact_deletion_pending"
  | "artifact_deleted"
  | "gc_unprocessed"
  | "gc_processing_unavailable"
  | "storage_inspection_unavailable"
  | "recovery_budget_exceeded"
  | "dependency_not_found"
  | "dependency_cycle";

export type ArtifactRegistrationOutcome =
  | { readonly kind: "registered"; readonly artifact: Readonly<ArtifactMetadata> }
  | {
      readonly kind: "continuable";
      readonly reason: "transfer_incomplete";
      readonly registration: Readonly<ArtifactRegistrationSnapshot>;
    }
  | {
      readonly kind: "failed";
      readonly terminal: boolean;
      readonly reason: ArtifactFailureReason;
    };

export type ArtifactRetrievalOutcome =
  | {
      readonly kind: "retrieved";
      readonly artifact: Readonly<ArtifactMetadata>;
      readonly bytes: Uint8Array;
      readonly integrity: "verified";
    }
  | {
      readonly kind: "failed";
      readonly terminal: boolean;
      readonly reason: ArtifactFailureReason;
    };

export type ArtifactAuthorityDecision = "allowed" | "denied" | "revoked" | "unknown";

export interface ResultAcceptancePreparationRequest {
  readonly preparationId: string;
  readonly operationId: string;
  readonly acceptanceRequestId: string;
  readonly manifestDigest: ArtifactDigest;
  readonly requirementsDigest: ArtifactDigest;
  readonly retentionPolicyDigest: ArtifactDigest;
  readonly manifest: Readonly<ResultAcceptanceManifest>;
}

export interface ResultAcceptancePreparationEvidence {
  readonly formatId: "pions.result-acceptance-preparation.v1";
  readonly preparationId: string;
  readonly operationId: string;
  readonly acceptanceRequestId: string;
  readonly manifestDigest: ArtifactDigest;
  readonly requirementsDigest: ArtifactDigest;
  readonly bodyArtifactId: string;
  readonly workProducts: ReadonlyArray<Readonly<ResultAcceptanceManifestWorkProduct>>;
  readonly artifactIds: ReadonlyArray<string>;
  readonly totalByteCount: number;
  readonly acceptedArtifactRetentionMs: number;
  readonly retentionPolicyDigest: ArtifactDigest;
  readonly digest: ArtifactDigest;
}

export interface ResultAcceptanceRetentionPolicyEvidence {
  readonly formatId: "pions.result-acceptance-retention-policy.v1";
  readonly operationId: string;
  readonly acceptedArtifactRetentionMs: number;
  readonly digest: ArtifactDigest;
}

export interface ResultAcceptanceRetentionPolicySource {
  read(operationId: string): Promise<Readonly<ResultAcceptanceRetentionPolicyEvidence> | "unknown">;
}

export interface ResultAcceptanceRequirementsSource {
  read(operationId: string): Promise<Readonly<ResolvedWorkProductRequirements> | "unknown">;
}

export interface ResultAcceptanceEventEvidence {
  readonly preparationId: string;
  readonly operationId: string;
  readonly acceptanceRequestId: string;
  readonly manifestDigest: ArtifactDigest;
  readonly evidenceDigest: ArtifactDigest;
  readonly state: "accepted" | "not_accepted";
  readonly observedAt: string;
  readonly acceptedAt?: string;
}

export interface ResultAcceptanceEventEvidenceVerifier {
  verify(evidence: Readonly<ResultAcceptanceEventEvidence>): Promise<"trusted" | "untrusted" | "unknown">;
}

export interface ResultAcceptancePreparationSnapshot {
  readonly evidence?: Readonly<ResultAcceptancePreparationEvidence>;
  readonly state: "preparing" | "prepared" | "accepted" | "aborted" | "unresolved";
  readonly retentionUntil?: string;
}

export type PublishedResultAcceptancePreparationSnapshot = ResultAcceptancePreparationSnapshot & {
  readonly evidence: Readonly<ResultAcceptancePreparationEvidence>;
};

export type ResultAcceptancePreparationOutcome =
  | { readonly kind: "prepared"; readonly preparation: Readonly<PublishedResultAcceptancePreparationSnapshot> }
  | { readonly kind: "accepted"; readonly preparation: Readonly<PublishedResultAcceptancePreparationSnapshot> }
  | { readonly kind: "aborted"; readonly preparation: Readonly<PublishedResultAcceptancePreparationSnapshot> }
  | { readonly kind: "continuable"; readonly preparation: Readonly<ResultAcceptancePreparationSnapshot> }
  | {
      readonly kind: "failed";
      readonly terminal: boolean;
      readonly reason: ArtifactFailureReason | ResultAcceptanceManifestFailureReason;
    };

export interface ArtifactUseBindingRequest {
  readonly bindingId: string;
  readonly operationId: string;
  readonly artifactId: string;
  readonly purpose: "review_subject";
  readonly decisionId: string;
  readonly authorityBasis: string;
}

export interface ArtifactUseBindingSnapshot extends ArtifactUseBindingRequest {
  readonly subjectId: string;
  readonly dependencyClosure: ReadonlyArray<string>;
  readonly retentionUntil: string;
  readonly state: "preparing" | "available" | "rejected" | "released" | "unresolved";
}

export type ArtifactUseBindingOutcome =
  | { readonly kind: "available"; readonly binding: Readonly<ArtifactUseBindingSnapshot> }
  | { readonly kind: "released"; readonly binding: Readonly<ArtifactUseBindingSnapshot> }
  | { readonly kind: "continuable"; readonly binding: Readonly<ArtifactUseBindingSnapshot> }
  | { readonly kind: "failed"; readonly terminal: boolean; readonly reason: ArtifactFailureReason };

export interface ArtifactRetentionPinRequest {
  readonly pinId: string;
  readonly artifactId: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly retention: "indefinite";
}

export interface ArtifactRetentionPinSnapshot extends ArtifactRetentionPinRequest {
  readonly subjectId: string;
  readonly dependencyClosure: ReadonlyArray<string>;
  readonly state: "held" | "released";
}

export type ArtifactRetentionPinOutcome =
  | { readonly kind: "held"; readonly pin: Readonly<ArtifactRetentionPinSnapshot> }
  | { readonly kind: "released"; readonly pin: Readonly<ArtifactRetentionPinSnapshot> }
  | { readonly kind: "failed"; readonly terminal: boolean; readonly reason: ArtifactFailureReason };

export interface ArtifactGarbageCollectionRequest {
  readonly collectionId: string;
  readonly scanBudget: number;
  readonly deletionBudget: number;
  readonly recoveryBudget: number;
  readonly afterArtifactId?: string;
}

export type ArtifactGarbageCollectionOutcome =
  | { readonly kind: "completed"; readonly deletedArtifactIds: ReadonlyArray<string> }
  | {
      readonly kind: "continuable";
      readonly reason: "gc_unprocessed";
      readonly deletedArtifactIds: ReadonlyArray<string>;
      readonly remainingArtifactIds: ReadonlyArray<string>;
      readonly nextCursor: string;
    }
  | { readonly kind: "failed"; readonly terminal: boolean; readonly reason: ArtifactFailureReason };

export interface ArtifactPrincipal {
  readonly subjectId: string;
  canRegister(request: Readonly<ArtifactRegistrationRequest>): Promise<ArtifactAuthorityDecision>;
  canReference(artifactId: string): Promise<ArtifactAuthorityDecision>;
  canRetrieve(artifactId: string): Promise<ArtifactAuthorityDecision>;
  canBindArtifactUse(request: Readonly<ArtifactUseBindingRequest>, artifactId: string): Promise<ArtifactAuthorityDecision>;
  canPinArtifact(request: Readonly<ArtifactRetentionPinRequest>, artifactId: string): Promise<ArtifactAuthorityDecision>;
  canPrepareResultAcceptance(
    request: Readonly<ResultAcceptancePreparationRequest>,
    artifactId: string,
  ): Promise<ArtifactAuthorityDecision>;
  canReconcileResultAcceptance(
    preparationId: string,
    evidence: Readonly<ResultAcceptanceEventEvidence>,
  ): Promise<ArtifactAuthorityDecision>;
  canGarbageCollect(request: Readonly<ArtifactGarbageCollectionRequest>): Promise<ArtifactAuthorityDecision>;
}

export interface ArtifactAuthenticator {
  authenticate(credential: string): Promise<Readonly<ArtifactPrincipal>>;
  restore(subjectId: string): Promise<Readonly<ArtifactPrincipal>>;
}

export interface ArtifactStorePolicy {
  readonly maxArtifactBytes: number;
  readonly maxConcurrentRegistrations: number;
  readonly maxTemporaryBytes: number;
  readonly maxDirectDependencies: number;
  readonly maxDependencyDepth: number;
  readonly maxDependencyCount: number;
  readonly maxRegistrationWindowMs: number;
  readonly maxRecoveryAttempts: number;
  readonly unusedArtifactRetentionMs: number;
  readonly reviewInputRetentionMs: number;
  readonly maxGarbageCollectionScan: number;
  readonly maxGarbageCollectionDeletes: number;
  readonly maxGarbageCollectionRecoveryAttempts: number;
}

export interface OpenArtifactStoreOptions {
  readonly rootDirectory: string;
  readonly policy: Readonly<ArtifactStorePolicy>;
  readonly authenticator: ArtifactAuthenticator;
  readonly resultAcceptanceRetentionPolicySource?: ResultAcceptanceRetentionPolicySource;
  readonly resultAcceptanceRequirementsSource?: ResultAcceptanceRequirementsSource;
  readonly resultAcceptanceEventEvidenceVerifier?: ResultAcceptanceEventEvidenceVerifier;
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
}

export interface ArtifactStore {
  startRegistration(
    credential: string,
    request: Readonly<ArtifactRegistrationRequest>,
  ): Promise<ArtifactRegistrationOutcome>;
  transfer(
    credential: string,
    registrationId: string,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<ArtifactRegistrationOutcome>;
  registrationStatus(
    credential: string,
    registrationId: string,
  ): Promise<ArtifactRegistrationOutcome>;
  retrieve(credential: string, artifactId: string): Promise<ArtifactRetrievalOutcome>;
  prepareUseBinding(credential: string, request: Readonly<ArtifactUseBindingRequest>): Promise<ArtifactUseBindingOutcome>;
  useBindingStatus(credential: string, bindingId: string): Promise<ArtifactUseBindingOutcome>;
  retrieveForUseBinding(credential: string, bindingId: string): Promise<ArtifactRetrievalOutcome>;
  releaseUseBinding(credential: string, bindingId: string): Promise<ArtifactUseBindingOutcome>;
  createRetentionPin(
    credential: string,
    request: Readonly<ArtifactRetentionPinRequest>,
  ): Promise<ArtifactRetentionPinOutcome>;
  releaseRetentionPin(credential: string, pinId: string): Promise<ArtifactRetentionPinOutcome>;
  prepareResultAcceptance(
    credential: string,
    request: Readonly<ResultAcceptancePreparationRequest>,
  ): Promise<ResultAcceptancePreparationOutcome>;
  resultAcceptancePreparationStatus(
    credential: string,
    preparationId: string,
  ): Promise<ResultAcceptancePreparationOutcome>;
  finalizeResultAcceptance(
    credential: string,
    evidence: Readonly<ResultAcceptanceEventEvidence>,
  ): Promise<ResultAcceptancePreparationOutcome>;
  abortResultAcceptance(
    credential: string,
    evidence: Readonly<ResultAcceptanceEventEvidence>,
  ): Promise<ResultAcceptancePreparationOutcome>;
  collectGarbage(
    credential: string,
    request: Readonly<ArtifactGarbageCollectionRequest>,
  ): Promise<ArtifactGarbageCollectionOutcome>;
  close(): Promise<void>;
}

export type ArtifactStoreOpenFailureReason =
  | "writer_locked"
  | "invalid_policy"
  | "unsupported_root"
  | "storage_inspection_unavailable";

export class ArtifactStoreOpenError extends Error {
  override readonly name = "ArtifactStoreOpenError";

  constructor(readonly reason: ArtifactStoreOpenFailureReason, message: string) {
    super(message);
  }
}
