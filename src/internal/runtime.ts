import { Cause, Effect, Exit, Schema } from "effect";

import type {
  EventInput,
  Operation,
  OperationLineage,
} from "./domain.js";
import type {
  BackendCancellationEvidence,
  RuntimeServices,
  StoreError,
} from "./services.js";
import {
  CancellationRejectedError,
  OperationCancelledError,
  OperationFailedError,
  OperationPersistenceError,
  OperationUnknownError,
  ResultConflictError,
  SpawnRejectedError,
} from "../public.js";
import type {
  CancellationResult,
  CancelOptions,
  OperationFailureReason,
  OperationHandle,
  Result,
  Runtime,
  SpawnOptions,
  TaskSpec,
} from "../public.js";

const MAX_DEPTH = 2;
const MAX_CHILDREN_PER_OPERATION = 3;
const MAX_LIVE_DESCENDANTS_PER_ROOT = 4;
const DESCENDANT_FAILURE_POLICY = "fail_parent" as const;

const TaskSpecSchema = Schema.Struct({
  promptRef: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
});

export class RuntimeError extends Error {
  override readonly name = "RuntimeError";

  constructor(readonly code: "operation_failed", message: string) {
    super(message);
  }
}

interface OperationRecord {
  readonly operationId: string;
  readonly lineage: OperationLineage;
  readonly children: Set<string>;
  readonly resultPromise: Promise<Result>;
  readonly resolveResult: (result: Result) => void;
  readonly rejectResult: (error: unknown) => void;
  pendingAdmissions: number;
  selfSettled: boolean;
  terminal: boolean;
  spawnFrozen: boolean;
  cancellationEpoch: number;
  finalizing?: Promise<void>;
  result?: Result;
  resultDeliveryError?: ResultConflictError;
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
  const spawnsByParent = new Map<
    string | undefined,
    Map<string, Promise<OperationHandle>>
  >();
  const records = new Map<string, OperationRecord>();
  const liveDescendantsByRoot = new Map<string, number>();
  const cancellations = new Map<string, Promise<CancellationResult>>();
  const cancellingSubtreeRoots = new Set<string>();
  let treeMutationTail = Promise.resolve();

  const serializeTreeMutation = async <Value>(
    mutation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = treeMutationTail;
    let release!: () => void;
    treeMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  };

  const persistenceError = (
    operationId: string,
    error: StoreError,
  ): OperationPersistenceError =>
    new OperationPersistenceError(
      operationId,
      error.code === "not_found" ? "corrupt_record" : error.code,
    );

  const append = (
    operationId: string,
    input: EventInput,
  ): Effect.Effect<Operation, OperationPersistenceError> =>
    services.store.append(operationId, input).pipe(
      Effect.mapError((error) => persistenceError(operationId, error)),
    );

  const getOperation = (operationId: string) =>
    services.store.get(operationId).pipe(
      Effect.mapError((error) => persistenceError(operationId, error)),
    );

  const project = (operation: Operation): Effect.Effect<void> =>
    Effect.catchAllCause(services.presentation.project(operation), () => Effect.void);

  const run = async <Value>(effect: Effect.Effect<Value, unknown>): Promise<Value> => {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    throw new RuntimeError("operation_failed", Cause.pretty(exit.cause));
  };

  const settleTerminal = async (
    record: OperationRecord,
    operation: Operation,
  ): Promise<void> => {
    if (record.terminal) return;
    record.terminal = true;
    await run(project(operation));

    if (record.lineage.parentOperationId !== undefined) {
      const current = liveDescendantsByRoot.get(record.lineage.rootOperationId) ?? 0;
      liveDescendantsByRoot.set(record.lineage.rootOperationId, current - 1);
    }

    if (record.resultDeliveryError !== undefined) {
      record.rejectResult(record.resultDeliveryError);
    } else if (operation.state === "completed" && record.result !== undefined) {
      record.resolveResult(record.result);
    } else if (operation.state === "cancelled") {
      record.rejectResult(new OperationCancelledError(record.operationId));
    } else if (operation.state === "unknown") {
      record.rejectResult(
        new OperationUnknownError(record.operationId, "cancel-unproven"),
      );
    } else {
      record.rejectResult(
        new OperationFailedError(
          record.operationId,
          operation.terminalReason === "backend_start_failed" ||
          operation.terminalReason === "descendant_failed"
            ? operation.terminalReason
            : "descendant_failed",
        ),
      );
    }

    const parentId = record.lineage.parentOperationId;
    if (parentId === undefined) return;
    const parent = records.get(parentId);
    if (parent === undefined || parent.terminal) return;

    const parentAfterChild = await run(
      append(parentId, {
        type: "child_settled",
        childOperationId: record.operationId,
        outcome: operation.state === "completed" ? "succeeded" : "failed",
      }),
    );
    await run(project(parentAfterChild));
    await tryFinalize(parent);
  };

