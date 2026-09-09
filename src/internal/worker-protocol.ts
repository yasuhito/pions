import { timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { Schema } from "effect";

import type {
  EffectiveWorkerConfig,
  ObservedWorkerConfig,
  StartInstructionReference,
  WorkerConfigurationFailureReason,
  WorkerProducedResult,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";
import type { AgentRunEvidence } from "./services.js";
import {
  EffectiveWorkerConfigSchema,
  ObservedWorkerConfigSchema,
} from "./worker-configuration.js";

export const WORKER_PROTOCOL_VERSION = 13 as const;

export interface ProtocolAuthority {
  readonly operationId: string;
  readonly capability: string;
}

export interface ProtocolLimits {
  readonly firstFrameBytes: number;
  readonly frameBytes: number;
  readonly artifactBytes: number;
  readonly sessionArtifactBytes: number;
  readonly artifacts: number;
}

export const DEFAULT_PROTOCOL_LIMITS: ProtocolLimits = Object.freeze({
  firstFrameBytes: 4 * 1024,
  frameBytes: 1024 * 1024,
  artifactBytes: 1024 * 1024,
  sessionArtifactBytes: 1024 * 1024,
  artifacts: 16,
});

export type ProtocolViolationReason =
  | "invalid_frame"
  | "version_mismatch"
  | "authority_mismatch"
  | "sequence_mismatch"
  | "frame_too_large"
  | "artifact_too_large"
  | "session_artifact_too_large"
  | "too_many_artifacts"
  | "digest_mismatch"
  | "invalid_transition"
  | "unexpected_acknowledgement"
  | "incomplete_session";

export class ProtocolViolation extends Error {
  override readonly name = "ProtocolViolation";

  constructor(
    readonly reason: ProtocolViolationReason,
    message: string,
  ) {
    super(message);
  }
}

const CapabilitySchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64,}$/u));
const ProcessInstanceIdSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const DigestSchema = Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/u));
const IdentifierSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u));

const CommonWorkerFrameFields = {
  protocolVersion: Schema.Number,
  operationId: Schema.NonEmptyString,
  capability: CapabilitySchema,
  sequenceNumber: Schema.Number,
};

const HelloSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("hello"),
  processId: Schema.Number,
  processInstanceId: ProcessInstanceIdSchema,
  processStartToken: Schema.NonEmptyString,
});
const StartedSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("started"),
  piSessionId: Schema.NonEmptyString,
  observedConfig: ObservedWorkerConfigSchema,
});
const ConfigurationFailedSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("configuration_failed"),
  reason: Schema.Literal(
    "model_mismatch",
    "thinking_level_mismatch",
    "model_not_found",
    "model_auth_unavailable",
    "unsupported_capability",
    "tool_policy_violation",
  ),
});
const ArtifactBeginSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("artifact_begin"),
  acceptanceRequestId: IdentifierSchema,
  slot: Schema.Literal("body", "work_product"),
  key: Schema.optional(Schema.String),
  index: Schema.optional(Schema.Number),
  formatId: Schema.NonEmptyString,
  normalizationId: Schema.NonEmptyString,
  expectedByteCount: Schema.Number,
  expectedDigest: DigestSchema,
});
const ArtifactChunkSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("artifact_chunk"),
  payload: Schema.String,
});
const ArtifactCommitSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("artifact_commit"),
  expectedDigest: DigestSchema,
});
const ResultManifestSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("result_manifest"),
  acceptanceRequestId: IdentifierSchema,
});
const UsageSchema = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
  cost: Schema.Number,
});
const ToolUseSchema = Schema.Struct({
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  isError: Schema.Boolean,
});
const DoneSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("done"),
  usage: UsageSchema,
  toolUses: Schema.Array(ToolUseSchema),
});
const FailedSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("failed"),
  errorMessage: Schema.String,
  usage: UsageSchema,
  toolUses: Schema.Array(ToolUseSchema),
});
const CancelledSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("cancelled"),
});
const AcknowledgementSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  operationId: Schema.NonEmptyString,
  acceptanceId: Schema.String.pipe(Schema.pattern(/^pions\.result-acceptance\.v1:[0-9a-f]{64}$/u)),
  manifestDigest: DigestSchema,
  eventSequenceNumber: Schema.Number,
  type: Schema.Literal("ack"),
});
const StartInstructionSchema = Schema.Struct({
  dispatcherId: IdentifierSchema,
  workerProcessInstanceId: ProcessInstanceIdSchema,
  receiptDigest: DigestSchema,
  authorizationDecisionId: Schema.optional(IdentifierSchema),
  deliveryGeneration: Schema.Number,
  deadline: Schema.optional(Schema.String),
});
const BeginRequestSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("begin"),
  instruction: StartInstructionSchema,
});
const BeginAcceptanceSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("begin_accepted"),
  instruction: StartInstructionSchema,
});
const BeginAcceptanceObservedSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("begin_acceptance_observed"),
  instruction: StartInstructionSchema,
});
const BeginAcknowledgementSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("begin_ack"),
  instruction: StartInstructionSchema,
});
const BeginRejectionReasonSchema = Schema.Literal(
  "conflict",
  "worker_mismatch",
  "expired",
  "stale_generation",
  "acceptance_unknown",
);
const BeginRejectionSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("begin_rejected"),
  instruction: StartInstructionSchema,
  reason: BeginRejectionReasonSchema,
});
const DeliveryGenerationUpdateSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("delivery_generation_update"),
  dispatcherId: IdentifierSchema,
  deliveryGeneration: Schema.Number,
});
const GenerationUpdatedSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("generation_updated"),
  deliveryGeneration: Schema.Number,
  acceptanceState: Schema.Literal("not_accepted", "accepted", "unknown"),
  acceptedInstruction: Schema.optional(StartInstructionSchema),
});
const CancellationRequestSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("cancel"),
  dispatcherId: Schema.optional(IdentifierSchema),
  deliveryGeneration: Schema.optional(Schema.Number),
});

const WorkerConfigSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  operationId: Schema.NonEmptyString,
  capability: CapabilitySchema,
  socketPath: Schema.NonEmptyString,
  promptPath: Schema.NonEmptyString,
  effectiveConfig: EffectiveWorkerConfigSchema,
});

export interface WorkerConfig {
  readonly operationId: string;
  readonly capability: string;
  readonly socketPath: string;
  readonly promptPath: string;
  readonly effectiveConfig: Readonly<EffectiveWorkerConfig>;
}

declare const resultAcceptanceProof: unique symbol;

export interface ResultAcceptanceProof {
  readonly operationId: string;
  readonly acceptanceId: `pions.result-acceptance.v1:${string}`;
  readonly manifestDigest: `sha256:${string}`;
  readonly eventSequenceNumber: number;
  readonly [resultAcceptanceProof]: true;
}

