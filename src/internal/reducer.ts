import type { Operation, OperationEvent } from "./domain.js";

export type TransitionErrorCode =
  | "operation_required"
  | "operation_already_exists"
  | "operation_id_mismatch"
  | "unexpected_sequence"
  | "illegal_transition"
  | "result_required_before_self_settlement"
  | "successful_settlement_required_before_completion";

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

export function reduceOperation(
  current: Operation | undefined,
  event: OperationEvent,
): Operation {
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

    case "result_persisted":
      if (current.state !== "running") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, result: { ...event.result }, stateSeq: event.seq });

    case "self_settled":
      if (current.state !== "running") {
        throw new TransitionError("illegal_transition");
      }
      if (current.result === undefined) {
        throw new TransitionError("result_required_before_self_settlement");
      }
      return immutable({
        ...current,
        selfOutcome: event.outcome,
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
  }
}
