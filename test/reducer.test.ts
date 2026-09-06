import assert from "node:assert/strict";
import { test } from "node:test";

import { reduceOperation, TransitionError } from "../src/internal/reducer.js";
import type { EventInput, OperationEvent } from "../src/internal/domain.js";

const metadata = {
  operationId: "operation-1",
  timestamp: "2026-09-06T10:00:00.000Z",
  actor: "runtime" as const,
  schemaVersion: 1 as const,
};

function event(
  seq: number,
  value: EventInput,
): OperationEvent {
  return {
    ...metadata,
    ...value,
    eventId: `event-${seq}`,
    seq,
  } as OperationEvent;
}

test("reducer refuses self-settlement until result evidence exists", () => {
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
  const starting = reduceOperation(requested, event(2, { type: "operation_starting" }));
  const running = reduceOperation(starting, event(3, { type: "operation_started" }));

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
  assert.equal(running.state, "running");
});
