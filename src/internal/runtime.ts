import { Cause, Effect, Exit, Schema } from "effect";

import type { EventInput, Operation, OperationEvent } from "./domain.js";
import type { RuntimeServices } from "./services.js";
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
          actor: "runtime",
          eventId: `${operationId}:${seq}`,
          operationId,
          schemaVersion: 1,
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

    yield* services.backend.start(operation);
    operation = yield* append({ type: "operation_started" });
    yield* project(operation);

    const message = yield* services.channel.receiveResult(operation);
    const seq = operation.stateSeq + 1;
    const timestamp = yield* services.clock.now();
    const accepted = yield* services.store.acceptResult(operationId, message.body, {
      actor: "runtime",
      eventId: `${operationId}:${seq}`,
      operationId,
      schemaVersion: 1,
      seq,
      timestamp,
    });

    operation = yield* append({ type: "self_settled", outcome: "succeeded" });
    operation = yield* append({ type: "operation_completed" });
    yield* project(operation);

    const result: Result = accepted.result;
    return {
      operationId,
      result: () => Promise.resolve(result),
    } satisfies OperationHandle;
  });
}

export function makeRuntime(services: RuntimeServices): Runtime {
  return {
    async spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle> {
      const exit = await Effect.runPromiseExit(
        makeRuntimeProgram(services, task, options),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      throw new RuntimeError("operation_failed", Cause.pretty(exit.cause));
    },
  };
}
