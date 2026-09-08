import { createHash, timingSafeEqual } from "node:crypto";

import { Schema } from "effect";

import type {
  EffectiveWorkerConfig,
  ObservedWorkerConfig,
  WorkerConfigurationFailureReason,
  WorkerProducedResult,
} from "../public.js";
import type { AgentRunEvidence } from "./services.js";
import {
  EffectiveWorkerConfigSchema,
  ObservedWorkerConfigSchema,
} from "./worker-configuration.js";

export const WORKER_PROTOCOL_VERSION = 8 as const;

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
  acceptanceRequestId: Schema.NonEmptyString,
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
  acceptanceRequestId: Schema.NonEmptyString,
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
const BeginRequestSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("begin"),
});
const CancellationRequestSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("cancel"),
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

export interface WorkerProtocolReception {
  readonly acknowledgementsComplete: boolean;
  readonly beginReceived?: true;
  readonly cancellationRequested?: true;
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

  begin(): Buffer {
    if (this.state !== "awaiting_begin") {
      throw violation("invalid_transition", "Worker execution cannot begin before identification");
    }
    const bytes = this.encodeHostFrame("begin");
    this.state = "receiving_results";
    return bytes;
  }

  requestCancellation(): Buffer | undefined {
    if (
      this.state === "awaiting_hello" ||
      this.state === "cancelling" ||
      this.state === "failed" ||
      this.state === "done"
    ) return undefined;
    const bytes = this.encodeHostFrame("cancel");
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

  private encodeHostFrame(type: "begin" | "cancel"): Buffer {
    const bytes = this.encodeFrame({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operationId: this.authority.operationId,
      capability: this.authority.capability,
      sequenceNumber: this.hostSequenceNumber,
      type,
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
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (bytes.byteLength !== artifact.expectedByteCount || digest !== artifact.expectedDigest) {
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
        this.workProducts.push({ ...produced, key: artifact.key! });
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
  private acknowledgedEvidence?: {
    readonly acceptanceId: string;
    readonly manifestDigest: string;
    readonly eventSequenceNumber: number;
  };

  constructor(
    private readonly authority: Readonly<ProtocolAuthority>,
    limits?: Partial<ProtocolLimits>,
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
      let beginReceived = false;
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
          if (this.state !== "ready") {
            throw violation("invalid_transition", "Begin arrived before Worker start or more than once");
          }
          this.state = "running";
          beginReceived = true;
          return;
        }
        if (object.type === "cancel") {
          const cancellation = decodeShape(
            CancellationRequestSchema,
            value,
            "Worker cancellation request has an invalid shape",
          );
          this.validateHostControl(cancellation, "Cancellation");
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
        ...(beginReceived ? { beginReceived: true as const } : {}),
        ...(cancellationRequested ? { cancellationRequested: true as const } : {}),
      };
    } catch (error) {
      this.state = "failed";
      throw error;
    }
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
