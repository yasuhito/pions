import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { ValidatedEventStore } from "./store.js";
import type { StoredOperationRecord } from "./store.js";
import type { RuntimeClock } from "../services.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RECORD_FILE = "events.v2.json";
const RESULT_FILE = "result.utf8";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

export function operationDirectoryKey(operationId: string): string {
  return createHash("sha256").update(operationId, "utf8").digest("hex");
}

export class PrivateFileEventStore extends ValidatedEventStore {
  constructor(
    private readonly rootDirectory: string,
    clock: RuntimeClock,
  ) {
    super(clock);
  }

  private async operationDirectory(operationId: string, create: boolean): Promise<string | undefined> {
    const rootExists = await validateDirectory(this.rootDirectory);
    if (!rootExists) {
      if (!create) return undefined;
      await mkdir(this.rootDirectory, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(this.rootDirectory, DIRECTORY_MODE);
      await validateDirectory(this.rootDirectory);
    }
    const directory = join(this.rootDirectory, operationDirectoryKey(operationId));
    const exists = await validateDirectory(directory);
    if (!exists) {
      if (!create) return undefined;
      await mkdir(directory, { mode: DIRECTORY_MODE });
      await chmod(directory, DIRECTORY_MODE);
      await validateDirectory(directory);
    }
    return directory;
  }

  private async readPrivateFile(path: string): Promise<Buffer | undefined> {
    if (!(await validateRegularFile(path))) return undefined;
    return readFile(path);
  }

  private async atomicWrite(path: string, bytes: Buffer): Promise<void> {
    if (await validateRegularFile(path)) {
      // Existing regular files may be replaced atomically.
    }
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: FILE_MODE });
      await chmod(temporary, FILE_MODE);
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  protected async readRecord(operationId: string): Promise<unknown | undefined> {
    const directory = await this.operationDirectory(operationId, false);
    if (directory === undefined) return undefined;
    const bytes = await this.readPrivateFile(join(directory, RECORD_FILE));
    if (bytes === undefined) return undefined;
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new Error(`Invalid record JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected async writeRecord(
    operationId: string,
    record: StoredOperationRecord,
  ): Promise<void> {
    const directory = await this.operationDirectory(operationId, true);
    if (directory === undefined) throw new Error("Unable to create Operation directory");
    await this.atomicWrite(
      join(directory, RECORD_FILE),
      Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
    );
  }

  protected async readResultBytes(operationId: string): Promise<Buffer | undefined> {
    const directory = await this.operationDirectory(operationId, false);
    if (directory === undefined) return undefined;
    return this.readPrivateFile(join(directory, RESULT_FILE));
  }

  protected async writeResultBytes(operationId: string, bytes: Buffer): Promise<void> {
    const directory = await this.operationDirectory(operationId, true);
    if (directory === undefined) throw new Error("Unable to create Operation directory");
    const path = join(directory, RESULT_FILE);
    if (await validateRegularFile(path)) {
      throw new Error("Result file already exists without accepted Result evidence");
    }
    await this.atomicWrite(path, bytes);
  }
}
