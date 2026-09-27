import { Effect, Either } from "effect";

import {
  presentationCleanupEligible,
  PrivateFileEventStore,
} from "./event-store/index.js";
import { makeOperationReader } from "./operation-reader.js";
import type { RuntimeClock } from "./services.js";
import type { OperationReader, OperationState } from "./types.js";

// Event Store requires a clock for writes; operation reads do not use it.
const clock: RuntimeClock = {
  now: () => Effect.sync(() => new Date().toISOString()),
  sleep: (milliseconds) =>
    Effect.promise(
      () => new Promise((resolve) => setTimeout(resolve, milliseconds))
    ),
  monotonicMilliseconds: () => performance.now(),
  recoveredElapsedTimeIsReliable: () => false,
};

export async function readPersistedOperationRecovery(
  stateDirectory: string,
  operationId: string
): Promise<
  | {
      readonly state: OperationState;
      readonly cleanupPending: boolean;
    }
  | undefined
> {
  const store = new PrivateFileEventStore(stateDirectory, clock);
  const result = await Effect.runPromise(
    Effect.either(store.read(operationId))
  );
  if (Either.isRight(result)) {
    const operation = result.right.operation;
    return {
      state: operation.state,
      cleanupPending:
        presentationCleanupEligible(operation) &&
        operation.presentation?.ownedByPions === true &&
        (operation.presentationCleanup === undefined ||
          operation.presentationCleanup.state === "pending"),
    };
  }
  if (result.left.code === "not_found") return undefined;
  throw new Error(result.left.message);
}

export async function readPersistedOperationState(
  stateDirectory: string,
  operationId: string
): Promise<OperationState | undefined> {
  return (await readPersistedOperationRecovery(stateDirectory, operationId))
    ?.state;
}

/** Open persisted Operation reads without constructing a Worker Runtime. */
export function makePersistedOperationReader(options: {
  readonly stateDirectory: string;
}): { operation(operationId: string): Promise<OperationReader> } {
  const store = new PrivateFileEventStore(options.stateDirectory, clock);
  return { operation: makeOperationReader(store).operation };
}
