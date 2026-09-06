import type { OperationFailureReason } from "../../public.js";
import type { ResultDelivery } from "../worker-protocol.js";

export interface CreatedPresentation {
  readonly kind: "herdr_pane";
  readonly paneId: string;
}

export interface PresentationOwnership extends CreatedPresentation {
  readonly ownedByPions: true;
}

export interface WorkerIdentity {
  readonly processInstanceId: string;
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
  | { readonly type: "operation_started" }
  | {
      readonly type: "worker_identified";
      readonly workerIdentity: Readonly<WorkerIdentity>;
    }
  | { readonly type: "operation_blocked" }
  | { readonly type: "operation_unblocked" }
  | { readonly type: "accept_result"; readonly delivery: ResultDelivery }
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
      readonly proof: "acknowledgement" | "worker-stop";
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
      readonly type: "operation_failed";
      readonly reason: OperationFailureReason;
    };

export type PersistableOperationIntent = Exclude<
  OperationIntent,
  { readonly type: "accept_result" }
>;
