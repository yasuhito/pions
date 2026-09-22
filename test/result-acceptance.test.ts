import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Effect } from "effect";

import { makeResultAcceptance } from "../src/internal/result-acceptance.js";
import {
  makeResultFormatRegistry,
  type ResultFormatRegistry,
} from "../src/internal/result-format-registry.js";
import {
  FakeClock,
  InMemoryEventStore,
  advanceTestOperationToRunning,
} from "../src/internal/testing.js";
import type {
  PinnedResultFormat,
  ResultFormatValidationFailureReason,
  WorkerProducedResult,
} from "../src/public.js";
import {
  effectiveConfig,
  requestedConfig,
  retentionPolicy,
  workProductRequirements,
} from "./worker-protocol-fixtures.js";

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
}

function produced(
  body = "finished",
  acceptanceRequestId = "request-1"
): WorkerProducedResult {
  const bytes = Buffer.from(body, "utf8");
  return {
    acceptanceRequestId,
    body: {
      formatId: "pions.result-body.v1",
      normalizationId: "identity.v1",
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest(bytes),
      bytes,
    },
    workProducts: [],
  };
}

async function fixture(
  resultFormat?: Readonly<{
    readonly registry: ResultFormatRegistry;
    readonly pinned: Readonly<PinnedResultFormat>;
  }>
) {
  const clock = new FakeClock(
    Array.from(
      { length: 30 },
      (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
  const store = new InMemoryEventStore([], clock);
  await Effect.runPromise(
    store.create({
      operationId: "operation-1",
      task: {
        promptRef: "private://prompt",
        profile: "coding",
        idempotencyKey: "task-1",
      },
      requestedConfig,
      effectiveConfig,
      workProductRequirements,
      resultRetentionPolicy: retentionPolicy("operation-1"),
      ...(resultFormat === undefined
        ? {}
        : { resultFormat: resultFormat.pinned }),
      lineage: { rootOperationId: "operation-1", depth: 0 },
      startAuthorization: {
        configuredPolicy: "disabled",
        policy: "disabled",
        windowMs: 0,
        authorizedSubjectIds: [],
      },
    })
  );
  await advanceTestOperationToRunning(store, "operation-1");
  return {
    store,
    acceptance: makeResultAcceptance({
      store,
      ...(resultFormat === undefined
        ? {}
        : { resultFormats: resultFormat.registry }),
    }),
  };
}

async function storedResult(store: InMemoryEventStore) {
  return (await Effect.runPromise(store.read("operation-1"))).operation.result;
}

async function storedBody(store: InMemoryEventStore) {
  const bytes = await Effect.runPromise(store.readResultBody("operation-1"));
  return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
}

function configuredResultFormat(
  validate: (input: {
    readonly bytes: Uint8Array;
    readonly formatId: string;
    readonly version: string;
    readonly normalizationId: string;
    readonly expectations: Readonly<Record<string, string>>;
  }) => Promise<
    | { readonly kind: "valid" }
    | {
        readonly kind: "invalid";
        readonly reason: ResultFormatValidationFailureReason;
      }
  >
) {
  const registry = makeResultFormatRegistry([
    {
      formatId: "test.formal-review-result",
      version: "1",
      normalizationId: "test.canonical-json.v1",
      validator: {
        validatorId: "test.formal-review-result-validator",
        validatorVersion: "1",
        registrationArtifact: Buffer.from("test validator v1", "utf8"),
        validate,
      },
    },
  ]);
  return {
    registry,
    pinned: registry.pin({
      formatId: "test.formal-review-result",
      version: "1",
      expectations: { axis: "standards" },
    }),
  };
}

for (const reason of [
  "invalid_encoding",
  "invalid_json",
  "duplicate_key",
  "unknown_key",
  "missing_key",
  "invalid_verdict",
  "invalid_finding",
  "expectation_mismatch",
] as const) {
  test(`a formal review Result rejected for ${reason} is not accepted`, async () => {
    const format = configuredResultFormat(async () => ({
      kind: "invalid",
      reason,
    }));
    const { acceptance } = await fixture(format);

    const outcome = await Effect.runPromise(
      acceptance.accept("operation-1", produced())
    );

    assert.equal(
      outcome.state === "failed"
        ? outcome.resultFormatRejection?.reason
        : undefined,
      reason
    );
  });
}

test("a formal review validator receives the pinned format contract", async () => {
  let received:
    | Readonly<{
        formatId: string;
        version: string;
        normalizationId: string;
        expectations: Readonly<Record<string, string>>;
      }>
    | undefined;
  const format = configuredResultFormat(async (input) => {
    received = {
      formatId: input.formatId,
      version: input.version,
      normalizationId: input.normalizationId,
      expectations: input.expectations,
    };
    return { kind: "valid" };
  });
  const { acceptance } = await fixture(format);

  await Effect.runPromise(acceptance.accept("operation-1", produced()));

  assert.deepEqual(received, {
    formatId: "test.formal-review-result",
    version: "1",
    normalizationId: "test.canonical-json.v1",
    expectations: { axis: "standards" },
  });
});

test("a rejected formal review Result is not published", async () => {
  const format = configuredResultFormat(async () => ({
    kind: "invalid",
    reason: "invalid_json",
  }));
  const { acceptance, store } = await fixture(format);

  await Effect.runPromise(acceptance.accept("operation-1", produced()));

  assert.equal(await storedResult(store), undefined);
});

test("a valid formal review Result preserves its original bytes", async () => {
  const body = '{ "axis": "standards" }\n';
  const format = configuredResultFormat(async ({ bytes }) => {
    bytes.fill(0x78);
    return { kind: "valid" };
  });
  const { acceptance, store } = await fixture(format);

  await Effect.runPromise(acceptance.accept("operation-1", produced(body)));

  assert.equal(await storedBody(store), body);
});

test("an unavailable validator rejects a formal review Result", async () => {
  const format = configuredResultFormat(async () => ({ kind: "valid" }));
  const { acceptance } = await fixture({
    ...format,
    registry: makeResultFormatRegistry([]),
  });

  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", produced())
  );

  assert.equal(
    outcome.state === "failed"
      ? outcome.resultFormatRejection?.reason
      : undefined,
    "validator_unavailable"
  );
});

test("a changed validator identity rejects an unaccepted formal review Result", async () => {
  const original = configuredResultFormat(async () => ({ kind: "valid" }));
  const replacement = makeResultFormatRegistry([
    {
      formatId: "test.formal-review-result",
      version: "1",
      normalizationId: "test.canonical-json.v1",
      validator: {
        validatorId: "test.formal-review-result-validator",
        validatorVersion: "2",
        registrationArtifact: Buffer.from("replacement validator", "utf8"),
        validate: async () => ({ kind: "valid" }),
      },
    },
  ]);
  const { acceptance } = await fixture({
    registry: replacement,
    pinned: original.pinned,
  });

  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", produced())
  );

  assert.equal(
    outcome.state === "failed"
      ? outcome.resultFormatRejection?.reason
      : undefined,
    "validator_identity_mismatch"
  );
});

test("an accepted Result replay is not reinterpreted by a changed validator", async () => {
  const original = configuredResultFormat(async () => ({ kind: "valid" }));
  const { acceptance, store } = await fixture(original);
  const first = await Effect.runPromise(
    acceptance.accept("operation-1", produced())
  );
  const replacement = makeResultFormatRegistry([
    {
      formatId: "test.formal-review-result",
      version: "1",
      normalizationId: "test.canonical-json.v1",
      validator: {
        validatorId: "test.formal-review-result-validator",
        validatorVersion: "2",
        registrationArtifact: Buffer.from("replacement validator", "utf8"),
        validate: async () => ({
          kind: "invalid" as const,
          reason: "invalid_json" as const,
        }),
      },
    },
  ]);
  const replayAcceptance = makeResultAcceptance({
    store,
    resultFormats: replacement,
  });

  const replay = await Effect.runPromise(
    replayAcceptance.accept("operation-1", produced())
  );

  assert.equal(
    replay.state === "accepted" && first.state === "accepted"
      ? replay.proof.acceptanceId
      : undefined,
    first.state === "accepted" ? first.proof.acceptanceId : undefined
  );
});

test("Result acceptance reports a missing Operation as not found", async () => {
  const { acceptance } = await fixture();

  const outcome = await Effect.runPromise(
    acceptance.accept("missing-operation", produced())
  );

  assert.equal(
    outcome.state === "failed" ? outcome.reason : undefined,
    "operation_not_found"
  );
});

test("a Worker final answer is accepted as the Operation-owned Result", async () => {
  const { acceptance } = await fixture();

  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", produced())
  );

  assert.equal(outcome.state, "accepted");
});

