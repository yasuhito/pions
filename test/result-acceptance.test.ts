import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/event-store/index.js";
import { makeResultAcceptance } from "../src/internal/result-acceptance.js";
import type { ResultDelivery } from "../src/internal/worker-protocol.js";
import {
  FakeClock,
  InMemoryEventStore,
} from "../src/internal/testing.js";
import {
  effectiveConfig,
  requestedConfig,
  resultDigest,
} from "./worker-protocol-fixtures.js";

async function runningOperation(
  store: InMemoryEventStore,
  operationId = "operation-1",
): Promise<Operation> {
  await Effect.runPromise(store.create({
    operationId,
    task: {
      promptRef: "file:///prompt.md",
      profile: "coding",
      idempotencyKey: "request-1",
    },
    requestedConfig,
    effectiveConfig,
    lineage: { rootOperationId: operationId, depth: 0 },
  }));
  await Effect.runPromise(store.advance(operationId, {
    type: "presentation_owned",
    presentation: {
      kind: "herdr_pane",
      paneId: "pane-1",
      ownedByPions: true,
    },
  }));
  await Effect.runPromise(store.advance(operationId, { type: "operation_starting" }));
  await Effect.runPromise(store.advance(operationId, { type: "worker_launched" }));
  return Effect.runPromise(store.advance(operationId, { type: "operation_started" })).then(
    (snapshot) => snapshot.operation,
  );
}

function delivery(
  body: string,
  sequenceNumber: number,
  digest = resultDigest(body),
): ResultDelivery {
  return { operationId: "operation-1", body, digest, sequenceNumber };
}

test("an empty Result delivery is a protocol failure", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({ store });

  const outcome = await Effect.runPromise(acceptance.accept("operation-1", []));

  assert.equal(outcome.state, "protocol_failed");
});

test("a Result delivery for another Operation is a protocol failure", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({ store });

  const outcome = await Effect.runPromise(acceptance.accept("operation-1", [{
    ...delivery("foreign", 1),
    operationId: "operation-2",
  }]));

  assert.equal(outcome.state, "protocol_failed");
});

test("a zero Result delivery sequence is a protocol failure", async () => {
  const store = new InMemoryEventStore([], new FakeClock([
    "time-1", "time-2", "time-3", "time-4", "time-5",
    "time-6",
  ]));
  await runningOperation(store);
  const outcome = await Effect.runPromise(
    makeResultAcceptance({ store }).accept("operation-1", [delivery("invalid", 0)]),
  );

  assert.equal(outcome.state, "protocol_failed");
});

test("a fractional Result delivery sequence is a protocol failure", async () => {
  const store = new InMemoryEventStore([], new FakeClock([
    "time-1", "time-2", "time-3", "time-4", "time-5",
    "time-6",
  ]));
  await runningOperation(store);
  const outcome = await Effect.runPromise(
    makeResultAcceptance({ store }).accept("operation-1", [delivery("invalid", 1.5)]),
  );

  assert.equal(outcome.state, "protocol_failed");
});

test("an unsafe Result delivery sequence is a protocol failure", async () => {
  const store = new InMemoryEventStore([], new FakeClock([
    "time-1", "time-2", "time-3", "time-4", "time-5",
    "time-6",
  ]));
  await runningOperation(store);
  const outcome = await Effect.runPromise(
    makeResultAcceptance({ store }).accept(
      "operation-1",
      [delivery("invalid", Number.MAX_SAFE_INTEGER + 1)],
    ),
  );

  assert.equal(outcome.state, "protocol_failed");
});

test("a Result delivery with a mismatched digest is a protocol failure", async () => {
  const store = new InMemoryEventStore([], new FakeClock([
    "time-1", "time-2", "time-3", "time-4", "time-5", "time-6",
  ]));
  await runningOperation(store);
  const outcome = await Effect.runPromise(
    makeResultAcceptance({ store }).accept("operation-1", [
      delivery("invalid", 1, resultDigest("different")),
    ]),
  );

  assert.equal(outcome.state, "protocol_failed");
});

