import { Effect } from "effect";

import { PrivateFileEventStore } from "./event-store/index.js";
import { makeOperationReader } from "./operation-reader.js";
import type { RuntimeClock } from "./services.js";
import type { OperationReader } from "./types.js";

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

/** Open persisted Operation reads without constructing a Worker Runtime. */
export function makePersistedOperationReader(options: {
  readonly stateDirectory: string;
}): { operation(operationId: string): Promise<OperationReader> } {
  const store = new PrivateFileEventStore(options.stateDirectory, clock);
  return { operation: makeOperationReader(store).operation };
}
