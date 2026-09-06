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
  WorkerConfig,
} from "./worker-protocol.js";
import type { Operation } from "./event-store/index.js";
import { operationDirectoryKey } from "./event-store/index.js";
import type {
  AgentBackend,
  BackendCancellationEvidence,
  BackendError,
  ChannelError,
  ChannelReception,
  ChildChannel,
} from "./services.js";
import type { CommandExecutor } from "./herdr-presentation.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_MAX_PROMPT_BYTES = 1024 * 1024;

export interface WorkerCapabilityGenerator {
  nextCapability(): string;
}

export interface PromptReader {
  read(promptRef: string): Promise<Buffer>;
}

export interface VisibleWorkerOptions {
  readonly rootDirectory: string;
  readonly cwd: string;
  readonly executor: CommandExecutor;
  readonly wrapperEntryPath: string;
  readonly nodeExecutable?: string;
  readonly capabilityGenerator?: WorkerCapabilityGenerator;
  readonly promptReader?: PromptReader;
  readonly profiles?: Readonly<Record<string, ReadonlyArray<string>>>;
}

interface Session {
  readonly operation: Operation;
  readonly server: Server;
  readonly socketPath: string;
  readonly reception: Promise<ChannelReception>;
  resolveReception(value: ChannelReception): void;
  rejectReception(error: ChannelError): void;
  readonly startedReception: Promise<{ readonly processInstanceId: string }>;
  resolveStarted(value: { readonly processInstanceId: string }): void;
  rejectStarted(error: ChannelError): void;
  socket?: Socket;
  receptionCompleted: boolean;
  readonly protocol: HostProtocolPeer;
}

function channelError(message: string): ChannelError {
  return { _tag: "ChannelError", message };
}