test("Result acceptance persists bytes before returning a proof", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6"]),
  );
  await runningOperation(store);
  trace.length = 0;
  const acceptance = makeResultAcceptance({ store });

  await Effect.runPromise(acceptance.accept("operation-1", [delivery("finished", 1)]));

  assert.deepEqual(trace, [
    "result:bytes-persisted",
    'event:{"operationId":"operation-1","type":"result_persisted","seq":6,"timestamp":"time-6"}',
  ]);
});

test("Result acceptance returns one proof for each same-Result retry", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({ store });

  const outcome = await Effect.runPromise(acceptance.accept("operation-1", [
    delivery("finished", 1),
    delivery("finished", 2),
  ]));

  assert.deepEqual(
    outcome.state === "accepted" ? outcome.proofs.map((proof) => proof.sequenceNumber) : [],
    [1, 2],
  );
});

test("a same-Result retry adds one acceptance event", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6"]),
  );
  await runningOperation(store);
  trace.length = 0;
  const acceptance = makeResultAcceptance({ store });

  await Effect.runPromise(acceptance.accept("operation-1", [
    delivery("finished", 1),
    delivery("finished", 2),
  ]));

  assert.equal(
    trace.filter((entry) => entry.includes('"type":"result_persisted"')).length,
    1,
  );
});

test("a conflicting Result receives no acceptance proof", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6", "time-7"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({ store });

  const outcome = await Effect.runPromise(acceptance.accept("operation-1", [
    delivery("accepted", 1),
    delivery("conflicting", 2),
  ]));

  assert.deepEqual(
    outcome.state === "accepted" ? outcome.proofs.map((proof) => proof.sequenceNumber) : [],
    [1],
  );
});

test("Result acceptance preserves the first conflict", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6", "time-7"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({ store });

  const outcome = await Effect.runPromise(acceptance.accept("operation-1", [
    delivery("accepted", 1),
    delivery("first conflict", 2),
    delivery("accepted", 3),
  ]));

  assert.equal(
    outcome.state === "accepted"
      ? outcome.resultDeliveryError?.conflictingDigest
      : undefined,
    resultDigest("first conflict"),
  );
});

test("a same-Result retry after a conflict receives an acceptance proof", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6", "time-7"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({ store });

  const outcome = await Effect.runPromise(acceptance.accept("operation-1", [
    delivery("accepted", 1),
    delivery("conflicting", 2),
    delivery("accepted", 3),
  ]));

  assert.deepEqual(
    outcome.state === "accepted" ? outcome.proofs.map((proof) => proof.sequenceNumber) : [],
    [1, 3],
  );
});

test("Result acceptance returns persisted conflict evidence after restart", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6", "time-7"]),
  );
  await runningOperation(store);
  const firstAcceptance = makeResultAcceptance({ store });
  await Effect.runPromise(firstAcceptance.accept("operation-1", [
    delivery("accepted", 1),
    delivery("first conflict", 2),
  ]));
  const restartedAcceptance = makeResultAcceptance({ store });

  const outcome = await Effect.runPromise(restartedAcceptance.accept(
    "operation-1",
    [delivery("later conflict", 3)],
  ));

  assert.equal(
    outcome.state === "accepted"
      ? outcome.resultDeliveryError?.conflictingDigest
      : undefined,
    resultDigest("first conflict"),
  );
});

test("a conflicting Result does not replace the accepted Result", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6", "time-7"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({ store });

  await Effect.runPromise(acceptance.accept("operation-1", [
    delivery("accepted", 1),
    delivery("conflicting", 2),
  ]));

  assert.equal((await Effect.runPromise(store.read("operation-1"))).result?.body, "accepted");
});

test("a persistence failure returns no acceptance proof", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({ store });

  const exit = await Effect.runPromiseExit(acceptance.accept("operation-1", [
    delivery("valid", 1),
  ]));

  assert.equal(exit._tag, "Failure");
});

test("cancellation before Result acceptance leaves no Result bytes", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5", "time-6"]),
  );
  await runningOperation(store);
  await Effect.runPromise(store.advance("operation-1", {
    type: "cancellation_requested",
    cancellationEpoch: 1,
  }));
  trace.length = 0;
  const acceptance = makeResultAcceptance({ store });

  await Effect.runPromise(Effect.either(
    acceptance.accept("operation-1", [delivery("finished", 1)]),
  ));

  assert.equal(trace.includes("result:bytes-persisted"), false);
});
