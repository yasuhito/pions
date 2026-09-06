import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/domain.js";
import { makeResultAcceptance } from "../src/internal/result-acceptance.js";
import {
  FakeChildChannel,
  FakeClock,
  InMemoryEventStore,
} from "../src/internal/testing.js";

async function runningOperation(
  store: InMemoryEventStore,
  operationId = "operation-1",
): Promise<Operation> {
  await Effect.runPromise(store.append(operationId, {
    type: "operation_requested",
    task: {
      promptRef: "file:///prompt.md",
      profile: "coding",
      idempotencyKey: "request-1",
    },
    lineage: { rootOperationId: operationId, depth: 0 },
  }));
  await Effect.runPromise(store.append(operationId, {
    type: "presentation_owned",
    presentation: {
      kind: "herdr_pane",
      paneId: "pane-1",
      ownedByPions: true,
    },
  }));
  await Effect.runPromise(store.append(operationId, { type: "operation_starting" }));
  return Effect.runPromise(store.append(operationId, { type: "operation_started" }));
}

class FailingReceptionChannel extends FakeChildChannel {
  constructor() {
    super({ body: "unused" });
  }

  override receiveResults(_operationId: string) {
    return Effect.fail({
      _tag: "ChannelError" as const,
      message: "disconnected",
    });
  }
}

class FailingAcknowledgementChannel extends FakeChildChannel {
  constructor() {
    super({ body: "accepted" });
  }

  override acknowledgeResult(_operationId: string, _sequenceNumber: number) {
    return Effect.fail({
      _tag: "ChannelError" as const,
      message: "acknowledgement failed",
    });
  }
}

test("a channel failure before Result acceptance is a protocol failure", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({
    channel: new FailingReceptionChannel(),
    store,
  });

  const outcome = await Effect.runPromise(
    acceptance.acceptFromWorker("operation-1"),
  );

  assert.equal(outcome.state, "protocol_failed");
});

test("an acknowledgement failure retains the accepted Result", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({
    channel: new FailingAcknowledgementChannel(),
    store,
  });

  const outcome = await Effect.runPromise(
    acceptance.acceptFromWorker("operation-1"),
  );

  assert.equal(
    outcome.state === "protocol_failed" ? outcome.acceptedResult?.body : undefined,
    "accepted",
  );
});

test("Result acceptance persists bytes and evidence before acknowledgement", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  trace.length = 0;
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel({ body: "finished" }, trace),
    store,
  });

  await Effect.runPromise(acceptance.acceptFromWorker("operation-1"));

  assert.deepEqual(trace, [
    "channel:receive-result",
    "result:bytes-persisted",
    "event:result_persisted",
    "channel:ack:1",
  ]);
});

test("each retry of the same Result is acknowledged regardless of delivery sequence", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  trace.length = 0;
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel([
      { body: "finished", sequenceNumber: 1 },
      { body: "finished", sequenceNumber: 2 },
    ], trace),
    store,
  });

  await Effect.runPromise(acceptance.acceptFromWorker("operation-1"));

  assert.deepEqual(
    trace.filter((entry) => entry.startsWith("channel:ack:")),
    ["channel:ack:1", "channel:ack:2"],
  );
});

test("a retry of the same Result with a different delivery sequence adds one acceptance event", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel([
      { body: "finished", sequenceNumber: 1 },
      { body: "finished", sequenceNumber: 2 },
    ]),
    store,
  });

  await Effect.runPromise(acceptance.acceptFromWorker("operation-1"));

  assert.equal(
    store.events("operation-1").filter(({ type }) => type === "result_persisted").length,
    1,
  );
});

test("a conflicting Result is not acknowledged", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  trace.length = 0;
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel([
      { body: "accepted", sequenceNumber: 1 },
      { body: "conflicting", sequenceNumber: 2 },
    ], trace),
    store,
  });

  await Effect.runPromise(acceptance.acceptFromWorker("operation-1"));

  assert.deepEqual(
    trace.filter((entry) => entry.startsWith("channel:ack:")),
    ["channel:ack:1"],
  );
});

test("Result acceptance stops processing after the first conflict", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  trace.length = 0;
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel([
      { body: "accepted", sequenceNumber: 1 },
      { body: "conflicting", sequenceNumber: 2 },
      { body: "accepted", sequenceNumber: 3 },
    ], trace),
    store,
  });

  await Effect.runPromise(acceptance.acceptFromWorker("operation-1"));

  assert.deepEqual(
    trace.filter((entry) => entry.startsWith("channel:ack:")),
    ["channel:ack:1"],
  );
});

test("the first conflict is reported when multiple conflicts are delivered", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel([
      { body: "accepted", sequenceNumber: 1 },
      { body: "first conflict", sequenceNumber: 2 },
      { body: "second conflict", sequenceNumber: 3 },
    ]),
    store,
  });

  const outcome = await Effect.runPromise(
    acceptance.acceptFromWorker("operation-1"),
  );

  assert.equal(
    outcome.state === "accepted"
      ? outcome.resultDeliveryError?.conflictingDigest
      : undefined,
    "sha256:749d6220f308d86f1fc9717595933ebd2f734bb0fd15d1755454756ee5094988",
  );
});

test("a conflicting Result does not replace the accepted Result", async () => {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel([
      { body: "accepted", sequenceNumber: 1 },
      { body: "conflicting", sequenceNumber: 2 },
    ]),
    store,
  });

  const outcome = await Effect.runPromise(
    acceptance.acceptFromWorker("operation-1"),
  );

  assert.equal(
    outcome.state === "accepted" ? outcome.result.body : undefined,
    "accepted",
  );
});

test("a persistence failure sends no acknowledgement", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4"]),
  );
  await runningOperation(store);
  trace.length = 0;
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel({
      body: "invalid",
      digest: "sha256:wrong",
    }, trace),
    store,
  });

  await Effect.runPromise(Effect.either(
    acceptance.acceptFromWorker("operation-1"),
  ));

  assert.equal(
    trace.some((entry) => entry.startsWith("channel:ack:")),
    false,
  );
});

test("cancellation before Result acceptance leaves no Result bytes", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(
    trace,
    new FakeClock(["time-1", "time-2", "time-3", "time-4", "time-5"]),
  );
  await runningOperation(store);
  await Effect.runPromise(store.append("operation-1", {
    type: "cancellation_requested",
    cancellationEpoch: 1,
  }));
  trace.length = 0;
  const acceptance = makeResultAcceptance({
    channel: new FakeChildChannel({ body: "finished" }, trace),
    store,
  });

  await Effect.runPromise(Effect.either(acceptance.acceptFromWorker("operation-1")));

  assert.equal(trace.includes("result:bytes-persisted"), false);
});
