import { timingSafeEqual } from "node:crypto";

import { Schema } from "effect";

import type {
  EffectiveWorkerConfig,
  ObservedWorkerConfig,
  Result,
  WorkerConfigurationFailureReason,
} from "../public.js";
import type { AgentRunEvidence } from "./services.js";
import { resultDigest } from "./result-digest.js";
import {
  EffectiveWorkerConfigSchema,
  ObservedWorkerConfigSchema,
} from "./worker-configuration.js";

export const WORKER_PROTOCOL_VERSION = 6 as const;

export interface ProtocolAuthority {
  readonly operationId: string;
  readonly capability: string;
}

export interface ProtocolLimits {
  readonly firstFrameBytes: number;
  readonly frameBytes: number;
  readonly resultBytes: number;
  readonly sessionResultBytes: number;
  readonly resultDeliveries: number;
}

export const DEFAULT_PROTOCOL_LIMITS: ProtocolLimits = Object.freeze({
  firstFrameBytes: 4 * 1024,
  frameBytes: 1024 * 1024,
  resultBytes: 1024 * 1024,
  sessionResultBytes: 1024 * 1024,
  resultDeliveries: 16,
});

export type ProtocolViolationReason =
  | "invalid_frame"
  | "version_mismatch"
  | "authority_mismatch"
  | "sequence_mismatch"
  | "frame_too_large"
  | "result_too_large"
  | "session_result_too_large"
  | "too_many_results"
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
    "model_not_found",
    "model_auth_unavailable",
    "unsupported_capability",
    "tool_policy_violation",
  ),
});
const ResultSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("result"),
  body: Schema.String,
  digest: DigestSchema,
  deliverySequenceNumber: Schema.Number,
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
  digest: DigestSchema,
  deliverySequenceNumber: Schema.Number,
  type: Schema.Literal("ack"),
});
const BeginRequestSchema = Schema.Struct({
  ...CommonWorkerFrameFields,
  type: Schema.Literal("begin"),
});
const CancellationRequestSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  operationId: Schema.NonEmptyString,
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

export interface ResultDelivery {
  readonly operationId: string;
  readonly body: string;
  readonly digest: Result["digest"];
  readonly sequenceNumber: number;
}

export function resultDeliveryViolation(
  operationId: string,
  delivery: Readonly<ResultDelivery>,
): "authority_mismatch" | "invalid_frame" | "digest_mismatch" | undefined {
  if (delivery.operationId !== operationId) return "authority_mismatch";
  if (
    typeof delivery.body !== "string" ||
    !Number.isSafeInteger(delivery.sequenceNumber) ||
    delivery.sequenceNumber <= 0
  ) return "invalid_frame";
  if (delivery.digest !== resultDigest(Buffer.from(delivery.body, "utf8"))) {
    return "digest_mismatch";
  }
  return undefined;
}

declare const resultAcceptanceProof: unique symbol;

export interface ResultAcceptanceProof {
  readonly operationId: string;
  readonly digest: Result["digest"];
  readonly sequenceNumber: number;
  readonly [resultAcceptanceProof]: true;
}

