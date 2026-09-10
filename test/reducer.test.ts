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
import { automaticStartScopeDigest } from "../src/internal/start-instruction.js";
import {
  effectiveConfig,
  observedConfig,
  requestedConfig,
  retentionPolicy,
  workProductRequirements,
} from "./worker-protocol-fixtures.js";

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
      | "lineage"
      | "requestedConfig"
      | "effectiveConfig"
      | "workProductRequirements"
      | "resultRetentionPolicy"
      | "startAuthorizationTiming"
    >;

function event(seq: number, value: TestEventInput): OperationEvent {
  return {
    ...metadata,
    ...(value.type === "operation_requested"
      ? {
          lineage: { rootOperationId: metadata.operationId, depth: 0 },
          requestedConfig,
          effectiveConfig,
          workProductRequirements,
          resultRetentionPolicy: retentionPolicy(metadata.operationId),
          startAuthorizationTiming: {
            createdAt: metadata.timestamp,
            windowMs: 0,
            deadline: metadata.timestamp,
            configuredPolicy: "disabled",
            policy: "disabled",
            authorizedSubjectIds: [],
          },
        }
      : {}),
    ...value,
    eventId: `event-${seq}`,
    seq,
  } as OperationEvent;
}

const startInstruction = {
  dispatcherId: RUNTIME_ACTOR_ID,
  workerProcessInstanceId: "worker-instance",
  receiptDigest: automaticStartScopeDigest({
    operationId: metadata.operationId,
    task: {
      promptRef: "private://prompt/1",
      profile: "coding",
      idempotencyKey: "task-1",
    },
    effectiveConfig,
  }),
  deliveryGeneration: 1,
};

function runningEvents(): ReadonlyArray<OperationEvent> {
  return [
    event(1, {
      type: "operation_requested",
      task: {
        promptRef: "private://prompt/1",
        profile: "coding",
        idempotencyKey: "task-1",
      },
    }),
    event(2, {
      type: "presentation_owned",
      presentation: { kind: "herdr_pane", paneId: "pane-1", ownedByPions: true },
    }),
    event(3, { type: "operation_starting" }),
    event(4, { type: "worker_launched" }),
    event(5, {
      type: "worker_identified",
      workerIdentity: {
        processId: 1,
        processInstanceId: "worker-instance",
        processStartToken: "worker-start",
        piSessionId: "pi-session",
        paneId: "pane-1",
      },
      observedConfig,
    }),
    event(6, { type: "start_delivery_authority_acquired", instruction: startInstruction }),
    event(7, { type: "start_delivery_entered", instruction: startInstruction }),
    event(8, { type: "start_instruction_dispatched", instruction: startInstruction }),
    event(9, {
      type: "start_instruction_accepted",
      instruction: startInstruction,
      proof: "worker-durable-acceptance",
    }),
    event(10, {
      type: "start_instruction_acknowledged",
      instruction: startInstruction,
      proof: "authenticated-worker-acknowledgement",
    }),
  ];
}

function runningOperation(): Operation {
  return { ...replayOperation(runningEvents())!, stateSeq: 4 };
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

test("reducer refuses Worker identification without launch evidence", () => {
  const requested = reduceOperation(undefined, runningEvents()[0]!);
  const presented = reduceOperation(requested, runningEvents()[1]!);
  const starting = reduceOperation(presented, runningEvents()[2]!);

  assert.throws(
    () => reduceOperation(starting, { ...runningEvents()[4]!, seq: 4 }),
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
    ...runningEvents(),
    event(11, {
      type: "self_settled",
      outcome: "failed",
      reason: "worker_start_failed",
    }),
    event(12, { type: "operation_failed", reason: "worker_start_failed" }),
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
    ...runningEvents(),
    event(11, { type: "operation_blocked" }),
    event(12, { type: "operation_unblocked" }),
  ];
  const snapshot = events.reduce<Operation | undefined>(reduceOperation, undefined);

  assert.deepEqual(replayOperation(events), snapshot);
});

test("Start delivery authority revocation records writer ownership independently", () => {
  const revoked = reduceOperation(runningOperation(), event(5, {
    type: "start_delivery_authority_revoked",
    successorDispatcherId: "dispatcher-2",
    deliveryGeneration: 2,
    writerOwnership: { pid: 1234, processStartToken: "writer-start" },
  }));

  assert.deepEqual(
    revoked.startDeliveryHandoffs[0]?.writerOwnership,
    { pid: 1234, processStartToken: "writer-start" },
  );
});

test("a pending Start delivery handoff records the recovering writer ownership", () => {
  const revoked = reduceOperation(runningOperation(), event(5, {
    type: "start_delivery_authority_revoked",
    successorDispatcherId: "dispatcher-2",
    deliveryGeneration: 2,
    writerOwnership: { pid: 1234, processStartToken: "first-writer" },
  }));
  const resumed = reduceOperation(revoked, event(6, {
    type: "start_delivery_authority_revoked",
    successorDispatcherId: "dispatcher-2",
    deliveryGeneration: 2,
    writerOwnership: { pid: 5678, processStartToken: "recovering-writer" },
  }));

  assert.deepEqual(
    resumed.startDeliveryHandoffs.at(-1)?.writerOwnership,
    { pid: 5678, processStartToken: "recovering-writer" },
  );
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