test("the acceptance proof carries the digest of the accepted bytes", async () => {
  const { acceptance } = await fixture();

  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", produced("finished"))
  );

  assert.equal(
    outcome.state === "accepted" ? outcome.proof.digest : undefined,
    digest(Buffer.from("finished", "utf8"))
  );
});

test("Result acceptance persists the exact body bytes", async () => {
  const { acceptance, store } = await fixture();

  await Effect.runPromise(
    acceptance.accept("operation-1", produced("先頭\r\n🌱\n末尾"))
  );

  assert.equal(await storedBody(store), "先頭\r\n🌱\n末尾");
});

test("a streamed body is accepted verbatim", async () => {
  const { acceptance, store } = await fixture();
  const bytes = Buffer.from("streamed 🌍 body", "utf8");
  const result: WorkerProducedResult = {
    ...produced(),
    body: {
      ...produced().body,
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest(bytes),
      bytes: (async function* () {
        yield bytes.subarray(0, 10);
        yield bytes.subarray(10);
      })(),
    },
  };

  await Effect.runPromise(acceptance.accept("operation-1", result));

  assert.equal(await storedBody(store), "streamed 🌍 body");
});

test("a body whose bytes do not match the declared digest is rejected", async () => {
  const { acceptance } = await fixture();
  const result: WorkerProducedResult = {
    ...produced(),
    body: {
      ...produced().body,
      expectedDigest: digest(Buffer.from("other", "utf8")),
    },
  };

  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", result)
  );

  assert.equal(
    outcome.state === "failed" ? outcome.reason : undefined,
    "input_integrity_mismatch"
  );
});