function backendError(message: string): BackendError {
  return { _tag: "BackendError", reason: "backend_start_failed", message };
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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

export class VisibleWorker implements AgentBackend, ChildChannel {
  private readonly sessions = new Map<string, Session>();
  private readonly capabilityGenerator: WorkerCapabilityGenerator;
  private readonly promptReader: PromptReader;

  constructor(private readonly options: VisibleWorkerOptions) {
    this.capabilityGenerator = options.capabilityGenerator ?? defaultCapabilityGenerator;
    this.promptReader = options.promptReader ?? defaultPromptReader;
  }

  start(operation: Operation): Effect.Effect<void, BackendError> {
    return Effect.tryPromise({
      try: () => this.startWorker(operation),
      catch: (error) => backendError(error instanceof Error ? error.message : String(error)),
    });
  }

  receiveStarted(operation: Operation) {
    const session = this.sessions.get(operation.operationId);
    return session === undefined
      ? Effect.fail(channelError("ChildChannel was not prepared"))
      : Effect.tryPromise({
          try: () => session.startedReception,
          catch: (error) => error as ChannelError,
        });
  }

  receiveResults(operationId: string): Effect.Effect<ChannelReception, ChannelError> {
    const session = this.sessions.get(operationId);
    return session === undefined
      ? Effect.fail(channelError("ChildChannel was not prepared"))
      : Effect.tryPromise({
          try: () => session.reception,
          catch: (error) => error as ChannelError,
        });
  }

  acknowledgeResult(
    acceptance: Readonly<ResultAcceptanceProof>,
  ): Effect.Effect<void, ChannelError> {
    return Effect.tryPromise({
      try: () => this.sendAcknowledgement(acceptance),
      catch: (error) => (typeof error === "object" && error !== null && "_tag" in error)
        ? error as ChannelError
        : channelError(error instanceof Error ? error.message : String(error)),
    });
  }

  cancel(operation: Operation): Effect.Effect<BackendCancellationEvidence, BackendError> {
    const session = this.sessions.get(operation.operationId);
    if (session?.socket !== undefined) {
      const cancellation = session.protocol.requestCancellation();
      if (cancellation !== undefined) session.socket.write(cancellation);
    }
    return Effect.fail(backendError("Visible worker stop has not been acknowledged"));
  }

  close(operation: Operation): void {
    const session = this.sessions.get(operation.operationId);
    if (session !== undefined) this.closeSession(session);
  }

  private async startWorker(operation: Operation): Promise<void> {
    if (operation.presentation === undefined) throw new Error("Worker pane ownership is missing");
    const directory = join(this.options.rootDirectory, operationDirectoryKey(operation.operationId));
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
    const promptPath = join(directory, "prompt.utf8");
    const configPath = join(directory, "worker.v1.json");
    const socketPath = join(directory, "child.sock");
    const prompt = await this.promptReader.read(operation.task.promptRef);
    if (prompt.byteLength > DEFAULT_MAX_PROMPT_BYTES) throw new Error("Prompt exceeds the configured size limit");
    const capability = this.capabilityGenerator.nextCapability();
    const agentArgs = (this.options.profiles ?? { coding: [] })[operation.task.profile];
    if (agentArgs === undefined) throw new Error(`Unknown visible worker profile: ${operation.task.profile}`);
    const config: WorkerConfig = {
      operationId: operation.operationId,
      capability,
      socketPath,
      promptPath,
      cwd: this.options.cwd,
      profile: operation.task.profile,
      agentArgs: [...agentArgs],
    };
    const encodedConfig = encodeWorkerConfig(config);
    await writeFile(promptPath, prompt, { mode: FILE_MODE, flag: "wx" });
    await chmod(promptPath, FILE_MODE);
    await writeFile(configPath, encodedConfig, { mode: FILE_MODE, flag: "wx" });
    await chmod(configPath, FILE_MODE);
    const session = this.createSession(operation, capability, socketPath);
    this.sessions.set(operation.operationId, session);
    await new Promise<void>((resolve, reject) => {
      session.server.once("error", reject);
      session.server.listen(socketPath, () => {
        session.server.unref();
        resolve();
      });
    });
    await chmod(socketPath, FILE_MODE);

    const command = [
      this.options.nodeExecutable ?? process.execPath,
      this.options.wrapperEntryPath,
      configPath,
    ].map(shellQuote).join(" ");
    const output = await Effect.runPromise(this.options.executor.execute({
      executable: "herdr",
      args: ["pane", "run", operation.presentation.paneId, command],
      cwd: this.options.cwd,
      shell: false,
    }));
    if (output.exitCode !== 0) throw new Error(output.stderr.trim() || "Unable to launch visible worker");
  }

  private createSession(operation: Operation, capability: string, socketPath: string): Session {
    let resolveReception!: (value: ChannelReception) => void;
    let rejectReception!: (error: ChannelError) => void;
    const reception = new Promise<ChannelReception>((resolve, reject) => {
      resolveReception = resolve;
      rejectReception = reject;
    });
    let resolveStarted!: (value: { readonly processInstanceId: string }) => void;
    let rejectStarted!: (error: ChannelError) => void;
    const startedReception = new Promise<{ readonly processInstanceId: string }>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    void reception.catch(() => undefined);
    void startedReception.catch(() => undefined);
    const server = createServer();
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
            session.resolveStarted({ processInstanceId: event.processInstanceId });
          } else {
            session.receptionCompleted = true;
            session.resolveReception(event.reception);
          }
        }
      } catch (error) {
        this.reject(session, error instanceof Error ? error.message : String(error));
      }
    });
    socket.on("end", () => {
      if (session.receptionCompleted) {
        this.closeSession(session);
        return;
      }
      try {
        session.protocol.disconnect();
      } catch (error) {
        this.reject(session, error instanceof Error ? error.message : String(error));
      }
    });
    socket.on("error", (error) => this.reject(session, error.message));
  }

  private async sendAcknowledgement(
    acceptance: Readonly<ResultAcceptanceProof>,
  ): Promise<void> {
    const session = this.sessions.get(acceptance.operationId);
    if (session?.socket === undefined) {
      throw channelError("No child connection to acknowledge");
    }
    try {
      const acknowledgement = session.protocol.acknowledgeResult(acceptance);
      await writeSocket(session.socket, acknowledgement.bytes);
      if (acknowledgement.complete) this.closeSession(session, true);
    } catch (error) {
      this.closeSession(session);
      throw error;
    }
  }

  private closeSession(session: Session, graceful = false): void {
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
    session.rejectStarted(channelError(message));
    session.rejectReception(channelError(message));
    session.socket?.destroy();
    session.server.close();
    this.sessions.delete(session.operation.operationId);
  }
}
