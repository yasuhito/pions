import type {
  OperationFailureReason,
  Result,
  TaskSpec,
} from "../../public.js";
import type {
  PersistableOperationIntent,
  PresentationOwnership,
  WorkerIdentity,
} from "./intent.js";

export type {
  CreatedPresentation,
  PresentationOwnership,
  WorkerIdentity,
} from "./intent.js";

export type OperationState =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "self_settled"
  | "draining_descendants"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface OperationLineage {
  readonly rootOperationId: string;
  readonly parentOperationId?: string;
  readonly depth: number;
}

export interface Operation {
  readonly operationId: string;
  readonly lineage: Readonly<OperationLineage>;
  readonly presentation?: Readonly<PresentationOwnership>;
  readonly workerIdentity?: Readonly<WorkerIdentity>;
  readonly state: OperationState;
  readonly stateSeq: number;
  readonly workerLaunched: boolean;
  readonly task: Readonly<TaskSpec>;
  readonly childOperationIds: ReadonlyArray<string>;
  readonly settledChildOperationIds: ReadonlyArray<string>;
  readonly descendantFailure: boolean;
  readonly spawnFrozen: boolean;
  readonly cancellationEpoch: number;
  readonly result?: Readonly<ResultReference>;
  readonly resultConflict?: Readonly<ResultConflictEvidence>;
  readonly selfOutcome?: "succeeded" | "failed";
  readonly failureReason?: OperationFailureReason;
  readonly terminalReason?: OperationFailureReason | "cancel-unproven";
}

export interface ResultReference {
  readonly location: "result.utf8";
  readonly byteCount: number;
  readonly digest: Result["digest"];
  readonly deliverySequenceNumber: number;
}

export interface ResultConflictEvidence {
  readonly acceptedDigest: Result["digest"];
  readonly conflictingDigest: Result["digest"];
  readonly deliverySequenceNumber: number;
}

export const EVENT_SCHEMA_VERSION = 3 as const;
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
    | PersistableOperationIntent
    | {
        readonly type: "result_persisted";
        readonly result: Readonly<ResultReference>;
      }
    | {
        readonly type: "result_conflict_recorded";
        readonly conflict: Readonly<ResultConflictEvidence>;
      }
  );

type DistributiveOmit<Value, Keys extends PropertyKey> = Value extends unknown
  ? Omit<Value, Keys>
  : never;

export type EventInput = DistributiveOmit<OperationEvent, keyof EventMetadata>;
