import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { bend } from "./bend-executable.mjs";
import {
  InMemoryEventStore,
  advanceTestOperationToRunning,
} from "../.test-dist/src/internal/testing.js";
import {
  reduceOperation,
  TransitionError,
} from "../.test-dist/src/internal/event-store/reducer.js";
import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "../.test-dist/src/internal/event-store/model.js";

const model = resolve("verification/bend/model.bend");
const requestedConfig = {};
const effectiveConfig = {
  model: { provider: "test", id: "model" },
  thinkingLevel: "medium",
  tools: ["read"],
  extensions: [],
  cwd: "/work",
  maxResultByteCount: 1024,
  modelPolicy: {
    candidates: [{ provider: "test", id: "model" }],
    attempted: [{ provider: "test", id: "model" }],
    maxAttempts: 1,
    fallback: "forbidden",
    aliases: [],
  },
};
const bool = (value) => (value ? "True{}" : "False{}");
const nat = (value) => `${value}n`;
const maybeNat = (value) =>
  value === undefined ? "None{}" : `Some{${nat(value)}}`;
const phases = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  cancelling: "Cancelling",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "UnknownPhase",
};

function project(operation) {
  if (operation === undefined) return "None{}";
  const handoff = operation.startDeliveryHandoffs.at(-1);
  const cleanup = operation.presentationCleanup?.state;
  const facts = [
    bool(operation.presentation !== undefined),
    bool(operation.workerLaunched),
    bool(operation.result !== undefined),
    bool(operation.workerStopConfirmedAt !== undefined),
    nat(operation.cancellationEpoch),
    maybeNat(operation.startDeliveryAuthority?.deliveryGeneration),
    maybeNat(handoff?.previousDeliveryGeneration),
    maybeNat(
      handoff?.workerGenerationConfirmedAt === undefined
        ? handoff?.deliveryGeneration
        : operation.startDeliveryAuthority?.deliveryGeneration ===
            handoff?.deliveryGeneration
          ? undefined
          : handoff?.deliveryGeneration
    ),
    maybeNat(
      handoff?.workerGenerationConfirmedAt === undefined
        ? undefined
        : handoff.deliveryGeneration
    ),
    nat(cleanup === undefined ? 0 : cleanup === "pending" ? 1 : 2),
  ];
  return `Some{model.State{model.${phases[operation.state]}{}, ${nat(operation.stateSeq)}, model.Facts{${facts.join(", ")}}}}`;
}

function bendState(operation) {
  return project(operation).replaceAll("model.", "M.");
}

function action(type, argument) {
  return `M.${type}{${argument === undefined ? "" : nat(argument)}}`;
}

function event(input, seq, id) {
  return {
    ...input,
    seq,
    eventId: `event-${id}`,
    operationId: "operation-1",
    timestamp: "2026-09-23T00:00:00.000Z",
    actorId: RUNTIME_ACTOR_ID,
    authority: OPERATION_AUTHORITY,
    schemaVersion: EVENT_SCHEMA_VERSION,
  };
}

function tsStep(current, input, seq, id) {
  try {
    return reduceOperation(current, event(input, seq, id));
  } catch (error) {
    if (error instanceof TransitionError) return current;
    throw error;
  }
}