  const finalizeOnce = async (record: OperationRecord): Promise<void> => {
    if (record.terminal || !record.selfSettled || record.pendingAdmissions > 0) {
      return;
    }
    const operation = await run(getOperation(record.operationId));
    if (
      operation.childOperationIds.length !==
      operation.settledChildOperationIds.length
    ) {
      return;
    }

    const failureReason: OperationFailureReason | undefined =
      operation.selfOutcome === "failed"
        ? operation.failureReason
        : operation.descendantFailure &&
            DESCENDANT_FAILURE_POLICY === "fail_parent"
          ? "descendant_failed"
          : undefined;
    const terminal = await run(
      append(
        record.operationId,
        failureReason === undefined
          ? { type: "operation_completed" }
          : { type: "operation_failed", reason: failureReason },
      ),
    );
    await settleTerminal(record, terminal);
  };

  const tryFinalize = async (record: OperationRecord): Promise<void> => {
    while (!record.terminal) {
      const inProgress = record.finalizing;
      if (inProgress !== undefined) {
        await inProgress;
        continue;
      }

      const finalizing = finalizeOnce(record);
      record.finalizing = finalizing;
      try {
        await finalizing;
      } finally {
        delete record.finalizing;
      }
      return;
    }
  };

  const execute = async (record: OperationRecord): Promise<void> => {
    try {
      let operation = await run(
        append(record.operationId, { type: "operation_starting" }),
      );
      await run(project(operation));

      const backendStart = await Effect.runPromise(
        Effect.either(services.backend.start(operation)),
      );
      if (backendStart._tag === "Left") {
        const reason = backendStart.left.reason;
        await run(
          Effect.catchAllCause(
            services.presentation.onBackendStartFailure(operation),
            () => Effect.void,
          ),
        );
        operation = await run(
          append(record.operationId, {
            type: "self_settled",
            outcome: "failed",
            reason,
          }),
        );
        record.selfSettled = true;
        await run(project(operation));
        await tryFinalize(record);
        return;
      }

      operation = await run(
        append(record.operationId, { type: "operation_started" }),
      );
      await run(project(operation));

      const deliveries = await run(services.channel.receiveResults(operation));
      const firstDelivery = deliveries[0];
      if (firstDelivery === undefined) {
        throw new Error("ChildChannel returned no Result");
      }

      const accepted = await run(
        services.store.acceptResult(record.operationId, firstDelivery).pipe(
          Effect.mapError((error) =>
            error instanceof ResultConflictError
              ? error
              : persistenceError(record.operationId, error),
          ),
        ),
      );
      record.result = accepted.result;

      for (const delivery of deliveries.slice(1)) {
        try {
          await run(
            services.store.acceptResult(record.operationId, delivery).pipe(
              Effect.mapError((error) =>
                error instanceof ResultConflictError
                  ? error
                  : persistenceError(record.operationId, error),
              ),
            ),
          );
        } catch (error) {
          if (error instanceof ResultConflictError) {
            record.resultDeliveryError = error;
          } else {
            throw error;
          }
        }
      }

      operation = await run(
        append(record.operationId, {
          type: "self_settled",
          outcome: "succeeded",
        }),
      );
      record.selfSettled = true;
      await run(project(operation));
      await tryFinalize(record);
    } catch (error) {
      if (!record.terminal) {
        record.terminal = true;
        record.rejectResult(
          error instanceof ResultConflictError ||
          error instanceof OperationPersistenceError
            ? error
            : new RuntimeError(
                "operation_failed",
                error instanceof Error ? error.message : String(error),
              ),
        );
      }
    }
  };

