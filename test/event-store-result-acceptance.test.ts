import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Effect } from "effect";

import type {
  EventStore,
  ResultAcceptanceRequest,
} from "../src/internal/event-store/index.js";
import {
  operationDirectoryKey,
  PrivateFileEventStore,
} from "../src/internal/event-store/index.js";
import type { OperationEvent } from "../src/internal/event-store/model.js";
import {
  FakeClock,
  InMemoryEventStore,
  advanceTestOperationToRunning,
} from "../src/internal/testing.js";
import {
  effectiveConfig,
  requestedConfig,
  maxResultByteCount,
} from "./worker-protocol-fixtures.js";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;

function clock(): FakeClock {
  return new FakeClock(
    Array.from(
      { length: 30 },
      (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
}

function request(
  body: string | Uint8Array = "finished",
  acceptanceRequestId = "request-1"
): ResultAcceptanceRequest {
  return {
    operationId: "operation-1",
    acceptanceRequestId,
    bytes: typeof body === "string" ? Buffer.from(body, "utf8") : body,
  };
}

async function createOperation(store: EventStore): Promise<void> {
  await Effect.runPromise(
    store.create({
      operationId: "operation-1",
      task: {
        promptRef: "private://prompt/1",
        profile: "coding",
        idempotencyKey: "task-1",
      },
      requestedConfig,
      effectiveConfig,
      maxResultByteCount,
    })
  );
}

async function makeRunning(store: EventStore): Promise<void> {
  await createOperation(store);
  await advanceTestOperationToRunning(store, "operation-1");
}

async function runningStore(
  trace: Array<string> = []
): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore(trace, clock());
  await makeRunning(store);
  return store;
}

async function privateRoot(context: TestContext): Promise<string> {
  const root = join(
    tmpdir(),
    `pions-result-acceptance-${process.pid}-${crypto.randomUUID()}`
  );
  await mkdir(root, { mode: 0o700 });
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function storeFailure(
  effect: Effect.Effect<unknown, { readonly code: string }>
) {
  return Effect.runPromise(Effect.flip(effect));
}

async function acceptedResult(store: EventStore) {
  return (await Effect.runPromise(store.read("operation-1"))).operation.result;
}

class FaultInjectedEventStore extends InMemoryEventStore {
  fault: "before_accepted" | "after_accepted" | undefined;

  protected override willAppend(event: OperationEvent): void {
    if (this.fault === "before_accepted" && event.type === "result_accepted")
      throw new Error("injected interruption");
  }

  protected override didAppend(event: OperationEvent): void {
    super.didAppend(event);
    if (this.fault === "after_accepted" && event.type === "result_accepted") {
      throw new Error("injected response loss");
    }
  }
}

test("accepting a Worker final answer publishes the Result acceptance on the Operation", async () => {
  const store = await runningStore();

  await Effect.runPromise(store.acceptResult(request()));

  assert.equal((await acceptedResult(store))?.acceptanceRequestId, "request-1");
});

test("the accepted Result records the exact byte count of the body", async () => {
  const store = await runningStore();

  await Effect.runPromise(store.acceptResult(request("先頭🌱末尾")));

  assert.equal(
    (await acceptedResult(store))?.byteCount,
    Buffer.byteLength("先頭🌱末尾", "utf8")
  );
});

test("the accepted Result records the SHA-256 digest of the exact bytes", async () => {
  const store = await runningStore();
  const bytes = Buffer.from("finished\n", "utf8");

  await Effect.runPromise(store.acceptResult(request(bytes)));

  assert.equal((await acceptedResult(store))?.digest, digest(bytes));
});

test("the accepted Result identifier is derived from the request and the accepted bytes", async () => {
  const store = await runningStore();

  await Effect.runPromise(store.acceptResult(request()));

  assert.match(
    (await acceptedResult(store))?.acceptanceId ?? "",
    /^pions\.result-acceptance\.v1:[0-9a-f]{64}$/u
  );
});

test("the accepted Result bytes are read back verbatim", async () => {
  const store = await runningStore();
  await Effect.runPromise(store.acceptResult(request("line one\r\nline two")));

  const body = await Effect.runPromise(store.readResultBody("operation-1"));

  assert.equal(
    Buffer.from(body ?? []).toString("utf8"),
    "line one\r\nline two"
  );
});

test("an Operation without an accepted Result has no persisted body", async () => {
  const store = await runningStore();

  assert.equal(
    await Effect.runPromise(store.readResultBody("operation-1")),
    undefined
  );
});

test("a resent request with the same bytes returns the same acceptance", async () => {
  const store = await runningStore();
  const first = await Effect.runPromise(store.acceptResult(request()));

  const resent = await Effect.runPromise(store.acceptResult(request()));

  assert.deepEqual(resent, first);
});

test("a resent request with the same bytes appends no second acceptance event", async () => {
  const trace: Array<string> = [];
  const store = await runningStore(trace);
  await Effect.runPromise(store.acceptResult(request()));

  await Effect.runPromise(store.acceptResult(request()));

  assert.equal(
    trace.filter((entry) => entry.includes('"type":"result_accepted"')).length,
    1
  );
});

test("the same request with different bytes is a request mismatch", async () => {
  const store = await runningStore();
  await Effect.runPromise(store.acceptResult(request("first")));

  const outcome = await Effect.runPromise(
    store.acceptResult(request("second"))
  );

  assert.equal(
    outcome.kind === "failed" ? outcome.reason : undefined,
    "request_mismatch"
  );
});

test("the same request with different bytes does not replace the accepted Result", async () => {
  const store = await runningStore();
  await Effect.runPromise(store.acceptResult(request("first")));

  await Effect.runPromise(store.acceptResult(request("second")));

  assert.equal(
    (await acceptedResult(store))?.digest,
    digest(Buffer.from("first", "utf8"))
  );
});

test("another request with the same bytes joins the accepted Result", async () => {
  const store = await runningStore();
  const first = await Effect.runPromise(
    store.acceptResult(request("same", "request-1"))
  );

  const joined = await Effect.runPromise(
    store.acceptResult(request("same", "request-2"))
  );

  assert.equal(
    joined.kind === "accepted" ? joined.acceptance.acceptanceId : undefined,
    first.kind === "accepted" ? first.acceptance.acceptanceId : undefined
  );
});

test("another request with different bytes is a Result conflict", async () => {
  const store = await runningStore();
  await Effect.runPromise(store.acceptResult(request("first", "request-1")));

  const outcome = await Effect.runPromise(
    store.acceptResult(request("second", "request-2"))
  );

  assert.equal(
    outcome.kind === "failed" ? outcome.reason : undefined,
    "result_conflict"
  );
});

test("a body over the Operation body limit is rejected", async () => {
  const store = await runningStore();
  const bytes = Buffer.alloc(maxResultByteCount + 1, "a");

  const outcome = await Effect.runPromise(store.acceptResult(request(bytes)));

  assert.equal(
    outcome.kind === "failed" ? outcome.reason : undefined,
    "limit_exceeded"
  );
});

test("a body at the Operation body limit is accepted", async () => {
  const store = await runningStore();
  const bytes = Buffer.alloc(maxResultByteCount, "a");

  const outcome = await Effect.runPromise(store.acceptResult(request(bytes)));

  assert.equal(outcome.kind, "accepted");
});

test("a body with invalid UTF-8 is rejected", async () => {
  const store = await runningStore();

  const outcome = await Effect.runPromise(
    store.acceptResult(request(Uint8Array.from([0x61, 0xff, 0x62])))
  );

  assert.equal(
    outcome.kind === "failed" ? outcome.reason : undefined,
    "invalid_utf8"
  );
});

test("a rejected body leaves no persisted Result bytes", async () => {
  const store = await runningStore();

  await Effect.runPromise(
    store.acceptResult(request(Uint8Array.from([0x61, 0xff, 0x62])))
  );

  assert.equal(
    await Effect.runPromise(store.readResultBody("operation-1")),
    undefined
  );
});

test("an acceptance request identifier outside the identifier grammar is a request mismatch", async () => {
  const store = await runningStore();

  const outcome = await Effect.runPromise(
    store.acceptResult(request("finished", "request 1"))
  );

  assert.equal(
    outcome.kind === "failed" ? outcome.reason : undefined,
    "request_mismatch"
  );
});

test("an Operation that is not running cannot accept a Result", async () => {
  const store = new InMemoryEventStore([], clock());
  await createOperation(store);

  const outcome = await Effect.runPromise(store.acceptResult(request()));

  assert.equal(
    outcome.kind === "failed" ? outcome.reason : undefined,
    "invalid_operation_state"
  );
});

test("an unknown Operation cannot accept a Result", async () => {
  const store = await runningStore();

  const outcome = await Effect.runPromise(
    store.acceptResult({ ...request(), operationId: "operation-9" })
  );

  assert.equal(
    outcome.kind === "failed" ? outcome.reason : undefined,
    "operation_not_found"
  );
});

test("an interruption before acceptance persistence leaves the Result unaccepted", async () => {
  const store = new FaultInjectedEventStore([], clock());
  await makeRunning(store);
  store.fault = "before_accepted";

  await Effect.runPromise(store.acceptResult(request()));

  assert.equal(await acceptedResult(store), undefined);
});

test("an interruption before acceptance persistence is reported as continuable", async () => {
  const store = new FaultInjectedEventStore([], clock());
  await makeRunning(store);
  store.fault = "before_accepted";

  const outcome = await Effect.runPromise(store.acceptResult(request()));

  assert.equal(
    outcome.kind === "continuable" ? outcome.reason : undefined,
    "write_failed"
  );
});

test("a retry after response loss returns the persisted acceptance", async () => {
  const store = new FaultInjectedEventStore([], clock());
  await makeRunning(store);
  store.fault = "after_accepted";
  await Effect.runPromise(store.acceptResult(request()));
  store.fault = undefined;

  const retried = await Effect.runPromise(store.acceptResult(request()));

  assert.equal(retried.kind, "accepted");
});

test("a published acceptance keeps its identifier after restart", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  const accepted = await Effect.runPromise(store.acceptResult(request()));

  const reopened = new PrivateFileEventStore(root, clock());

  assert.equal(
    (await acceptedResult(reopened))?.acceptanceId,
    accepted.kind === "accepted" ? accepted.acceptance.acceptanceId : undefined
  );
});

test("the accepted Result bytes are read back after restart", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  await Effect.runPromise(store.acceptResult(request("durable 🌱")));

  const reopened = new PrivateFileEventStore(root, clock());

  assert.equal(
    Buffer.from(
      (await Effect.runPromise(reopened.readResultBody("operation-1"))) ?? []
    ).toString("utf8"),
    "durable 🌱"
  );
});

test("the accepted Result bytes live in the Operation's private record directory", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  await Effect.runPromise(store.acceptResult(request("finished")));

  const stored = await readFile(
    join(root, operationDirectoryKey("operation-1"), "result.v1.utf8")
  );

  assert.equal(stored.toString("utf8"), "finished");
});

