import { spawn } from "node:child_process";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import {
  makePersistedOperationReader,
  readPersistedOperationRecovery,
  readPersistedOperationState,
} from "./persisted-operation-reader.js";
import { writePrivatePrompt } from "./repository-state.js";
import {
  requestBackgroundCancellation,
  type BackgroundOwnerRequest,
} from "./background-owner.js";
import type { CancellationResult, OperationState } from "./types.js";
import { hasCode } from "./has-code.js";

function isTerminalState(
  state: OperationState | undefined
): state is "completed" | "cancelled" | "failed" | "unknown" {
  return (
    state === "completed" ||
    state === "cancelled" ||
    state === "failed" ||
    state === "unknown"
  );
}

export function backgroundOwnerEntryPath(workerExtensionPath: string): string {
  return join(
    dirname(workerExtensionPath),
    "internal",
    "background-owner-entry.js"
  );
}

export interface BackgroundProcessOptions {
  readonly entryPath: string;
  readonly repositoryState: string;
  readonly request: BackgroundOwnerRequest;
  readonly environment?: NodeJS.ProcessEnv;
  readonly startTimeoutMs?: number;
}

export async function readBackgroundRequest(options: {
  readonly repositoryRoot: string;
  readonly repositoryState: string;
  readonly operationId: string;
}): Promise<BackgroundOwnerRequest | undefined> {
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(options.operationId)
  )
    throw new Error(
      "Background Operation is unavailable in the current repository"
    );
  const path = join(
    options.repositoryState,
    "requests",
    `${options.operationId}.background.json`
  );
  const status = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (status === undefined) return undefined;
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error(
      "Background Operation is unavailable in the current repository"
    );
  const request = JSON.parse(
    await readFile(path, "utf8")
  ) as BackgroundOwnerRequest;
  if (
    request.operationId !== options.operationId ||
    request.task?.background !== true ||
    request.runtime?.stateDirectory !==
      join(options.repositoryState, "runtime") ||
    (request.runtime.cwd !== options.repositoryRoot &&
      !request.runtime.cwd.startsWith(`${options.repositoryRoot}${sep}`))
  )
    throw new Error(
      "Background Operation is unavailable in the current repository"
    );
  return request;
}

/** Start a separate process; an unconfirmed reply is never called a successful start. */
export async function cancelBackgroundProcess(options: {
  readonly repositoryRoot: string;
  readonly repositoryState: string;
  readonly operationId: string;
  readonly entryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly start?: typeof startBackgroundProcess;
}): Promise<CancellationResult | { readonly state: OperationState }> {
  const request = await readBackgroundRequest(options);
  if (request === undefined)
    throw new Error(
      "Background Operation is unavailable in the current repository"
    );
  const state = await readPersistedOperationState(
    request.runtime.stateDirectory,
    options.operationId
  );
  if (state === undefined)
    throw new Error("Background Operation start was not confirmed");
  if (isTerminalState(state)) return { state };
  try {
    return await requestBackgroundCancellation(request);
  } catch (error) {
    if (!hasCode(error, "ECONNREFUSED") && !hasCode(error, "ENOENT"))
      throw error;
    const current = await readPersistedOperationState(
      request.runtime.stateDirectory,
      request.operationId
    );
    if (isTerminalState(current)) return { state: current };
  }
  await (options.start ?? startBackgroundProcess)({
    repositoryState: options.repositoryState,
    request,
    entryPath:
      request.runtime.extensionEntryPath === undefined
        ? options.entryPath
        : backgroundOwnerEntryPath(request.runtime.extensionEntryPath),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
  });
  try {
    return await requestBackgroundCancellation(request);
  } catch (error) {
    const current = await readPersistedOperationState(
      request.runtime.stateDirectory,
      request.operationId
    );
    if (isTerminalState(current)) return { state: current };
    throw error;
  }
}

export async function recoverBackgroundProcesses(options: {
  readonly repositoryRoot: string;
  readonly repositoryState: string;
  readonly entryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly start?: typeof startBackgroundProcess;
}): Promise<void> {
  const requests = join(options.repositoryState, "requests");
  let files: ReadonlyArray<string>;
  try {
    files = await readdir(requests);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  for (const file of files) {
    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.background\.json$/u.test(
        file
      )
    )
      continue;
    const request = await readBackgroundRequest({
      repositoryRoot: options.repositoryRoot,
      repositoryState: options.repositoryState,
      operationId: file.slice(0, -".background.json".length),
    });
    if (request === undefined)
      throw new Error(`Background Operation request vanished: ${file}`);
    const recovery = await readPersistedOperationRecovery(
      request.runtime.stateDirectory,
      request.operationId
    );
    if (
      recovery !== undefined &&
      !recovery.cleanupPending &&
      (recovery.state === "completed" ||
        recovery.state === "cancelled" ||
        recovery.state === "failed" ||
        recovery.state === "unknown")
    )
      continue;
    await (options.start ?? startBackgroundProcess)({
      repositoryState: options.repositoryState,
      request,
      entryPath:
        request.runtime.extensionEntryPath === undefined
          ? options.entryPath
          : backgroundOwnerEntryPath(request.runtime.extensionEntryPath),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
    });
  }
}

export async function startBackgroundProcess(
  options: BackgroundProcessOptions
): Promise<string> {
  const entry = await stat(options.entryPath).catch(() => undefined);
  if (!entry?.isFile())
    throw new Error(
      `Background owner entry is unavailable: ${options.entryPath}. Build Pions and load its dist/src/extension.js entry.`
    );
  const requestPath = join(
    options.repositoryState,
    "requests",
    `${options.request.operationId}.background.json`
  );
  await writePrivatePrompt(requestPath, JSON.stringify(options.request));
  // Pi can be a standalone executable, so process.execPath (used by fork)
  // may launch another Pi rather than a Node process for this module.
  const child = spawn("node", [options.entryPath, requestPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: options.environment ?? process.env,
  });
  child.unref();
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Background Operation ${options.request.operationId} start could not be confirmed`
        )
      );
    }, options.startTimeoutMs ?? 60_000);
    const finish = (error?: Error, operationId?: string) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onExit);
      if (child.connected) child.disconnect();
      if (error !== undefined) reject(error);
      else if (operationId !== undefined) resolve(operationId);
    };
    const onMessage = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("type" in value))
        return;
      if (value.type === "started") {
        if (
          !("operationId" in value) ||
          value.operationId !== options.request.operationId
        ) {
          finish(new Error("Background owner returned another Operation"));
          return;
        }
        finish(undefined, value.operationId);
      } else if (value.type === "already-owned") {
        child.off("close", onExit);
        if (
          !("operationId" in value) ||
          value.operationId !== options.request.operationId
        ) {
          finish(new Error("Background owner returned another Operation"));
          return;
        }
        void makePersistedOperationReader({
          stateDirectory: options.request.runtime.stateDirectory,
        })
          .operation(options.request.operationId)
          .then(() => finish(undefined, options.request.operationId))
          .catch(() =>
            finish(
              new Error(
                `Background Operation ${value.operationId} start could not be confirmed`
              )
            )
          );
      } else if (value.type === "failed") {
        finish(
          new Error(
            `Background Operation ${options.request.operationId} failed to start: ${"message" in value ? String(value.message) : "unknown reason"}`
          )
        );
      }
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) =>
      finish(
        new Error(
          `Background Operation ${options.request.operationId} owner exited before start was confirmed (exit ${code}; executable ${child.spawnfile}; entry ${options.entryPath})`
        )
      );
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onExit);
  });
}
