import { readFile } from "node:fs/promises";

import { Effect } from "effect";

import type {
  WorkerCancellationEvidence,
  WorkerProcessIdentity,
} from "./services.js";

export type WorkerProcessState = "running" | "stopped" | "unverifiable";

export interface WorkerProcessControl {
  observe(identity: Readonly<WorkerProcessIdentity>): Effect.Effect<WorkerProcessState>;
  waitForStop(
    identity: Readonly<WorkerProcessIdentity>,
    timeoutMilliseconds: number,
  ): Effect.Effect<WorkerProcessState>;
  terminate(identity: Readonly<WorkerProcessIdentity>): Effect.Effect<WorkerCancellationEvidence | undefined>;
}

export interface NodeWorkerProcessControlOptions {
  readonly readProcessStat?: (processId: number) => Promise<string>;
  readonly signal?: (processId: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly stopPollMilliseconds?: number;
  readonly stopTimeoutMilliseconds?: number;
}

export function processStartToken(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const token = fieldsAfterCommand[19];
  return token === undefined || token.length === 0 ? undefined : token;
}

export async function currentProcessStartToken(): Promise<string> {
  const token = processStartToken(await readFile("/proc/self/stat", "utf8"));
  if (token === undefined) throw new Error("Current process start token is unavailable");
  return token;
}

export class NodeWorkerProcessControl implements WorkerProcessControl {
  private readonly readProcessStat: (processId: number) => Promise<string>;
  private readonly signal: (processId: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly stopPollMilliseconds: number;
  private readonly stopTimeoutMilliseconds: number;

  constructor(options: NodeWorkerProcessControlOptions = {}) {
    this.readProcessStat = options.readProcessStat ?? ((processId) =>
      readFile(`/proc/${processId}/stat`, "utf8"));
    this.signal = options.signal ?? ((processId, signal) => process.kill(processId, signal));
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.stopPollMilliseconds = options.stopPollMilliseconds ?? 20;
    this.stopTimeoutMilliseconds = options.stopTimeoutMilliseconds ?? 250;
  }

  observe(identity: Readonly<WorkerProcessIdentity>): Effect.Effect<WorkerProcessState> {
    return Effect.promise(async () => {
      try {
        const observed = processStartToken(await this.readProcessStat(identity.processId));
        if (observed === undefined) return "unverifiable";
        return observed === identity.processStartToken ? "running" : "stopped";
      } catch (error) {
        return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
          ? "stopped"
          : "unverifiable";
      }
    });
  }

  waitForStop(
    identity: Readonly<WorkerProcessIdentity>,
    timeoutMilliseconds: number,
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

  terminate(identity: Readonly<WorkerProcessIdentity>): Effect.Effect<WorkerCancellationEvidence | undefined> {
    return Effect.promise(async () => {
      const initial = await Effect.runPromise(this.observe(identity));
      if (initial === "stopped") return { proof: "worker-stop" };
      if (initial === "unverifiable") return undefined;
      try {
        this.signal(identity.processId, "SIGTERM");
      } catch {
        return await Effect.runPromise(this.observe(identity)) === "stopped"
          ? { proof: "worker-stop" }
          : undefined;
      }
      const state = await Effect.runPromise(
        this.waitForStop(identity, this.stopTimeoutMilliseconds),
      );
      return state === "stopped" ? { proof: "worker-stop" } : undefined;
    });
  }
}
