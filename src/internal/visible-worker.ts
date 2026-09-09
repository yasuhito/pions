import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import {
  HostProtocolPeer,
  decodeWorkerConfig,
  encodeWorkerConfig,
} from "./worker-protocol.js";
import type {
  BeginRejectionReason,
  ResultAcceptanceProof,
  StartInstruction,
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
import {
  OperationPersistenceError,
  ResourceProofRejectedError,
} from "../public.js";
import type {
  WorkerConfigurationFailureReason,
  WorkerProducedResult,
} from "../public.js";
import { configurationMismatch } from "./worker-configuration.js";
import type { CommandExecutor } from "./herdr-presentation.js";
import {
  type BackendProcessIdentity,
  NodeWorkerProcessControl,
  type WorkerProcessControl,
} from "./worker-process-control.js";
import {
  type ApprovedProviderExtension,
  verifyApprovedProviderExtension,
} from "./worker-extension-entry.js";

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
  readonly providerExtension?: Readonly<ApprovedProviderExtension>;
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

type StartInstructionAcceptanceResolution =
  | { readonly state: "accepted" }
  | { readonly state: "rejected"; readonly reason: BeginRejectionReason }
  | { readonly state: "unknown" };

type StartInstructionAcknowledgementResolution =
  | { readonly state: "acknowledged" }
  | { readonly state: "rejected"; readonly reason: BeginRejectionReason }
  | { readonly state: "unknown" };

type DeliveryGenerationResolution =
  | {
      readonly state: "confirmed";
      readonly deliveryGeneration: number;
      readonly acceptanceState: "not_accepted" | "accepted" | "unknown";
      readonly acceptedInstruction?: Readonly<StartInstruction>;
    }
  | { readonly state: "unknown" };

type WorkerCompletionReception =
  | {
      readonly state: "result_received";
      readonly result: Readonly<WorkerProducedResult>;
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | {
      readonly state: "agent_failed" | WorkerConfigurationFailureReason;
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | { readonly state: "cancelled" }
  | { readonly state: "liveness-unproven" };

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
  readonly startInstructionAcceptance: Promise<StartInstructionAcceptanceResolution>;
  resolveStartInstructionAcceptance(resolution: StartInstructionAcceptanceResolution): void;
  rejectStartInstructionAcceptance(error: WorkerProtocolError): void;
  readonly startInstructionAcknowledgement: Promise<StartInstructionAcknowledgementResolution>;
  resolveStartInstructionAcknowledgement(resolution: StartInstructionAcknowledgementResolution): void;
  rejectStartInstructionAcknowledgement(error: WorkerProtocolError): void;
  readonly deliveryGeneration: Promise<DeliveryGenerationResolution>;
  resolveDeliveryGeneration(resolution: DeliveryGenerationResolution): void;
  rejectDeliveryGeneration(error: WorkerProtocolError): void;
  socket?: Socket;
  identity?: Readonly<WorkerProcessIdentity>;
  receptionCompleted: boolean;
  successfulExitObservation?: Promise<boolean>;
  backendProcesses: ReadonlyArray<Readonly<BackendProcessIdentity>> | undefined;
  readonly protocol: HostProtocolPeer;
}

function protocolError(message: string): WorkerProtocolError {
  return { _tag: "WorkerProtocolError", message };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function classifyAgentFailure(
  provider: string,
  errorMessage: string,
): "agent_failed" | WorkerConfigurationFailureReason {
  if (provider !== "claude-bridge") return "agent_failed";
  const message = errorMessage.toLowerCase();
  if (/\b(plan|subscription|extra usage|billing)\b/u.test(message)) {
    return "unsupported_capability";
  }
  if (/\b(not logged in|login|authentication|authenticate|credentials?)\b/u.test(message)) {
    return "model_auth_unavailable";
  }
  if (/\b(model)\b.*\b(not available|unavailable|not found|unknown)\b/u.test(message)) {
    return "model_not_found";
  }
  return "agent_failed";
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
      run: (hooks) => this.runSession(operation, hooks, cancellation, false),
      cancel: (_cancellationEpoch, timeoutMs) => Effect.promise(() =>
        cancellation.execute(() => this.cancelSession(operation, timeoutMs))),
    });
  }

  recover(operation: Operation): Worker {
    const cancellation = new WorkerCancellation();
    return makeSingleRunWorker({
      run: (hooks) => this.runSession(operation, hooks, cancellation, true),
      cancel: (_cancellationEpoch, timeoutMs) => Effect.promise(() =>
        cancellation.execute(() => this.cancelSession(operation, timeoutMs))),
    });
  }

  private runSession(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>,
    cancellation: WorkerCancellation,
    recovering: boolean,
  ): Effect.Effect<
    WorkerRunOutcome,
    OperationPersistenceError | ResourceProofRejectedError
  > {
    let session: Session | undefined;
    let startDeliveryEntered = false;
    return Effect.gen(this, function* () {
      if (cancellation.requested) {
        return { state: "worker_protocol_failed" } as const;
      }
      const launch = yield* Effect.either(Effect.tryPromise({
        try: () => recovering
          ? this.recoverWorker(operation, cancellation)
          : this.startWorker(operation, cancellation),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      }));
      if (launch._tag === "Left") {
        if (recovering) {
          return yield* Effect.promise(() => this.stopRecoveredWorker(operation));
        }
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
      if (!recovering) yield* hooks.workerLaunched();

      return yield* Effect.gen(this, function* () {
        const started = yield* receiveWorkerProtocol(
          recovering
            ? this.waitForRecoveredWorker(session!)
            : session!.startedReception,
        );
        if (started.state === "configuration_failed") {
          return { state: started.reason } as WorkerRunOutcome;
        }
        if (started.state === "liveness-unproven") {
          return recovering
            ? yield* Effect.promise(() => this.stopRecoveredWorker(operation))
            : { state: "liveness-unproven" } as const;
        }
        const mismatch = configurationMismatch(operation.effectiveConfig, started.identity.observedConfig);
        if (mismatch !== undefined) return { state: mismatch } as WorkerRunOutcome;
        if (
          recovering &&
          (operation.workerIdentity?.processInstanceId !== started.identity.processInstanceId ||
            operation.workerIdentity.processStartToken !== started.identity.processStartToken)
        ) {
          return yield* Effect.promise(() => this.stopAfterUncertainStart(operation));
        }
        const instruction = yield* hooks.workerIdentified(started.identity);
        let startAlreadyAccepted = false;
        if (recovering) {
          yield* hooks.startDeliveryAuthorityRevoked(
            instruction.dispatcherId,
            instruction.deliveryGeneration,
          );
          yield* Effect.tryPromise({
            try: () => this.requestDeliveryGenerationUpdate(
              session!,
              instruction.deliveryGeneration,
              instruction.dispatcherId,
            ),
            catch: (error) => protocolError(error instanceof Error ? error.message : String(error)),
          });
          const generation = yield* receiveWorkerProtocol(session!.deliveryGeneration);
          if (generation.state !== "confirmed") {
            return yield* Effect.promise(() => this.stopAfterUncertainStart(operation));
          }
          session!.protocol.completeDispatcherHandoff(instruction.dispatcherId);
          yield* hooks.deliveryGenerationConfirmed({
            dispatcherId: instruction.dispatcherId,
            deliveryGeneration: generation.deliveryGeneration,
            acceptanceState: generation.acceptanceState,
            ...(generation.acceptedInstruction === undefined
              ? {}
              : { acceptedInstruction: generation.acceptedInstruction }),
          });
          if (generation.acceptanceState === "unknown") {
            return yield* Effect.promise(() => this.stopAfterUncertainStart(operation));
          }
          startAlreadyAccepted = generation.acceptanceState === "accepted";
        }
        if (cancellation.requested) {
          if (cancellation.responsePending) {
            yield* receiveWorkerProtocol(session!.reception);
          }
          return { state: "worker_protocol_failed" } as const;
        }
        if (!startAlreadyAccepted) {
          yield* hooks.startDeliveryEntered(instruction);
          startDeliveryEntered = true;
          yield* Effect.tryPromise({
            try: () => this.dispatchBegin(session!, instruction),
            catch: (error) => protocolError(error instanceof Error ? error.message : String(error)),
          });
          yield* hooks.startInstructionDispatched(instruction);
          const beginAcceptance = yield* receiveWorkerProtocol(session!.startInstructionAcceptance);
          if (beginAcceptance.state !== "accepted") {
            return yield* Effect.promise(() => this.stopAfterUncertainStart(operation));
          }
          yield* hooks.startInstructionAccepted(instruction);
          yield* Effect.tryPromise({
            try: () => this.sendStartAcceptanceObservation(session!, instruction),
            catch: (error) => protocolError(error instanceof Error ? error.message : String(error)),
          });
          const acknowledgement = yield* receiveWorkerProtocol(session!.startInstructionAcknowledgement);
          if (acknowledgement.state !== "acknowledged") {
            return yield* Effect.promise(() => this.stopAfterUncertainStart(operation));
          }
          yield* hooks.startInstructionAcknowledged(instruction);
        }
        const reception = yield* receiveWorkerProtocol(session!.reception);
        if (reception.state === "agent_failed" ||
            reception.state === "model_auth_unavailable" ||
            reception.state === "model_not_found" ||
            reception.state === "unsupported_capability") {
          const backendInspected = yield* Effect.promise(() => this.captureBackendProcesses(session!));
          if (!backendInspected) return { state: "liveness-unproven" } as const;
          return { state: reception.state, evidence: reception.evidence } as WorkerRunOutcome;
        }
        if (reception.state !== "result_received") {
          return {
            state: reception.state === "cancelled"
              ? "worker_protocol_failed"
              : reception.state,
          } as WorkerRunOutcome;
        }
        const acceptance = yield* hooks.acceptResult(reception.result);
        if (
          acceptance.state === "accepted" &&
          acceptance.proof.operationId !== operation.operationId
        ) {
          return { state: "worker_protocol_failed" } as const;
        }
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
        Effect.catchAll((error): Effect.Effect<
          WorkerRunOutcome,
          OperationPersistenceError | ResourceProofRejectedError
        > => {
          if (error instanceof OperationPersistenceError || error instanceof ResourceProofRejectedError) {
            return startDeliveryEntered
              ? Effect.promise(() => this.cancelSession(operation, 1_000)).pipe(
                  Effect.andThen(Effect.fail(error)),
                )
              : Effect.fail(error);
          }
          return startDeliveryEntered
            ? Effect.promise(() => this.stopAfterUncertainStart(operation))
            : Effect.succeed<WorkerRunOutcome>({ state: "worker_protocol_failed" });
        }),
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
    const configPath = join(directory, "worker.v13.json");
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
      const providerExtension = effective.model.provider === this.options.providerExtension?.provider
        ? verifyApprovedProviderExtension(this.options.providerExtension)
        : undefined;
      const approvedExtensionArgs = providerExtension === undefined
        ? []
        : ["--extension", providerExtension.entryPath];
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
          ...approvedExtensionArgs,
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

  private async recoverWorker(
    operation: Operation,
    cancellation: WorkerCancellation,
  ): Promise<Session> {
    cancellation.requireLaunchAllowed();
    const directory = join(this.options.rootDirectory, operationDirectoryKey(operation.operationId));
    const config = decodeWorkerConfig(await readFile(join(directory, "worker.v13.json"), "utf8"));
    if (config.operationId !== operation.operationId) {
      throw new Error("Recovered Worker configuration belongs to another Operation");
    }
    const previous = operation.startInstructionDelivery ?? operation.startDeliveryAuthority;
    if (previous === undefined) throw new Error("Recovered Operation has no Start delivery authority");
    await mkdir(this.options.socketDirectory, { recursive: true, mode: DIRECTORY_MODE });
    await rm(config.socketPath, { force: true });
    const session = this.createSession(operation, config.capability, config.socketPath);
    session.protocol.restoreStartDelivery({
      dispatcherId: previous.dispatcherId,
      workerProcessInstanceId: previous.workerProcessInstanceId,
      receiptDigest: previous.receiptDigest,
      ...(previous.authorizationDecisionId === undefined
        ? {}
        : { authorizationDecisionId: previous.authorizationDecisionId }),
      deliveryGeneration: previous.deliveryGeneration,
      ...(operation.startAuthorizationTiming.policy === "required"
        ? { deadline: operation.startAuthorizationTiming.deadline }
        : {}),
    });
    this.sessions.set(operation.operationId, session);
    try {
      await new Promise<void>((resolve, reject) => {
        session.server.once("error", reject);
        session.server.listen(config.socketPath, resolve);
      });
      await chmod(config.socketPath, FILE_MODE);
      return session;
    } catch (error) {
      this.closeSession(session);
      throw error;
    }
  }

  private createSession(operation: Operation, capability: string, socketPath: string): Session {
    const reception = deferred<WorkerCompletionReception>();
    const started = deferred<WorkerStartReception>();
    const cancellation = deferred<void>();
    const startAcceptance = deferred<StartInstructionAcceptanceResolution>();
    const startAcknowledgement = deferred<StartInstructionAcknowledgementResolution>();
    const generation = deferred<DeliveryGenerationResolution>();
    const server = this.serverFactory();
    const session: Session = {
      operation,
      server,
      socketPath,
      reception: reception.promise,
      resolveReception: reception.resolve,
      rejectReception: reception.reject,
      startedReception: started.promise,
      resolveStarted: started.resolve,
      rejectStarted: started.reject,
      cancellationReception: cancellation.promise,
      resolveCancellation: () => cancellation.resolve(),
      startInstructionAcceptance: startAcceptance.promise,
      resolveStartInstructionAcceptance: startAcceptance.resolve,
      rejectStartInstructionAcceptance: startAcceptance.reject,
      startInstructionAcknowledgement: startAcknowledgement.promise,
      resolveStartInstructionAcknowledgement: startAcknowledgement.resolve,
      rejectStartInstructionAcknowledgement: startAcknowledgement.reject,
      deliveryGeneration: generation.promise,
      resolveDeliveryGeneration: generation.resolve,
      rejectDeliveryGeneration: generation.reject,
      receptionCompleted: false,
      backendProcesses: undefined,
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
          } else if (event.type === "start_instruction_accepted") {
            session.resolveStartInstructionAcceptance({ state: "accepted" });
          } else if (event.type === "start_instruction_acknowledged") {
            session.resolveStartInstructionAcknowledgement({ state: "acknowledged" });
          } else if (event.type === "start_instruction_rejected") {
            const rejection = { state: "rejected", reason: event.reason } as const;
            session.resolveStartInstructionAcceptance(rejection);
            session.resolveStartInstructionAcknowledgement(rejection);
          } else if (event.type === "delivery_generation_updated") {
            session.resolveDeliveryGeneration({
              state: "confirmed",
              deliveryGeneration: event.deliveryGeneration,
              acceptanceState: event.acceptanceState,
              ...(event.acceptedInstruction === undefined
                ? {}
                : { acceptedInstruction: event.acceptedInstruction }),
            });
          } else {
            session.receptionCompleted = true;
            if (event.type === "worker_cancelled") {
              session.resolveCancellation();
            } else {
              session.resolveReception(event.type === "worker_failed"
                ? {
                    state: classifyAgentFailure(
                      session.operation.effectiveConfig.model.provider,
                      event.errorMessage,
                    ),
                    evidence: event.evidence,
                  }
                : {
                    state: "result_received",
                    result: event.result,
                    evidence: event.evidence,
                  });
            }
          }
        }
      } catch (error) {
        this.reject(session, error instanceof Error ? error.message : String(error));
      }
    });
    socket.on("end", () => this.classifyDisconnect(session));
    socket.on("error", () => this.classifyDisconnect(session));
  }

  private classifyDisconnect(session: Session): void {
    if (session.receptionCompleted) {
      this.closeSession(session);
      return;
    }
    session.receptionCompleted = true;
    if (session.identity === undefined) {
      session.resolveReception({ state: "liveness-unproven" });
      session.resolveStarted({ state: "liveness-unproven" });
      session.resolveDeliveryGeneration({ state: "unknown" });
      this.closeSession(session);
      return;
    }
    session.resolveReception({ state: "liveness-unproven" });
    session.resolveStartInstructionAcceptance({ state: "unknown" });
    session.resolveStartInstructionAcknowledgement({ state: "unknown" });
    session.resolveDeliveryGeneration({ state: "unknown" });
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
    await this.captureBackendProcesses(session, remaining());
    const request = session.protocol.requestCancellation();
    if (request === undefined) {
      const exitObservation = session.successfulExitObservation;
      if (exitObservation === undefined) return undefined;
      const stopped = await this.waitForSuccessfulExit(exitObservation, remaining());
      if (stopped === undefined) return undefined;
      if (stopped) {
        return await this.confirmBackendStop(session, remaining())
          ? { proof: "worker-stop" }
          : undefined;
      }
      if (session.identity === undefined) return undefined;
      const state = await Effect.runPromise(this.processControl.observe(session.identity));
      if (state === "unverifiable" || remaining() === 0) return undefined;
      const workerEvidence = state === "stopped"
        ? { proof: "worker-stop" } as const
        : await Effect.runPromise(this.processControl.terminate(session.identity, remaining()));
      return workerEvidence !== undefined && await this.confirmBackendStop(session, remaining())
        ? workerEvidence
        : undefined;
    }
    try {
      await writeSocket(session.socket, request);
    } catch {
      if (session.identity === undefined) return undefined;
      await this.captureBackendProcesses(session, remaining());
      const state = await Effect.runPromise(this.processControl.observe(session.identity));
      if (state === "unverifiable" || remaining() === 0) return undefined;
      const workerEvidence = state === "stopped"
        ? { proof: "worker-stop" } as const
        : await Effect.runPromise(this.processControl.terminate(session.identity, remaining()));
      return workerEvidence !== undefined && await this.confirmBackendStop(session, remaining())
        ? workerEvidence
        : undefined;
    }
    await this.captureBackendProcesses(session, remaining());
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
      const backendStopped = evidence !== undefined && await this.confirmBackendStop(session, remaining());
      this.completeCancellation(session);
      return backendStopped ? evidence : undefined;
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
    const backendStopped = evidence !== undefined && await this.confirmBackendStop(session, remaining());
    this.completeCancellation(session);
    return backendStopped ? evidence : undefined;
  }

  private async captureBackendProcesses(
    session: Session,
    timeoutMs = this.backendCancellationGraceMs,
  ): Promise<boolean> {
    if (session.operation.effectiveConfig.model.provider !== "claude-bridge") return true;
    if (session.identity === undefined || this.processControl.captureDescendants === undefined) return false;
    const captured = await new Promise<ReadonlyArray<Readonly<BackendProcessIdentity>> | undefined>((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
      void Effect.runPromise(this.processControl.captureDescendants!(session.identity!)).then((identities) => {
        clearTimeout(timeout);
        resolve(identities);
      });
    });
    if (captured === undefined) return false;
    const existing = session.backendProcesses ?? [];
    const identities = new Map(existing.map((identity) => [
      `${identity.processId}:${identity.processStartToken}`,
      identity,
    ]));
    for (const identity of captured) {
      identities.set(`${identity.processId}:${identity.processStartToken}`, identity);
    }
    session.backendProcesses = Object.freeze([...identities.values()]);
    return true;
  }

  private async confirmBackendStop(session: Session, timeoutMs: number): Promise<boolean> {
    if (session.operation.effectiveConfig.model.provider !== "claude-bridge") return true;
    const identities = session.backendProcesses;
    const waitForStop = this.processControl.waitForBackendStop;
    const terminate = this.processControl.terminateBackend;
    if (identities === undefined || waitForStop === undefined || terminate === undefined) return false;
    const deadline = Date.now() + timeoutMs;
    const observationBudget = Math.min(this.exitObservationGraceMs, timeoutMs);
    const state = await Effect.runPromise(
      waitForStop.call(this.processControl, identities, observationBudget),
    );
    if (state === "stopped") return true;
    const remaining = Math.max(0, deadline - Date.now());
    if (state === "unverifiable" || remaining === 0) return false;
    return await Effect.runPromise(
      terminate.call(this.processControl, identities, remaining),
    ) !== undefined;
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

  private waitForRecoveredWorker(session: Session): Promise<WorkerStartReception> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => resolve({ state: "liveness-unproven" }),
        this.agentStartTimeoutMs,
      );
      timeout.unref();
      session.startedReception.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  private async stopRecoveredWorker(operation: Operation): Promise<WorkerRunOutcome> {
    const storedIdentity = operation.workerIdentity;
    const observedConfig = operation.observedConfig;
    if (storedIdentity === undefined || observedConfig === undefined) {
      return { state: "liveness-unproven" };
    }
    const identity: WorkerProcessIdentity = { ...storedIdentity, observedConfig };
    const observed = await Effect.runPromise(this.processControl.observe(identity));
    if (observed === "stopped") {
      return { state: "worker_protocol_failed", successfulExitConfirmed: true };
    }
    if (observed !== "running") return { state: "liveness-unproven" };
    const stopped = await Effect.runPromise(
      this.processControl.terminate(identity, this.agentStartTimeoutMs),
    );
    return stopped === undefined
      ? { state: "liveness-unproven" }
      : { state: "worker_protocol_failed", successfulExitConfirmed: true };
  }

  private async stopAfterUncertainStart(
    operation: Operation,
  ): Promise<WorkerRunOutcome> {
    const stopped = await this.cancelSession(operation, 1_000);
    return stopped === undefined
      ? { state: "liveness-unproven" }
      : { state: "worker_protocol_failed", successfulExitConfirmed: true };
  }

  private async dispatchBegin(
    session: Session,
    instruction: Readonly<StartInstruction>,
  ): Promise<void> {
    if (session.socket === undefined) {
      throw protocolError("No Worker connection to begin execution");
    }
    await writeSocket(session.socket, session.protocol.begin(instruction));
  }

  private async requestDeliveryGenerationUpdate(
    session: Session,
    deliveryGeneration: number,
    dispatcherId: string,
  ): Promise<void> {
    if (session.socket === undefined) {
      throw protocolError("No Worker connection to update delivery generation");
    }
    await writeSocket(
      session.socket,
      session.protocol.updateDeliveryGeneration(deliveryGeneration, dispatcherId),
    );
  }

  private async sendStartAcceptanceObservation(
    session: Session,
    instruction: Readonly<StartInstruction>,
  ): Promise<void> {
    if (session.socket === undefined) {
      throw protocolError("No Worker connection to acknowledge Start acceptance");
    }
    await writeSocket(
      session.socket,
      session.protocol.acknowledgeStartInstructionAcceptance(instruction),
    );
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
    session.rejectStartInstructionAcceptance(protocolError(message));
    session.rejectStartInstructionAcknowledgement(protocolError(message));
    session.rejectDeliveryGeneration(protocolError(message));
    this.closeSession(session);
  }
}
