import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";

import { Effect, Schema } from "effect";

import {
  CHILD_PROTOCOL_VERSION,
  DEFAULT_MAX_FIRST_FRAME_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_RESULT_BYTES,
  DoneSchema,
  HelloSchema,
  ResultSchema,
  StartedSchema,
  resultDigest,
} from "./child-protocol.js";
import type { WorkerConfig } from "./child-protocol.js";
import type { Operation, ResultDelivery } from "./event-store/index.js";
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

export {
  CHILD_PROTOCOL_VERSION,
  DEFAULT_MAX_FIRST_FRAME_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_RESULT_BYTES,
} from "./child-protocol.js";

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
  readonly maxFirstFrameBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxResultBytes?: number;
}

interface Session {
  readonly operation: Operation;
  readonly capability: string;
  readonly server: Server;
  readonly socketPath: string;
  readonly reception: Promise<ChannelReception>;
  resolveReception(value: ChannelReception): void;
  rejectReception(error: ChannelError): void;
  readonly startedReception: Promise<{ readonly processInstanceId: string }>;
  resolveStarted(value: { readonly processInstanceId: string }): void;
  rejectStarted(error: ChannelError): void;
  socket?: Socket;
  lastSequenceNumber: number;
  authenticated: boolean;
  started: boolean;
  receptionCompleted: boolean;
  processInstanceId?: string;
  readonly deliveries: Array<ResultDelivery>;
  readonly pendingAcknowledgements: Map<number, number>;
  receivedResultBytes: number;
}

function channelError(message: string): ChannelError {
  return { _tag: "ChannelError", message };
}

