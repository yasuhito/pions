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

export interface WorkerProfilePolicy {
  readonly modelCandidates: ReadonlyArray<Readonly<ModelReference>>;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: ReadonlyArray<string>;
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
  | "descendant_failed";

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
}
