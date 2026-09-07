import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import {
  HostProtocolPeer,
  encodeWorkerConfig,
} from "./worker-protocol.js";
import type {
  ResultAcceptanceProof,
  ResultDelivery,
  WorkerConfig,
} from "./worker-protocol.js";
import type { Operation } from "./event-store/index.js";
import { operationDirectoryKey } from "./event-store/index.js";
import {
  acknowledgeResultAcceptance,
  makeSingleRunWorker,
} from "./services.js";
import type {
  AgentRunEvidence,
  Worker,
  WorkerCancellationEvidence,
  WorkerAdapter,
  WorkerProcessIdentity,
  WorkerRunHooks,
  WorkerRunOutcome,
} from "./services.js";
import type {
  OperationPersistenceError,
  ResultConflictError,
  WorkerConfigurationFailureReason,
} from "../public.js";
import { configurationMismatch } from "./worker-configuration.js";
import type { CommandExecutor } from "./herdr-presentation.js";
import {
  NodeWorkerProcessControl,
  type WorkerProcessControl,
} from "./worker-process-control.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_MAX_PROMPT_BYTES = 1024 * 1024;
const CANCELLATION_TIMEOUT_BUDGET_RATIO = 0.9;

export interface WorkerCapabilityGenerator {
  nextCapability(): string;
}

export interface PromptReader {
  read(promptRef: string): Promise<Buffer>;
}

export interface VisibleWorkerOptions {
  readonly rootDirectory: string;
  readonly socketDirectory: string;
  readonly cwd: string;
  readonly executor: CommandExecutor;
  readonly extensionEntryPath: string;
  readonly capabilityGenerator?: WorkerCapabilityGenerator;
  readonly promptReader?: PromptReader;
  readonly serverFactory?: () => Server;
  readonly processControl?: WorkerProcessControl;
  readonly backendCancellationGraceMs?: number;
  readonly exitObservationGraceMs?: number;
  readonly successfulExitGraceMs?: number;
  readonly agentStartTimeoutMs?: number;
}

interface WorkerProtocolError {
  readonly _tag: "WorkerProtocolError";
  readonly message: string;
}

type WorkerStartReception =
  | { readonly state: "identified"; readonly identity: Readonly<WorkerProcessIdentity> }
  | { readonly state: "configuration_failed"; readonly reason: WorkerConfigurationFailureReason }
  | { readonly state: "liveness-unproven" };

