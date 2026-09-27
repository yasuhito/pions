import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { ValidatedEventStore } from "./store.js";
import type { StoredOperationRecord } from "./store.js";
import { RecordDecodingError } from "./codec.js";
import type { RuntimeClock } from "../services.js";
import { hasCode } from "../has-code.js";
import { syncDirectory } from "../sync-directory.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RECORD_FILE = "events.v29.json";
const RESULT_FILE = "result.v1.utf8";
const LOCK_SECRET_FILE = "writer-lock.v1.key";

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

async function validateDirectory(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`Private record path is not a directory: ${path}`);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function validateRegularFile(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`Private record path is not a regular file: ${path}`);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function createPrivateDirectoryTree(path: string): Promise<void> {
  const missing: Array<string> = [];
  let current = path;
  while (!(await validateDirectory(current))) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current)
      throw new Error(`Unable to find an existing parent directory: ${path}`);
    current = parent;
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    await chmod(directory, DIRECTORY_MODE);
    await validateDirectory(directory);
    await syncDirectory(dirname(directory));
  }
}

export function operationDirectoryKey(operationId: string): string {
  return createHash("sha256").update(operationId, "utf8").digest("hex");
}

export class PrivateFileEventStore extends ValidatedEventStore {
  constructor(
    private readonly rootDirectory: string,
    clock: RuntimeClock
  ) {
    super(clock);
  }

  protected override async withOperationLock<Value>(
    operationId: string,
    action: () => Promise<Value>
  ): Promise<Value> {
    await createPrivateDirectoryTree(this.rootDirectory);
    const root = await realpath(this.rootDirectory);
    const secretPath = join(root, LOCK_SECRET_FILE);
    let secret = await this.readPrivateFile(secretPath);
    if (secret === undefined) {
      try {
        await this.atomicWrite(secretPath, randomBytes(32), true);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      secret = await this.readPrivateFile(secretPath);
    }
    if (secret?.byteLength !== 32)
      throw new Error("Event Store writer lock secret is unavailable");
    // Linux abstract sockets are released by the kernel when their owning
    // process exits. A private secret prevents other users from reserving
    // the name of a repository's writer lock.
    const address = `\0pions-store-${createHash("sha256").update(secret).update(root).update("\0").update(operationId).digest("hex")}`;
    while (true) {
      const server = createServer((socket) => socket.destroy());
      try {
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
      } catch (error) {
        if (!hasCode(error, "EADDRINUSE")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      try {
        return await action();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  }

  private async operationDirectory(
    operationId: string,
    create: boolean
  ): Promise<string | undefined> {
    const rootExists = await validateDirectory(this.rootDirectory);
    if (!rootExists) {
      if (!create) return undefined;
      await createPrivateDirectoryTree(this.rootDirectory);
    }
    const directory = join(
      this.rootDirectory,
      operationDirectoryKey(operationId)
    );
    const exists = await validateDirectory(directory);
    if (!exists) {
      if (!create) return undefined;
      await createPrivateDirectoryTree(directory);
    }
    return directory;
  }

  private async readPrivateFile(path: string): Promise<Buffer | undefined> {
    if (!(await validateRegularFile(path))) return undefined;
    return readFile(path);
  }

  private async atomicWrite(
    path: string,
    bytes: Buffer,
    create = false
  ): Promise<void> {
    if (await validateRegularFile(path)) {
      // Existing regular files may be replaced atomically.
    }
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
    try {
      temporaryFile = await open(temporary, "wx", FILE_MODE);
      await temporaryFile.writeFile(bytes);
      await temporaryFile.chmod(FILE_MODE);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      if (create) {
        // Linking a synced temporary file publishes a new record atomically
        // without overwriting another process's creation of the same Operation.
        await link(temporary, path);
        await syncDirectory(dirname(path));
        await unlink(temporary);
      } else {
        await rename(temporary, path);
      }
      await syncDirectory(dirname(path));
    } catch (error) {
      await temporaryFile?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  protected async readRecord(
    operationId: string
  ): Promise<unknown | undefined> {
    const directory = await this.operationDirectory(operationId, false);
    if (directory === undefined) return undefined;
    const bytes = await this.readPrivateFile(join(directory, RECORD_FILE));
    if (bytes === undefined) {
      const hasUnsupportedRecord = (await readdir(directory)).some((entry) =>
        /^events\.v\d+\.json$/u.test(entry)
      );
      if (hasUnsupportedRecord) {
        throw new RecordDecodingError(
          "unsupported_schema",
          "Unsupported Event Store record schema"
        );
      }
      return undefined;
    }
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid record JSON: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        }
      );
    }
  }

  protected async writeRecord(
    operationId: string,
    record: StoredOperationRecord,
    create: boolean
  ): Promise<void> {
    const directory = await this.operationDirectory(operationId, true);
    if (directory === undefined)
      throw new Error("Unable to create Operation directory");
    await this.atomicWrite(
      join(directory, RECORD_FILE),
      Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
      create
    );
  }

  protected async writeResultBody(
    operationId: string,
    bytes: Uint8Array
  ): Promise<void> {
    const directory = await this.operationDirectory(operationId, true);
    if (directory === undefined)
      throw new Error("Unable to create Operation directory");
    await this.atomicWrite(join(directory, RESULT_FILE), Buffer.from(bytes));
  }

  protected async readResultBytes(
    operationId: string
  ): Promise<Uint8Array | undefined> {
    const directory = await this.operationDirectory(operationId, false);
    if (directory === undefined) return undefined;
    return this.readPrivateFile(join(directory, RESULT_FILE));
  }

  protected async listOperationIds(): Promise<ReadonlyArray<string>> {
    if (!(await validateDirectory(this.rootDirectory))) return [];
    const operationIds: Array<string> = [];
    for (const entry of await readdir(this.rootDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const bytes = await this.readPrivateFile(
        join(this.rootDirectory, entry.name, RECORD_FILE)
      );
      if (bytes === undefined) continue;
      const value = JSON.parse(bytes.toString("utf8")) as {
        readonly operationId?: unknown;
      };
      if (
        typeof value.operationId !== "string" ||
        operationDirectoryKey(value.operationId) !== entry.name
      ) {
        throw new Error("Operation index contains a mismatched record");
      }
      operationIds.push(value.operationId);
    }
    return operationIds.sort();
  }
}