test("a rewritten acceptance record is rejected as corrupt", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  await Effect.runPromise(store.acceptResult(request()));
  const path = join(
    root,
    operationDirectoryKey("operation-1"),
    "events.v27.json"
  );
  const record = JSON.parse(await readFile(path, "utf8")) as {
    events: Array<{ type: string; acceptance?: { byteCount: number } }>;
  };
  const accepted = record.events.find(
    (event) => event.type === "result_accepted"
  );
  if (accepted?.acceptance !== undefined) accepted.acceptance.byteCount += 1;
  await writeFile(path, JSON.stringify(record));

  const failure = await storeFailure(
    new PrivateFileEventStore(root, clock()).read("operation-1")
  );

  assert.equal(failure.code, "corrupt_record");
});

test("an old Event Store root is rejected instead of initialized as the current schema", async (context) => {
  const root = await privateRoot(context);
  const store = new PrivateFileEventStore(root, clock());
  await makeRunning(store);
  const directory = join(root, operationDirectoryKey("operation-1"));
  await rename(
    join(directory, "events.v27.json"),
    join(directory, "events.v10.json")
  );

  const failure = await storeFailure(
    new PrivateFileEventStore(root, clock()).read("operation-1")
  );

  assert.equal(failure.code, "unsupported_schema");
});

test("parallel conflicting acceptances append only one acceptance event", async () => {
  const trace: Array<string> = [];
  const store = await runningStore(trace);
  trace.length = 0;

  await Promise.all([
    Effect.runPromise(store.acceptResult(request("first", "request-1"))),
    Effect.runPromise(store.acceptResult(request("second", "request-2"))),
  ]);

  assert.equal(
    trace.filter((entry) => entry.includes('"type":"result_accepted"')).length,
    1
  );
});
