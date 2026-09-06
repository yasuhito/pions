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
  OperationPersistenceError,
  ResultConflictError,
  SpawnRejectedError,
} from "../public.js";
import type {
  CancellationResult,
  CancelOptions,
  OperationFailureReason,
  Result,
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

export interface OperationAdmission {
  readonly operationId: string;
}

export type TerminalOutcome =
  | { readonly state: "completed"; readonly result: Result; readonly resultDeliveryError?: ResultConflictError }
  | { readonly state: "failed"; readonly reason: OperationFailureReason }
  | { readonly state: "cancelled" }
  | { readonly state: "unknown"; readonly reason: "cancel-unproven" };

export interface DurableOperations {
  admit(task: TaskSpec, options?: SpawnOptions): Promise<OperationAdmission>;
  run(admission: OperationAdmission): Promise<TerminalOutcome>;
  cancelSubtree(operationId: string, options: CancelOptions): Promise<CancellationResult>;
}

interface OperationRecord {
  readonly operationId: string;
  readonly terminalPromise: Promise<TerminalOutcome>;
  readonly resolveTerminal: (outcome: TerminalOutcome) => void;
  readonly rejectTerminal: (error: unknown) => void;
  pendingAdmissions: number;
  execution?: Promise<TerminalOutcome>;
  finalizing?: Promise<void>;
  resultDeliveryError?: ResultConflictError;
}

function deferredTerminal(): {
  readonly promise: Promise<TerminalOutcome>;
  readonly resolve: (outcome: TerminalOutcome) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (outcome: TerminalOutcome) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<TerminalOutcome>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function isTerminal(operation: Operation): boolean {
  return operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" || operation.state === "unknown";
}

export function makeDurableOperations(services: RuntimeServices): DurableOperations {
  const records = new Map<string, OperationRecord>();
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

  const readResult = (operationId: string) =>
    services.store.readResult(operationId).pipe(
      Effect.mapError((error) => persistenceError(operationId, error)),
    );

  const runEffect = async <Value>(effect: Effect.Effect<Value, unknown>): Promise<Value> => {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    throw new Error(Cause.pretty(exit.cause));
  };

  const settleTerminal = async (
    record: OperationRecord,
    operation: Operation,
  ): Promise<void> => {
    await runEffect(project(operation));

    if (operation.state === "completed") {
      const result = await runEffect(readResult(record.operationId));
      record.resolveTerminal({
        state: "completed",
        result,
        ...(record.resultDeliveryError === undefined
          ? {}
          : { resultDeliveryError: record.resultDeliveryError }),
      });
    } else if (operation.state === "cancelled") {
      record.resolveTerminal({ state: "cancelled" });
    } else if (operation.state === "unknown") {
      record.resolveTerminal({ state: "unknown", reason: "cancel-unproven" });
    } else {
      record.resolveTerminal({
        state: "failed",
        reason:
          operation.terminalReason === "backend_start_failed" ||
          operation.terminalReason === "worker_protocol_failed" ||
          operation.terminalReason === "descendant_failed"
            ? operation.terminalReason
            : "descendant_failed",
      });
    }

    const parentId = operation.lineage.parentOperationId;
    if (parentId === undefined) return;
    const parent = records.get(parentId);
    if (parent === undefined) return;
    const parentOperation = await runEffect(getOperation(parentId));
    if (isTerminal(parentOperation)) return;

    const parentAfterChild = await runEffect(
      append(parentId, {
        type: "child_settled",
        childOperationId: record.operationId,
        outcome: operation.state === "completed" ? "succeeded" : "failed",
      }),
    );
    await runEffect(project(parentAfterChild));
    await tryFinalize(parent);
  };

  const finalizeOnce = async (record: OperationRecord): Promise<void> => {
    if (record.pendingAdmissions > 0) return;
    const operation = await runEffect(getOperation(record.operationId));
    if (isTerminal(operation) || operation.selfOutcome === undefined) return;
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
    const terminal = await runEffect(
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
    while (true) {
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
      let operation = await runEffect(
        append(record.operationId, { type: "operation_starting" }),
      );
      await runEffect(project(operation));

      const backendStart = await Effect.runPromise(
        Effect.either(services.backend.start(operation)),
      );
      if (backendStart._tag === "Left") {
        const reason = backendStart.left.reason;
        await runEffect(
          Effect.catchAllCause(
            services.presentation.onBackendStartFailure(operation),
            () => Effect.void,
          ),
        );
        operation = await runEffect(
          append(record.operationId, {
            type: "self_settled",
            outcome: "failed",
            reason,
          }),
        );
        await runEffect(project(operation));
        await tryFinalize(record);
        return;
      }

      operation = await runEffect(
        append(record.operationId, { type: "operation_started" }),
      );
      await runEffect(project(operation));

      const workerIdentity = await runEffect(services.channel.receiveStarted(operation));
      operation = await runEffect(
        append(record.operationId, {
          type: "worker_identified",
          workerIdentity: {
            processInstanceId: workerIdentity.processInstanceId,
            paneId: operation.presentation?.paneId ?? "",
          },
        }),
      );
      await runEffect(project(operation));
      const reception = await runEffect(services.channel.receiveResults(operation));
      const firstDelivery = reception.deliveries[0];
      if (firstDelivery === undefined) {
        throw new Error("ChildChannel returned no Result");
      }

      for (const delivery of reception.deliveries) {
        try {
          await runEffect(
            services.store.acceptResult(record.operationId, delivery).pipe(
              Effect.mapError((error) =>
                error instanceof ResultConflictError
                  ? error
                  : persistenceError(record.operationId, error),
              ),
            ),
          );
          await runEffect(services.channel.acknowledgeResult(operation, delivery.sequenceNumber));
        } catch (error) {
          if (delivery !== firstDelivery && error instanceof ResultConflictError) {
            record.resultDeliveryError = error;
          } else {
            throw error;
          }
        }
      }

      operation = await runEffect(
        append(record.operationId, {
          type: "self_settled",
          outcome: "succeeded",
        }),
      );
      await runEffect(project(operation));
      await tryFinalize(record);
    } catch (error) {
      const current = await runEffect(getOperation(record.operationId)).catch(() => undefined);
      if (current !== undefined && isTerminal(current)) return;
      if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ChannelError") {
        const failed = await runEffect(
          append(record.operationId, {
            type: "self_settled",
            outcome: "failed",
            reason: "worker_protocol_failed",
          }),
        );
        await runEffect(project(failed));
        await tryFinalize(record);
      } else {
        record.rejectTerminal(error);
      }
    }
  };

  const countLiveDescendants = async (rootOperationId: string): Promise<number> => {
    let count = 0;
    for (const active of records.values()) {
      const operation = await runEffect(getOperation(active.operationId));
      if (
        operation.lineage.rootOperationId === rootOperationId &&
        operation.lineage.parentOperationId !== undefined &&
        !isTerminal(operation)
      ) {
        count += 1;
      }
    }
    return count;
  };

  const createOperationUnlocked = async (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationAdmission> => {
    await runEffect(services.presentation.preflight());
    const task = await Effect.runPromise(
      Schema.decodeUnknown(TaskSpecSchema)(taskInput),
    );
    const parentId = options?.parentOperationId;
    const parent = parentId === undefined ? undefined : records.get(parentId);

    if (parentId !== undefined && parent === undefined) {
      throw new SpawnRejectedError("parent_not_found", parentId);
    }
    const parentOperation = parent === undefined
      ? undefined
      : await runEffect(getOperation(parent.operationId));
    if (parent !== undefined && parentOperation !== undefined) {
      let cancellationInProgress = parentOperation.spawnFrozen;
      for (const cancellingRootId of cancellingSubtreeRoots) {
        if (await isAncestor(cancellingRootId, parent.operationId)) {
          cancellationInProgress = true;
          break;
        }
      }
      if (cancellationInProgress) {
        throw new SpawnRejectedError(
          "cancellation_in_progress",
          parent.operationId,
        );
      }
      if (isTerminal(parentOperation) || parentOperation.selfOutcome !== undefined) {
        throw new SpawnRejectedError("parent_terminal", parent.operationId);
      }
      if (parentOperation.lineage.depth + 1 > MAX_DEPTH) {
        throw new SpawnRejectedError("depth_limit_exceeded", parent.operationId);
      }
      if (
        parentOperation.childOperationIds.length + parent.pendingAdmissions >=
        MAX_CHILDREN_PER_OPERATION
      ) {
        throw new SpawnRejectedError("child_limit_exceeded", parent.operationId);
      }
      const live = await countLiveDescendants(parentOperation.lineage.rootOperationId);
      if (live >= MAX_LIVE_DESCENDANTS_PER_ROOT) {
        throw new SpawnRejectedError(
          "live_descendant_limit_exceeded",
          parent.operationId,
        );
      }
      parent.pendingAdmissions += 1;
    }

    let operationId: string;
    try {
      operationId = await Effect.runPromise(services.ids.nextOperationId());
    } catch (error) {
      if (parent !== undefined) parent.pendingAdmissions -= 1;
      throw error;
    }

    const lineage: OperationLineage =
      parentOperation === undefined
        ? { rootOperationId: operationId, depth: 0 }
        : {
            rootOperationId: parentOperation.lineage.rootOperationId,
            parentOperationId: parentOperation.operationId,
            depth: parentOperation.lineage.depth + 1,
          };
    const deferred = deferredTerminal();
    const record: OperationRecord = {
      operationId,
      terminalPromise: deferred.promise,
      resolveTerminal: deferred.resolve,
      rejectTerminal: deferred.reject,
      pendingAdmissions: 0,
    };

    if (parent !== undefined) {
      const updatedParent = await runEffect(
        append(parent.operationId, {
          type: "child_attached",
          childOperationId: operationId,
        }),
      );
      parent.pendingAdmissions -= 1;
      await runEffect(project(updatedParent));
    }

    records.set(operationId, record);
    let operation = await runEffect(
      append(operationId, { type: "operation_requested", task, lineage }),
    );
    await runEffect(project(operation));

    const createdPresentation = await runEffect(services.presentation.create(operation));
    try {
      operation = await runEffect(
        append(operationId, {
          type: "presentation_owned",
          presentation: { ...createdPresentation, ownedByPions: true },
        }),
      );
    } catch (error) {
      await runEffect(
        Effect.catchAllCause(
          services.presentation.rollbackCreated(createdPresentation),
          () => Effect.void,
        ),
      );
      records.delete(operationId);
      throw error;
    }
    await runEffect(project(operation));
    return { operationId };
  };

  const createOperation = (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationAdmission> =>
    serializeTreeMutation(() => createOperationUnlocked(taskInput, options));

  const isAncestor = async (
    possibleAncestorId: string,
    operationId: string,
  ): Promise<boolean> => {
    let currentId: string | undefined = operationId;
    while (currentId !== undefined) {
      if (currentId === possibleAncestorId) return true;
      const current = records.get(currentId);
      if (current === undefined) return false;
      const operation = await runEffect(getOperation(current.operationId));
      currentId = operation.lineage.parentOperationId;
    }
    return false;
  };

  interface CancellationNode {
    readonly record: OperationRecord;
    readonly childOperationIds: ReadonlyArray<string>;
  }

  const collectPostOrder = async (
    record: OperationRecord,
    postOrder: Array<CancellationNode>,
  ): Promise<void> => {
    const operation = await runEffect(getOperation(record.operationId));
    if (isTerminal(operation)) return;
    const activeChildIds: Array<string> = [];
    for (const childId of operation.childOperationIds) {
      const child = records.get(childId);
      if (child === undefined) continue;
      const childOperation = await runEffect(getOperation(childId));
      if (isTerminal(childOperation)) continue;
      activeChildIds.push(childId);
      await collectPostOrder(child, postOrder);
    }
    postOrder.push({ record, childOperationIds: activeChildIds });
  };

  const beginCancellation = async (
    root: OperationRecord,
    options: CancelOptions,
  ): Promise<CancellationResult> => {
    const rootOperation = await runEffect(getOperation(root.operationId));
    const epoch = options.cancellationEpoch ?? rootOperation.cancellationEpoch + 1;
    if (epoch <= rootOperation.cancellationEpoch) {
      throw new CancellationRejectedError("stale_epoch", epoch);
    }

    let overlapsCancellation = false;
    for (const rootId of cancellingSubtreeRoots) {
      if (rootId === root.operationId) continue;
      if (
        await isAncestor(rootId, root.operationId) ||
        await isAncestor(root.operationId, rootId)
      ) {
        overlapsCancellation = true;
        break;
      }
    }
    if (
      rootOperation.spawnFrozen ||
      epoch > rootOperation.cancellationEpoch + 1 ||
      overlapsCancellation
    ) {
      throw new CancellationRejectedError("future_epoch", epoch);
    }
    const cancellation: Promise<CancellationResult> = serializeTreeMutation(async () => {
      const postOrder: Array<CancellationNode> = [];
      await collectPostOrder(root, postOrder);
      for (const { record } of postOrder) {
        const operation = await runEffect(
          append(record.operationId, {
            type: "cancellation_requested",
            cancellationEpoch: epoch,
          }),
        );
        await runEffect(project(operation));
      }
      return postOrder;
    }).then(async (postOrder) => {
      const responses: Array<
        Promise<BackendCancellationEvidence | undefined>
      > = [];
      for (const { record } of postOrder) {
        const operation = await runEffect(
          append(record.operationId, {
            type: "cancel_dispatched",
            cancellationEpoch: epoch,
          }),
        );
        await runEffect(project(operation));
        const response = Promise.race([
          runEffect(services.backend.cancel(operation, epoch)),
          runEffect(services.clock.sleep(options.timeoutMs ?? 1_000)).then(
            () => undefined,
          ),
        ]).catch(() => undefined);
        responses.push(response);
      }

      const evidence = await Promise.all(responses);
      const unprovenSubtrees = new Set<string>();
      let rootState: CancellationResult["state"] = "cancelled";
      for (let index = 0; index < postOrder.length; index += 1) {
        const node = postOrder[index];
        if (node === undefined) continue;
        const descendantUnproven = node.childOperationIds.some((childId) =>
          unprovenSubtrees.has(childId),
        );
        const response = evidence[index];
        const unproven = response === undefined || descendantUnproven;
        if (unproven) unprovenSubtrees.add(node.record.operationId);

        if (response !== undefined) {
          const acknowledged = await runEffect(
            append(node.record.operationId, {
              type: "cancel_acknowledged",
              cancellationEpoch: epoch,
              proof: response.proof,
            }),
          );
          await runEffect(project(acknowledged));
        }

        const terminal = unproven
          ? await runEffect(
              append(node.record.operationId, {
                type: "operation_unknown",
                cancellationEpoch: epoch,
                reason: "cancel-unproven",
              }),
            )
          : await runEffect(
              append(node.record.operationId, {
                type: "operation_cancelled",
                cancellationEpoch: epoch,
              }),
            );
        await settleTerminal(node.record, terminal);
        if (node.record === root) {
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
    return cancellation;
  };

  return {
    admit(task: TaskSpec, options?: SpawnOptions): Promise<OperationAdmission> {
      return createOperation(task, options);
    },

    run(admission: OperationAdmission): Promise<TerminalOutcome> {
      const record = records.get(admission.operationId);
      if (record === undefined) {
        return Promise.reject(new Error(`Operation not admitted: ${admission.operationId}`));
      }
      if (record.execution !== undefined) return record.execution;
      record.execution = record.terminalPromise;
      void execute(record);
      return record.execution;
    },

    cancelSubtree(
      operationId: string,
      options: CancelOptions,
    ): Promise<CancellationResult> {
      const record = records.get(operationId);
      if (record === undefined) {
        return Promise.reject(new Error(`Operation not admitted: ${operationId}`));
      }
      const requestedEpoch = options.cancellationEpoch;
      if (requestedEpoch !== undefined) {
        const key = `${operationId}:${requestedEpoch}`;
        const existing = cancellations.get(key);
        if (existing !== undefined) return existing;
        cancellingSubtreeRoots.add(operationId);
        const cancellation = beginCancellation(record, options);
        cancellations.set(key, cancellation);
        return cancellation;
      }
      if (cancellingSubtreeRoots.has(operationId)) {
        return runEffect(getOperation(operationId)).then((operation) =>
          Promise.reject(
            new CancellationRejectedError(
              "future_epoch",
              operation.cancellationEpoch + 2,
            ),
          ),
        );
      }
      cancellingSubtreeRoots.add(operationId);
      return beginCancellation(record, options);
    },
  };
}
