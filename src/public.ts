export interface TaskSpec {
  readonly promptRef: string;
  readonly profile: string;
  readonly idempotencyKey: string;
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
  | "backend_start_failed"
  | "descendant_failed";

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
    readonly reason: "cancel-unproven",
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
