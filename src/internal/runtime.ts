import { Cause, Effect, Exit, Schema } from "effect";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./domain.js";
import type {
  EventInput,
  Operation,
  OperationEvent,
  OperationLineage,
} from "./domain.js";
import type { RuntimeServices } from "./services.js";
import {
  OperationFailedError,
  ResultConflictError,
  SpawnRejectedError,
} from "../public.js";
import type {
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
  const operationMutationTails = new Map<string, Promise<void>>();

  const serializeOperationMutation = async <Value>(
    operationId: string,
    mutation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = operationMutationTails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    operationMutationTails.set(operationId, current);
    await previous;
    try {
      return await mutation();
    } finally {
      release();
      if (operationMutationTails.get(operationId) === current) {
        operationMutationTails.delete(operationId);
      }
    }
  };

  const append = (
    operationId: string,
    input: EventInput,
  ): Effect.Effect<Operation, unknown> =>
    Effect.tryPromise({
      try: () =>
        serializeOperationMutation(operationId, async () => {
          const current = await Effect.runPromise(
            Effect.option(services.store.get(operationId)),
          );
          const seq = current._tag === "Some" ? current.value.stateSeq + 1 : 1;
          const timestamp = await Effect.runPromise(services.clock.now());
          const event = {
            ...input,
            actorId: RUNTIME_ACTOR_ID,
            authority: OPERATION_AUTHORITY,
            eventId: `${operationId}:${seq}`,
            operationId,
            schemaVersion: EVENT_SCHEMA_VERSION,
            seq,
            timestamp,
          } as OperationEvent;
          return Effect.runPromise(services.store.append(event));
        }),
      catch: (error) => error,
    });

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
    } else {
      record.rejectResult(
        new OperationFailedError(
          record.operationId,
          operation.terminalReason ?? "descendant_failed",
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
    const operation = await run(services.store.get(record.operationId));
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

      const accepted = await serializeOperationMutation(
        record.operationId,
        async () => {
          const current = await run(services.store.get(record.operationId));
          const seq = current.stateSeq + 1;
          const timestamp = await run(services.clock.now());
          const resultMetadata = {
            actorId: RUNTIME_ACTOR_ID,
            authority: OPERATION_AUTHORITY,
            eventId: `${record.operationId}:${seq}`,
            operationId: record.operationId,
            schemaVersion: EVENT_SCHEMA_VERSION,
            seq,
            timestamp,
          };
          const acceptance = await run(
            services.store.acceptResult(
              record.operationId,
              firstDelivery,
              resultMetadata,
            ),
          );
          return { acceptance, resultMetadata };
        },
      );
      record.result = accepted.acceptance.result;

      for (const delivery of deliveries.slice(1)) {
        try {
          await serializeOperationMutation(record.operationId, () =>
            run(
              services.store.acceptResult(
                record.operationId,
                delivery,
                accepted.resultMetadata,
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
          error instanceof ResultConflictError
            ? error
            : new RuntimeError(
                "operation_failed",
                error instanceof Error ? error.message : String(error),
              ),
        );
      }
    }
  };

  const createOperation = async (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationHandle> => {
    const task = await Effect.runPromise(
      Schema.decodeUnknown(TaskSpecSchema)(taskInput),
    );
    const parentId = options?.parentOperationId;
    const parent = parentId === undefined ? undefined : records.get(parentId);

    if (parentId !== undefined && parent === undefined) {
      throw new SpawnRejectedError("parent_not_found", parentId);
    }
    if (parent !== undefined) {
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
    const operation = await run(
      append(operationId, { type: "operation_requested", task, lineage }),
    );
    await run(project(operation));

    const handle: OperationHandle = {
      operationId,
      result: () => record.resultPromise,
    };
    void execute(record);
    return handle;
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