test("a body whose bytes do not match the declared byte count is rejected", async () => {
  const { acceptance } = await fixture();
  const result: WorkerProducedResult = {
    ...produced(),
    body: { ...produced().body, expectedByteCount: 1 },
  };

  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", result)
  );

  assert.equal(
    outcome.state === "failed" ? outcome.reason : undefined,
    "input_integrity_mismatch"
  );
});

test("a mismatched body leaves the Operation without a Result", async () => {
  const { acceptance, store } = await fixture();
  const result: WorkerProducedResult = {
    ...produced(),
    body: { ...produced().body, expectedByteCount: 1 },
  };

  await Effect.runPromise(acceptance.accept("operation-1", result));

  assert.equal(await storedResult(store), undefined);
});

test("a Result with work products is rejected", async () => {
  const { acceptance } = await fixture();
  const attachment = Buffer.from("attachment", "utf8");

  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", {
      ...produced(),
      workProducts: [
        {
          key: "attachment",
          formatId: "pions.opaque.v1",
          normalizationId: "identity.v1",
          expectedByteCount: attachment.byteLength,
          expectedDigest: digest(attachment),
          bytes: attachment,
        },
      ],
    })
  );

  assert.equal(
    outcome.state === "failed" ? outcome.reason : undefined,
    "work_products_unsupported"
  );
});