export interface ResultReception {
  readonly deliveries: ReadonlyArray<ResultDelivery>;
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
      readonly type: "results_received";
      readonly reception: ResultReception;
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
      readonly type: "result";
      readonly body: string;
      readonly deliverySequenceNumber: number;
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

function deliveryKey(delivery: {
  readonly digest: Result["digest"];
  readonly sequenceNumber: number;
}): string {
  return `${delivery.sequenceNumber}:${delivery.digest}`;
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

class ResultBudget {
  private bytes = 0;
  private deliveries = 0;

  constructor(private readonly limits: ProtocolLimits) {}

  check(body: string): number {
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > this.limits.resultBytes) {
      throw violation("result_too_large", "Result exceeds its size limit");
    }
    if (this.bytes + bodyBytes > this.limits.sessionResultBytes) {
      throw violation("session_result_too_large", "Result delivery exceeds its session size limit");
    }
    if (this.deliveries + 1 > this.limits.resultDeliveries) {
      throw violation("too_many_results", "Result delivery exceeds its count limit");
    }
    return bodyBytes;
  }

  commit(bodyBytes: number): void {
    this.bytes += bodyBytes;
    this.deliveries += 1;
  }

  accept(body: string): void {
    this.commit(this.check(body));
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
  private processId = 0;
  private processInstanceId = "";
  private processStartToken = "";
  private readonly resultBudget: ResultBudget;
  private readonly deliveries: Array<ResultDelivery> = [];
  private readonly pendingAcknowledgements = new Map<string, number>();

  constructor(
    private readonly authority: Readonly<ProtocolAuthority>,
    limits?: Partial<ProtocolLimits>,
  ) {
    const resolvedLimits = completeLimits(limits);
    super(resolvedLimits);
    this.resultBudget = new ResultBudget(resolvedLimits);
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
    const bytes = this.encodeFrame({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operationId: this.authority.operationId,
      capability: this.authority.capability,
      sequenceNumber: 1,
      type: "begin",
    });
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
    const bytes = this.encodeFrame({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operationId: this.authority.operationId,
      type: "cancel",
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
    const key = deliveryKey(acceptance);
    const pending = this.pendingAcknowledgements.get(key) ?? 0;
    if (pending === 0) {
      throw violation(
        "unexpected_acknowledgement",
        "Result acknowledgement does not match a received delivery",
      );
    }
    const bytes = this.encodeFrame({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operationId: this.authority.operationId,
      digest: acceptance.digest,
      deliverySequenceNumber: acceptance.sequenceNumber,
      type: "ack",
    });
    if (pending === 1) this.pendingAcknowledgements.delete(key);
    else this.pendingAcknowledgements.set(key, pending - 1);
    return {
      bytes,
      complete: this.pendingAcknowledgements.size === 0,
    };
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
    if (object.type === "result") {
      const result = decodeShape(
        ResultSchema,
        value,
        "Worker protocol frame has an invalid shape",
      );
      this.validateCommon(result);
      if (this.state !== "receiving_results") {
        throw violation("invalid_transition", "Result arrived before started notification");
      }
      const delivery: ResultDelivery = {
        operationId: this.authority.operationId,
        body: result.body,
        digest: result.digest as Result["digest"],
        sequenceNumber: result.deliverySequenceNumber,
      };
      const deliveryViolation = resultDeliveryViolation(
        this.authority.operationId,
        delivery,
      );
      if (deliveryViolation !== undefined) {
        throw violation(deliveryViolation, "Result delivery is invalid");
      }
      this.resultBudget.accept(delivery.body);
      this.deliveries.push(delivery);
      const key = deliveryKey(delivery);
      this.pendingAcknowledgements.set(
        key,
        (this.pendingAcknowledgements.get(key) ?? 0) + 1,
      );
      return undefined;
    }
    if (object.type === "failed") {
      const failed = decodeShape(
        FailedSchema,
        value,
        "Worker protocol frame has an invalid shape",
      );
      this.validateCommon(failed);
      if (this.state !== "receiving_results" || this.deliveries.length !== 0) {
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
      if (this.state !== "receiving_results" || this.deliveries.length === 0) {
        throw violation("invalid_transition", "Worker finished without a Result");
      }
      this.state = "done";
      return {
        type: "results_received",
        reception: { deliveries: [...this.deliveries] },
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
  private readonly resultBudget: ResultBudget;
  private readonly pendingAcknowledgements = new Map<string, number>();

  constructor(
    private readonly authority: Readonly<ProtocolAuthority>,
    limits?: Partial<ProtocolLimits>,
  ) {
    const resolvedLimits = completeLimits(limits);
    super(resolvedLimits);
    this.resultBudget = new ResultBudget(resolvedLimits);
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
      case "result": {
        if (this.state !== "running" && this.state !== "delivering") {
          return this.invalidSend(event.type);
        }
        validateSafePositiveInteger(event.deliverySequenceNumber, "deliverySequenceNumber");
        const bodyBytes = this.resultBudget.check(event.body);
        const digest = resultDigest(Buffer.from(event.body, "utf8"));
        const bytes = this.encodeWorkerFrame({
          type: "result",
          body: event.body,
          digest,
          deliverySequenceNumber: event.deliverySequenceNumber,
        });
        this.resultBudget.commit(bodyBytes);
        this.state = "delivering";
        const key = deliveryKey({
          digest,
          sequenceNumber: event.deliverySequenceNumber,
        });
        this.pendingAcknowledgements.set(
          key,
          (this.pendingAcknowledgements.get(key) ?? 0) + 1,
        );
        return bytes;
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
          if (
            begin.operationId !== this.authority.operationId ||
            !sameSecret(this.authority.capability, begin.capability)
          ) {
            throw violation("authority_mismatch", "Begin authority does not match the Operation");
          }
          validateSafePositiveInteger(begin.sequenceNumber, "sequenceNumber");
          if (begin.sequenceNumber !== this.lastHostSequenceNumber + 1) {
            throw violation("sequence_mismatch", "Host protocol sequence is stale or out of order");
          }
          this.lastHostSequenceNumber = begin.sequenceNumber;
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
          if (cancellation.operationId !== this.authority.operationId) {
            throw violation("authority_mismatch", "Cancellation operation does not match");
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
        if (this.state !== "done") {
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
          acknowledgement.deliverySequenceNumber,
          "deliverySequenceNumber",
        );
        const key = deliveryKey({
          digest: acknowledgement.digest as Result["digest"],
          sequenceNumber: acknowledgement.deliverySequenceNumber,
        });
        const pending = this.pendingAcknowledgements.get(key) ?? 0;
        if (pending === 0) {
          throw violation("unexpected_acknowledgement", "Acknowledgement does not match a Result delivery");
        }
        if (pending === 1) this.pendingAcknowledgements.delete(key);
        else this.pendingAcknowledgements.set(key, pending - 1);
      });
      const acknowledgementsComplete = this.state === "done" && this.pendingAcknowledgements.size === 0;
      if (acknowledgementsComplete) {
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
