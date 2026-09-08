import type {
  AcceptedResult,
  EffectiveWorkerConfig,
  ObservedWorkerConfig,
  OperationFailureReason,
  OperationState,
  RequestedWorkerConfig,
  ResolvedWorkProductRequirements,
  ResultAcceptancePreparationEvidence,
  ResultAcceptanceReservation,
  ResultAcceptanceRetentionPolicyEvidence,
  StartAuthorizationDecisionRecord,
  StartAuthorizationTiming,
  StartGateState,
  StartInstructionAcceptanceEvidence,
  StartInstructionDeliveryEvidence,
  StartInstructionReference,
  StartupReceipt,
  TaskSpec,
} from "../../public.js";
import type { AgentRunEvidence } from "../services.js";
import type { PersistedResourceRecord } from "../resource-controller.js";
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
  readonly agentRunEvidence?: Readonly<AgentRunEvidence>;
  readonly presentationCleanupFailure?: "pane_close_failed";
  readonly requestedConfig: Readonly<RequestedWorkerConfig>;
  readonly effectiveConfig: Readonly<EffectiveWorkerConfig>;
  readonly workProductRequirements: Readonly<ResolvedWorkProductRequirements>;
  readonly resultRetentionPolicy: Readonly<ResultAcceptanceRetentionPolicyEvidence>;
  readonly startAuthorizationTiming: Readonly<StartAuthorizationTiming>;
  readonly startGate: StartGateState;
  readonly startupReceipt?: Readonly<StartupReceipt>;
  readonly startAuthorizationDecision?: Readonly<StartAuthorizationDecisionRecord>;
  readonly startInstructionDelivery?: Readonly<StartInstructionDeliveryEvidence>;
  readonly startInstructionAcceptance?: Readonly<StartInstructionAcceptanceEvidence>;
  readonly resultAcceptedAt?: string;
  readonly workerStopConfirmedAt?: string;
  readonly observedConfig?: Readonly<ObservedWorkerConfig>;
  readonly resourceEvidenceRecord?: Readonly<PersistedResourceRecord>;
  readonly state: OperationState;
  readonly stateSeq: number;
  readonly workerLaunched: boolean;
  readonly task: Readonly<TaskSpec>;
  readonly childOperationIds: ReadonlyArray<string>;
  readonly settledChildOperationIds: ReadonlyArray<string>;
  readonly descendantFailure: boolean;
  readonly spawnFrozen: boolean;
  readonly cancellationEpoch: number;
  readonly result?: Readonly<AcceptedResult>;
  readonly resultAcceptanceReservation?: Readonly<ResultAcceptanceReservation>;
  readonly selfOutcome?: "succeeded" | "failed";
  readonly failureReason?: OperationFailureReason;
  readonly terminalReason?: OperationFailureReason | "cancel-unproven" | "liveness-unproven";
}

export const EVENT_SCHEMA_VERSION = 12 as const;
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
        readonly requestedConfig: Readonly<RequestedWorkerConfig>;
        readonly effectiveConfig: Readonly<EffectiveWorkerConfig>;
        readonly workProductRequirements: Readonly<ResolvedWorkProductRequirements>;
        readonly resultRetentionPolicy: Readonly<ResultAcceptanceRetentionPolicyEvidence>;
        readonly lineage: Readonly<OperationLineage>;
        readonly startAuthorizationTiming: Readonly<StartAuthorizationTiming>;
      }
    | {
        readonly type: "startup_receipt_recorded";
        readonly receipt: Readonly<StartupReceipt>;
        readonly gate: "not_required" | "waiting";
      }
    | {
        readonly type: "start_authorization_decided";
        readonly gate: "authorized" | "rejected";
        readonly decision: Readonly<StartAuthorizationDecisionRecord>;
      }
    | {
        readonly type: "start_gate_closed";
        readonly gate: "expired" | "invalidated";
      }
    | {
        readonly type: "start_instruction_dispatched";
        readonly instruction: Readonly<StartInstructionReference>;
      }
    | {
        readonly type: "start_instruction_accepted";
        readonly instruction: Readonly<StartInstructionReference>;
        readonly proof: "authenticated-worker-acknowledgement";
      }
    | { readonly type: "worker_stop_confirmed"; readonly proof: "worker-stop" }
    | { readonly type: "resource_evidence_recorded"; readonly record: Readonly<PersistedResourceRecord> }
    | PersistableOperationIntent
    | {
        readonly type: "result_acceptance_prepared";
        readonly reservation: Readonly<ResultAcceptanceReservation>;
      }
    | {
        readonly type: "result_accepted";
        readonly acceptance: Readonly<AcceptedResult>;
        readonly preparationEvidence: Readonly<ResultAcceptancePreparationEvidence>;
      }
  );

type DistributiveOmit<Value, Keys extends PropertyKey> = Value extends unknown
  ? Omit<Value, Keys>
  : never;

export type EventInput = DistributiveOmit<OperationEvent, keyof EventMetadata>;
