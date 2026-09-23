import type {
  CleanupDiagnosticCode,
  ObservedWorkerConfig,
  OperationFailureReason,
  StartInstructionReference,
  WorkerIdentity,
} from "../types.js";
import type { AgentRunEvidence } from "../services.js";

export interface CreatedPresentation {
  readonly kind: "herdr_workspace";
  readonly workspaceId: string;
  readonly paneId: string;
}

export interface PresentationOwnership extends CreatedPresentation {
  readonly ownedByPions: true;
}

export type OperationIntent =
  | {
      readonly type: "presentation_owned";
      readonly presentation: Readonly<PresentationOwnership>;
    }
  | { readonly type: "operation_starting" }
  | { readonly type: "worker_launched" }
  | {
      readonly type: "worker_identified";
      readonly workerIdentity: Readonly<WorkerIdentity>;
      readonly observedConfig: Readonly<ObservedWorkerConfig>;
    }
  | {
      readonly type: "start_delivery_authority_acquired";
      readonly instruction: Readonly<StartInstructionReference>;
    }
  | {
      readonly type: "start_delivery_authority_revoked";
      readonly successorDispatcherId: string;
      readonly deliveryGeneration: number;
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
      readonly proof:
        | "authenticated-worker-acknowledgement"
        | "authenticated-generation-acknowledgement";
    }
  | { readonly type: "worker_stop_confirmed"; readonly proof: "worker-stop" }
  | {
      readonly type: "agent_settled";
      readonly evidence: Readonly<AgentRunEvidence>;
    }
  | {
      readonly type: "presentation_cleanup_started";
      readonly cleanupId: string;
      readonly workspaceId: string;
    }
  | {
      readonly type: "presentation_cleanup_completed";
      readonly cleanupId: string;
      readonly workspaceId: string;
    }
  | {
      readonly type: "presentation_cleanup_unconfirmed";
      readonly cleanupId: string;
      readonly workspaceId: string;
      readonly reason: CleanupDiagnosticCode;
    }
  | { readonly type: "operation_completed" }
  | {
      readonly type: "operation_failed";
      readonly reason: OperationFailureReason;
    }
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
      readonly reason:
        "cancel-unproven" | "start-acceptance-unknown" | "liveness-unproven";
      readonly cancellationEpoch?: number;
    };

export type PersistableOperationIntent = OperationIntent;
