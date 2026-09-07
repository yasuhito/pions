import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "../src/internal/event-store/model.js";
import type {
  EventInput,
  Operation,
  OperationEvent,
} from "../src/internal/event-store/model.js";
import {
  reduceOperation,
  replayOperation,
  TransitionError,
} from "../src/internal/event-store/reducer.js";
import { effectiveConfig, requestedConfig } from "./worker-protocol-fixtures.js";

const metadata = {
  operationId: "operation-1",
  timestamp: "2026-09-06T10:00:00.000Z",
  actorId: RUNTIME_ACTOR_ID,
  authority: OPERATION_AUTHORITY,
  schemaVersion: EVENT_SCHEMA_VERSION,
};

type TestEventInput =
  | Exclude<EventInput, { readonly type: "operation_requested" }>
  | Omit<
      Extract<EventInput, { readonly type: "operation_requested" }>,
      "lineage" | "requestedConfig" | "effectiveConfig" | "startAuthorizationTiming"
    >;

function event(seq: number, value: TestEventInput): OperationEvent {
  return {
    ...metadata,
    ...(value.type === "operation_requested"
      ? {
          lineage: { rootOperationId: metadata.operationId, depth: 0 },
          requestedConfig,
          effectiveConfig,
          startAuthorizationTiming: {
            createdAt: metadata.timestamp,
            windowMs: 0,
            deadline: metadata.timestamp,
          },
        }
      : {}),
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
  const launched = reduceOperation(
    starting,
    event(3, { type: "worker_launched" }),
  );
  return reduceOperation(launched, event(4, { type: "automatic_operation_started" }));
}

test("reducer rejects an inconsistent fixed authorization deadline", () => {
  const requested = event(1, {
    type: "operation_requested",
    task: { promptRef: "prompt", profile: "coding", idempotencyKey: "task" },
  }) as Extract<OperationEvent, { readonly type: "operation_requested" }>;

  assert.throws(
    () => reduceOperation(undefined, {
      ...requested,
      startAuthorizationTiming: {
        ...requested.startAuthorizationTiming,
        deadline: "2026-09-06T10:01:00.000Z",
      },
    }),
    (error) => error instanceof TransitionError && error.code === "illegal_transition",
  );
});

test("reducer refuses Operation start without Worker launch evidence", () => {
  const requested = reduceOperation(undefined, event(1, {
    type: "operation_requested",
    task: { promptRef: "prompt", profile: "coding", idempotencyKey: "task" },
  }));
  const starting = reduceOperation(requested, event(2, { type: "operation_starting" }));

  assert.throws(
    () => reduceOperation(starting, event(3, { type: "automatic_operation_started" })),
    (error) => error instanceof TransitionError && error.code === "illegal_transition",
  );
});

test("reducer refuses stop confirmation before Worker launch", () => {
  const requested = reduceOperation(undefined, event(1, {
    type: "operation_requested",
    task: { promptRef: "prompt", profile: "coding", idempotencyKey: "task" },
  }));

  assert.throws(
    () => reduceOperation(requested, event(2, {
      type: "worker_stop_confirmed",
      proof: "worker-stop",
    })),
    (error) => error instanceof TransitionError && error.code === "illegal_transition",
  );
});

test("reducer refuses self-settlement without result evidence", () => {
  const running = runningOperation();

  assert.throws(
    () =>
      reduceOperation(
        running,
        event(5, { type: "self_settled", outcome: "succeeded" }),
      ),
    (error) =>
      error instanceof TransitionError &&
      error.code === "result_required_before_self_settlement",
  );
});

test("a blocked Operation resumes running after input arrives", () => {
  const blocked = reduceOperation(
    runningOperation(),
    event(5, { type: "operation_blocked" }),
  );

  assert.equal(
    reduceOperation(blocked, event(6, { type: "operation_unblocked" })).state,
    "running",
  );
});

test("a cancellation request atomically freezes spawning", () => {
  const cancelling = reduceOperation(
    runningOperation(),
    event(5, { type: "cancellation_requested", cancellationEpoch: 1 }),
  );

  assert.deepEqual(
    [cancelling.state, cancelling.spawnFrozen, cancelling.cancellationEpoch],
    ["cancelling", true, 1],
  );
});

test("reducer rejects an older cancellation epoch", () => {
  const cancelling = reduceOperation(
    runningOperation(),
    event(5, { type: "cancellation_requested", cancellationEpoch: 2 }),
  );

  assert.throws(
    () =>
      reduceOperation(
        cancelling,
        event(6, { type: "cancellation_requested", cancellationEpoch: 1 }),
      ),
    (error) =>
      error instanceof TransitionError &&
      error.code === "stale_cancellation_epoch",
  );
});

test("unproven cancellation reaches unknown with its reason", () => {
  const cancelling = reduceOperation(
    runningOperation(),
    event(5, { type: "cancellation_requested", cancellationEpoch: 1 }),
  );
  const unknown = reduceOperation(
    cancelling,
    event(6, {
      type: "operation_unknown",
      cancellationEpoch: 1,
      reason: "cancel-unproven",
    }),
  );

  assert.deepEqual(
    [unknown.state, unknown.terminalReason],
    ["unknown", "cancel-unproven"],
  );
});

test("a failed self-settlement reaches the failed terminal state", () => {
  const selfSettled = reduceOperation(
    runningOperation(),
    event(5, {
      type: "self_settled",
      outcome: "failed",
      reason: "worker_start_failed",
    }),
  );

  assert.equal(
    reduceOperation(
      selfSettled,
      event(6, { type: "operation_failed", reason: "worker_start_failed" }),
    ).state,
    "failed",
  );
});

test("replay reconstructs a terminal failure reason", () => {
  const events = [
    event(1, {
      type: "operation_requested",
      task: {
        promptRef: "private://prompt/1",
        profile: "coding",
        idempotencyKey: "task-1",
      },
    }),
    event(2, { type: "operation_starting" }),
    event(3, { type: "worker_launched" }),
    event(4, { type: "automatic_operation_started" }),
    event(5, {
      type: "self_settled",
      outcome: "failed",
      reason: "worker_start_failed",
    }),
    event(6, { type: "operation_failed", reason: "worker_start_failed" }),
  ];

  assert.equal(replayOperation(events)?.terminalReason, "worker_start_failed");
});

test("replay rejects a reused event identifier", () => {
  const requested = event(1, {
    type: "operation_requested",
    task: {
      promptRef: "private://prompt/1",
      profile: "coding",
      idempotencyKey: "task-1",
    },
  });
  const starting = {
    ...event(2, { type: "operation_starting" }),
    eventId: requested.eventId,
  };

  assert.throws(
    () => replayOperation([requested, starting]),
    (error) => error instanceof TransitionError && error.code === "duplicate_event",
  );
});

test("replay reconstructs the same snapshot", () => {
  const events = [
    event(1, {
      type: "operation_requested",
      task: {
        promptRef: "private://prompt/1",
        profile: "coding",
        idempotencyKey: "task-1",
      },
    }),
    event(2, { type: "operation_starting" }),
    event(3, { type: "worker_launched" }),
    event(4, { type: "automatic_operation_started" }),
    event(5, { type: "operation_blocked" }),
    event(6, { type: "operation_unblocked" }),
  ];
  const snapshot = events.reduce<Operation | undefined>(reduceOperation, undefined);

  assert.deepEqual(replayOperation(events), snapshot);
});

test("reducer rejects an unsupported event schema", () => {
  const invalid = { ...event(5, { type: "operation_blocked" }), schemaVersion: 1 };

  assert.throws(
    () => reduceOperation(runningOperation(), invalid as OperationEvent),
    (error) =>
      error instanceof TransitionError &&
      error.code === "unsupported_schema_version",
  );
});

test("reducer rejects an event from the wrong actor", () => {
  const invalid = { ...event(5, { type: "operation_blocked" }), actorId: "observer" };

  assert.throws(
    () => reduceOperation(runningOperation(), invalid as OperationEvent),
    (error) => error instanceof TransitionError && error.code === "actor_mismatch",
  );
});

test("reducer rejects an event with the wrong authority", () => {
  const invalid = { ...event(5, { type: "operation_blocked" }), authority: "read" };

  assert.throws(
    () => reduceOperation(runningOperation(), invalid as OperationEvent),
    (error) =>
      error instanceof TransitionError && error.code === "authority_mismatch",
  );
});

test("reducer rejects an event for another Operation", () => {
  const invalid = {
    ...event(5, { type: "operation_blocked" }),
    operationId: "operation-2",
  };

  assert.throws(
    () => reduceOperation(runningOperation(), invalid),
    (error) =>
      error instanceof TransitionError && error.code === "operation_id_mismatch",
  );
});

test("reducer rejects a duplicate event sequence", () => {
  assert.throws(
    () =>
      reduceOperation(
        runningOperation(),
        event(3, { type: "operation_blocked" }),
      ),
    (error) =>
      error instanceof TransitionError && error.code === "unexpected_sequence",
  );
});

test("reducer rejects an event that skips a sequence number", () => {
  assert.throws(
    () =>
      reduceOperation(
        runningOperation(),
        event(6, { type: "operation_blocked" }),
      ),
    (error) =>
      error instanceof TransitionError && error.code === "unexpected_sequence",
  );
});

test("a rejected event does not change the snapshot", () => {
  const running = runningOperation();
  try {
    reduceOperation(running, event(5, { type: "operation_unblocked" }));
  } catch {
    // Rejection is observed separately; this case observes the snapshot.
  }

  assert.equal(running.state, "running");
});

test("reducer rejects an illegal state transition", () => {
  assert.throws(
    () =>
      reduceOperation(
        runningOperation(),
        event(5, { type: "operation_unblocked" }),
      ),
    (error) =>
      error instanceof TransitionError && error.code === "illegal_transition",
  );
});

test("reducer keeps a terminal Operation immutable", () => {
  const selfSettled = reduceOperation(
    runningOperation(),
    event(5, {
      type: "self_settled",
      outcome: "failed",
      reason: "worker_start_failed",
    }),
  );
  const failed = reduceOperation(
    selfSettled,
    event(6, { type: "operation_failed", reason: "worker_start_failed" }),
  );

  assert.throws(
    () => reduceOperation(failed, event(7, { type: "operation_starting" })),
    (error) =>
      error instanceof TransitionError && error.code === "terminal_state_immutable",
  );
});
