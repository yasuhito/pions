import { readFile } from "node:fs/promises";

import { Effect } from "effect";

import type {
  WorkerCancellationEvidence,
  WorkerProcessIdentity,
} from "./services.js";

export type WorkerProcessState = "running" | "stopped" | "unverifiable";

export interface BackendProcessIdentity {
  readonly processId: number;
  readonly processStartToken: string;
}

export interface WorkerProcessControl {
  observe(
    identity: Readonly<WorkerProcessIdentity>
  ): Effect.Effect<WorkerProcessState>;
  waitForStop(
    identity: Readonly<WorkerProcessIdentity>,
    timeoutMilliseconds: number
  ): Effect.Effect<WorkerProcessState>;
  terminate(
    identity: Readonly<WorkerProcessIdentity>,
    timeoutMilliseconds?: number
  ): Effect.Effect<WorkerCancellationEvidence | undefined>;
  captureDescendants?(
    identity: Readonly<WorkerProcessIdentity>
  ): Effect.Effect<ReadonlyArray<Readonly<BackendProcessIdentity>> | undefined>;
  waitForBackendStop?(
    identities: ReadonlyArray<Readonly<BackendProcessIdentity>>,
    timeoutMilliseconds: number
  ): Effect.Effect<WorkerProcessState>;
  terminateBackend?(
    identities: ReadonlyArray<Readonly<BackendProcessIdentity>>,
    timeoutMilliseconds: number
  ): Effect.Effect<WorkerCancellationEvidence | undefined>;
}

