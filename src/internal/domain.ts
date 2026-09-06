import type {
  OperationFailureReason,
  Result,
  TaskSpec,
} from "../public.js";

export type OperationState =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "self_settled"
  | "draining_descendants"
  | "completed"
  | "failed";

export interface OperationLineage {
  readonly rootOperationId: string;
  readonly parentOperationId?: string;
  readonly depth: number;
}

export interface Operation {
  readonly operationId: string;
  readonly lineage: Readonly<OperationLineage>;
  readonly state: OperationState;
  readonly stateSeq: number;
  readonly task: Readonly<TaskSpec>;
  readonly childOperationIds: ReadonlyArray<string>;
  readonly settledChildOperationIds: ReadonlyArray<string>;
  readonly descendantFailure: boolean;
  readonly result?: Readonly<Result>;
  readonly selfOutcome?: "succeeded" | "failed";
  readonly failureReason?: OperationFailureReason;
  readonly terminalReason?: OperationFailureReason;
}

export const EVENT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_ACTOR_ID = "pions-runtime" as const;
export const OPERATION_AUTHORITY = "operation:lifecycle" as const;

interface EventMetadata {
  readonly eventId: string;
  readonly operationId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly actorId: typeof RUNTIME_ACTOR_ID;
  readonly authority: typeof OPERATION_AUTHORITY;
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
}

export type OperationEvent = EventMetadata &
  (
    | {
        readonly type: "operation_requested";
        readonly task: Readonly<TaskSpec>;
        readonly lineage: Readonly<OperationLineage>;
      }
    | {
        readonly type: "child_attached";
        readonly childOperationId: string;
      }
    | {
        readonly type: "child_settled";
        readonly childOperationId: string;
        readonly outcome: "succeeded" | "failed";
      }
    | { readonly type: "operation_starting" }
    | { readonly type: "operation_started" }
    | { readonly type: "operation_blocked" }
    | { readonly type: "operation_unblocked" }
    | {
        readonly type: "result_persisted";
        readonly result: Readonly<Result>;
      }
    | {
        readonly type: "self_settled";
        readonly outcome: "succeeded";
      }
    | {
        readonly type: "self_settled";
        readonly outcome: "failed";
        readonly reason: OperationFailureReason;
      }
    | { readonly type: "operation_completed" }
    | {
        readonly type: "operation_failed";
        readonly reason: OperationFailureReason;
      }
  );

type DistributiveOmit<Value, Keys extends PropertyKey> = Value extends unknown
  ? Omit<Value, Keys>
  : never;

export type EventInput = DistributiveOmit<OperationEvent, keyof EventMetadata>;