function backendError(message: string): BackendError {
  return { _tag: "BackendError", reason: "backend_start_failed", message };
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
  private readonly maxFirstFrameBytes: number;
  private readonly maxMessageBytes: number;
  private readonly maxResultBytes: number;

  constructor(private readonly options: VisibleWorkerOptions) {
    this.capabilityGenerator = options.capabilityGenerator ?? defaultCapabilityGenerator;
    this.promptReader = options.promptReader ?? defaultPromptReader;
    this.maxFirstFrameBytes = options.maxFirstFrameBytes ?? DEFAULT_MAX_FIRST_FRAME_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
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
    operationId: string,
    sequenceNumber: number,
  ): Effect.Effect<void, ChannelError> {
    return Effect.try({
      try: () => {
        const session = this.sessions.get(operationId);
        if (session?.socket === undefined || !session.authenticated) {
          throw channelError("No authenticated child connection to acknowledge");
        }
        const pending = session.pendingAcknowledgements.get(sequenceNumber) ?? 0;
        if (pending === 0) throw channelError("Result acknowledgement does not match a received delivery");
        if (pending === 1) session.pendingAcknowledgements.delete(sequenceNumber);
        else session.pendingAcknowledgements.set(sequenceNumber, pending - 1);
        session.socket.write(`${JSON.stringify({
          protocolVersion: CHILD_PROTOCOL_VERSION,
          operationId,
          sequenceNumber,
          type: "ack",
        })}\n`);
        if (session.pendingAcknowledgements.size === 0) {
          session.socket.end();
          session.server.close();
          this.sessions.delete(operationId);
        }
      },
      catch: (error) => (typeof error === "object" && error !== null && "_tag" in error)
        ? error as ChannelError
        : channelError(error instanceof Error ? error.message : String(error)),
    });
  }

  cancel(operation: Operation): Effect.Effect<BackendCancellationEvidence, BackendError> {
    const session = this.sessions.get(operation.operationId);
    if (session?.socket !== undefined && session.authenticated) {
      session.socket.write(`${JSON.stringify({
        protocolVersion: CHILD_PROTOCOL_VERSION,
        operationId: operation.operationId,
        type: "cancel",
      })}\n`);
    }
    return Effect.fail(backendError("Visible worker stop has not been acknowledged"));
  }

  close(operation: Operation): void {
    const session = this.sessions.get(operation.operationId);
    session?.socket?.destroy();
    session?.server.close();
    this.sessions.delete(operation.operationId);
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
    if (prompt.byteLength > this.maxMessageBytes) throw new Error("Prompt exceeds the configured size limit");
    const capability = this.capabilityGenerator.nextCapability();
    if (!/^[0-9a-f]{64,}$/u.test(capability)) throw new Error("Operation capability must contain at least 256 bits");
    await writeFile(promptPath, prompt, { mode: FILE_MODE, flag: "wx" });
    await chmod(promptPath, FILE_MODE);
    const agentArgs = (this.options.profiles ?? { coding: [] })[operation.task.profile];
    if (agentArgs === undefined) throw new Error(`Unknown visible worker profile: ${operation.task.profile}`);
    const config: WorkerConfig = {
      protocolVersion: CHILD_PROTOCOL_VERSION,
      operationId: operation.operationId,
      capability,
      socketPath,
      promptPath,
      cwd: this.options.cwd,
      profile: operation.task.profile,
      agentArgs: [...agentArgs],
    };
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: FILE_MODE, flag: "wx" });
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
      capability,
      server,
      socketPath,
      reception,
      resolveReception,
      rejectReception,
      startedReception,
      resolveStarted,
      rejectStarted,
      lastSequenceNumber: 0,
      authenticated: false,
      started: false,
      receptionCompleted: false,
      deliveries: [],
      pendingAcknowledgements: new Map(),
      receivedResultBytes: 0,
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
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const firstNewline = buffered.indexOf(0x0a);
      if (!session.authenticated && firstNewline < 0 && buffered.byteLength > this.maxFirstFrameBytes) {
        this.reject(session, "Child frame exceeds the configured size limit");
        return;
      }
      if (buffered.byteLength > this.maxMessageBytes && firstNewline < 0) {
        this.reject(session, "Child frame exceeds the configured size limit");
        return;
      }
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        this.acceptFrame(session, frame);
        newline = buffered.indexOf(0x0a);
      }
      if (buffered.byteLength > this.maxMessageBytes) {
        this.reject(session, "Child frame exceeds the configured size limit");
      }
    });
    socket.on("end", () => {
      if (!session.receptionCompleted) this.reject(session, "Child disconnected before delivering a Result");
    });
    socket.on("error", (error) => this.reject(session, error.message));
  }

  private acceptFrame(session: Session, bytes: Buffer): void {
    try {
      const limit = session.authenticated ? this.maxMessageBytes : this.maxFirstFrameBytes;
      if (bytes.byteLength > limit) throw new Error("Child frame exceeds the configured size limit");
      const unknownFrame = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!session.authenticated) {
        const hello = Schema.decodeUnknownSync(HelloSchema)(unknownFrame);
        this.validateAuthority(session, hello);
        session.authenticated = true;
        session.lastSequenceNumber = hello.sequenceNumber;
        session.processInstanceId = hello.processInstanceId;
        return;
      }
      const object = unknownFrame as { readonly type?: unknown };
      if (object.type === "started") {
        const started = Schema.decodeUnknownSync(StartedSchema)(unknownFrame);
        this.validateSequence(session, started);
        session.started = true;
        session.resolveStarted({ processInstanceId: session.processInstanceId ?? "" });
        return;
      }
      if (object.type === "result") {
        const result = Schema.decodeUnknownSync(ResultSchema)(unknownFrame);
        this.validateSequence(session, result);
        if (!session.started) throw new Error("Result arrived before started notification");
        const bodyBytes = Buffer.from(result.body, "utf8");
        if (bodyBytes.byteLength > this.maxResultBytes) throw new Error("Result exceeds the configured size limit");
        session.receivedResultBytes += bodyBytes.byteLength;
        if (session.receivedResultBytes > this.maxMessageBytes || session.deliveries.length >= 16) {
          throw new Error("Result reception exceeds the configured aggregate limit");
        }
        if (result.digest !== resultDigest(result.body)) throw new Error("Result digest does not match its body");
        const delivery = {
          body: result.body,
          digest: result.digest as ResultDelivery["digest"],
          sequenceNumber: result.deliverySequenceNumber,
        };
        session.deliveries.push(delivery);
        session.pendingAcknowledgements.set(
          delivery.sequenceNumber,
          (session.pendingAcknowledgements.get(delivery.sequenceNumber) ?? 0) + 1,
        );
        return;
      }
      if (object.type === "done") {
        const done = Schema.decodeUnknownSync(DoneSchema)(unknownFrame);
        this.validateSequence(session, done);
        if (session.deliveries.length === 0) throw new Error("Child finished without a Result");
        session.receptionCompleted = true;
        session.resolveReception({ deliveries: [...session.deliveries] });
        return;
      }
      throw new Error("Unknown child message type");
    } catch (error) {
      this.reject(session, error instanceof Error ? error.message : String(error));
    }
  }

  private validateAuthority(
    session: Session,
    frame: { readonly operationId: string; readonly capability: string },
  ): void {
    const expected = Buffer.from(session.capability, "utf8");
    const actual = Buffer.from(frame.capability, "utf8");
    if (
      frame.operationId !== session.operation.operationId ||
      expected.byteLength !== actual.byteLength ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new Error("Child authority does not match the Operation");
    }
  }

  private validateSequence(
    session: Session,
    frame: { readonly operationId: string; readonly capability: string; readonly sequenceNumber: number },
  ): void {
    this.validateAuthority(session, frame);
    if (!Number.isSafeInteger(frame.sequenceNumber) || frame.sequenceNumber !== session.lastSequenceNumber + 1) {
      throw new Error("Child sequence number is stale or out of order");
    }
    session.lastSequenceNumber = frame.sequenceNumber;
  }

  private reject(session: Session, message: string): void {
    if (session.receptionCompleted) return;
    session.receptionCompleted = true;
    session.rejectStarted(channelError(message));
    session.rejectReception(channelError(message));
    session.socket?.destroy();
    session.server.close();
    this.sessions.delete(session.operation.operationId);
  }
}
