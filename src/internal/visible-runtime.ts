import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import { HerdrPresentation, NodeCommandExecutor } from "./herdr-presentation.js";
import { PrivateFileEventStore } from "./event-store/index.js";
import { EventStoreResourceEvidenceRepository } from "./event-store-resource-evidence.js";
import { makeResourceProofController } from "./resource-controller.js";
import { makeRuntime } from "./runtime.js";
import type { RuntimeClock } from "./services.js";
import { VisibleWorker } from "./visible-worker.js";
import { resolveWorkerExtensionEntryPath } from "./worker-extension-entry.js";
import type {
  ResourceAuthorityRegistration,
  ResourceCleanupAuthenticator,
  Runtime,
  StartAuthorizationAuthenticator,
  WorkerProfilePolicy,
} from "../public.js";

export interface VisibleRuntimeOptions {
  readonly cwd: string;
  readonly stateDirectory: string;
  readonly profiles: Readonly<Record<string, Readonly<WorkerProfilePolicy>>>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly extensionEntryPath?: string;
  readonly startAuthorizationAuthenticator?: StartAuthorizationAuthenticator;
  readonly resourceAuthorities?: ReadonlyArray<Readonly<ResourceAuthorityRegistration>>;
  readonly resourceCleanupAuthenticator?: ResourceCleanupAuthenticator;
}

const systemClock: RuntimeClock = {
  now: () => Effect.sync(() => new Date().toISOString()),
  sleep: (milliseconds) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, milliseconds))),
};

/** Construct the caller-facing Runtime for one visible Herdr worker per Operation. */
export function makeVisibleRuntime(options: VisibleRuntimeOptions): Runtime {
  const executor = new NodeCommandExecutor();
  const environment = options.environment ?? process.env;
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  const userId = process.getuid?.();
  if ((runtimeDirectory === undefined || !isAbsolute(runtimeDirectory)) && userId === undefined) {
    throw new Error("Pions requires XDG_RUNTIME_DIR or a numeric user identifier for Worker sockets");
  }
  const socketDirectory = runtimeDirectory !== undefined && isAbsolute(runtimeDirectory)
    ? join(runtimeDirectory, "pions")
    : join(tmpdir(), `pions-${userId}`);
  const presentation = new HerdrPresentation({
    cwd: options.cwd,
    environment,
    executor,
  });
  const worker = new VisibleWorker({
    rootDirectory: options.stateDirectory,
    socketDirectory,
    cwd: options.cwd,
    executor,
    extensionEntryPath: resolveWorkerExtensionEntryPath({
      ...(options.extensionEntryPath === undefined ? {} : { explicitPath: options.extensionEntryPath }),
      cwd: options.cwd,
    }),
  });
  const store = new PrivateFileEventStore(options.stateDirectory, systemClock);
  return makeRuntime({
    worker,
    clock: systemClock,
    ids: { nextOperationId: () => Effect.sync(() => randomUUID()) },
    presentation,
    store,
    ...(options.startAuthorizationAuthenticator === undefined
      ? {}
      : { startAuthorizationAuthenticator: options.startAuthorizationAuthenticator }),
    ...(options.resourceAuthorities === undefined
      ? {}
      : {
          resourceProofController: makeResourceProofController({
            registrations: options.resourceAuthorities,
            repository: new EventStoreResourceEvidenceRepository(store),
            ...(options.resourceCleanupAuthenticator === undefined
              ? {}
              : { cleanupAuthenticator: options.resourceCleanupAuthenticator }),
          }),
        }),
    configuration: { cwd: options.cwd, profiles: options.profiles },
  });
}
