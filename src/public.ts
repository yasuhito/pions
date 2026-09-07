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

export interface SpawnOptions {
  readonly parentOperationId?: string;
}

export interface Result {
  readonly body: string;
  readonly byteCount: number;
  readonly digest: `sha256:${string}`;
}

export type OperationFailureReason =
  | "worker_start_failed"
  | "worker_protocol_failed"
  | "process-exited-without-result"
  | "agent_failed"
  | "model_mismatch"
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

export interface OperationHandle {
  readonly operationId: string;
  result(): Promise<Result>;
  cancel(options: CancelOptions): Promise<CancellationResult>;
}

export interface Runtime {
  spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle>;
}
