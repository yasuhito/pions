export { makeVisibleRuntime } from "./internal/visible-runtime.js";
export type { VisibleRuntimeOptions } from "./internal/visible-runtime.js";

export {
  CancellationRejectedError,
  HerdrPreconditionError,
  OperationCancelledError,
  OperationUnknownError,
  OperationFailedError,
  OperationPersistenceError,
  ResultConflictError,
  SpawnRejectedError,
} from "./public.js";
export type {
  CancellationRejectionReason,
  CancellationResult,
  CancelOptions,
  OperationFailureReason,
  OperationHandle,
  PersistenceFailureReason,
  Result,
  Runtime,
  SpawnRejectionReason,
  SpawnOptions,
  TaskSpec,
} from "./public.js";
