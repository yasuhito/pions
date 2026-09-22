import { Effect } from "effect";

import { PrivateFileEventStore } from "./event-store/index.js";
import { makeRuntime } from "./runtime.js";
import type { Presentation, RuntimeClock, WorkerAdapter } from "./services.js";
import type { Runtime } from "../public.js";

const clock: RuntimeClock = {
  now: () => Effect.sync(() => new Date().toISOString()),
  sleep: (milliseconds) =>
    Effect.promise(
      () => new Promise((resolve) => setTimeout(resolve, milliseconds))
    ),
  monotonicMilliseconds: () => performance.now(),
  recoveredElapsedTimeIsReliable: () => false,
};

const unavailableWorker: WorkerAdapter = {
  open: () => {
    throw new Error("Result retrieval Runtime cannot start Workers");
  },
  recover: () => {
    throw new Error("Result retrieval Runtime cannot recover Workers");
  },
};

const unavailablePresentation: Presentation = {
  preflight: () => Effect.die("Result retrieval has no Presentation"),
  create: () => Effect.die("Result retrieval has no Presentation"),
  rollbackCreated: () => Effect.die("Result retrieval has no Presentation"),
  inspectOwnedWorkspace: () =>
    Effect.die("Result retrieval has no Presentation"),
  closeOwnedWorkspace: () => Effect.die("Result retrieval has no Presentation"),
  project: () => Effect.die("Result retrieval has no Presentation"),
};

/** Open the persistent Runtime boundary without recovering or starting Workers. */
export function makeResultRetrievalRuntime(options: {
  readonly cwd: string;
  readonly stateDirectory: string;
}): Runtime {
  const store = new PrivateFileEventStore(options.stateDirectory, clock);
  return makeRuntime({
    worker: unavailableWorker,
    clock,
    ids: {
      nextOperationId: () =>
        Effect.die("Result retrieval Runtime cannot create Operations"),
    },
    presentation: unavailablePresentation,
    store,
    recovery: "disabled",
    configuration: { cwd: options.cwd, profiles: {} },
  });
}