function run(current, samples) {
  const dir = mkdtempSync(join(tmpdir(), "pions-bend-"));
  try {
    cpSync(model, join(dir, "model.bend"));
    const occurrences = [];
    const expected = [];
    let state = current;
    for (const [index, sample] of samples.entries()) {
      const [input, type, argument, seq] = sample;
      occurrences.push(`M.Occurrence{${nat(seq)}, ${action(type, argument)}}`);
      state = tsStep(state, input, seq, index + 1);
      expected.push(project(state));
    }
    writeFileSync(
      join(dir, "check.bend"),
      `import Base\nimport ./model.bend as M\ndef main() -> List<&2, Maybe<&2, M.State>>:\n  M.trace([${occurrences.join(", ")}], ${bendState(current)})\n`
    );
    const output = execFileSync(bend, [join(dir, "check.bend")], {
      encoding: "utf8",
      env: { ...process.env, BEND_NO_TELEMETRY: "1" },
      timeout: 60000,
    }).trim();
    return { actual: output, expected: `[${expected.join(", ")}]` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fixtures() {
  const store = new InMemoryEventStore();
  const created = await Effect.runPromise(
    store.create({
      operationId: "operation-1",
      task: {
        promptRef: "private://prompt",
        profile: "coding",
        idempotencyKey: "task-1",
      },
      requestedConfig,
      effectiveConfig,
      maxResultByteCount: 1024,
    })
  );
  await advanceTestOperationToRunning(store, "operation-1");
  const running = (await Effect.runPromise(store.read("operation-1")))
    .operation;
  await Effect.runPromise(
    store.acceptResult({
      operationId: "operation-1",
      acceptanceRequestId: "request-1",
      bytes: Buffer.from("finished"),
    })
  );
  const accepted = (await Effect.runPromise(store.read("operation-1")))
    .operation;
  const stopped = (
    await Effect.runPromise(
      store.advance("operation-1", {
        type: "worker_stop_confirmed",
        proof: "worker-stop",
      })
    )
  ).operation;
  const completed = (
    await Effect.runPromise(
      store.advance("operation-1", { type: "operation_completed" })
    )
  ).operation;
  return { queued: created.operation, running, accepted, stopped, completed };
}

const { queued, running, accepted, stopped, completed } = await fixtures();
const request = {
  type: "operation_requested",
  task: queued.task,
  requestedConfig,
  effectiveConfig,
  maxResultByteCount: 1024,
};
const completion = { type: "operation_completed" };
const stop = { type: "worker_stop_confirmed", proof: "worker-stop" };
const result = (seq) => ({
  type: "result_accepted",
  acceptance: {
    ...accepted.result,
    acceptedAt: "2026-09-23T00:00:00.000Z",
    eventSequenceNumber: seq,
  },
});
const presentation = {
  type: "presentation_owned",
  presentation: {
    kind: "herdr_workspace",
    workspaceId: "test-workspace",
    paneId: "test-pane",
    ownedByPions: true,
  },
};
const examples = [
  ["creation", undefined, request, "Requested", undefined, 1],
  ["first seq is one", undefined, request, "Requested", undefined, 0],
  [
    "presentation before starting",
    queued,
    { type: "operation_starting" },
    "StartingWork",
    undefined,
    queued.stateSeq + 1,
  ],
  [
    "own presentation",
    queued,
    presentation,
    "PresentationOwned",
    undefined,
    queued.stateSeq + 1,
  ],
  [
    "nonconsecutive seq",
    queued,
    presentation,
    "PresentationOwned",
    undefined,
    queued.stateSeq + 2,
  ],
  [
    "result absent",
    running,
    completion,
    "Complete",
    undefined,
    running.stateSeq + 1,
  ],
  [
    "stop absent after result",
    accepted,
    completion,
    "Complete",
    undefined,
    accepted.stateSeq + 1,
  ],
  [
    "result only once",
    accepted,
    result(accepted.stateSeq + 1),
    "ResultAccepted",
    undefined,
    accepted.stateSeq + 1,
  ],
  [
    "stop after launched",
    accepted,
    stop,
    "StopConfirmed",
    undefined,
    accepted.stateSeq + 1,
  ],
  [
    "completion after stop",
    stopped,
    completion,
    "Complete",
    undefined,
    stopped.stateSeq + 1,
  ],
  [
    "terminal unchanged",
    completed,
    completion,
    "Complete",
    undefined,
    completed.stateSeq + 1,
  ],
  [
    "stop requires launch",
    queued,
    stop,
    "StopConfirmed",
    undefined,
    queued.stateSeq + 1,
  ],
  [
    "stale cancellation epoch",
    queued,
    { type: "cancellation_requested", cancellationEpoch: 0 },
    "CancelRequested",
    0,
    queued.stateSeq + 1,
  ],
  [
    "cancel epoch",
    queued,
    { type: "cancellation_requested", cancellationEpoch: 1 },
    "CancelRequested",
    1,
    queued.stateSeq + 1,
  ],
];

for (const [name, current, input, type, argument, seq] of examples) {
  test(`Bend / TS: ${name}`, () => {
    const { actual, expected } = run(current, [[input, type, argument, seq]]);
    assert.equal(actual, expected);
  });
}

test("cancellation and cleanup replay compares every accepted and rejected step", () => {
  const samples = [
    [presentation, "PresentationOwned", undefined, 2],
    [{ type: "operation_starting" }, "StartingWork", undefined, 3],
    [{ type: "worker_launched" }, "WorkerLaunched", undefined, 4],
    [
      { type: "worker_stop_confirmed", proof: "worker-stop" },
      "StopConfirmed",
      undefined,
      5,
    ],
    [
      { type: "cancellation_requested", cancellationEpoch: 1 },
      "CancelRequested",
      1,
      6,
    ],
    [
      {
        type: "cancel_acknowledged",
        cancellationEpoch: 1,
        proof: "worker-stop",
      },
      "CancelAcknowledged",
      1,
      7,
    ],
    [{ type: "operation_cancelled", cancellationEpoch: 1 }, "Cancel", 1, 8],
    [
      {
        type: "presentation_cleanup_started",
        cleanupId: "cleanup-1",
        workspaceId: "test-workspace",
      },
      "CleanupStarted",
      undefined,
      9,
    ],
    [
      {
        type: "presentation_cleanup_completed",
        cleanupId: "cleanup-1",
        workspaceId: "test-workspace",
      },
      "CleanupFinished",
      undefined,
      10,
    ],
  ];
  const { actual, expected } = run(queued, samples);
  assert.equal(actual, expected);
});

test("authority handoff confirms only the successor generation", () => {
  const instruction = {
    ...running.startDeliveryAuthority,
    dispatcherId: "successor",
    deliveryGeneration: 2,
  };
  delete instruction.acquiredAt;
  const samples = [
    [
      {
        type: "start_delivery_authority_revoked",
        successorDispatcherId: "successor",
        deliveryGeneration: 2,
      },
      "AuthorityRevoked",
      2,
      running.stateSeq + 1,
    ],
    [
      {
        type: "start_delivery_generation_confirmed",
        dispatcherId: "successor",
        deliveryGeneration: 1,
        acceptanceState: "not_accepted",
      },
      "GenerationConfirmed",
      1,
      running.stateSeq + 2,
    ],
    [
      {
        type: "start_delivery_generation_confirmed",
        dispatcherId: "successor",
        deliveryGeneration: 2,
        acceptanceState: "not_accepted",
      },
      "GenerationConfirmed",
      2,
      running.stateSeq + 2,
    ],
    [
      { type: "start_delivery_authority_acquired", instruction },
      "AuthorityAcquired",
      2,
      running.stateSeq + 3,
    ],
  ];
  const { actual, expected } = run(running, samples);
  assert.equal(actual, expected);
});

// Deterministic PRNG: failed events keep the snapshot and do not consume a sequence.
function random(seed) {
  let value = seed;
  return (max) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value % max;
  };
}

for (const [seedName, seedState] of [
  ["new", undefined],
  ["queued", queued],
  ["running", running],
  ["accepted", accepted],
  ["completed", completed],
]) {
  test(`random replay after every step: ${seedName}`, () => {
    const roll = random(
      0x19ab + seedName.length * 37 + (seedState?.stateSeq ?? 0)
    );
    const samples = [];
    let state = seedState;
    if (state === undefined) {
      samples.push([request, "Requested", undefined, 1]);
      state = tsStep(state, request, 1, 1);
    }
    const choices = [
      () => [request, "Requested"],
      () => [presentation, "PresentationOwned"],
      () => [{ type: "operation_starting" }, "StartingWork"],
      () => [{ type: "worker_launched" }, "WorkerLaunched"],
      (_state, seq) => [result(seq), "ResultAccepted"],
      () => [stop, "StopConfirmed"],
      () => [completion, "Complete"],
      () => [
        { type: "operation_failed", reason: "worker-failed" },
        "MarkFailed",
      ],
      (s) => {
        const epoch = (s?.cancellationEpoch ?? 0) + roll(3);
        return [
          { type: "cancellation_requested", cancellationEpoch: epoch },
          "CancelRequested",
          epoch,
        ];
      },
      (s) => [
        {
          type: "cancel_dispatched",
          cancellationEpoch: s?.cancellationEpoch ?? 0,
        },
        "CancelDispatched",
        s?.cancellationEpoch ?? 0,
      ],
      (s) => [
        {
          type: "cancel_acknowledged",
          cancellationEpoch: s?.cancellationEpoch ?? 0,
          proof: "worker-stop",
        },
        "CancelAcknowledged",
        s?.cancellationEpoch ?? 0,
      ],
      (s) => [
        {
          type: "operation_cancelled",
          cancellationEpoch: s?.cancellationEpoch ?? 0,
        },
        "Cancel",
        s?.cancellationEpoch ?? 0,
      ],
      () => [
        { type: "operation_unknown", reason: "liveness-unproven" },
        "UnknownLiveness",
      ],
      (s) => [
        {
          type: "operation_unknown",
          reason: "cancel-unproven",
          cancellationEpoch: s?.cancellationEpoch ?? 0,
        },
        "UnknownCancel",
        s?.cancellationEpoch ?? 0,
      ],
    ];
    for (let i = 0; i < 45; i++) {
      const seq =
        state === undefined
          ? 1 + roll(3)
          : state.stateSeq + (roll(5) === 0 ? 2 : 1);
      const [input, type, argument] = choices[roll(choices.length)](state, seq);
      samples.push([input, type, argument, seq]);
      state = tsStep(state, input, seq, i + 1);
    }
    const { actual, expected } = run(seedState, samples);
    assert.equal(actual, expected);
  });
}
