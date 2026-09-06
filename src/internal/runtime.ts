import {
  OperationCancelledError,
  OperationFailedError,
  OperationPersistenceError,
  OperationUnknownError,
  ResultConflictError,
} from "../public.js";
import type {
  OperationHandle,
  Result,
  Runtime,
  SpawnOptions,
  TaskSpec,
} from "../public.js";
import { makeDurableOperations } from "./operation-lifecycle.js";
import type { RuntimeServices } from "./services.js";

export class RuntimeError extends Error {
  override readonly name = "RuntimeError";

  constructor(readonly code: "operation_failed", message: string) {
    super(message);
  }
}

function deferredResult(): {
  readonly promise: Promise<Result>;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export function makeRuntime(services: RuntimeServices): Runtime {
  const operations = makeDurableOperations(services);
  const spawnsByParent = new Map<
    string | undefined,
    Map<string, Promise<OperationHandle>>
  >();

  const createHandle = async (
    task: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationHandle> => {
    const admission = await operations.admit(task, options);
    const deferred = deferredResult();

    void operations.run(admission).then(
      (outcome) => {
        switch (outcome.state) {
          case "completed":
            if (outcome.resultDeliveryError === undefined) {
              deferred.resolve(outcome.result);
            } else {
              deferred.reject(outcome.resultDeliveryError);
            }
            return;
          case "failed":
            deferred.reject(
              new OperationFailedError(admission.operationId, outcome.reason),
            );
            return;
          case "cancelled":
            deferred.reject(new OperationCancelledError(admission.operationId));
            return;
          case "unknown":
            deferred.reject(
              new OperationUnknownError(admission.operationId, outcome.reason),
            );
        }
      },
      (error: unknown) => {
        deferred.reject(
          error instanceof ResultConflictError ||
          error instanceof OperationPersistenceError
            ? error
            : new RuntimeError(
                "operation_failed",
                error instanceof Error ? error.message : String(error),
              ),
        );
      },
    );

    return {
      operationId: admission.operationId,
      result: () => deferred.promise,
      cancel: (cancelOptions) =>
        operations.cancelSubtree(admission.operationId, cancelOptions),
    };
  };

  return {
    spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle> {
      const parentOperationId = options?.parentOperationId;
      let spawnsByKey = spawnsByParent.get(parentOperationId);
      if (spawnsByKey === undefined) {
        spawnsByKey = new Map();
        spawnsByParent.set(parentOperationId, spawnsByKey);
      }

      const existing = spawnsByKey.get(task.idempotencyKey);
      if (existing !== undefined) return existing;

      const spawn = createHandle(task, options);
      spawnsByKey.set(task.idempotencyKey, spawn);
      return spawn;
    },
  };
}