export interface NodeWorkerProcessControlOptions {
  readonly readProcessStat?: (processId: number) => Promise<string>;
  readonly readProcessChildren?: (processId: number) => Promise<string>;
  readonly signal?: (processId: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly stopPollMilliseconds?: number;
  readonly stopTimeoutMilliseconds?: number;
}

export function processStartToken(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const token = fieldsAfterCommand[19];
  return token === undefined || token.length === 0 ? undefined : token;
}

export async function currentProcessStartToken(): Promise<string> {
  const token = processStartToken(await readFile("/proc/self/stat", "utf8"));
  if (token === undefined)
    throw new Error("Current process start token is unavailable");
  return token;
}

export class NodeWorkerProcessControl implements WorkerProcessControl {
  private readonly readProcessStat: (processId: number) => Promise<string>;
  private readonly readProcessChildren: (processId: number) => Promise<string>;
  private readonly signal: (processId: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly stopPollMilliseconds: number;
  private readonly stopTimeoutMilliseconds: number;

  constructor(options: NodeWorkerProcessControlOptions = {}) {
    this.readProcessStat =
      options.readProcessStat ??
      ((processId) => readFile(`/proc/${processId}/stat`, "utf8"));
    this.readProcessChildren =
      options.readProcessChildren ??
      ((processId) =>
        readFile(`/proc/${processId}/task/${processId}/children`, "utf8"));
    this.signal =
      options.signal ??
      ((processId, signal) => process.kill(processId, signal));
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.stopPollMilliseconds = options.stopPollMilliseconds ?? 20;
    this.stopTimeoutMilliseconds = options.stopTimeoutMilliseconds ?? 250;
  }

  observe(
    identity: Readonly<WorkerProcessIdentity>
  ): Effect.Effect<WorkerProcessState> {
    return Effect.promise(async () => {
      try {
        const observed = processStartToken(
          await this.readProcessStat(identity.processId)
        );
        if (observed === undefined) return "unverifiable";
        return observed === identity.processStartToken ? "running" : "stopped";
      } catch (error) {
        return typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
          ? "stopped"
          : "unverifiable";
      }
    });
  }

  waitForStop(
    identity: Readonly<WorkerProcessIdentity>,
    timeoutMilliseconds: number
  ): Effect.Effect<WorkerProcessState> {
    return Effect.promise(async () => {
      const deadline = Date.now() + timeoutMilliseconds;
      while (true) {
        const state = await Effect.runPromise(this.observe(identity));
        if (state !== "running" || Date.now() >= deadline) return state;
        await this.sleep(this.stopPollMilliseconds);
      }
    });
  }

  captureDescendants(
    identity: Readonly<WorkerProcessIdentity>
  ): Effect.Effect<
    ReadonlyArray<Readonly<BackendProcessIdentity>> | undefined
  > {
    return Effect.promise(async () => {
      const rootIdentity = {
        processId: identity.processId,
        processStartToken: identity.processStartToken,
      };
      const captured: Array<Readonly<BackendProcessIdentity>> = [];
      const pending: Array<Readonly<BackendProcessIdentity>> = [rootIdentity];
      try {
        if ((await this.observeProcess(rootIdentity)) !== "running")
          return undefined;
        while (pending.length > 0) {
          const parent = pending.pop()!;
          if ((await this.observeProcess(parent)) !== "running")
            return undefined;
          const source = await this.readProcessChildren(parent.processId);
          const children =
            source.trim().length === 0
              ? []
              : source.trim().split(/\s+/u).map(Number);
          for (const processId of children) {
            if (!Number.isSafeInteger(processId) || processId <= 0)
              return undefined;
            const token = processStartToken(
              await this.readProcessStat(processId)
            );
            if (token === undefined) return undefined;
            captured.push({ processId, processStartToken: token });
            pending.push({ processId, processStartToken: token });
          }
          if ((await this.observeProcess(parent)) !== "running")
            return undefined;
        }
        if ((await this.observeProcess(rootIdentity)) !== "running")
          return undefined;
        return Object.freeze(captured);
      } catch {
        return undefined;
      }
    });
  }

  waitForBackendStop(
    identities: ReadonlyArray<Readonly<BackendProcessIdentity>>,
    timeoutMilliseconds: number
  ): Effect.Effect<WorkerProcessState> {
    return Effect.promise(async () => {
      const deadline = Date.now() + timeoutMilliseconds;
      while (true) {
        let unverifiable = false;
        let running = false;
        for (const identity of identities) {
          const state = await this.observeProcess(identity);
          if (state === "unverifiable") unverifiable = true;
          if (state === "running") running = true;
        }
        if (unverifiable) return "unverifiable";
        if (!running) return "stopped";
        if (Date.now() >= deadline) return "running";
        await this.sleep(this.stopPollMilliseconds);
      }
    });
  }

  terminateBackend(
    identities: ReadonlyArray<Readonly<BackendProcessIdentity>>,
    timeoutMilliseconds: number
  ): Effect.Effect<WorkerCancellationEvidence | undefined> {
    return Effect.promise(async () => {
      for (const identity of [...identities].reverse()) {
        const state = await this.observeProcess(identity);
        if (state === "unverifiable") return undefined;
        if (state === "running") {
          try {
            this.signal(identity.processId, "SIGTERM");
          } catch {
            if ((await this.observeProcess(identity)) !== "stopped")
              return undefined;
          }
        }
      }
      const state = await Effect.runPromise(
        this.waitForBackendStop(identities, timeoutMilliseconds)
      );
      return state === "stopped" ? { proof: "worker-stop" } : undefined;
    });
  }

  terminate(
    identity: Readonly<WorkerProcessIdentity>,
    timeoutMilliseconds = this.stopTimeoutMilliseconds
  ): Effect.Effect<WorkerCancellationEvidence | undefined> {
    return Effect.promise(async () => {
      const initial = await Effect.runPromise(this.observe(identity));
      if (initial === "stopped") return { proof: "worker-stop" };
      if (initial === "unverifiable") return undefined;
      try {
        this.signal(identity.processId, "SIGTERM");
      } catch {
        return (await Effect.runPromise(this.observe(identity))) === "stopped"
          ? { proof: "worker-stop" }
          : undefined;
      }
      const state = await Effect.runPromise(
        this.waitForStop(
          identity,
          Math.min(
            this.stopTimeoutMilliseconds,
            Math.max(0, timeoutMilliseconds)
          )
        )
      );
      return state === "stopped" ? { proof: "worker-stop" } : undefined;
    });
  }

  private async observeProcess(
    identity: Readonly<BackendProcessIdentity>
  ): Promise<WorkerProcessState> {
    try {
      const observed = processStartToken(
        await this.readProcessStat(identity.processId)
      );
      if (observed === undefined) return "unverifiable";
      return observed === identity.processStartToken ? "running" : "stopped";
    } catch (error) {
      return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
        ? "stopped"
        : "unverifiable";
    }
  }
}
