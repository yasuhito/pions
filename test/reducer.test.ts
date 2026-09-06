import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  EventInput,
  Operation,
  OperationEvent,
} from "../src/internal/domain.js";
import { reduceOperation, TransitionError } from "../src/internal/reducer.js";

const metadata = {
  operationId: "operation-1",
  timestamp: "2026-09-06T10:00:00.000Z",
  actor: "runtime" as const,
  schemaVersion: 1 as const,
};

function event(seq: number, value: EventInput): OperationEvent {
  return {
    ...metadata,
    ...value,
    eventId: `event-${seq}`,
    seq,
  } as OperationEvent;
}

function runningOperation(): Operation {
  const requested = reduceOperation(
    undefined,
    event(1, {
      type: "operation_requested",
      task: {
        promptRef: "private://prompt/1",
        profile: "coding",
        idempotencyKey: "task-1",
      },
    }),
  );
  const starting = reduceOperation(
    requested,
    event(2, { type: "operation_starting" }),
  );
  return reduceOperation(starting, event(3, { type: "operation_started" }));
}

test("reducer refuses self-settlement without result evidence", () => {
  const running = runningOperation();

  assert.throws(
    () =>
      reduceOperation(
        running,
        event(4, { type: "self_settled", outcome: "succeeded" }),
      ),
    (error) =>
      error instanceof TransitionError &&
      error.code === "result_required_before_self_settlement",
  );
});
