import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./domain.js";
import type { Operation, OperationEvent } from "./domain.js";

export type TransitionErrorCode =
  | "operation_required"
  | "operation_already_exists"
  | "operation_id_mismatch"
  | "invalid_operation_id"
  | "invalid_event_id"
  | "duplicate_event"
  | "unsupported_schema_version"
  | "actor_mismatch"
  | "authority_mismatch"
  | "unexpected_sequence"
  | "illegal_transition"
  | "terminal_state_immutable"
  | "result_required_before_self_settlement"
  | "successful_settlement_required_before_completion"
  | "descendants_must_be_settled"
  | "descendant_failure_prevents_completion"
  | "unknown_child"
  | "child_already_settled"
  | "failed_settlement_required_before_failure"
  | "failure_reason_mismatch"
  | "stale_cancellation_epoch"
  | "cancellation_epoch_mismatch";

export class TransitionError extends Error {
  override readonly name = "TransitionError";

  constructor(readonly code: TransitionErrorCode) {
    super(code);
  }
}

function immutable(operation: Operation): Operation {
  Object.freeze(operation.task);
  Object.freeze(operation.lineage);
  Object.freeze(operation.childOperationIds);
  Object.freeze(operation.settledChildOperationIds);
  if (operation.result !== undefined) Object.freeze(operation.result);
  return Object.freeze(operation);
}

function hasUnsettledChildren(operation: Operation): boolean {
  return (
    operation.childOperationIds.length !==
    operation.settledChildOperationIds.length
  );
}

function validateEnvelope(event: OperationEvent): void {
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new TransitionError("unsupported_schema_version");
  }
  if (event.actorId !== RUNTIME_ACTOR_ID) {
    throw new TransitionError("actor_mismatch");
  }
  if (event.authority !== OPERATION_AUTHORITY) {
    throw new TransitionError("authority_mismatch");
  }
  if (event.operationId.length === 0) {
    throw new TransitionError("invalid_operation_id");
  }
  if (event.eventId.length === 0) {
    throw new TransitionError("invalid_event_id");
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) {
    throw new TransitionError("unexpected_sequence");
  }
}

