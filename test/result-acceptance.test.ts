import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { makeResultAcceptance } from "../src/internal/result-acceptance.js";
import { sha256Digest } from "../src/internal/result-digest.js";
import { makeResultFormatRegistry } from "../src/internal/result-format-registry.js";
import type { ResultFormatRegistry } from "../src/internal/result-format-registry.js";
import type { PinnedResultFormat } from "../src/public.js";
import {
  advanceTestOperationToRunning,
  FakeClock,
  InMemoryEventStore,
} from "../src/internal/testing.js";

async function fixture(
  resultFormat?: Readonly<PinnedResultFormat>,
  resultFormats?: ResultFormatRegistry
) {
  const store = new InMemoryEventStore(
    [],
    new FakeClock(
      Array.from(
        { length: 30 },
        (_, index) => `2026-09-23T01:00:${String(index).padStart(2, "0")}.000Z`
      )
    )
  );
  await Effect.runPromise(
    store.create({
      operationId: "operation-1",
      task: {
        promptRef: "private://prompt",
        profile: "coding",
        idempotencyKey: "task-1",
      },
      requestedConfig: {},
      effectiveConfig: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "medium",
        tools: ["read"],
        cwd: "/work",
        maxResultByteCount: 1024,
        modelPolicy: {
          candidates: [{ provider: "test", id: "model" }],
          attempted: [{ provider: "test", id: "model" }],
          maxAttempts: 1,
          fallback: "forbidden",
          aliases: [],
        },
      },
      maxResultByteCount: 1024,
      ...(resultFormat === undefined ? {} : { resultFormat }),
    })
  );
  await advanceTestOperationToRunning(store, "operation-1");
  return {
    store,
    acceptance: makeResultAcceptance({
      store,
      ...(resultFormats === undefined ? {} : { resultFormats }),
    }),
  };
}

test("形式不適合の結果を受理前に拒否する", async () => {
  const formats = makeResultFormatRegistry([
    {
      formatId: "review-result",
      version: "1",
      normalizationId: "identity.v1",
      validator: {
        validatorId: "review-validator",
        validatorVersion: "1",
        implementation: Buffer.from("invalid-verdict-validator", "utf8"),
        validate: async () => ({ kind: "invalid", reason: "invalid_verdict" }),
      },
    },
  ]);
  const pinned = formats.pin({
    formatId: "review-result",
    version: "1",
    expectations: {},
  });
  const { acceptance } = await fixture(pinned, formats);
  const body = "invalid";
  const bytes = Buffer.from(body, "utf8");
  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", {
      acceptanceRequestId: "request-1",
      body,
      expectedByteCount: bytes.byteLength,
      expectedDigest: sha256Digest(bytes),
    })
  );

  assert.deepEqual(
    outcome.state === "failed" ? outcome.resultFormatRejection : undefined,
    {
      formatId: pinned.formatId,
      version: pinned.version,
      validator: pinned.validator,
      reason: "invalid_verdict",
    }
  );
});

test("形式に適合する結果は受理される", async () => {
  const formats = makeResultFormatRegistry([
    {
      formatId: "review-result",
      version: "1",
      normalizationId: "identity.v1",
      validator: {
        validatorId: "review-validator",
        validatorVersion: "1",
        implementation: Buffer.from("valid-result-validator", "utf8"),
        validate: async () => ({ kind: "valid" }),
      },
    },
  ]);
  const pinned = formats.pin({
    formatId: "review-result",
    version: "1",
    expectations: {},
  });
  const { acceptance } = await fixture(pinned, formats);
  const body = "valid";
  const bytes = Buffer.from(body, "utf8");
  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", {
      acceptanceRequestId: "request-1",
      body,
      expectedByteCount: bytes.byteLength,
      expectedDigest: sha256Digest(bytes),
    })
  );

  assert.equal(outcome.state, "accepted");
});

test("正確なUTF-8結果を受理する", async () => {
  const { acceptance } = await fixture();
  const body = "完了";
  const bytes = Buffer.from(body, "utf8");
  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", {
      acceptanceRequestId: "request-1",
      body,
      expectedByteCount: bytes.byteLength,
      expectedDigest: sha256Digest(bytes),
    })
  );
  assert.equal(outcome.state, "accepted");
});

