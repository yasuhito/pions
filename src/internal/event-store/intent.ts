import type {
  ArtifactWriterOwnership,
  CleanupDiagnosticCode,
  ObservedWorkerConfig,
  OperationFailureReason,
  StartAuthorizationDecisionAttemptRecord,
  StartAuthorizationDecisionRecord,
  StartInstructionReference,
  StartupReceipt,
} from "../../public.js";
import type { AgentRunEvidence } from "../services.js";
import type { PersistedResourceRecord } from "../resource-controller.js";

export interface CreatedPresentation {
  readonly kind: "herdr_pane";
  readonly paneId: string;
}

export interface PresentationOwnership extends CreatedPresentation {
  readonly ownedByPions: true;
}

export interface WorkerIdentity {
  readonly processId: number;
  readonly processInstanceId: string;
  readonly processStartToken: string;
  readonly piSessionId: string;
  readonly paneId: string;
}

export type OperationIntent =
  | {
      readonly type: "presentation_owned";
      readonly presentation: Readonly<PresentationOwnership>;
    }
  | { readonly type: "child_attached"; readonly childOperationId: string }
  | {
      readonly type: "child_settled";
      readonly childOperationId: string;
      readonly outcome: "succeeded" | "failed";
    }
  | { readonly type: "operation_starting" }
  | { readonly type: "worker_launched" }
  | {
      readonly type: "startup_receipt_recorded";
      readonly receipt: Readonly<Omit<StartupReceipt, "digest" | "recordedAt">>;
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
      readonly type: "start_authorization_decision_rejected";
      readonly attempt: Readonly<Omit<StartAuthorizationDecisionAttemptRecord, "attemptedAt">>;
    }
  | {
      readonly type: "start_delivery_authority_acquired";
      readonly instruction: Readonly<StartInstructionReference>;
    }
  | {
      readonly type: "start_delivery_authority_revoked";
      readonly successorDispatcherId: string;
      readonly deliveryGeneration: number;
      readonly writerOwnership: Readonly<ArtifactWriterOwnership>;
    }
  | {
      readonly type: "start_delivery_generation_confirmed";
      readonly dispatcherId: string;
      readonly deliveryGeneration: number;
      readonly acceptanceState: "not_accepted" | "accepted" | "unknown";
      readonly acceptedInstruction?: Readonly<StartInstructionReference>;
    }
  | {
      readonly type: "start_delivery_entered";
      readonly instruction: Readonly<StartInstructionReference>;
    }
  | {
      readonly type: "start_instruction_dispatched";
      readonly instruction: Readonly<StartInstructionReference>;
    }
  | {
      readonly type: "start_instruction_accepted";
      readonly instruction: Readonly<StartInstructionReference>;
      readonly proof: "worker-durable-acceptance";
    }
  | {
      readonly type: "start_instruction_acknowledged";
      readonly instruction: Readonly<StartInstructionReference>;
      readonly proof: "authenticated-worker-acknowledgement" | "authenticated-generation-acknowledgement";
    }
  | { readonly type: "worker_stop_confirmed"; readonly proof: "worker-stop" }
  | { readonly type: "resource_evidence_recorded"; readonly record: Readonly<PersistedResourceRecord> }
  | {
      readonly type: "worker_identified";
      readonly workerIdentity: Readonly<WorkerIdentity>;
      readonly observedConfig: Readonly<ObservedWorkerConfig>;
    }
  | {
      readonly type: "agent_settled";
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | {
      readonly type: "presentation_cleanup_started";
      readonly cleanupId: string;
      readonly paneId: string;
    }
  | {
      readonly type: "presentation_cleanup_completed";
      readonly cleanupId: string;
      readonly paneId: string;
    }
  | {
      readonly type: "presentation_cleanup_unconfirmed";
      readonly cleanupId: string;
      readonly paneId: string;
      readonly reason: CleanupDiagnosticCode;
    }
  | { readonly type: "operation_blocked" }
  | { readonly type: "operation_unblocked" }
  | { readonly type: "self_settled"; readonly outcome: "succeeded" }
  | {
      readonly type: "self_settled";
      readonly outcome: "failed";
      readonly reason: OperationFailureReason;
    }
  | { readonly type: "operation_completed" }
  | {
      readonly type: "cancellation_requested";
      readonly cancellationEpoch: number;
    }
  | {
      readonly type: "cancel_dispatched";
      readonly cancellationEpoch: number;
    }
  | {
      readonly type: "cancel_acknowledged";
      readonly cancellationEpoch: number;
      readonly proof: "worker-stop";
    }
  | {
      readonly type: "operation_cancelled";
      readonly cancellationEpoch: number;
    }
  | {
      readonly type: "operation_unknown";
      readonly cancellationEpoch: number;
      readonly reason: "cancel-unproven";
    }
  | {
      readonly type: "operation_unknown";
      readonly reason: "liveness-unproven";
      readonly failureReason?: "start_rejected" | "start_authorization_timed_out" | "start_authorization_invalidated";
    }
  | {
      readonly type: "operation_failed";
      readonly reason: OperationFailureReason;
    };

export type PersistableOperationIntent =
  | Exclude<
      OperationIntent,
      | { readonly type: "startup_receipt_recorded" }
      | { readonly type: "start_authorization_decided" }
      | { readonly type: "start_authorization_decision_rejected" }
    >
  | {
      readonly type: "startup_receipt_recorded";
      readonly receipt: Readonly<StartupReceipt>;
      readonly gate: "not_required" | "waiting" | "expired";
    }
  | {
      readonly type: "start_authorization_decided";
      readonly gate: "authorized" | "rejected";
      readonly decision: Readonly<StartAuthorizationDecisionRecord>;
    }
  | {
      readonly type: "start_authorization_decision_rejected";
      readonly attempt: Readonly<StartAuthorizationDecisionAttemptRecord>;
    };
