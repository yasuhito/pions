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

export interface OperationHandle {
  readonly operationId: string;
  result(): Promise<Result>;
}

export interface Runtime {
  spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle>;
}
