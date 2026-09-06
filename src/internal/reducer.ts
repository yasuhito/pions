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
  | "failed_settlement_required_before_failure"
  | "failure_reason_mismatch";

export class TransitionError extends Error {
  override readonly name = "TransitionError";

  constructor(readonly code: TransitionErrorCode) {
    super(code);
  }
}

function immutable(operation: Operation): Operation {
  Object.freeze(operation.task);
  if (operation.result !== undefined) Object.freeze(operation.result);
  return Object.freeze(operation);
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
      state: "queued",
      stateSeq: event.seq,
      task: { ...event.task },
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
  if (current.state === "completed" || current.state === "failed") {
    throw new TransitionError("terminal_state_immutable");
  }

  switch (event.type) {
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
          state: "self_settled",
          stateSeq: event.seq,
        });
      }
      return immutable({
        ...current,
        failureReason: event.reason,
        selfOutcome: "failed",
        state: "self_settled",
        stateSeq: event.seq,
      });

    case "operation_completed":
      if (current.state !== "self_settled" || current.selfOutcome !== "succeeded") {
        throw new TransitionError(
          "successful_settlement_required_before_completion",
        );
      }
      if (current.result === undefined) {
        throw new TransitionError("result_required_before_self_settlement");
      }
      return immutable({ ...current, state: "completed", stateSeq: event.seq });

    case "operation_failed":
      if (current.state !== "self_settled" || current.selfOutcome !== "failed") {
        throw new TransitionError("failed_settlement_required_before_failure");
      }
      if (current.failureReason !== event.reason) {
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
