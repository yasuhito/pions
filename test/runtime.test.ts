import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import type { Operation } from "../src/internal/event-store/index.js";
import type {
  Worker,
  WorkerAdapter,
  WorkerRunHooks,
} from "../src/internal/services.js";
import {
  advanceTestOperationToRunning,
  advanceTestOperationToStartDeliveryAuthority,
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  InMemoryEventStore,
  makeTestRuntime,
} from "../src/internal/testing.js";
import { sha256Digest } from "../src/internal/result-digest.js";
import { makeResultFormatRegistry } from "../src/internal/result-format-registry.js";
import type { PinnedResultFormat, WorkerProfilePolicy } from "../src/public.js";

const profile: WorkerProfilePolicy = {
  modelCandidates: [{ provider: "test", id: "model" }],
  thinkingLevel: "medium",
  tools: ["read"],
  maxResultByteCount: 1024,
};

function clock(): FakeClock {
  return new FakeClock(
    Array.from(
      { length: 80 },
      (_, index) => `2026-09-23T03:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
}

function services(store: InMemoryEventStore, worker: WorkerAdapter) {
  return {
    worker,
    clock: clock(),
    ids: new FakeIdGenerator(["operation-1"]),
    presentation: new FakePresentation(),
    store,
    configuration: { cwd: "/work", profiles: { coding: profile } },
  };
}

test("Runtime exposes only delegation lifecycle operations", () => {
  const runtime = makeTestRuntime({
    ...services(new InMemoryEventStore(), new CancellableWorker(true)),
    recovery: "disabled",
  });

  assert.deepEqual(Object.keys(runtime), ["ready", "close", "spawn", "operation"]);
});

test("new formal review operations are refused", async () => {
  const profileForReview = { ...profile };
  const runtime = makeTestRuntime({
    ...services(new InMemoryEventStore(), new FakeWorkerAdapter()),
    recovery: "disabled",
    configuration: {
      cwd: "/work",
      profiles: { "formal-review": profileForReview },
    },
  });

  await assert.rejects(
    runtime.spawn({
      promptRef: "private://review",
      profile: "formal-review",
      idempotencyKey: "review-1",
    }),
    { name: "WorkerConfigurationError", reason: "unsupported_capability" }
  );
});

async function seed(
  store: InMemoryEventStore,
  resultFormat?: Readonly<PinnedResultFormat>
): Promise<void> {
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
}

class RecoveryWorker implements WorkerAdapter {
  constructor(
    private readonly acceptanceState: "accepted" | "unknown",
    private readonly deliverResult: boolean
  ) {}

  open(): Worker {
    throw new Error("not used");
  }

  recover(operation: Operation): Worker {
    return {
      run: (hooks) => this.run(operation, hooks),
      cancel: () => Effect.succeed({ proof: "worker-stop" as const }),
    };
  }

  private run(operation: Operation, hooks: Readonly<WorkerRunHooks>) {
    return Effect.gen(this, function* () {
      const identity = operation.workerIdentity!;
      const instruction = yield* hooks.workerIdentified({
        processId: identity.processId,
        processInstanceId: identity.processInstanceId,
        processStartToken: identity.processStartToken,
        piSessionId: identity.piSessionId,
        observedConfig: operation.observedConfig!,
      });
      yield* hooks.startDeliveryAuthorityRevoked(
        instruction.dispatcherId,
        instruction.deliveryGeneration
      );
      yield* hooks.deliveryGenerationConfirmed({
        dispatcherId: instruction.dispatcherId,
        deliveryGeneration: instruction.deliveryGeneration,
        acceptanceState: this.acceptanceState,
        ...(this.acceptanceState === "accepted"
          ? { acceptedInstruction: operation.startInstructionAcceptance! }
          : {}),
      });
      if (!this.deliverResult) return { state: "liveness-unproven" as const };
      const body = "recovered result";
      const bytes = Buffer.from(body, "utf8");
      const accepted = yield* hooks.acceptResult({
        acceptanceRequestId: "request-recovered",
        body,
        expectedByteCount: bytes.byteLength,
        expectedDigest: sha256Digest(bytes),
      });
      if (
        accepted.state === "continuable" &&
        accepted.reason === "validator_unavailable"
      )
        return { state: "validator_unavailable" as const };
      if (accepted.state !== "accepted")
        return { state: "worker_protocol_failed" as const };
      return {
        state: "result_acknowledged" as const,
        successfulExitConfirmed: true as const,
        evidence: {
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: 0,
          },
          toolUses: [],
        },
      };
    });
  }
}

class CancellableWorker implements WorkerAdapter {
  private resume: (() => void) | undefined;

  constructor(private readonly confirmsStop: boolean) {}

  open(operation: Operation): Worker {
    return {
      run: (hooks) =>
        Effect.gen(this, function* () {
          yield* hooks.workerLaunched();
          const instruction = yield* hooks.workerIdentified({
            processId: 1,
            processInstanceId: "fake-process-instance",
            processStartToken: "fake-process-start",
            piSessionId: "fake-session",
            observedConfig: {
              model: {
                state: "observed",
                value: operation.effectiveConfig.model,
              },
              thinkingLevel: { state: "observed", value: "medium" },
              tools: { state: "observed", value: ["read"] },
              cwd: { state: "observed", value: "/work" },
            },
          });
          yield* hooks.startDeliveryEntered(instruction);
          yield* hooks.startInstructionDispatched(instruction);
          yield* hooks.startInstructionAccepted(instruction);
          yield* hooks.startInstructionAcknowledged(instruction);
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                this.resume = resolve;
              })
          );
          return { state: "worker_protocol_failed" as const };
        }),
      cancel: () => {
        this.resume?.();
        return Effect.succeed(
          this.confirmsStop ? { proof: "worker-stop" as const } : undefined
        );
      },
    };
  }

  recover(): Worker {
    throw new Error("not used");
  }
}

async function waitForState(
  store: InMemoryEventStore,
  expected: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = (await Effect.runPromise(store.read("operation-1"))).operation
      .state;
    if (state === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Operation did not reach ${expected}`);
}

test("復旧時に開始受理が不明なら開始指示を再配送しない", async () => {
  const trace: Array<string> = [];
  const store = new InMemoryEventStore(trace, clock());
  await seed(store);
  await advanceTestOperationToStartDeliveryAuthority(store, "operation-1");
  const worker = new RecoveryWorker("unknown", false);
  makeTestRuntime({ ...services(store, worker), recovery: "enabled" });
  await waitForState(store, "unknown");
  assert.equal(
    trace.some((entry) =>
      entry.includes('"type":"start_instruction_dispatched"')
    ),
    false
  );
});

test("復旧時に開始受理が不明なら状態不明を永続化する", async () => {
  const store = new InMemoryEventStore([], clock());
  await seed(store);
  await advanceTestOperationToStartDeliveryAuthority(store, "operation-1");
  const runtime = makeTestRuntime({
    ...services(store, new RecoveryWorker("unknown", false)),
    recovery: "enabled",
  });
  await waitForState(store, "unknown");
  const snapshot = await (await runtime.operation("operation-1")).read();
  assert.equal(snapshot.state, "unknown");
});

test("状態不明の理由を状態照会で返す", async () => {
  const store = new InMemoryEventStore([], clock());
  await seed(store);
  await advanceTestOperationToStartDeliveryAuthority(store, "operation-1");
  const runtime = makeTestRuntime({
    ...services(store, new RecoveryWorker("unknown", false)),
    recovery: "enabled",
  });
  await waitForState(store, "unknown");
  const snapshot = await (await runtime.operation("operation-1")).read();
  assert.equal(snapshot.unknownReason, "start-acceptance-unknown");
});

test("作成直後に終了したRuntimeは未配送作業を状態不明にする", async () => {
  const store = new InMemoryEventStore([], clock());
  await seed(store);
  makeTestRuntime({
    ...services(store, new RecoveryWorker("unknown", false)),
    recovery: "enabled",
  });
  await waitForState(store, "unknown");
  const snapshot = await Effect.runPromise(store.read("operation-1"));
  assert.equal(snapshot.operation.terminalReason, "liveness-unproven");
});

test("停止要求後に終了したRuntimeは停止未確認を状態不明にする", async () => {
  const store = new InMemoryEventStore([], clock());
  await seed(store);
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "cancellation_requested",
      cancellationEpoch: 1,
    })
  );
  makeTestRuntime({
    ...services(store, new RecoveryWorker("unknown", false)),
    recovery: "enabled",
  });
  await waitForState(store, "unknown");
  const snapshot = await Effect.runPromise(store.read("operation-1"));
  assert.equal(snapshot.operation.terminalReason, "cancel-unproven");
});

