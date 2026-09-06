import { createHash } from "node:crypto";

import { Schema } from "effect";

import type { Result } from "../public.js";

export const CHILD_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_FIRST_FRAME_BYTES = 4 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;

export const CapabilitySchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64,}$/u));
export const ProcessInstanceIdSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
export const DigestSchema = Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/u));

const CommonFrameFields = {
  protocolVersion: Schema.Literal(CHILD_PROTOCOL_VERSION),
  operationId: Schema.NonEmptyString,
  capability: CapabilitySchema,
  sequenceNumber: Schema.Number,
};

export const HelloSchema = Schema.Struct({
  ...CommonFrameFields,
  sequenceNumber: Schema.Literal(1),
  type: Schema.Literal("hello"),
  processInstanceId: ProcessInstanceIdSchema,
});
export const StartedSchema = Schema.Struct({
  ...CommonFrameFields,
  type: Schema.Literal("started"),
});
export const ResultSchema = Schema.Struct({
  ...CommonFrameFields,
  type: Schema.Literal("result"),
  body: Schema.String,
  digest: DigestSchema,
  deliverySequenceNumber: Schema.Number,
});
export const DoneSchema = Schema.Struct({
  ...CommonFrameFields,
  type: Schema.Literal("done"),
});

export interface WorkerConfig {
  readonly protocolVersion: typeof CHILD_PROTOCOL_VERSION;
  readonly operationId: string;
  readonly capability: string;
  readonly socketPath: string;
  readonly promptPath: string;
  readonly cwd: string;
  readonly profile: string;
  readonly agentArgs: ReadonlyArray<string>;
}

export type WorkerOutboundFrame =
  | { readonly type: "hello"; readonly processInstanceId: string }
  | { readonly type: "started" }
  | {
      readonly type: "result";
      readonly body: string;
      readonly digest: Result["digest"];
      readonly deliverySequenceNumber: number;
    }
  | { readonly type: "done" };

export function resultDigest(body: string): Result["digest"] {
  return `sha256:${createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex")}`;
}