export interface StartInstruction extends StartInstructionReference {
  readonly deadline?: string;
}

export interface StartInstructionAcceptanceStore {
  load(): Readonly<StartInstruction> | "none" | "unknown";
  save(instruction: Readonly<StartInstruction>): boolean;
  loadGeneration(): number | "unknown";
  saveGeneration(deliveryGeneration: number): boolean;
}

export type BeginRejectionReason = Schema.Schema.Type<typeof BeginRejectionReasonSchema>;
export type StartAcceptanceState = "not_accepted" | "accepted" | "unknown";

export interface WorkerProtocolReception {
  readonly acknowledgementsComplete: boolean;
  readonly cancellationRequested?: true;
  readonly startInstructions: ReadonlyArray<Readonly<{
    readonly status: "accepted" | "duplicate" | BeginRejectionReason;
    readonly instruction: Readonly<StartInstruction>;
  }>>;
  readonly observedStartAcceptances: ReadonlyArray<Readonly<StartInstruction>>;
  readonly generationUpdate?: Readonly<{
    readonly deliveryGeneration: number;
    readonly acceptanceState: StartAcceptanceState;
    readonly acceptedInstruction?: Readonly<StartInstruction>;
  }>;
}

export type HostProtocolEvent =
  | {
      readonly type: "started";
      readonly processId: number;
      readonly processInstanceId: string;
      readonly processStartToken: string;
      readonly piSessionId: string;
      readonly observedConfig: Readonly<ObservedWorkerConfig>;
    }
  | {
      readonly type: "worker_configuration_failed";
      readonly reason: WorkerConfigurationFailureReason;
    }
  | {
      readonly type: "result_received";
      readonly result: Readonly<WorkerProducedResult>;
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | {
      readonly type: "worker_failed";
      readonly errorMessage: string;
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | {
      readonly type: "start_instruction_accepted";
      readonly instruction: Readonly<StartInstruction>;
    }
  | {
      readonly type: "start_instruction_rejected";
      readonly instruction: Readonly<StartInstruction>;
      readonly reason: BeginRejectionReason;
    }
  | {
      readonly type: "start_instruction_acknowledged";
      readonly instruction: Readonly<StartInstruction>;
    }
  | {
      readonly type: "delivery_generation_updated";
      readonly deliveryGeneration: number;
      readonly acceptanceState: StartAcceptanceState;
      readonly acceptedInstruction?: Readonly<StartInstruction>;
    }
  | { readonly type: "worker_cancelled" };

export type WorkerProtocolEvent =
  | {
      readonly type: "hello";
      readonly processId: number;
      readonly processInstanceId: string;
      readonly processStartToken: string;
    }
  | {
      readonly type: "started";
      readonly piSessionId: string;
      readonly observedConfig: Readonly<ObservedWorkerConfig>;
    }
  | {
      readonly type: "configuration_failed";
      readonly reason: WorkerConfigurationFailureReason;
    }
  | {
      readonly type: "artifacts";
      readonly result: Readonly<WorkerProducedResult>;
    }
  | ({ readonly type: "done" } & Readonly<AgentRunEvidence>)
  | ({ readonly type: "failed"; readonly errorMessage: string } & Readonly<AgentRunEvidence>)
  | { readonly type: "begin_accepted"; readonly instruction: Readonly<StartInstruction> }
  | { readonly type: "begin_ack"; readonly instruction: Readonly<StartInstruction> }
  | {
      readonly type: "begin_rejected";
      readonly instruction: Readonly<StartInstruction>;
      readonly reason: BeginRejectionReason;
    }
  | {
      readonly type: "generation_updated";
      readonly deliveryGeneration: number;
      readonly acceptanceState: StartAcceptanceState;
      readonly acceptedInstruction?: Readonly<StartInstruction>;
    }
  | { readonly type: "cancelled" };

function violation(
  reason: ProtocolViolationReason,
  message: string,
): ProtocolViolation {
  return new ProtocolViolation(reason, message);
}

function validateProtocolVersion(value: unknown, subject: string): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "protocolVersion" in value &&
    typeof value.protocolVersion === "number" &&
    value.protocolVersion !== WORKER_PROTOCOL_VERSION
  ) {
    throw violation("version_mismatch", `${subject} version does not match`);
  }
}

function parseFrame(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw violation("invalid_frame", "Worker protocol frame is not valid JSON");
  }
}

function decodeShape<Decoded>(
  schema: Schema.Schema<Decoded>,
  value: unknown,
  message: string,
): Decoded {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw violation("invalid_frame", message);
  }
}

function validateSafePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw violation("invalid_frame", `${field} must be a positive safe integer`);
  }
}

function validateStartInstruction(instruction: Readonly<StartInstruction>): void {
  validateSafePositiveInteger(instruction.deliveryGeneration, "deliveryGeneration");
  if (instruction.deadline !== undefined && !Number.isFinite(Date.parse(instruction.deadline))) {
    throw violation("invalid_frame", "Start instruction deadline must be absolute");
  }
}

export function decodeStartInstruction(value: unknown): StartInstruction {
  const instruction = decodeShape(
    StartInstructionSchema,
    value,
    "Stored Start instruction has an invalid shape",
  ) as StartInstruction;
  validateStartInstruction(instruction);
  return instruction;
}