type WorkerCompletionReception =
  | {
      readonly state: "results_received";
      readonly deliveries: ReadonlyArray<ResultDelivery>;
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | {
      readonly state: "agent_failed";
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | { readonly state: "cancelled" }
  | { readonly state: "process-exited-without-result" }
  | { readonly state: "liveness-unproven" }
  | { readonly state: "worker_protocol_failed" };

class WorkerCancellation {
  private isRequested = false;
  private isResponsePending = false;
  private response?: Promise<WorkerCancellationEvidence | undefined>;

  request(): void {
    this.isRequested = true;
  }

  execute(
    cancellation: () => Promise<WorkerCancellationEvidence | undefined>,
  ): Promise<WorkerCancellationEvidence | undefined> {
    this.request();
    if (this.response === undefined) {
      this.isResponsePending = true;
      this.response = cancellation().finally(() => {
        this.isResponsePending = false;
      });
    }
    return this.response;
  }

  get responsePending(): boolean {
    return this.isResponsePending;
  }

  get requested(): boolean {
    return this.isRequested;
  }

  requireLaunchAllowed(phase: "before" | "during" = "before"): void {
    if (this.requested) {
      throw new Error(`Worker was cancelled ${phase} launch`);
    }
  }
}

interface Session {
  readonly operation: Operation;
  readonly server: Server;
  readonly socketPath: string;
  readonly reception: Promise<WorkerCompletionReception>;
  resolveReception(value: WorkerCompletionReception): void;
  rejectReception(error: WorkerProtocolError): void;
  readonly startedReception: Promise<WorkerStartReception>;
  resolveStarted(value: WorkerStartReception): void;
  rejectStarted(error: WorkerProtocolError): void;
  readonly cancellationReception: Promise<void>;
  resolveCancellation(): void;
  socket?: Socket;
  identity?: Readonly<WorkerProcessIdentity>;
  receptionCompleted: boolean;
  successfulExitObservation?: Promise<boolean>;
  readonly protocol: HostProtocolPeer;
}

function protocolError(message: string): WorkerProtocolError {
  return { _tag: "WorkerProtocolError", message };
}

function receiveWorkerProtocol<Value>(
  reception: Promise<Value>,
): Effect.Effect<Value, WorkerProtocolError> {
  return Effect.tryPromise({
    try: () => reception,
    catch: (error) => protocolError(
      error instanceof Error ? error.message : String(error),
    ),
  });
}

function writeSocket(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed || !socket.writable || socket.writableEnded) {
      reject(new Error("Child connection closed before acknowledgement"));
      return;
    }
    socket.write(bytes, (error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}

function parsePromptPath(promptRef: string): string {
  if (promptRef.startsWith("file://")) return new URL(promptRef).pathname;
  if (isAbsolute(promptRef)) return promptRef;
  throw new Error("Visible worker promptRef must be an absolute path or file URL");
}

const defaultPromptReader: PromptReader = {
  read: (promptRef) => readFile(parsePromptPath(promptRef)),
};

const defaultCapabilityGenerator: WorkerCapabilityGenerator = {
  nextCapability: () => randomBytes(32).toString("hex"),
};

export class VisibleWorker implements WorkerAdapter {
  private readonly sessions = new Map<string, Session>();
  private readonly capabilityGenerator: WorkerCapabilityGenerator;
  private readonly promptReader: PromptReader;
  private readonly serverFactory: () => Server;
  private readonly processControl: WorkerProcessControl;
  private readonly backendCancellationGraceMs: number;
  private readonly exitObservationGraceMs: number;
  private readonly successfulExitGraceMs: number;
  private readonly agentStartTimeoutMs: number;

  constructor(private readonly options: VisibleWorkerOptions) {
    this.capabilityGenerator = options.capabilityGenerator ?? defaultCapabilityGenerator;
    this.promptReader = options.promptReader ?? defaultPromptReader;
    this.serverFactory = options.serverFactory ?? createServer;
    this.processControl = options.processControl ?? new NodeWorkerProcessControl();
    this.backendCancellationGraceMs = options.backendCancellationGraceMs ?? 500;
    this.exitObservationGraceMs = options.exitObservationGraceMs ?? 250;
    this.successfulExitGraceMs = options.successfulExitGraceMs ?? 10_000;
    this.agentStartTimeoutMs = options.agentStartTimeoutMs ?? 30_000;
  }

  open(operation: Operation): Worker {
    const cancellation = new WorkerCancellation();
    return makeSingleRunWorker({
      run: (hooks) => this.runSession(operation, hooks, cancellation),
      cancel: (_cancellationEpoch, timeoutMs) => Effect.promise(() =>
        cancellation.execute(() => this.cancelSession(operation, timeoutMs))),
    });
  }

  private runSession(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>,
    cancellation: WorkerCancellation,
  ): Effect.Effect<
    WorkerRunOutcome,
    OperationPersistenceError | ResultConflictError
  > {
    let session: Session | undefined;
    return Effect.gen(this, function* () {
      if (cancellation.requested) {
        return { state: "worker_protocol_failed" } as const;
      }
      const launch = yield* Effect.either(Effect.tryPromise({
        try: () => this.startWorker(operation, cancellation),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      }));
      if (launch._tag === "Left") {
        return {
          state: cancellation.requested
            ? "worker_protocol_failed"
            : "worker_start_failed",
        } as const;
      }
      session = launch.right;
      if (cancellation.requested) {
        return { state: "worker_protocol_failed" } as const;
      }
      yield* hooks.workerLaunched();

      return yield* Effect.gen(this, function* () {
        const started = yield* receiveWorkerProtocol(session!.startedReception);
        if (started.state === "configuration_failed") {
          return { state: started.reason } as WorkerRunOutcome;
        }
        if (started.state === "liveness-unproven") {
          return { state: "liveness-unproven" } as const;
        }
        const mismatch = configurationMismatch(operation.effectiveConfig, started.identity.observedConfig);
        if (mismatch !== undefined) return { state: mismatch } as WorkerRunOutcome;
        yield* hooks.workerIdentified(started.identity);
        if (cancellation.requested) {
          if (cancellation.responsePending) {
            yield* receiveWorkerProtocol(session!.reception);
          }
          return { state: "worker_protocol_failed" } as const;
        }
        yield* Effect.tryPromise({
          try: () => this.sendBegin(session!),
          catch: (error) => protocolError(error instanceof Error ? error.message : String(error)),
        });
        const reception = yield* receiveWorkerProtocol(session!.reception);
        if (reception.state === "agent_failed") {
          return { state: "agent_failed", evidence: reception.evidence } as const;
        }
        if (reception.state !== "results_received") {
          return {
            state: reception.state === "cancelled"
              ? "worker_protocol_failed"
              : reception.state,
          } as WorkerRunOutcome;
        }
        const acceptance = yield* hooks.acceptResults(reception.deliveries);
        const acknowledged = yield* acknowledgeResultAcceptance(
          acceptance,
          reception.evidence,
          (proof) => Effect.tryPromise({
            try: () => this.sendAcknowledgement(session!, proof),
            catch: (error) => error instanceof Error ? error : new Error(String(error)),
          }),
        );
        if (acknowledged.state !== "result_acknowledged") return acknowledged;
        const stopped = yield* Effect.promise(() => this.confirmSuccessfulExit(session!));
        if (!stopped) return { state: "liveness-unproven" } as const;
        return cancellation.requested
          ? acknowledged
          : { ...acknowledged, successfulExitConfirmed: true } as const;
      }).pipe(
        Effect.catchTag(
          "WorkerProtocolError",
          () => Effect.succeed({ state: "worker_protocol_failed" } as const),
        ),
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        if (
          session !== undefined &&
          this.sessions.get(session.operation.operationId) === session
        ) {
          this.closeSession(session);
        }
      })),
    );
  }

  private async startWorker(
    operation: Operation,
    cancellation: WorkerCancellation,
  ): Promise<Session> {
    cancellation.requireLaunchAllowed();
    if (operation.presentation === undefined) throw new Error("Worker pane ownership is missing");
    const directory = join(this.options.rootDirectory, operationDirectoryKey(operation.operationId));
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
    const promptPath = join(directory, "prompt.utf8");
    const configPath = join(directory, "worker.v7.json");
    await mkdir(this.options.socketDirectory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(this.options.socketDirectory, DIRECTORY_MODE);
    const socketPath = join(this.options.socketDirectory, `${operationDirectoryKey(operation.operationId)}.sock`);
    const prompt = await this.promptReader.read(operation.task.promptRef);
    cancellation.requireLaunchAllowed();
    if (prompt.byteLength > DEFAULT_MAX_PROMPT_BYTES) throw new Error("Prompt exceeds the configured size limit");
    const capability = this.capabilityGenerator.nextCapability();
    const config: WorkerConfig = {
      operationId: operation.operationId,
      capability,
      socketPath,
      promptPath,
      effectiveConfig: operation.effectiveConfig,
    };
    const encodedConfig = encodeWorkerConfig(config);
    await writeFile(promptPath, prompt, { mode: FILE_MODE, flag: "wx" });
    await chmod(promptPath, FILE_MODE);
    await writeFile(configPath, encodedConfig, { mode: FILE_MODE, flag: "wx" });
    await chmod(configPath, FILE_MODE);
    cancellation.requireLaunchAllowed();
    const session = this.createSession(operation, capability, socketPath);
    this.sessions.set(operation.operationId, session);
    try {
      await new Promise<void>((resolve, reject) => {
        session.server.once("error", reject);
        session.server.listen(socketPath, () => {
          resolve();
        });
      });
      await chmod(socketPath, FILE_MODE);

      cancellation.requireLaunchAllowed();
      const effective = operation.effectiveConfig;
      const output = await Effect.runPromise(this.options.executor.execute({
        executable: "herdr",
        args: [
          "agent", "start", `pions-${operationDirectoryKey(operation.operationId).slice(0, 26)}`,
          "--kind", "pi",
          "--pane", operation.presentation.paneId,
          "--timeout", String(this.agentStartTimeoutMs),
          "--",
          "--provider", effective.model.provider,
          "--model", effective.model.id,
          "--thinking", effective.thinkingLevel,
          "--tools", effective.tools.join(","),
          "--no-session",
          "--tui-mode", "regular",
          "--no-extensions",
          "--extension", this.options.extensionEntryPath,
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--approve",
          "--pions-worker-config", configPath,
        ],
        cwd: this.options.cwd,
        shell: false,
      }));
      if (output.exitCode !== 0) throw new Error(output.stderr.trim() || "Unable to launch visible worker");
      cancellation.requireLaunchAllowed("during");
      return session;
    } catch (error) {
      this.closeSession(session);
      throw error;
    }
  }

  private createSession(operation: Operation, capability: string, socketPath: string): Session {
    let resolveReception!: (value: WorkerCompletionReception) => void;
    let rejectReception!: (error: WorkerProtocolError) => void;
    const reception = new Promise<WorkerCompletionReception>((resolve, reject) => {
      resolveReception = resolve;
      rejectReception = reject;
    });
    let resolveStarted!: (value: WorkerStartReception) => void;
    let rejectStarted!: (error: WorkerProtocolError) => void;
    const startedReception = new Promise<WorkerStartReception>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    let resolveCancellation!: () => void;
    const cancellationReception = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    void reception.catch(() => undefined);
    void startedReception.catch(() => undefined);
    const server = this.serverFactory();
    const session: Session = {
      operation,
      server,
      socketPath,
      reception,
      resolveReception,
      rejectReception,
      startedReception,
      resolveStarted,
      rejectStarted,
      cancellationReception,
      resolveCancellation,
      receptionCompleted: false,
      protocol: new HostProtocolPeer({
        operationId: operation.operationId,
        capability,
      }),
    };
    server.on("connection", (socket) => this.acceptConnection(session, socket));
    return session;
  }

  private acceptConnection(session: Session, socket: Socket): void {
    if (session.socket !== undefined) {
      socket.destroy();
      return;
    }
    session.socket = socket;
    socket.unref();
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const event of session.protocol.receive(chunk)) {
          if (event.type === "started") {
            const identity = {
              processId: event.processId,
              processInstanceId: event.processInstanceId,
              processStartToken: event.processStartToken,
              piSessionId: event.piSessionId,
              observedConfig: event.observedConfig,
            };
            session.identity = identity;
            session.resolveStarted({
              state: "identified",
              identity,
            });
          } else if (event.type === "worker_configuration_failed") {
            session.receptionCompleted = true;
            session.resolveStarted({ state: "configuration_failed", reason: event.reason });
          } else {
            session.receptionCompleted = true;
            if (event.type === "worker_cancelled") {
              session.resolveCancellation();
            } else {
              session.resolveReception(event.type === "worker_failed"
                ? { state: "agent_failed", evidence: event.evidence }
                : {
                    state: "results_received",
                    deliveries: event.reception.deliveries,
                    evidence: event.evidence,
                  });
            }
          }
        }
      } catch (error) {
        this.reject(session, error instanceof Error ? error.message : String(error));
      }
    });
    socket.on("end", () => {
      void this.classifyDisconnect(session);
    });
    socket.on("error", (error) => this.reject(session, error.message));
  }

  private async classifyDisconnect(session: Session): Promise<void> {
    if (session.receptionCompleted) {
      this.closeSession(session);
      return;
    }
    session.receptionCompleted = true;
    if (session.identity === undefined) {
      session.resolveReception({ state: "liveness-unproven" });
      session.resolveStarted({ state: "liveness-unproven" });
      this.closeSession(session);
      return;
    }
    const state = await Effect.runPromise(
      this.processControl.waitForStop(session.identity, this.exitObservationGraceMs),
    );
    session.resolveReception(
      state === "stopped"
        ? { state: "process-exited-without-result" }
        : state === "unverifiable"
          ? { state: "liveness-unproven" }
          : { state: "worker_protocol_failed" },
    );
    this.closeSession(session);
  }

  private async cancelSession(
    operation: Operation,
    timeoutMs: number,
  ): Promise<WorkerCancellationEvidence | undefined> {
    const session = this.sessions.get(operation.operationId);
    if (session?.socket === undefined) {
      if (session !== undefined) {
        this.reject(session, "Visible Worker cancelled before protocol identification");
      }
      return undefined;
    }
    const cancellationDeadline = Date.now() + Math.max(
      0,
      Math.floor(timeoutMs * CANCELLATION_TIMEOUT_BUDGET_RATIO),
    );
    const remaining = () => Math.max(0, cancellationDeadline - Date.now());
    const request = session.protocol.requestCancellation();
    if (request === undefined) {
      const exitObservation = session.successfulExitObservation;
      if (exitObservation === undefined) return undefined;
      const stopped = await this.waitForSuccessfulExit(exitObservation, remaining());
      if (stopped === undefined) return undefined;
      if (stopped) return { proof: "worker-stop" };
      if (session.identity === undefined) return undefined;
      const state = await Effect.runPromise(this.processControl.observe(session.identity));
      if (state === "stopped") return { proof: "worker-stop" };
      if (state === "unverifiable" || remaining() === 0) return undefined;
      return Effect.runPromise(
        this.processControl.terminate(session.identity, remaining()),
      );
    }
    try {
      await writeSocket(session.socket, request);
    } catch {
      return undefined;
    }
    const acknowledged = await this.waitForCancellationAcknowledgement(
      session,
      Math.min(this.backendCancellationGraceMs, remaining()),
    );
    if (!acknowledged) {
      if (session.identity === undefined || session.socket.destroyed) return undefined;
      const evidence = remaining() > 0
        ? await Effect.runPromise(
            this.processControl.terminate(session.identity, remaining()),
          )
        : undefined;
      this.completeCancellation(session);
      return evidence;
    }
    if (session.identity === undefined) {
      this.completeCancellation(session);
      return undefined;
    }
    const state = await Effect.runPromise(
      this.processControl.waitForStop(
        session.identity,
        Math.min(this.exitObservationGraceMs, remaining()),
      ),
    );
    const evidence = state === "stopped"
      ? { proof: "worker-stop" } as const
      : state === "running" && remaining() > 0
        ? await Effect.runPromise(
            this.processControl.terminate(session.identity, remaining()),
          )
        : undefined;
    this.completeCancellation(session);
    return evidence;
  }

  private completeCancellation(session: Session): void {
    session.resolveReception({ state: "cancelled" });
    this.closeSession(session);
  }

  private waitForSuccessfulExit(
    observation: Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean | undefined> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), timeoutMs);
      observation.then((stopped) => {
        clearTimeout(timeout);
        resolve(stopped);
      });
    });
  }

  private waitForCancellationAcknowledgement(
    session: Session,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      session.cancellationReception.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  private async sendBegin(session: Session): Promise<void> {
    if (session.socket === undefined) {
      throw protocolError("No Worker connection to begin execution");
    }
    await writeSocket(session.socket, session.protocol.begin());
  }

  private async sendAcknowledgement(
    session: Session,
    acceptance: Readonly<ResultAcceptanceProof>,
  ): Promise<void> {
    if (acceptance.operationId !== session.operation.operationId) {
      throw protocolError("Result acceptance belongs to another Operation");
    }
    if (session.socket === undefined) {
      throw protocolError("No Worker connection to acknowledge");
    }
    try {
      const acknowledgement = session.protocol.acknowledgeResult(acceptance);
      await writeSocket(session.socket, acknowledgement.bytes);
    } catch (error) {
      this.closeSession(session);
      throw error;
    }
  }

  private confirmSuccessfulExit(session: Session): Promise<boolean> {
    if (session.identity === undefined) return Promise.resolve(false);
    session.successfulExitObservation ??= Effect.runPromise(
      this.processControl.waitForStop(session.identity, this.successfulExitGraceMs),
    ).then((processState) => {
      this.closeSession(session, processState === "stopped");
      return processState === "stopped";
    });
    return session.successfulExitObservation;
  }

  private closeSession(session: Session, graceful = false): void {
    session.server.removeAllListeners("connection");
    session.server.removeAllListeners("error");
    session.socket?.removeAllListeners("data");
    session.socket?.removeAllListeners("end");
    session.socket?.removeAllListeners("error");
    if (graceful) session.socket?.end();
    else session.socket?.destroy();
    if (session.server.listening) session.server.close();
    if (this.sessions.get(session.operation.operationId) === session) {
      this.sessions.delete(session.operation.operationId);
    }
  }

  private reject(session: Session, message: string): void {
    if (session.receptionCompleted) {
      this.closeSession(session);
      return;
    }
    session.receptionCompleted = true;
    session.rejectStarted(protocolError(message));
    session.rejectReception(protocolError(message));
    this.closeSession(session);
  }
}