test("Runtime再起動後に結果受理を継続する", async () => {
  const store = new InMemoryEventStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  const runtime = makeTestRuntime({
    ...services(store, new RecoveryWorker("accepted", true)),
    recovery: "enabled",
  });
  await waitForState(store, "completed");
  const result = await (await runtime.operation("operation-1")).readResult();
  assert.equal(result.kind, "retrieved");
});

test("保存済み正式レビューは検証器復元後に結果受理を再開する", async () => {
  const formats = makeResultFormatRegistry([{
    formatId: "review-result",
    version: "1",
    normalizationId: "identity.v1",
    validator: {
      validatorId: "review-validator",
      validatorVersion: "1",
      implementation: Buffer.from("valid-review-validator", "utf8"),
      validate: async () => ({ kind: "valid" }),
    },
  }]);
  const resultFormat = formats.pin({
    formatId: "review-result",
    version: "1",
    expectations: {},
  });
  const store = new InMemoryEventStore([], clock());
  await seed(store, resultFormat);
  await advanceTestOperationToRunning(store, "operation-1");
  const unavailable = makeTestRuntime({
    ...services(store, new RecoveryWorker("accepted", true)),
    recovery: "enabled",
  });
  await unavailable.close();
  const restored = makeTestRuntime({
    ...services(store, new RecoveryWorker("accepted", true)),
    formalReviewResultFormats: { registry: formats, resultFormat },
    recovery: "enabled",
  });
  await waitForState(store, "completed");
  const snapshot = await (await restored.operation("operation-1")).read();

  assert.deepEqual(snapshot.resultFormat, resultFormat);
});

test("停止確認済みの親キャンセルを永続化する", async () => {
  const store = new InMemoryEventStore([], clock());
  const runtime = makeTestRuntime({
    ...services(store, new CancellableWorker(true)),
    recovery: "disabled",
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await waitForState(store, "running");
  const result = await handle.cancel({});
  assert.equal(result.state, "cancelled");
});

test("停止未確認の親キャンセルを状態不明として永続化する", async () => {
  const store = new InMemoryEventStore([], clock());
  const runtime = makeTestRuntime({
    ...services(store, new CancellableWorker(false)),
    recovery: "disabled",
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await waitForState(store, "running");
  const result = await handle.cancel({});
  assert.equal(result.state, "unknown");
});