  const createOperationUnlocked = async (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationHandle> => {
    await run(services.presentation.preflight());
    const task = await Effect.runPromise(
      Schema.decodeUnknown(TaskSpecSchema)(taskInput),
    );
    const parentId = options?.parentOperationId;
    const parent = parentId === undefined ? undefined : records.get(parentId);

    if (parentId !== undefined && parent === undefined) {
      throw new SpawnRejectedError("parent_not_found", parentId);
    }
    if (parent !== undefined) {
      if (parent.spawnFrozen) {
        throw new SpawnRejectedError(
          "cancellation_in_progress",
          parent.operationId,
        );
      }
      if (parent.terminal || parent.selfSettled) {
        throw new SpawnRejectedError("parent_terminal", parent.operationId);
      }
      if (parent.lineage.depth + 1 > MAX_DEPTH) {
        throw new SpawnRejectedError("depth_limit_exceeded", parent.operationId);
      }
      if (parent.children.size + parent.pendingAdmissions >= MAX_CHILDREN_PER_OPERATION) {
        throw new SpawnRejectedError("child_limit_exceeded", parent.operationId);
      }
      const live = liveDescendantsByRoot.get(parent.lineage.rootOperationId) ?? 0;
      if (live >= MAX_LIVE_DESCENDANTS_PER_ROOT) {
        throw new SpawnRejectedError(
          "live_descendant_limit_exceeded",
          parent.operationId,
        );
      }
      parent.pendingAdmissions += 1;
      liveDescendantsByRoot.set(parent.lineage.rootOperationId, live + 1);
    }

    let operationId: string;
    try {
      operationId = await Effect.runPromise(services.ids.nextOperationId());
    } catch (error) {
      if (parent !== undefined) {
        parent.pendingAdmissions -= 1;
        const live = liveDescendantsByRoot.get(parent.lineage.rootOperationId) ?? 1;
        liveDescendantsByRoot.set(parent.lineage.rootOperationId, live - 1);
      }
      throw error;
    }

    const lineage: OperationLineage =
      parent === undefined
        ? { rootOperationId: operationId, depth: 0 }
        : {
            rootOperationId: parent.lineage.rootOperationId,
            parentOperationId: parent.operationId,
            depth: parent.lineage.depth + 1,
          };
    const deferred = deferredResult();
    const record: OperationRecord = {
      operationId,
      lineage,
      children: new Set(),
      resultPromise: deferred.promise,
      resolveResult: deferred.resolve,
      rejectResult: deferred.reject,
      pendingAdmissions: 0,
      selfSettled: false,
      terminal: false,
      spawnFrozen: false,
      cancellationEpoch: 0,
    };

    if (parent !== undefined) {
      parent.children.add(operationId);
      const parentOperation = await run(
        append(parent.operationId, {
          type: "child_attached",
          childOperationId: operationId,
        }),
      );
      parent.pendingAdmissions -= 1;
      await run(project(parentOperation));
    } else {
      liveDescendantsByRoot.set(operationId, 0);
    }

    records.set(operationId, record);
    let operation = await run(
      append(operationId, { type: "operation_requested", task, lineage }),
    );
    await run(project(operation));

    const createdPresentation = await run(services.presentation.create(operation));
    try {
      operation = await run(
        append(operationId, {
          type: "presentation_owned",
          presentation: { ...createdPresentation, ownedByPions: true },
        }),
      );
    } catch (error) {
      await run(
        Effect.catchAllCause(
          services.presentation.rollbackCreated(createdPresentation),
          () => Effect.void,
        ),
      );
      records.delete(operationId);
      throw error;
    }
    await run(project(operation));

    const handle: OperationHandle = {
      operationId,
      result: () => record.resultPromise,
      cancel: (cancelOptions) => cancelSubtree(record, cancelOptions),
    };
    void execute(record);
    return handle;
  };

  const createOperation = (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationHandle> =>
    serializeTreeMutation(() => createOperationUnlocked(taskInput, options));

  const isAncestor = (
    possibleAncestor: OperationRecord,
    operation: OperationRecord,
  ): boolean => {
    let current: OperationRecord | undefined = operation;
    while (current !== undefined) {
      if (current === possibleAncestor) return true;
      const parentId: string | undefined = current.lineage.parentOperationId;
      current = parentId === undefined ? undefined : records.get(parentId);
    }
    return false;
  };

  const cancelSubtree = (
    root: OperationRecord,
    options: CancelOptions,
  ): Promise<CancellationResult> => {
    const epoch = options.cancellationEpoch ?? root.cancellationEpoch + 1;
    const key = `${root.operationId}:${epoch}`;
    const existing = cancellations.get(key);
    if (existing !== undefined) return existing;
    if (epoch <= root.cancellationEpoch) {
      return Promise.reject(new CancellationRejectedError("stale_epoch", epoch));
    }
    const overlapsCancellation = [...cancellingSubtreeRoots].some((rootId) => {
      const activeRoot = records.get(rootId);
      return (
        activeRoot !== undefined &&
        (isAncestor(activeRoot, root) || isAncestor(root, activeRoot))
      );
    });
    if (
      root.spawnFrozen ||
      epoch > root.cancellationEpoch + 1 ||
      overlapsCancellation
    ) {
      return Promise.reject(new CancellationRejectedError("future_epoch", epoch));
    }
    root.cancellationEpoch = epoch;
    cancellingSubtreeRoots.add(root.operationId);

    const cancellation: Promise<CancellationResult> = serializeTreeMutation(async () => {
      const postOrder: Array<OperationRecord> = [];
      const visit = (record: OperationRecord): void => {
        for (const childId of record.children) {
          const child = records.get(childId);
          if (child !== undefined && !child.terminal) visit(child);
        }
        if (!record.terminal) postOrder.push(record);
      };
      visit(root);

      for (const record of postOrder) {
        record.spawnFrozen = true;
        record.cancellationEpoch = epoch;
      }
      for (const record of postOrder) {
        const operation = await run(
          append(record.operationId, {
            type: "cancellation_requested",
            cancellationEpoch: epoch,
          }),
        );
        await run(project(operation));
      }
      return postOrder;
    }).then(async (postOrder) => {
      const responses: Array<
        Promise<BackendCancellationEvidence | undefined>
      > = [];
      for (const record of postOrder) {
        const operation = await run(
          append(record.operationId, {
            type: "cancel_dispatched",
            cancellationEpoch: epoch,
          }),
        );
        await run(project(operation));
        const response = Promise.race([
          run(services.backend.cancel(operation, epoch)),
          run(services.clock.sleep(options.timeoutMs ?? 1_000)).then(
            () => undefined,
          ),
        ]).catch(() => undefined);
        responses.push(response);
      }

      const evidence = await Promise.all(responses);
      const unprovenSubtrees = new Set<string>();
      let rootState: CancellationResult["state"] = "cancelled";
      for (let index = 0; index < postOrder.length; index += 1) {
        const record = postOrder[index];
        if (record === undefined) continue;
        const descendantUnproven = [...record.children].some((childId) =>
          unprovenSubtrees.has(childId),
        );
        const response = evidence[index];
        const unproven = response === undefined || descendantUnproven;
        if (unproven) unprovenSubtrees.add(record.operationId);

        if (response !== undefined) {
          const acknowledged = await run(
            append(record.operationId, {
              type: "cancel_acknowledged",
              cancellationEpoch: epoch,
              proof: response.proof,
            }),
          );
          await run(project(acknowledged));
        }

        const terminal = unproven
          ? await run(
              append(record.operationId, {
                type: "operation_unknown",
                cancellationEpoch: epoch,
                reason: "cancel-unproven",
              }),
            )
          : await run(
              append(record.operationId, {
                type: "operation_cancelled",
                cancellationEpoch: epoch,
              }),
            );
        await settleTerminal(record, terminal);
        if (record === root) {
          rootState = terminal.state as CancellationResult["state"];
        }
      }

      return rootState === "unknown"
        ? {
            cancellationEpoch: epoch,
            state: rootState,
            reason: "cancel-unproven" as const,
          }
        : { cancellationEpoch: epoch, state: rootState };
    });
    cancellations.set(key, cancellation);
    return cancellation;
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

      const spawn = createOperation(task, options);
      spawnsByKey.set(task.idempotencyKey, spawn);
      return spawn;
    },
  };
}
