import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";

import { syncDirectory } from "./sync-directory.js";
import type {
  CancellationResult,
  OperationHandle,
  OperationRuntime,
  TaskSpec,
} from "./types.js";
import {
  makeVisibleRuntime,
  type VisibleRuntimeOptions,
} from "./visible-runtime.js";

const OWNER_KEY_FILE = "background-owner.v1.key";

export interface BackgroundOwnerRequest {
  readonly operationId: string;
  readonly task: TaskSpec;
  readonly runtime: Omit<VisibleRuntimeOptions, "environment">;
}

async function ownerKey(stateDirectory: string): Promise<Buffer> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const rootStatus = await lstat(stateDirectory);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink())
    throw new Error("Background owner state is not a directory");
  const directory = await realpath(stateDirectory);
  const path = join(directory, OWNER_KEY_FILE);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(randomBytes(32));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      await syncDirectory(directory);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error("Background owner key is not a regular file");
  const stored = await readFile(path);
  if (stored.byteLength !== 32)
    throw new Error("Background owner key has an invalid length");
  return stored;
}

/** Reserve this Operation while its independent owner can receive Worker frames. */
async function ownerAddress(request: BackgroundOwnerRequest): Promise<{
  readonly address: string;
  readonly key: Buffer;
}> {
  const key = await ownerKey(request.runtime.stateDirectory);
  const directory = await realpath(request.runtime.stateDirectory);
  return {
    key,
    address: `\0pions-owner-${createHash("sha256")
      .update(key)
      .update(directory)
      .update("\0")
      .update(request.operationId)
      .digest("hex")}`,
  };
}

interface OwnerControl {
  activate(handle: OperationHandle): void;
  close(): Promise<void>;
}

async function acquireOwner(
  request: BackgroundOwnerRequest
): Promise<OwnerControl> {
  const { address, key } = await ownerAddress(request);
  let activateHandle!: (handle: OperationHandle) => void;
  let failHandle!: (error: Error) => void;
  const handleReady = new Promise<OperationHandle>((resolve, reject) => {
    activateHandle = resolve;
    failHandle = reject;
  });
  void handleReady.catch(() => undefined);
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.setTimeout(30_000, () => socket.destroy());
    let input = "";
    socket.on("data", (bytes: Buffer) => {
      input += bytes.toString("utf8");
      if (Buffer.byteLength(input, "utf8") > 1024) {
        socket.destroy();
        return;
      }
      const end = input.indexOf("\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      let message: { type?: unknown; operationId?: unknown; key?: unknown };
      try {
        message = JSON.parse(input.slice(0, end)) as typeof message;
      } catch {
        socket.destroy();
        return;
      }
      if (
        message.type !== "cancel" ||
        message.operationId !== request.operationId ||
        typeof message.key !== "string" ||
        !/^[0-9a-f]{64}$/u.test(message.key) ||
        !timingSafeEqual(Buffer.from(message.key, "hex"), key)
      ) {
        socket.destroy();
        return;
      }
      void handleReady
        .then((handle) => handle.cancel({}))
        .then(
          (result) => socket.end(`${JSON.stringify(result)}\n`),
          (error: unknown) =>
            socket.end(
              `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`
            )
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(address);
  });
  return {
    activate: activateHandle,
    close: () => {
      failHandle(new Error("Background owner stopped before Worker startup"));
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function requestBackgroundCancellation(
  request: BackgroundOwnerRequest
): Promise<CancellationResult> {
  const { address, key } = await ownerAddress(request);
  return new Promise<CancellationResult>((resolve, reject) => {
    const socket = connect(address);
    socket.setTimeout(30_000, () =>
      socket.destroy(new Error("Cancellation timed out"))
    );
    let response = "";
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ type: "cancel", operationId: request.operationId, key: key.toString("hex") })}\n`
      )
    );
    socket.on("data", (bytes: Buffer) => {
      response += bytes.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > 4096)
        socket.destroy(new Error("Cancellation response exceeded the limit"));
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        const message = JSON.parse(response.trim()) as {
          state?: unknown;
          cancellationEpoch?: unknown;
          error?: unknown;
        };
        if (
          (message.state !== "cancelled" && message.state !== "unknown") ||
          typeof message.cancellationEpoch !== "number"
        )
          throw new Error(
            String(message.error ?? "Invalid cancellation response")
          );
        resolve(message as CancellationResult);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Own exactly one background Operation until its Runtime has settled. */
export async function runBackgroundOwner(
  request: BackgroundOwnerRequest,
  started: (operationId: string) => Promise<void>,
  runtimeFactory: (
    options: VisibleRuntimeOptions
  ) => OperationRuntime = makeVisibleRuntime
): Promise<void> {
  if (request.task.background !== true)
    throw new Error("Background owner requires a background Task");
  const control = await acquireOwner(request);
  try {
    const runtime = runtimeFactory({
      ...request.runtime,
      environment: process.env,
      operationId: request.operationId,
      recovery: "background-only",
      recoveryOperationId: request.operationId,
    });
    try {
      await runtime.ready();
      const handle = await runtime.spawn(request.task);
      control.activate(handle);
      await started(handle.operationId);
      await handle.result().catch(() => undefined);
    } finally {
      await runtime.close();
    }
  } finally {
    await control.close();
  }
}
