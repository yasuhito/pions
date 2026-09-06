import type { Result, TaskSpec } from "../public.js";

export type OperationState =
  | "queued"
  | "starting"
  | "running"
  | "self_settled"
  | "completed";

export interface Operation {
  readonly operationId: string;
  readonly state: OperationState;
  readonly stateSeq: number;
  readonly task: Readonly<TaskSpec>;
  readonly result?: Readonly<Result>;
  readonly selfOutcome?: "succeeded";
}

interface EventMetadata {
  readonly eventId: string;
  readonly operationId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly actor: "runtime";
  readonly schemaVersion: 1;
}

export type OperationEvent = EventMetadata &
  (
    | {
        readonly type: "operation_requested";
        readonly task: Readonly<TaskSpec>;
      }
    | { readonly type: "operation_starting" }
    | { readonly type: "operation_started" }
    | {
        readonly type: "result_persisted";
        readonly result: Readonly<Result>;
      }
    | {
        readonly type: "self_settled";
        readonly outcome: "succeeded";
      }
    | { readonly type: "operation_completed" }
  );

type DistributiveOmit<Value, Keys extends PropertyKey> = Value extends unknown
  ? Omit<Value, Keys>
  : never;

export type EventInput = DistributiveOmit<OperationEvent, keyof EventMetadata>;
