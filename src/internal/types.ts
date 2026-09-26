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

export interface WorkerProfilePolicy {
  readonly modelCandidates: ReadonlyArray<Readonly<ModelReference>>;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: ReadonlyArray<string>;
  readonly maxResultByteCount: number;
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

export interface StartInstructionReference {
  readonly dispatcherId: string;
  readonly workerProcessInstanceId: string;
  readonly receiptDigest: Sha256Digest;
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

export type OperationFailureReason =
  | "worker_start_failed"
  | "worker_protocol_failed"
  | "process-exited-without-result"
  | "agent_failed"
  | "model_mismatch"
  | "thinking_level_mismatch"
  | "tool_policy_violation";

export class HerdrPreconditionError extends Error {
  override readonly name = "HerdrPreconditionError";

  constructor(readonly missingVariables: ReadonlyArray<string>) {
    super(`Herdr environment is unavailable: ${missingVariables.join(", ")}`);
  }
}

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
    readonly reason: OperationFailureReason,
    readonly agentErrorMessage?: string
  ) {
    super(
      agentErrorMessage === undefined
        ? `Operation ${operationId} failed: ${reason}`
        : `Operation ${operationId} failed: ${reason}: ${agentErrorMessage}`
    );
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

export interface OperationRuntime {
  ready(): Promise<void>;
  spawn(task: TaskSpec): Promise<OperationHandle>;
  operation(operationId: string): Promise<OperationReader>;
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