test("a Result with work products leaves the Operation without a Result", async () => {
  const { acceptance, store } = await fixture();
  const attachment = Buffer.from("attachment", "utf8");

  await Effect.runPromise(
    acceptance.accept("operation-1", {
      ...produced(),
      workProducts: [
        {
          key: "attachment",
          formatId: "pions.opaque.v1",
          normalizationId: "identity.v1",
          expectedByteCount: attachment.byteLength,
          expectedDigest: digest(attachment),
          bytes: attachment,
        },
      ],
    })
  );

  assert.equal(await storedResult(store), undefined);
});

test("a repeated acceptance request returns the same acceptance identifier", async () => {
  const { acceptance } = await fixture();
  const first = await Effect.runPromise(
    acceptance.accept("operation-1", produced())
  );

  const repeated = await Effect.runPromise(
    acceptance.accept("operation-1", produced())
  );

  assert.equal(
    repeated.state === "accepted" && first.state === "accepted"
      ? repeated.proof.acceptanceId
      : undefined,
    first.state === "accepted" ? first.proof.acceptanceId : undefined
  );
});

test("the same acceptance request with different content is a request mismatch", async () => {
  const { acceptance } = await fixture();
  await Effect.runPromise(acceptance.accept("operation-1", produced("first")));

  const conflicting = await Effect.runPromise(
    acceptance.accept("operation-1", produced("second"))
  );

  assert.equal(
    conflicting.state === "failed" ? conflicting.reason : undefined,
    "request_mismatch"
  );
});

test("another request with the same content returns the accepted identifier", async () => {
  const { acceptance } = await fixture();
  const first = await Effect.runPromise(
    acceptance.accept("operation-1", produced("same", "request-1"))
  );

  const joined = await Effect.runPromise(
    acceptance.accept("operation-1", produced("same", "request-2"))
  );

  assert.equal(
    joined.state === "accepted" && first.state === "accepted"
      ? joined.proof.acceptanceId
      : undefined,
    first.state === "accepted" ? first.proof.acceptanceId : undefined
  );
});

test("another request with different content is a Result conflict", async () => {
  const { acceptance } = await fixture();
  await Effect.runPromise(
    acceptance.accept("operation-1", produced("first", "request-1"))
  );

  const conflicting = await Effect.runPromise(
    acceptance.accept("operation-1", produced("second", "request-2"))
  );

  assert.equal(
    conflicting.state === "failed" ? conflicting.reason : undefined,
    "result_conflict"
  );
});

test("a body with invalid UTF-8 is rejected", async () => {
  const { acceptance } = await fixture();
  const bytes = Uint8Array.from([0xff]);
  const result: WorkerProducedResult = {
    acceptanceRequestId: "request-invalid",
    body: {
      formatId: "pions.result-body.v1",
      normalizationId: "identity.v1",
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest(bytes),
      bytes,
    },
    workProducts: [],
  };

  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", result)
  );

  assert.equal(
    outcome.state === "failed" ? outcome.reason : undefined,
    "invalid_utf8"
  );
});

test("a body with invalid UTF-8 is not published", async () => {
  const { acceptance, store } = await fixture();
  const bytes = Uint8Array.from([0xff]);
  const result: WorkerProducedResult = {
    acceptanceRequestId: "request-invalid",
    body: {
      formatId: "pions.result-body.v1",
      normalizationId: "identity.v1",
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest(bytes),
      bytes,
    },
    workProducts: [],
  };

  await Effect.runPromise(acceptance.accept("operation-1", result));

  assert.equal(await storedResult(store), undefined);
});

test("a body over the Operation body limit is rejected", async () => {
  const { acceptance } = await fixture();

  const outcome = await Effect.runPromise(
    acceptance.accept(
      "operation-1",
      produced("a".repeat(workProductRequirements.body.maxByteCount + 1))
    )
  );

  assert.equal(
    outcome.state === "failed" ? outcome.reason : undefined,
    "limit_exceeded"
  );
});
