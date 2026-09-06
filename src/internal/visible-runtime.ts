import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { HerdrPresentation, NodeCommandExecutor } from "./herdr-presentation.js";
import { PrivateFileEventStore } from "./private-file-event-store.js";
import { makeRuntime } from "./runtime.js";
import type { RuntimeClock } from "./services.js";
import { VisibleWorker } from "./visible-worker.js";
import type { Runtime } from "../public.js";

export interface VisibleRuntimeOptions {
  readonly cwd: string;
  readonly stateDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly profiles?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly wrapperEntryPath?: string;
}

const systemClock: RuntimeClock = {
  now: () => Effect.sync(() => new Date().toISOString()),
  sleep: (milliseconds) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, milliseconds))),
};

/** Construct the caller-facing Runtime for one visible Herdr worker per Operation. */
export function makeVisibleRuntime(options: VisibleRuntimeOptions): Runtime {
  const executor = new NodeCommandExecutor();
  const worker = new VisibleWorker({
    rootDirectory: options.stateDirectory,
    cwd: options.cwd,
    executor,
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    wrapperEntryPath: options.wrapperEntryPath ?? fileURLToPath(new URL("../worker-wrapper.js", import.meta.url)),
  });
  return makeRuntime({
    backend: worker,
    channel: worker,
    clock: systemClock,
    ids: { nextOperationId: () => Effect.sync(() => randomUUID()) },
    presentation: new HerdrPresentation({
      cwd: options.cwd,
      environment: options.environment ?? process.env,
      executor,
    }),
    store: new PrivateFileEventStore(options.stateDirectory, systemClock),
  });
}