test("同じ要求の再送は同じ結果受理へ合流する", async () => {
  const { acceptance } = await fixture();
  const bytes = Buffer.from("done", "utf8");
  const produced = {
    acceptanceRequestId: "request-1",
    body: "done",
    expectedByteCount: bytes.byteLength,
    expectedDigest: sha256Digest(bytes),
  };
  const first = await Effect.runPromise(
    acceptance.accept("operation-1", produced)
  );
  const second = await Effect.runPromise(
    acceptance.accept("operation-1", produced)
  );
  assert.equal(
    second.state === "accepted" ? second.proof.acceptanceId : undefined,
    first.state === "accepted" ? first.proof.acceptanceId : undefined
  );
});

test("完全性宣言が本文と異なる結果を拒否する", async () => {
  const { acceptance } = await fixture();
  const outcome = await Effect.runPromise(
    acceptance.accept("operation-1", {
      acceptanceRequestId: "request-1",
      body: "done",
      expectedByteCount: 5,
      expectedDigest: sha256Digest(Buffer.from("done", "utf8")),
    })
  );
  assert.equal(
    outcome.state === "failed" ? outcome.reason : undefined,
    "input_integrity_mismatch"
  );
});

test("形式検証器がない場合は結果を保留する", async () => {
  const formats = makeResultFormatRegistry([
    {
      formatId: "review-result",
      version: "1",
      normalizationId: "identity.v1",
      validator: {
        validatorId: "review-validator",
        validatorVersion: "1",
        implementation: Buffer.from("valid-result-validator", "utf8"),
        validate: async () => ({ kind: "valid" }),
      },
    },
  ]);
  const pinned = formats.pin({ formatId: "review-result", version: "1", expectations: {} });
  const { acceptance } = await fixture(pinned);
  const bytes = Buffer.from("valid", "utf8");
  const outcome = await Effect.runPromise(acceptance.accept("operation-1", {
    acceptanceRequestId: "request-1",
    body: "valid",
    expectedByteCount: bytes.byteLength,
    expectedDigest: sha256Digest(bytes),
  }));

  assert.deepEqual(outcome, { state: "continuable", reason: "validator_unavailable" });
});

test("形式検証器を復元すると保留した結果を受理できる", async () => {
  const formats = makeResultFormatRegistry([
    {
      formatId: "review-result",
      version: "1",
      normalizationId: "identity.v1",
      validator: {
        validatorId: "review-validator",
        validatorVersion: "1",
        implementation: Buffer.from("valid-result-validator", "utf8"),
        validate: async () => ({ kind: "valid" }),
      },
    },
  ]);
  const pinned = formats.pin({ formatId: "review-result", version: "1", expectations: {} });
  const { store, acceptance } = await fixture(pinned);
  const bytes = Buffer.from("valid", "utf8");
  const produced = {
    acceptanceRequestId: "request-1",
    body: "valid",
    expectedByteCount: bytes.byteLength,
    expectedDigest: sha256Digest(bytes),
  };
  await Effect.runPromise(acceptance.accept("operation-1", produced));
  const recovered = makeResultAcceptance({ store, resultFormats: formats });
  const outcome = await Effect.runPromise(recovered.accept("operation-1", produced));

  assert.equal(outcome.state, "accepted");
});

test("登録済み検証器が利用できない場合も結果を保留する", async () => {
  const formats = makeResultFormatRegistry([
    {
      formatId: "review-result",
      version: "1",
      normalizationId: "identity.v1",
      validator: {
        validatorId: "review-validator",
        validatorVersion: "1",
        implementation: Buffer.from("unavailable-validator", "utf8"),
        validate: async () => { throw new Error("validator unavailable"); },
      },
    },
  ]);
  const pinned = formats.pin({ formatId: "review-result", version: "1", expectations: {} });
  const { acceptance } = await fixture(pinned, formats);
  const bytes = Buffer.from("valid", "utf8");
  const outcome = await Effect.runPromise(acceptance.accept("operation-1", {
    acceptanceRequestId: "request-1",
    body: "valid",
    expectedByteCount: bytes.byteLength,
    expectedDigest: sha256Digest(bytes),
  }));

  assert.deepEqual(outcome, { state: "continuable", reason: "validator_unavailable" });
});