export function reduceOperation(
  current: Operation | undefined,
  event: OperationEvent,
): Operation {
  validateEnvelope(event);

  if (current === undefined) {
    if (event.type !== "operation_requested") {
      throw new TransitionError("operation_required");
    }
    if (event.seq !== 1) throw new TransitionError("unexpected_sequence");

    return immutable({
      operationId: event.operationId,
      lineage: { ...event.lineage },
      state: "queued",
      stateSeq: event.seq,
      task: { ...event.task },
      childOperationIds: [],
      settledChildOperationIds: [],
      descendantFailure: false,
      spawnFrozen: false,
      cancellationEpoch: 0,
    });
  }

  if (event.type === "operation_requested") {
    throw new TransitionError("operation_already_exists");
  }
  if (event.operationId !== current.operationId) {
    throw new TransitionError("operation_id_mismatch");
  }
  if (event.seq !== current.stateSeq + 1) {
    throw new TransitionError("unexpected_sequence");
  }
  if (
    current.state === "completed" ||
    current.state === "failed" ||
    current.state === "cancelled" ||
    current.state === "unknown"
  ) {
    throw new TransitionError("terminal_state_immutable");
  }

  switch (event.type) {
    case "child_attached":
      if (current.spawnFrozen || current.state === "draining_descendants") {
        throw new TransitionError("illegal_transition");
      }
      if (current.childOperationIds.includes(event.childOperationId)) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        childOperationIds: [...current.childOperationIds, event.childOperationId],
        state:
          current.state === "self_settled"
            ? "draining_descendants"
            : current.state,
        stateSeq: event.seq,
      });

    case "child_settled": {
      if (!current.childOperationIds.includes(event.childOperationId)) {
        throw new TransitionError("unknown_child");
      }
      if (current.settledChildOperationIds.includes(event.childOperationId)) {
        throw new TransitionError("child_already_settled");
      }
      const settledChildOperationIds = [
        ...current.settledChildOperationIds,
        event.childOperationId,
      ];
      const descendantsDrained =
        settledChildOperationIds.length === current.childOperationIds.length;
      return immutable({
        ...current,
        descendantFailure:
          current.descendantFailure || event.outcome === "failed",
        settledChildOperationIds,
        state:
          current.state === "draining_descendants" && descendantsDrained
            ? "self_settled"
            : current.state,
        stateSeq: event.seq,
      });
    }

    case "operation_starting":
      if (current.state !== "queued") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, state: "starting", stateSeq: event.seq });

    case "operation_started":
      if (current.state !== "starting") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, state: "running", stateSeq: event.seq });

    case "operation_blocked":
      if (current.state !== "running") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, state: "blocked", stateSeq: event.seq });

    case "operation_unblocked":
      if (current.state !== "blocked") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, state: "running", stateSeq: event.seq });

    case "result_persisted":
      if (current.state !== "running" && current.state !== "blocked") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, result: { ...event.result }, stateSeq: event.seq });

    case "self_settled":
      if (
        current.state !== "starting" &&
        current.state !== "running" &&
        current.state !== "blocked"
      ) {
        throw new TransitionError("illegal_transition");
      }
      if (event.outcome === "succeeded") {
        if (current.state === "starting") {
          throw new TransitionError("illegal_transition");
        }
        if (current.result === undefined) {
          throw new TransitionError("result_required_before_self_settlement");
        }
        return immutable({
          ...current,
          selfOutcome: "succeeded",
          state: hasUnsettledChildren(current)
            ? "draining_descendants"
            : "self_settled",
          stateSeq: event.seq,
        });
      }
      return immutable({
        ...current,
        failureReason: event.reason,
        selfOutcome: "failed",
        state: hasUnsettledChildren(current)
          ? "draining_descendants"
          : "self_settled",
        stateSeq: event.seq,
      });

    case "cancellation_requested":
      if (event.cancellationEpoch <= current.cancellationEpoch) {
        throw new TransitionError("stale_cancellation_epoch");
      }
      return immutable({
        ...current,
        state: "cancelling",
        stateSeq: event.seq,
        spawnFrozen: true,
        cancellationEpoch: event.cancellationEpoch,
      });

    case "cancel_dispatched":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch
      ) {
        throw new TransitionError("cancellation_epoch_mismatch");
      }
      return immutable({ ...current, stateSeq: event.seq });

    case "cancel_acknowledged":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch
      ) {
        throw new TransitionError("cancellation_epoch_mismatch");
      }
      return immutable({ ...current, stateSeq: event.seq });

    case "operation_cancelled":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch
      ) {
        throw new TransitionError("cancellation_epoch_mismatch");
      }
      return immutable({ ...current, state: "cancelled", stateSeq: event.seq });

    case "operation_unknown":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch
      ) {
        throw new TransitionError("cancellation_epoch_mismatch");
      }
      return immutable({
        ...current,
        state: "unknown",
        stateSeq: event.seq,
        terminalReason: event.reason,
      });

    case "operation_completed":
      if (current.state !== "self_settled" || current.selfOutcome !== "succeeded") {
        throw new TransitionError(
          "successful_settlement_required_before_completion",
        );
      }
      if (hasUnsettledChildren(current)) {
        throw new TransitionError("descendants_must_be_settled");
      }
      if (current.descendantFailure) {
        throw new TransitionError("descendant_failure_prevents_completion");
      }
      if (current.result === undefined) {
        throw new TransitionError("result_required_before_self_settlement");
      }
      return immutable({ ...current, state: "completed", stateSeq: event.seq });

    case "operation_failed":
      if (
        current.state !== "self_settled" ||
        (current.selfOutcome !== "failed" && !current.descendantFailure)
      ) {
        throw new TransitionError("failed_settlement_required_before_failure");
      }
      if (hasUnsettledChildren(current)) {
        throw new TransitionError("descendants_must_be_settled");
      }
      if (
        current.selfOutcome === "failed" &&
        current.failureReason !== event.reason
      ) {
        throw new TransitionError("failure_reason_mismatch");
      }
      if (
        current.selfOutcome === "succeeded" &&
        (!current.descendantFailure || event.reason !== "descendant_failed")
      ) {
        throw new TransitionError("failure_reason_mismatch");
      }
      return immutable({
        ...current,
        state: "failed",
        stateSeq: event.seq,
        terminalReason: event.reason,
      });
  }
}

export function replayOperation(
  events: ReadonlyArray<OperationEvent>,
): Operation | undefined {
  const eventIds = new Set<string>();
  let operation: Operation | undefined;
  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      throw new TransitionError("duplicate_event");
    }
    operation = reduceOperation(operation, event);
    eventIds.add(event.eventId);
  }
  return operation;
}