function encode(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function sameSecret(expectedValue: string, actualValue: string): boolean {
  const expected = Buffer.from(expectedValue, "utf8");
  const actual = Buffer.from(actualValue, "utf8");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function completeLimits(overrides?: Partial<ProtocolLimits>): ProtocolLimits {
  const limits = { ...DEFAULT_PROTOCOL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Worker protocol limit ${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

class ArtifactBudget {
  private bytes = 0;
  private deliveries = 0;

  constructor(private readonly limits: ProtocolLimits) {}

  check(bodyBytes: number): number {
    if (bodyBytes > this.limits.artifactBytes) {
      throw violation("artifact_too_large", "Artifact exceeds its size limit");
    }
    if (this.bytes + bodyBytes > this.limits.sessionArtifactBytes) {
      throw violation("session_artifact_too_large", "Artifact transfer exceeds its session size limit");
    }
    if (this.deliveries + 1 > this.limits.artifacts) {
      throw violation("too_many_artifacts", "Artifact transfer exceeds its count limit");
    }
    return bodyBytes;
  }

  commit(bodyBytes: number): void {
    this.bytes += bodyBytes;
    this.deliveries += 1;
  }

  accept(bodyBytes: number): void {
    this.commit(this.check(bodyBytes));
  }
}

abstract class FramedPeer {
  private buffered = Buffer.alloc(0);

  protected constructor(protected readonly limits: ProtocolLimits) {}

  protected encodeFrame(value: unknown, firstFrame = false): Buffer {
    const bytes = encode(value);
    const limit = firstFrame ? this.limits.firstFrameBytes : this.limits.frameBytes;
    if (bytes.byteLength - 1 > limit) {
      throw violation("frame_too_large", "Worker protocol frame exceeds its size limit");
    }
    return bytes;
  }

  protected acceptBytes(
    bytes: Buffer,
    firstFrame: boolean,
    acceptFrame: (frame: Buffer) => void,
  ): void {
    let offset = 0;
    let first = firstFrame;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.byteLength : newline;
      const fragment = bytes.subarray(offset, end);
      const limit = first ? this.limits.firstFrameBytes : this.limits.frameBytes;
      if (this.buffered.byteLength + fragment.byteLength > limit) {
        throw violation("frame_too_large", "Worker protocol frame exceeds its size limit");
      }
      if (newline < 0) {
        this.buffered = this.buffered.byteLength === 0
          ? Buffer.from(fragment)
          : Buffer.concat([this.buffered, fragment]);
        return;
      }
      const frame = this.buffered.byteLength === 0
        ? fragment
        : Buffer.concat([this.buffered, fragment]);
      this.buffered = Buffer.alloc(0);
      acceptFrame(frame);
      first = false;
      offset = newline + 1;
    }
  }

  protected requireFrameBoundary(): void {
    if (this.buffered.byteLength !== 0) {
      throw violation("invalid_frame", "Worker protocol ended with an incomplete frame");
    }
  }
}

export class HostProtocolPeer extends FramedPeer {
  private state:
    | "awaiting_hello"
    | "awaiting_started"
    | "awaiting_begin"
    | "receiving_results"
    | "cancelling"
    | "done"
    | "failed" = "awaiting_hello";
  private lastSequenceNumber = 0;
  private hostSequenceNumber = 1;
  private processId = 0;
  private processInstanceId = "";
  private processStartToken = "";
  private readonly artifactBudget: ArtifactBudget;
  private bodyArtifact?: WorkerProducedResult["body"];
  private readonly workProducts: Array<WorkerProducedResult["workProducts"][number]> = [];
  private currentArtifact: {
    readonly acceptanceRequestId: string;
    readonly slot: "body" | "work_product";
    readonly key?: string;
    readonly index?: number;
    readonly formatId: string;
    readonly normalizationId: string;
    readonly expectedByteCount: number;
    readonly expectedDigest: `sha256:${string}`;
    readonly chunks: Array<Buffer>;
    receivedByteCount: number;
  } | undefined;
  private acceptanceRequestId?: string;
  private acknowledgementPending = false;
  private acknowledgedProof?: Readonly<ResultAcceptanceProof>;
  private startInstruction?: Readonly<StartInstruction>;
  private acceptedStartInstruction?: Readonly<StartInstruction>;
  private pendingStartAcceptanceObservations = 0;
  private pendingStartAcknowledgements = 0;
  private activeDispatcherId?: string;
  private pendingDeliveryGeneration: number | undefined;
  private confirmedDeliveryGeneration = 1;
  private confirmedStartAcceptanceState: StartAcceptanceState | undefined;

  constructor(
    private readonly authority: Readonly<ProtocolAuthority>,
    limits?: Partial<ProtocolLimits>,
  ) {
    const resolvedLimits = completeLimits(limits);
    super(resolvedLimits);
    this.artifactBudget = new ArtifactBudget(resolvedLimits);
  }

  receive(bytes: Buffer): ReadonlyArray<HostProtocolEvent> {
    const events: Array<HostProtocolEvent> = [];
    try {
      if (this.state === "failed" || this.state === "done") {
        throw violation("invalid_transition", "Worker protocol session is already terminal");
      }
      this.acceptBytes(bytes, this.state === "awaiting_hello", (frame) => {
        const event = this.acceptFrame(frame);
        if (event !== undefined) events.push(event);
      });
      this.requireTerminalFrameBoundary();
      return events;
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  disconnect(): void {
    if (this.state !== "done") {
      this.state = "failed";
      throw violation(
        "incomplete_session",
        "Worker protocol disconnected before delivering a Result",
      );
    }
  }

  begin(instruction: Readonly<StartInstruction>): Buffer {
    if (this.activeDispatcherId !== undefined && instruction.dispatcherId !== this.activeDispatcherId) {
      throw violation("authority_mismatch", "Dispatcher does not hold Start delivery authority");
    }
    if (this.state !== "awaiting_begin" && this.state !== "receiving_results") {
      throw violation("invalid_transition", "Worker execution cannot begin before identification");
    }
    if (this.startInstruction !== undefined && !isDeepStrictEqual(this.startInstruction, instruction)) {
      throw violation("invalid_transition", "A different Start instruction cannot replace the dispatched instruction");
    }
    validateStartInstruction(instruction);
    this.activeDispatcherId ??= instruction.dispatcherId;
    this.startInstruction = { ...instruction };
    const bytes = this.encodeHostFrame("begin", { instruction });
    this.state = "receiving_results";
    return bytes;
  }

  restoreStartDelivery(instruction: Readonly<StartInstruction>): void {
    if (this.state !== "awaiting_hello" || this.startInstruction !== undefined) {
      throw violation("invalid_transition", "Start delivery can only be restored before Worker reconnection");
    }
    validateStartInstruction(instruction);
    this.startInstruction = { ...instruction };
    this.activeDispatcherId = instruction.dispatcherId;
    this.confirmedDeliveryGeneration = instruction.deliveryGeneration;
  }

  completeDispatcherHandoff(nextDispatcherId: string): void {
    if (
      nextDispatcherId.length === 0 ||
      this.pendingDeliveryGeneration !== undefined ||
      this.confirmedDeliveryGeneration <= 1
    ) {
      throw violation(
        "invalid_transition",
        "Dispatcher handoff requires Worker generation confirmation",
      );
    }
    this.activeDispatcherId = nextDispatcherId;
    if (this.confirmedStartAcceptanceState === "not_accepted") {
      delete this.startInstruction;
      delete this.acceptedStartInstruction;
      this.state = "awaiting_begin";
    }
  }

  acknowledgeStartInstructionAcceptance(instruction: Readonly<StartInstruction>): Buffer {
    if (
      this.acceptedStartInstruction === undefined ||
      !isDeepStrictEqual(instruction, this.acceptedStartInstruction) ||
      this.pendingStartAcceptanceObservations === 0
    ) {
      throw violation("invalid_transition", "Start acceptance cannot be acknowledged before observation");
    }
    this.pendingStartAcceptanceObservations -= 1;
    this.pendingStartAcknowledgements += 1;
    return this.encodeHostFrame("begin_acceptance_observed", { instruction });
  }

  updateDeliveryGeneration(deliveryGeneration: number, dispatcherId: string): Buffer {
    validateSafePositiveInteger(deliveryGeneration, "deliveryGeneration");
    if (deliveryGeneration <= this.confirmedDeliveryGeneration || this.pendingDeliveryGeneration !== undefined) {
      throw violation("invalid_transition", "A newer delivery generation is already confirmed or pending");
    }
    if (dispatcherId.length === 0) {
      throw violation("invalid_frame", "Successor Dispatcher identity is required");
    }
    this.pendingDeliveryGeneration = deliveryGeneration;
    return this.encodeHostFrame("delivery_generation_update", { dispatcherId, deliveryGeneration });
  }

  requestCancellation(): Buffer | undefined {
    if (
      this.state === "awaiting_hello" ||
      this.state === "cancelling" ||
      this.state === "failed" ||
      this.state === "done"
    ) return undefined;
    const bytes = this.encodeHostFrame("cancel", {
      ...(this.activeDispatcherId === undefined
        ? {}
        : {
            dispatcherId: this.activeDispatcherId,
            deliveryGeneration: this.confirmedDeliveryGeneration,
          }),
    });
    this.state = "cancelling";
    return bytes;
  }

  acknowledgeResult(acceptance: Readonly<ResultAcceptanceProof>): {
    readonly bytes: Buffer;
    readonly complete: boolean;
  } {
    if (this.state !== "done") {
      throw violation("invalid_transition", "Result cannot be acknowledged before reception completes");
    }
    if (acceptance.operationId !== this.authority.operationId) {
      throw violation("unexpected_acknowledgement", "Result acceptance belongs to another Operation");
    }
    if (!this.acknowledgementPending && (
      this.acknowledgedProof?.acceptanceId !== acceptance.acceptanceId ||
      this.acknowledgedProof.manifestDigest !== acceptance.manifestDigest ||
      this.acknowledgedProof.eventSequenceNumber !== acceptance.eventSequenceNumber
    )) {
      throw violation(
        "unexpected_acknowledgement",
        "Result acknowledgement does not match a received delivery",
      );
    }
    const bytes = this.encodeFrame({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operationId: this.authority.operationId,
      acceptanceId: acceptance.acceptanceId,
      manifestDigest: acceptance.manifestDigest,
      eventSequenceNumber: acceptance.eventSequenceNumber,
      type: "ack",
    });
    this.acknowledgementPending = false;
    this.acknowledgedProof = acceptance;
    return { bytes, complete: true };
  }

  private encodeHostFrame(
    type: "begin" | "begin_acceptance_observed" | "cancel" | "delivery_generation_update",
    fields: Readonly<Record<string, unknown>> = {},
  ): Buffer {
    const bytes = this.encodeFrame({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operationId: this.authority.operationId,
      capability: this.authority.capability,
      sequenceNumber: this.hostSequenceNumber,
      type,
      ...fields,
    });
    this.hostSequenceNumber += 1;
    return bytes;
  }

  private requireTerminalFrameBoundary(): void {
    if (this.state === "done") this.requireFrameBoundary();
  }

  private acceptFrame(bytes: Buffer): HostProtocolEvent | undefined {
    if (this.state === "done") {
      throw violation("invalid_transition", "Worker protocol sent a frame after completion");
    }
    const value = parseFrame(bytes);
    validateProtocolVersion(value, "Worker protocol");
    const object = value as { readonly type?: unknown };

    if (this.state === "awaiting_hello") {
      const hello = decodeShape(
        HelloSchema,
        value,
        "Worker protocol frame has an invalid shape",
      );
      this.validateCommon(hello, true);
      this.state = "awaiting_started";
      return undefined;
    }
    if (object.type === "started") {
      const started = decodeShape(
        StartedSchema,
        value,
        "Worker protocol frame has an invalid shape",
      );
      this.validateCommon(started);
      if (this.state !== "awaiting_started") {
        throw violation("invalid_transition", "Worker started more than once");
      }
      this.state = "awaiting_begin";
      return {
        type: "started",
        processId: this.processId,
        processInstanceId: this.processInstanceId,
        processStartToken: this.processStartToken,
        piSessionId: started.piSessionId,
        observedConfig: started.observedConfig as ObservedWorkerConfig,
      };
    }
    if (object.type === "configuration_failed") {
      const failed = decodeShape(
        ConfigurationFailedSchema,
        value,
        "Worker configuration failure frame has an invalid shape",
      );
      this.validateCommon(failed);
      if (this.state !== "awaiting_started") {
        throw violation("invalid_transition", "Configuration failure arrived after Worker start");
      }
      this.state = "done";
      return { type: "worker_configuration_failed", reason: failed.reason };
    }
    if (object.type === "cancelled") {
      const cancelled = decodeShape(
        CancelledSchema,
        value,
        "Worker cancellation frame has an invalid shape",
      );
      this.validateCommon(cancelled);
      if (this.state !== "cancelling") {
        throw violation("invalid_transition", "Worker cancellation arrived without a host request");
      }
      this.state = "done";
      return { type: "worker_cancelled" };
    }
    if (object.type === "generation_updated") {
      const acknowledgement = decodeShape(
        GenerationUpdatedSchema,
        value,
        "Worker generation acknowledgement has an invalid shape",
      );
      this.validateCommon(acknowledgement);
      validateSafePositiveInteger(acknowledgement.deliveryGeneration, "deliveryGeneration");
      if (
        acknowledgement.deliveryGeneration !== this.pendingDeliveryGeneration ||
        (acknowledgement.acceptanceState === "accepted") !==
          (acknowledgement.acceptedInstruction !== undefined) ||
        acknowledgement.acceptedInstruction !== undefined &&
          this.startInstruction !== undefined &&
          !isDeepStrictEqual(acknowledgement.acceptedInstruction, this.startInstruction)
      ) {
        throw violation("unexpected_acknowledgement", "Worker generation acknowledgement is inconsistent");
      }
      this.confirmedDeliveryGeneration = acknowledgement.deliveryGeneration;
      this.confirmedStartAcceptanceState = acknowledgement.acceptanceState;
      this.pendingDeliveryGeneration = undefined;
      if (acknowledgement.acceptanceState === "accepted") {
        this.state = "receiving_results";
      }
      return {
        type: "delivery_generation_updated",
        deliveryGeneration: acknowledgement.deliveryGeneration,
        acceptanceState: acknowledgement.acceptanceState,
        ...(acknowledgement.acceptedInstruction === undefined
          ? {}
          : { acceptedInstruction: { ...acknowledgement.acceptedInstruction } as StartInstruction }),
      };
    }
    if (object.type === "begin_rejected") {
      const rejection = decodeShape(
        BeginRejectionSchema,
        value,
        "Worker begin rejection has an invalid shape",
      );
      this.validateCommon(rejection);
      if (
        this.state !== "receiving_results" ||
        this.startInstruction === undefined ||
        !isDeepStrictEqual(rejection.instruction, this.startInstruction)
      ) {
        throw violation("unexpected_acknowledgement", "Begin rejection does not match the dispatched instruction");
      }
      return {
        type: "start_instruction_rejected",
        instruction: { ...rejection.instruction } as StartInstruction,
        reason: rejection.reason,
      };
    }
    if (object.type === "begin_accepted") {
      const acceptance = decodeShape(
        BeginAcceptanceSchema,
        value,
        "Worker begin acceptance has an invalid shape",
      );
      this.validateCommon(acceptance);
      if (
        this.state !== "receiving_results" ||
        this.startInstruction === undefined ||
        !isDeepStrictEqual(acceptance.instruction, this.startInstruction)
      ) {
        throw violation("unexpected_acknowledgement", "Begin acceptance does not match the dispatched instruction");
      }
      this.acceptedStartInstruction = { ...acceptance.instruction } as StartInstruction;
      this.pendingStartAcceptanceObservations += 1;
      return {
        type: "start_instruction_accepted",
        instruction: this.acceptedStartInstruction,
      };
    }
    if (object.type === "begin_ack") {
      const acknowledgement = decodeShape(
        BeginAcknowledgementSchema,
        value,
        "Worker begin acknowledgement has an invalid shape",
      );
      this.validateCommon(acknowledgement);
      if (
        this.state !== "receiving_results" ||
        this.acceptedStartInstruction === undefined ||
        this.pendingStartAcknowledgements === 0 ||
        !isDeepStrictEqual(acknowledgement.instruction, this.acceptedStartInstruction)
      ) {
        throw violation("unexpected_acknowledgement", "Begin acknowledgement does not match the accepted instruction");
      }
      this.pendingStartAcknowledgements -= 1;
      return {
        type: "start_instruction_acknowledged",
        instruction: { ...acknowledgement.instruction } as StartInstruction,
      };
    }
    if (object.type === "artifact_begin") {
      const begin = decodeShape(ArtifactBeginSchema, value, "Artifact begin frame has an invalid shape");
      this.validateCommon(begin);
      if (this.state !== "receiving_results" || this.currentArtifact !== undefined) {
        throw violation("invalid_transition", "Artifact began outside result reception");
      }
      if (!Number.isSafeInteger(begin.expectedByteCount) || begin.expectedByteCount < 0 ||
          begin.slot === "body" && (begin.key !== undefined || begin.index !== undefined) ||
          begin.slot === "work_product" && (
            begin.key === undefined || begin.key.length === 0 ||
            !Number.isSafeInteger(begin.index) || begin.index !== this.workProducts.length
          )) {
        throw violation("invalid_frame", "Artifact slot is invalid");
      }
      if (this.acceptanceRequestId !== undefined && this.acceptanceRequestId !== begin.acceptanceRequestId) {
        throw violation("invalid_transition", "Acceptance request changed during transfer");
      }
      this.artifactBudget.check(begin.expectedByteCount);
      this.acceptanceRequestId = begin.acceptanceRequestId;
      this.currentArtifact = {
        acceptanceRequestId: begin.acceptanceRequestId,
        slot: begin.slot,
        ...(begin.key === undefined ? {} : { key: begin.key }),
        ...(begin.index === undefined ? {} : { index: begin.index }),
        formatId: begin.formatId,
        normalizationId: begin.normalizationId,
        expectedByteCount: begin.expectedByteCount,
        expectedDigest: begin.expectedDigest as `sha256:${string}`,
        chunks: [],
        receivedByteCount: 0,
      };
      return undefined;
    }
    if (object.type === "artifact_chunk") {
      const chunk = decodeShape(ArtifactChunkSchema, value, "Artifact chunk frame has an invalid shape");
      this.validateCommon(chunk);
      if (this.state !== "receiving_results" || this.currentArtifact === undefined ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(chunk.payload)) {
        throw violation("invalid_transition", "Artifact chunk arrived without an active artifact");
      }
      const chunkBytes = Buffer.from(chunk.payload, "base64");
      this.currentArtifact.receivedByteCount += chunkBytes.byteLength;
      if (this.currentArtifact.receivedByteCount > this.currentArtifact.expectedByteCount) {
        throw violation("artifact_too_large", "Artifact chunks exceed the declared size");
      }
      this.currentArtifact.chunks.push(chunkBytes);
      return undefined;
    }
    if (object.type === "artifact_commit") {
      const commit = decodeShape(ArtifactCommitSchema, value, "Artifact commit frame has an invalid shape");
      this.validateCommon(commit);
      const artifact = this.currentArtifact;
      if (this.state !== "receiving_results" || artifact === undefined || commit.expectedDigest !== artifact.expectedDigest) {
        throw violation("invalid_transition", "Artifact commit does not match an active artifact");
      }
      const bytes = Buffer.concat(artifact.chunks);
      if (bytes.byteLength !== artifact.expectedByteCount || sha256Digest(bytes) !== artifact.expectedDigest) {
        throw violation("digest_mismatch", "Artifact bytes do not match their declaration");
      }
      this.artifactBudget.accept(bytes.byteLength);
      const produced = {
        formatId: artifact.formatId,
        normalizationId: artifact.normalizationId,
        expectedByteCount: artifact.expectedByteCount,
        expectedDigest: artifact.expectedDigest,
        bytes,
      };
      if (artifact.slot === "body") {
        if (this.bodyArtifact !== undefined) throw violation("invalid_transition", "Result body was sent more than once");
        this.bodyArtifact = produced;
      } else {
        if (artifact.key === undefined) {
          throw violation("invalid_frame", "Work product key is missing");
        }
        this.workProducts.push({ ...produced, key: artifact.key });
      }
      this.currentArtifact = undefined;
      return undefined;
    }
    if (object.type === "result_manifest") {
      const manifest = decodeShape(ResultManifestSchema, value, "Result manifest frame has an invalid shape");
      this.validateCommon(manifest);
      if (this.state !== "receiving_results" || this.currentArtifact !== undefined || this.bodyArtifact === undefined ||
          manifest.acceptanceRequestId !== this.acceptanceRequestId) {
        throw violation("invalid_transition", "Result manifest arrived before all artifacts");
      }
      this.acknowledgementPending = true;
      return undefined;
    }
    if (object.type === "failed") {
      const failed = decodeShape(
        FailedSchema,
        value,
        "Worker protocol frame has an invalid shape",
      );
      this.validateCommon(failed);
      if (this.state !== "receiving_results" || this.bodyArtifact !== undefined) {
        throw violation("invalid_transition", "Worker failure arrived outside an active Pi run");
      }
      this.state = "done";
      return {
        type: "worker_failed",
        errorMessage: failed.errorMessage,
        evidence: {
          usage: { ...failed.usage },
          toolUses: failed.toolUses.map((toolUse) => ({ ...toolUse })),
        },
      };
    }
    if (object.type === "done") {
      const done = decodeShape(
        DoneSchema,
        value,
        "Worker protocol frame has an invalid shape",
      );
      this.validateCommon(done);
      if (this.state !== "receiving_results" || this.bodyArtifact === undefined ||
          this.acceptanceRequestId === undefined || !this.acknowledgementPending) {
        throw violation("invalid_transition", "Worker finished without a Result manifest");
      }
      this.state = "done";
      return {
        type: "result_received",
        result: {
          acceptanceRequestId: this.acceptanceRequestId,
          body: this.bodyArtifact,
          workProducts: [...this.workProducts],
        },
        evidence: {
          usage: { ...done.usage },
          toolUses: done.toolUses.map((toolUse) => ({ ...toolUse })),
        },
      };
    }
    throw violation("invalid_frame", "Unknown worker protocol frame type");
  }

  private validateCommon(
    frame: {
      readonly operationId: string;
      readonly capability: string;
      readonly sequenceNumber: number;
      readonly processId?: number;
      readonly processInstanceId?: string;
      readonly processStartToken?: string;
    },
    hello = false,
  ): void {
    if (
      frame.operationId !== this.authority.operationId ||
      !sameSecret(this.authority.capability, frame.capability)
    ) {
      throw violation("authority_mismatch", "Worker protocol authority does not match the Operation");
    }
    validateSafePositiveInteger(frame.sequenceNumber, "sequenceNumber");
    if (frame.sequenceNumber !== this.lastSequenceNumber + 1) {
      throw violation("sequence_mismatch", "Worker protocol sequence is stale or out of order");
    }
    this.lastSequenceNumber = frame.sequenceNumber;
    if (hello) {
      if (!Number.isSafeInteger(frame.processId) || (frame.processId ?? 0) < 1) {
        throw violation("invalid_frame", "processId must be a positive safe integer");
      }
      this.processId = frame.processId ?? 0;
      this.processInstanceId = frame.processInstanceId ?? "";
      this.processStartToken = frame.processStartToken ?? "";
    }
  }
}

export class WorkerProtocolPeer extends FramedPeer {
  private state:
    | "new"
    | "identified"
    | "ready"
    | "running"
    | "delivering"
    | "cancelling"
    | "done"
    | "acknowledged"
    | "failed" = "new";
  private sequenceNumber = 1;
  private lastHostSequenceNumber = 0;
  private readonly artifactBudget: ArtifactBudget;
  private acknowledgementPending = false;
  private processInstanceId?: string;
  private deliveryGeneration = 1;
  private deliveryDispatcherId: string | undefined;
  private acceptedStartInstruction?: Readonly<StartInstruction>;
  private acknowledgedEvidence?: {
    readonly acceptanceId: string;
    readonly manifestDigest: string;
    readonly eventSequenceNumber: number;
  };

  constructor(
    private readonly authority: Readonly<ProtocolAuthority>,
    private readonly startAcceptanceStore: Readonly<StartInstructionAcceptanceStore>,
    limits?: Partial<ProtocolLimits>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    const resolvedLimits = completeLimits(limits);
    super(resolvedLimits);
    this.artifactBudget = new ArtifactBudget(resolvedLimits);
  }

  send(event: WorkerProtocolEvent): Buffer {
    switch (event.type) {
      case "hello": {
        if (this.state !== "new") return this.invalidSend(event.type);
        if (!Number.isSafeInteger(event.processId) || event.processId < 1) {
          throw violation("invalid_frame", "processId must be a positive safe integer");
        }
        if (!/^[0-9a-f]{64}$/u.test(event.processInstanceId)) {
          throw violation("invalid_frame", "processInstanceId has an invalid shape");
        }
        if (event.processStartToken.length === 0) {
          throw violation("invalid_frame", "processStartToken must not be empty");
        }
        const bytes = this.encodeWorkerFrame({
          type: "hello",
          processId: event.processId,
          processInstanceId: event.processInstanceId,
          processStartToken: event.processStartToken,
        });
        this.processInstanceId = event.processInstanceId;
        this.state = "identified";
        return bytes;
      }
      case "started": {
        if (this.state !== "identified") return this.invalidSend(event.type);
        if (event.piSessionId.length === 0) {
          throw violation("invalid_frame", "piSessionId must not be empty");
        }
        const bytes = this.encodeWorkerFrame({
          type: "started",
          piSessionId: event.piSessionId,
          observedConfig: event.observedConfig,
        });
        this.state = "ready";
        return bytes;
      }
      case "configuration_failed": {
        if (this.state !== "identified") return this.invalidSend(event.type);
        const bytes = this.encodeWorkerFrame({
          type: "configuration_failed",
          reason: event.reason,
        });
        this.state = "done";
        return bytes;
      }
      case "generation_updated": {
        if (event.deliveryGeneration !== this.deliveryGeneration ||
            (event.acceptanceState === "accepted") !== (event.acceptedInstruction !== undefined) ||
            event.acceptedInstruction !== undefined &&
              !isDeepStrictEqual(event.acceptedInstruction, this.acceptedStartInstruction)) {
          return this.invalidSend(event.type);
        }
        return this.encodeWorkerFrame({
          type: "generation_updated",
          deliveryGeneration: event.deliveryGeneration,
          acceptanceState: event.acceptanceState,
          ...(event.acceptedInstruction === undefined
            ? {}
            : { acceptedInstruction: event.acceptedInstruction }),
        });
      }
      case "begin_accepted": {
        if (this.state !== "running" ||
            this.acceptedStartInstruction === undefined ||
            !isDeepStrictEqual(event.instruction, this.acceptedStartInstruction)) {
          return this.invalidSend(event.type);
        }
        return this.encodeWorkerFrame({ type: "begin_accepted", instruction: event.instruction });
      }
      case "begin_ack": {
        if (this.state !== "running" ||
            this.acceptedStartInstruction === undefined ||
            !isDeepStrictEqual(event.instruction, this.acceptedStartInstruction)) {
          return this.invalidSend(event.type);
        }
        return this.encodeWorkerFrame({ type: "begin_ack", instruction: event.instruction });
      }
      case "begin_rejected": {
        if (this.state !== "ready" && this.state !== "running") {
          return this.invalidSend(event.type);
        }
        return this.encodeWorkerFrame({
          type: "begin_rejected",
          instruction: event.instruction,
          reason: event.reason,
        });
      }
      case "artifacts": {
        if (this.state !== "running") return this.invalidSend(event.type);
        if (Symbol.asyncIterator in Object(event.result.body.bytes) ||
            event.result.workProducts.some((entry) => Symbol.asyncIterator in Object(entry.bytes))) {
          throw violation("invalid_frame", "Worker protocol artifacts must be finite byte arrays");
        }
        const frames: Array<Buffer> = [];
        const append = (
          artifact: WorkerProducedResult["body"],
          slot: "body" | "work_product",
          key?: string,
          index?: number,
        ) => {
          const bytes = Buffer.from(artifact.bytes as Uint8Array);
          this.artifactBudget.accept(bytes.byteLength);
          frames.push(this.encodeWorkerFrame({
            type: "artifact_begin",
            acceptanceRequestId: event.result.acceptanceRequestId,
            slot,
            ...(key === undefined ? {} : { key }),
            ...(index === undefined ? {} : { index }),
            formatId: artifact.formatId,
            normalizationId: artifact.normalizationId,
            expectedByteCount: artifact.expectedByteCount,
            expectedDigest: artifact.expectedDigest,
          }));
          const maxChunk = Math.max(1, Math.floor(this.limits.frameBytes / 2));
          for (let offset = 0; offset < bytes.byteLength; offset += maxChunk) {
            frames.push(this.encodeWorkerFrame({
              type: "artifact_chunk",
              payload: bytes.subarray(offset, offset + maxChunk).toString("base64"),
            }));
          }
          frames.push(this.encodeWorkerFrame({
            type: "artifact_commit",
            expectedDigest: artifact.expectedDigest,
          }));
        };
        append(event.result.body, "body");
        event.result.workProducts.forEach((artifact, index) => append(artifact, "work_product", artifact.key, index));
        frames.push(this.encodeWorkerFrame({
          type: "result_manifest",
          acceptanceRequestId: event.result.acceptanceRequestId,
        }));
        this.acknowledgementPending = true;
        this.state = "delivering";
        return Buffer.concat(frames);
      }
      case "failed": {
        if (this.state !== "running") return this.invalidSend(event.type);
        const bytes = this.encodeWorkerFrame({
          type: "failed",
          errorMessage: event.errorMessage,
          usage: event.usage,
          toolUses: event.toolUses,
        });
        this.state = "done";
        return bytes;
      }
      case "done": {
        if (this.state !== "delivering") return this.invalidSend(event.type);
        const bytes = this.encodeWorkerFrame({
          type: "done",
          usage: event.usage,
          toolUses: event.toolUses,
        });
        this.state = "done";
        return bytes;
      }
      case "cancelled": {
        if (this.state !== "cancelling") return this.invalidSend(event.type);
        const bytes = this.encodeWorkerFrame({ type: "cancelled" });
        this.state = "done";
        return bytes;
      }
    }
  }

  receive(bytes: Buffer): WorkerProtocolReception {
    try {
      const startInstructions: Array<WorkerProtocolReception["startInstructions"][number]> = [];
      const observedStartAcceptances: Array<Readonly<StartInstruction>> = [];
      let generationUpdate: WorkerProtocolReception["generationUpdate"];
      let cancellationRequested = false;
      this.acceptBytes(bytes, false, (frameBytes) => {
        const value = parseFrame(frameBytes);
        validateProtocolVersion(value, "Worker protocol");
        const object = value as { readonly type?: unknown };
        if (object.type === "begin") {
          const begin = decodeShape(
            BeginRequestSchema,
            value,
            "Worker begin request has an invalid shape",
          );
          this.validateHostControl(begin, "Begin");
          validateStartInstruction(begin.instruction as StartInstruction);
          const received = { ...begin.instruction } as StartInstruction;
          const durableGeneration = this.startAcceptanceStore.loadGeneration();
          if (durableGeneration === "unknown") {
            startInstructions.push({ status: "acceptance_unknown", instruction: received });
            return;
          }
          this.deliveryGeneration = durableGeneration;
          if (received.workerProcessInstanceId !== this.processInstanceId) {
            startInstructions.push({ status: "worker_mismatch", instruction: received });
            return;
          }
          if (
            received.deliveryGeneration !== this.deliveryGeneration ||
            this.deliveryDispatcherId !== undefined &&
              received.dispatcherId !== this.deliveryDispatcherId
          ) {
            startInstructions.push({ status: "stale_generation", instruction: received });
            return;
          }
          if (this.acceptedStartInstruction !== undefined) {
            startInstructions.push({
              status: isDeepStrictEqual(received, this.acceptedStartInstruction)
                ? "duplicate"
                : "conflict",
              instruction: received,
            });
            return;
          }
          const storedAcceptance = this.restoreDurableStartAcceptance();
          if (storedAcceptance === "unknown") {
            startInstructions.push({ status: "acceptance_unknown", instruction: received });
            return;
          }
          if (storedAcceptance !== "none") {
            startInstructions.push({
              status: isDeepStrictEqual(received, storedAcceptance) ? "duplicate" : "conflict",
              instruction: received,
            });
            return;
          }
          if (this.state !== "ready") {
            throw violation("invalid_transition", "Begin arrived before Worker start");
          }
          if (
            received.deadline !== undefined &&
            Date.parse(this.now()) >= Date.parse(received.deadline)
          ) {
            startInstructions.push({ status: "expired", instruction: received });
            return;
          }
          if (!this.startAcceptanceStore.save(received)) {
            startInstructions.push({ status: "acceptance_unknown", instruction: received });
            return;
          }
          this.acceptedStartInstruction = received;
          this.deliveryDispatcherId = received.dispatcherId;
          this.state = "running";
          startInstructions.push({ status: "accepted", instruction: received });
          return;
        }
        if (object.type === "begin_acceptance_observed") {
          const observation = decodeShape(
            BeginAcceptanceObservedSchema,
            value,
            "Worker Start acceptance observation has an invalid shape",
          );
          this.validateHostControl(observation, "Start acceptance observation");
          validateStartInstruction(observation.instruction as StartInstruction);
          const durableAcceptance = this.acceptedStartInstruction ?? this.restoreDurableStartAcceptance();
          if (
            durableAcceptance === "none" ||
            durableAcceptance === "unknown" ||
            !isDeepStrictEqual(observation.instruction, durableAcceptance)
          ) {
            throw violation("unexpected_acknowledgement", "Observed Start acceptance does not match durable acceptance");
          }
          observedStartAcceptances.push({ ...durableAcceptance });
          return;
        }
        if (object.type === "delivery_generation_update") {
          const update = decodeShape(
            DeliveryGenerationUpdateSchema,
            value,
            "Worker delivery generation update has an invalid shape",
          );
          this.validateHostControl(update, "Delivery generation update");
          validateSafePositiveInteger(update.deliveryGeneration, "deliveryGeneration");
          if (this.state !== "ready" && this.state !== "running") {
            throw violation("invalid_transition", "Delivery generation changed before Worker identification");
          }
          const durableGeneration = this.startAcceptanceStore.loadGeneration();
          if (durableGeneration === "unknown") {
            throw violation("invalid_transition", "Durable delivery generation is unavailable");
          }
          this.deliveryGeneration = durableGeneration;
          if (update.deliveryGeneration <= this.deliveryGeneration) {
            throw violation("invalid_transition", "Delivery generation must increase");
          }
          let acceptanceState: StartAcceptanceState =
            this.acceptedStartInstruction === undefined ? "not_accepted" : "accepted";
          if (this.acceptedStartInstruction === undefined) {
            const storedAcceptance = this.restoreDurableStartAcceptance();
            acceptanceState = storedAcceptance === "unknown"
              ? "unknown"
              : storedAcceptance === "none"
                ? "not_accepted"
                : "accepted";
          }
          if (!this.startAcceptanceStore.saveGeneration(update.deliveryGeneration)) {
            throw violation("invalid_transition", "Delivery generation could not be durably updated");
          }
          this.deliveryGeneration = update.deliveryGeneration;
          this.deliveryDispatcherId = update.dispatcherId;
          generationUpdate = {
            deliveryGeneration: update.deliveryGeneration,
            acceptanceState,
            ...(this.acceptedStartInstruction === undefined
              ? {}
              : { acceptedInstruction: this.acceptedStartInstruction }),
          };
          return;
        }
        if (object.type === "cancel") {
          const cancellation = decodeShape(
            CancellationRequestSchema,
            value,
            "Worker cancellation request has an invalid shape",
          );
          this.validateHostControl(cancellation, "Cancellation");
          if (cancellation.deliveryGeneration !== undefined) {
            validateSafePositiveInteger(cancellation.deliveryGeneration, "deliveryGeneration");
          }
          if (
            this.deliveryDispatcherId !== undefined &&
            (cancellation.deliveryGeneration !== this.deliveryGeneration ||
              cancellation.dispatcherId !== this.deliveryDispatcherId)
          ) {
            throw violation("authority_mismatch", "Cancellation sender has no current Start delivery authority");
          }
          if (
            this.state !== "ready" &&
            this.state !== "running" &&
            this.state !== "delivering"
          ) {
            throw violation("invalid_transition", "Cancellation arrived outside an available Pi run");
          }
          this.state = "cancelling";
          cancellationRequested = true;
          return;
        }
        if (this.state !== "done" && this.state !== "acknowledged") {
          throw violation("invalid_transition", "Acknowledgement arrived outside the completed delivery state");
        }
        const acknowledgement = decodeShape(
          AcknowledgementSchema,
          value,
          "Worker protocol frame has an invalid shape",
        );
        if (acknowledgement.operationId !== this.authority.operationId) {
          throw violation("authority_mismatch", "Acknowledgement operation does not match");
        }
        validateSafePositiveInteger(
          acknowledgement.eventSequenceNumber,
          "eventSequenceNumber",
        );
        if (!this.acknowledgementPending) {
          if (
            this.acknowledgedEvidence?.acceptanceId === acknowledgement.acceptanceId &&
            this.acknowledgedEvidence.manifestDigest === acknowledgement.manifestDigest &&
            this.acknowledgedEvidence.eventSequenceNumber === acknowledgement.eventSequenceNumber
          ) return;
          throw violation("unexpected_acknowledgement", "Acknowledgement does not match a Result delivery");
        }
        this.acknowledgementPending = false;
        this.acknowledgedEvidence = acknowledgement;
      });
      const acknowledgementsComplete =
        this.state === "acknowledged" || this.state === "done" && !this.acknowledgementPending;
      if (this.state === "done" && acknowledgementsComplete) {
        this.requireFrameBoundary();
        this.state = "acknowledged";
      }
      return {
        acknowledgementsComplete,
        startInstructions,
        observedStartAcceptances,
        ...(generationUpdate === undefined ? {} : { generationUpdate }),
        ...(cancellationRequested ? { cancellationRequested: true as const } : {}),
      };
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  private restoreDurableStartAcceptance(): Readonly<StartInstruction> | "none" | "unknown" {
    const stored = this.startAcceptanceStore.load();
    if (stored === "none" || stored === "unknown") return stored;
    validateStartInstruction(stored);
    if (stored.workerProcessInstanceId !== this.processInstanceId) return "unknown";
    this.acceptedStartInstruction = { ...stored };
    this.deliveryDispatcherId = stored.dispatcherId;
    this.state = "running";
    return this.acceptedStartInstruction;
  }

  private validateHostControl(
    frame: {
      readonly operationId: string;
      readonly capability: string;
      readonly sequenceNumber: number;
    },
    subject: string,
  ): void {
    if (
      frame.operationId !== this.authority.operationId ||
      !sameSecret(this.authority.capability, frame.capability)
    ) {
      throw violation("authority_mismatch", `${subject} authority does not match the Operation`);
    }
    validateSafePositiveInteger(frame.sequenceNumber, "sequenceNumber");
    if (frame.sequenceNumber !== this.lastHostSequenceNumber + 1) {
      throw violation("sequence_mismatch", "Host protocol sequence is stale or out of order");
    }
    this.lastHostSequenceNumber = frame.sequenceNumber;
  }

  private encodeWorkerFrame(fields: Readonly<Record<string, unknown>>): Buffer {
    const sequenceNumber = this.sequenceNumber;
    const bytes = this.encodeFrame({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operationId: this.authority.operationId,
      capability: this.authority.capability,
      sequenceNumber,
      ...fields,
    }, sequenceNumber === 1);
    this.sequenceNumber += 1;
    return bytes;
  }

  private invalidSend(type: WorkerProtocolEvent["type"]): never {
    throw violation("invalid_transition", `Worker cannot send ${type} while ${this.state}`);
  }
}

export function encodeWorkerConfig(config: WorkerConfig): string {
  const wireConfig = decodeWorkerConfigValue({
    ...config,
    protocolVersion: WORKER_PROTOCOL_VERSION,
  });
  return `${JSON.stringify(wireConfig)}\n`;
}

export function decodeWorkerConfig(text: string): WorkerConfig {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw violation("invalid_frame", "Worker configuration is not valid JSON");
  }
  const decoded = decodeWorkerConfigValue(value);
  const { protocolVersion: _protocolVersion, ...config } = decoded;
  return config;
}

function decodeWorkerConfigValue(
  value: unknown,
): Schema.Schema.Type<typeof WorkerConfigSchema> {
  validateProtocolVersion(value, "Worker configuration");
  try {
    return Schema.decodeUnknownSync(WorkerConfigSchema)(value);
  } catch {
    throw violation("invalid_frame", "Worker configuration has an invalid shape");
  }
}
