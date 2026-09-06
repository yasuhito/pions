import { Cause, Effect, Exit, Schema } from "effect";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./domain.js";
import type { EventInput, Operation, OperationEvent } from "./domain.js";
import type { RuntimeServices } from "./services.js";
import {
  OperationFailedError,
  ResultConflictError,
} from "../public.js";
import type {
  OperationHandle,
  Result,
  Runtime,
  SpawnOptions,
  TaskSpec,
} from "../public.js";

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

function makeRuntimeProgram(
  services: RuntimeServices,
  taskInput: TaskSpec,
  _options: SpawnOptions | undefined,
): Effect.Effect<OperationHandle, unknown> {
  return Effect.gen(function* () {
    const task = yield* Schema.decodeUnknown(TaskSpecSchema)(taskInput);
    const operationId = yield* services.ids.nextOperationId();

    const append = (input: EventInput): Effect.Effect<Operation, unknown> =>
      Effect.gen(function* () {
        const current = yield* Effect.option(services.store.get(operationId));
        const seq = current._tag === "Some" ? current.value.stateSeq + 1 : 1;
        const timestamp = yield* services.clock.now();
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
        return yield* services.store.append(event);
      });

    const project = (operation: Operation): Effect.Effect<void> =>
      Effect.catchAllCause(services.presentation.project(operation), () => Effect.void);

    let operation = yield* append({ type: "operation_requested", task });
    yield* project(operation);

    operation = yield* append({ type: "operation_starting" });
    yield* project(operation);

    const backendStart = yield* Effect.either(services.backend.start(operation));
    if (backendStart._tag === "Left") {
      const reason = backendStart.left.reason;
      operation = yield* append({ type: "self_settled", outcome: "failed", reason });
      operation = yield* append({ type: "operation_failed", reason });
      yield* project(operation);
      const failure = new OperationFailedError(operationId, reason);
      return {
        operationId,
        result: () => Promise.reject(failure),
      } satisfies OperationHandle;
    }

    operation = yield* append({ type: "operation_started" });
    yield* project(operation);

    const deliveries = yield* services.channel.receiveResults(operation);
    const firstDelivery = deliveries[0];
    if (firstDelivery === undefined) {
      throw new Error("ChildChannel returned no Result");
    }

    const seq = operation.stateSeq + 1;
    const timestamp = yield* services.clock.now();
    const resultMetadata = {
      actorId: RUNTIME_ACTOR_ID,
      authority: OPERATION_AUTHORITY,
      eventId: `${operationId}:${seq}`,
      operationId,
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq,
      timestamp,
    };
    const accepted = yield* services.store.acceptResult(
      operationId,
      firstDelivery,
      resultMetadata,
    );

    operation = yield* append({ type: "self_settled", outcome: "succeeded" });
    operation = yield* append({ type: "operation_completed" });
    yield* project(operation);

    for (const delivery of deliveries.slice(1)) {
      yield* services.store.acceptResult(operationId, delivery, resultMetadata);
    }

    const result: Result = accepted.result;
    return {
      operationId,
      result: () => Promise.resolve(result),
    } satisfies OperationHandle;
  });
}

export function makeRuntime(services: RuntimeServices): Runtime {
  const spawnsByParent = new Map<
    string | undefined,
    Map<string, Promise<OperationHandle>>
  >();

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

      const spawn = (async () => {
        const exit = await Effect.runPromiseExit(
          makeRuntimeProgram(services, task, options),
        );
        if (Exit.isSuccess(exit)) return exit.value;

        const failure = Cause.failureOption(exit.cause);
        if (
          failure._tag === "Some" &&
          failure.value instanceof ResultConflictError
        ) {
          throw failure.value;
        }
        throw new RuntimeError("operation_failed", Cause.pretty(exit.cause));
      })();
      spawnsByKey.set(task.idempotencyKey, spawn);
      return spawn;
    },
  };
}
