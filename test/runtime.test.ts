import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import type {
  Operation,
  OperationIntent,
} from "../src/internal/event-store/index.js";
import { acknowledgeResultAcceptance } from "../src/internal/services.js";
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
import {
  makeResultFormatRegistry,
  type ResultFormatRegistry,
} from "../src/internal/result-format-registry.js";
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
  resultFormat?: Readonly<PinnedResultFormat>,
  operationId = "operation-1"
): Promise<void> {
  await Effect.runPromise(
    store.create({
      operationId,
      task: {
        promptRef: "private://prompt",
        profile: "coding",
        idempotencyKey: `task-${operationId}`,
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
  expected: string,
  operationId = "operation-1"
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = (await Effect.runPromise(store.read(operationId))).operation
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
  makeTestRuntime(services(store, worker));
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
  });
  await waitForState(store, "completed");
  const result = await (await runtime.operation("operation-1")).readResult();
  assert.equal(result.kind, "retrieved");
});

test("復旧した実行の保存失敗を追加のreadyなしで再処理する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override advance(operationId: string, intent: OperationIntent) {
      if (this.fail && intent.type === "start_delivery_authority_revoked") {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.advance(operationId, intent);
    }
  }
  const trace: Array<string> = [];
  const store = new FailingOnceStore(trace, clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  const runtime = makeTestRuntime(
    services(store, new RecoveryWorker("accepted", true))
  );
  await runtime.ready();
  await waitForState(store, "completed");

  assert.equal(
    trace.filter((entry) =>
      entry.includes('"type":"start_instruction_dispatched"')
    ).length,
    1
  );
});

test("復旧中の完了保存失敗を受理済み結果から再処理する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override advance(operationId: string, intent: OperationIntent) {
      if (this.fail && intent.type === "operation_completed") {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.advance(operationId, intent);
    }
  }
  const worker = new RecoveryWorker("accepted", true);
  let recoveries = 0;
  const store = new FailingOnceStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  const runtime = makeTestRuntime(
    services(store, {
      open: () => { throw new Error("worker reopened"); },
      recover: (operation) => {
        recoveries += 1;
        return worker.recover(operation);
      },
    })
  );
  await runtime.ready();
  await waitForState(store, "completed");

  assert.equal(recoveries, 1);
});

test("復旧したキャンセルの保存失敗を追加のreadyなしで再処理する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override advance(operationId: string, intent: OperationIntent) {
      if (this.fail && intent.type === "cancel_dispatched") {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.advance(operationId, intent);
    }
  }
  const store = new FailingOnceStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(
    store.advance("operation-1", {
      type: "cancellation_requested",
      cancellationEpoch: 1,
    })
  );
  const runtime = makeTestRuntime(
    services(store, new RecoveryWorker("accepted", false))
  );
  await runtime.ready();
  await waitForState(store, "cancelled");

  assert.equal(
    (await Effect.runPromise(store.read("operation-1"))).operation.state,
    "cancelled"
  );
});

test("終了処理は復旧キャンセルの保留中の再試行を実行する", async () => {
  let failureObserved!: () => void;
  const failed = new Promise<void>((resolve) => { failureObserved = resolve; });
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override advance(operationId: string, intent: OperationIntent) {
      if (this.fail && intent.type === "cancel_dispatched") {
        this.fail = false;
        failureObserved();
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.advance(operationId, intent);
    }
  }
  const store = new FailingOnceStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(store.advance("operation-1", {
    type: "cancellation_requested",
    cancellationEpoch: 1,
  }));
  const runtime = makeTestRuntime(services(store, new RecoveryWorker("accepted", false)));
  await failed;
  await runtime.close();

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "cancelled");
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
  });
  await unavailable.close();
  const restored = makeTestRuntime({
    ...services(store, new RecoveryWorker("accepted", true)),
    formalReviewResultFormats: { registry: formats, resultFormat },
  });
  await waitForState(store, "completed");
  const snapshot = await (await restored.operation("operation-1")).read();

  assert.deepEqual(snapshot.resultFormat, resultFormat);
});

test("検証器の一時的な不在から追加のreadyなしで結果受理を再開する", async () => {
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
  let available = false;
  let firstValidation!: () => void;
  const attempted = new Promise<void>((resolve) => {
    firstValidation = resolve;
  });
  const registry: ResultFormatRegistry = {
    ...formats,
    validate: async (pinned, bytes) => {
      if (!available) {
        firstValidation();
        return { kind: "invalid", reason: "validator_unavailable" };
      }
      return formats.validate(pinned, bytes);
    },
  };
  const store = new InMemoryEventStore([], clock());
  await seed(store, resultFormat);
  await advanceTestOperationToRunning(store, "operation-1");
  const runtime = makeTestRuntime({
    ...services(store, new RecoveryWorker("accepted", true)),
    formalReviewResultFormats: { registry, resultFormat },
  });
  await runtime.ready();
  await attempted;
  available = true;
  await waitForState(store, "completed");

  assert.equal(
    (await Effect.runPromise(store.read("operation-1"))).operation.state,
    "completed"
  );
});

test("検証器が不在の間は復旧の再試行間隔を延ばす", async () => {
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
  let available = false;
  let attempts = 0;
  let fourthAttempt!: () => void;
  const attempted = new Promise<void>((resolve) => {
    fourthAttempt = resolve;
  });
  const registry: ResultFormatRegistry = {
    ...formats,
    validate: async (pinned, bytes) => {
      if (available) return formats.validate(pinned, bytes);
      attempts += 1;
      if (attempts === 4) fourthAttempt();
      return { kind: "invalid", reason: "validator_unavailable" };
    },
  };
  const store = new InMemoryEventStore(
    [],
    new FakeClock(
      Array.from(
        { length: 400 },
        (_, index) => `2026-09-23T03:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`
      )
    )
  );
  await seed(store, resultFormat);
  await advanceTestOperationToRunning(store, "operation-1");
  const runtime = makeTestRuntime({
    ...services(store, new RecoveryWorker("accepted", true)),
    formalReviewResultFormats: { registry, resultFormat },
  });
  const startedAt = performance.now();
  await runtime.ready();
  await attempted;
  const elapsedMs = performance.now() - startedAt;
  available = true;
  await runtime.close();

  assert.ok(elapsedMs >= 140, `retries took ${elapsedMs}ms`);
});

test("別の復旧対象の解決は待機中の復旧の再試行間隔を戻さない", async () => {
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
  let available = false;
  let attempts = 0;
  let firstAttempt!: () => void;
  let fourthAttempt!: () => void;
  const attemptedOnce = new Promise<void>((resolve) => {
    firstAttempt = resolve;
  });
  const attemptedFourTimes = new Promise<void>((resolve) => {
    fourthAttempt = resolve;
  });
  const registry: ResultFormatRegistry = {
    ...formats,
    validate: async (pinned, bytes) => {
      if (available) return formats.validate(pinned, bytes);
      attempts += 1;
      if (attempts === 1) firstAttempt();
      if (attempts === 4) fourthAttempt();
      return { kind: "invalid", reason: "validator_unavailable" };
    },
  };
  const store = new InMemoryEventStore(
    [],
    new FakeClock(
      Array.from(
        { length: 400 },
        (_, index) => `2026-09-23T03:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`
      )
    )
  );
  await seed(store, resultFormat);
  await advanceTestOperationToRunning(store, "operation-1");
  await seed(store, undefined, "operation-2");
  await advanceTestOperationToRunning(store, "operation-2");
  let releaseOther!: () => void;
  const otherReleased = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  const recoveryWorker = new RecoveryWorker("accepted", true);
  const runtime = makeTestRuntime({
    ...services(store, {
      open: () => {
        throw new Error("not used");
      },
      recover: (operation) => {
        const worker = recoveryWorker.recover(operation);
        if (operation.operationId !== "operation-2") return worker;
        return {
          run: (hooks) =>
            Effect.promise(() => otherReleased).pipe(
              Effect.flatMap(() => worker.run(hooks))
            ),
          cancel: worker.cancel,
        };
      },
    }),
    formalReviewResultFormats: { registry, resultFormat },
  });
  const startedAt = performance.now();
  await runtime.ready();
  await attemptedOnce;
  releaseOther();
  await waitForState(store, "completed", "operation-2");
  await attemptedFourTimes;
  const elapsedMs = performance.now() - startedAt;
  available = true;
  await runtime.close();

  assert.ok(elapsedMs >= 140, `retries took ${elapsedMs}ms`);
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

test("Runtime終了は進行中の親キャンセルを待つ", async () => {
  let stopRequested!: () => void;
  let releaseStop!: () => void;
  const requested = new Promise<void>((resolve) => { stopRequested = resolve; });
  const held = new Promise<void>((resolve) => { releaseStop = resolve; });
  const worker = new CancellableWorker(true);
  const adapter: WorkerAdapter = {
    open: (operation) => {
      const opened = worker.open(operation);
      return {
        run: (hooks) => opened.run(hooks),
        cancel: (epoch, timeoutMs) => Effect.promise(async () => {
          const evidence = await Effect.runPromise(opened.cancel(epoch, timeoutMs));
          stopRequested();
          await held;
          return evidence;
        }),
      };
    },
    recover: (operation) => worker.open(operation),
  };
  const store = new InMemoryEventStore([], clock());
  const runtime = makeTestRuntime({
    ...services(store, adapter),
    recovery: "disabled",
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await waitForState(store, "running");
  const cancellation = handle.cancel({});
  await requested;
  await new Promise<void>((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closedBeforeStop = closed;
  releaseStop();
  await cancellation;
  await closing;
  assert.equal(closedBeforeStop, false);
});

for (const failedEvent of [
  "cancel_dispatched",
  "cancel_acknowledged",
  "operation_cancelled",
] as const) {
  test(`親キャンセルの${failedEvent}保存失敗を終了時に再処理する`, async () => {
    class FailingOnceStore extends InMemoryEventStore {
      private fail = true;

      override advance(operationId: string, intent: OperationIntent) {
        if (this.fail && intent.type === failedEvent) {
          this.fail = false;
          return Effect.fail({
            _tag: "StoreError" as const,
            code: "write_failed" as const,
            message: "temporary failure",
          });
        }
        return super.advance(operationId, intent);
      }
    }
    const store = new FailingOnceStore([], clock());
    const worker = new CancellableWorker(true);
    let stopRequests = 0;
    const adapter: WorkerAdapter = {
      open: (operation) => {
        const opened = worker.open(operation);
        return {
          run: (hooks) => opened.run(hooks),
          cancel: (epoch, timeoutMs) => {
            stopRequests += 1;
            return stopRequests === 1
              ? opened.cancel(epoch, timeoutMs)
              : Effect.succeed(undefined);
          },
        };
      },
      recover: () => { throw new Error("worker reopened"); },
    };
    const runtime = makeTestRuntime({
      ...services(store, adapter),
      recovery: "disabled",
    });
    const handle = await runtime.spawn({
      promptRef: "private://prompt",
      profile: "coding",
      idempotencyKey: "task-1",
    });
    await waitForState(store, "running");
    await handle.cancel({}).catch(() => undefined);
    await runtime.close();

    assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "cancelled");
  });
}

test("通常実行の停止確認保存失敗を所有Runtimeで再処理する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override advance(operationId: string, intent: OperationIntent) {
      if (this.fail && intent.type === "worker_stop_confirmed") {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.advance(operationId, intent);
    }
  }
  const store = new FailingOnceStore([], clock());
  const worker = new FakeWorkerAdapter({ successfulExitConfirmed: true });
  const runtime = makeTestRuntime({
    ...services(store, {
      open: (operation) => worker.open(operation),
      recover: () => ({
        run: () => Effect.succeed({
          state: "liveness-unproven" as const,
          successfulExitConfirmed: true as const,
        }),
        cancel: () => Effect.succeed({ proof: "worker-stop" as const }),
      }),
    }),
    recovery: "disabled",
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result().catch(() => undefined);
  await runtime.close();

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "completed");
});

class FailingOnceIntentStore extends InMemoryEventStore {
  private fail = true;

  constructor(
    private readonly failedIntent: OperationIntent["type"],
    timestamps: FakeClock
  ) {
    super([], timestamps);
  }

  override advance(operationId: string, intent: OperationIntent) {
    if (this.fail && intent.type === this.failedIntent) {
      this.fail = false;
      return Effect.fail({
        _tag: "StoreError" as const,
        code: "write_failed" as const,
        message: "temporary failure",
      });
    }
    return super.advance(operationId, intent);
  }
}

class ReopenRefusingAdapter implements WorkerAdapter {
  recoverCount = 0;

  constructor(private readonly worker: FakeWorkerAdapter) {}

  open(operation: Operation): Worker {
    return this.worker.open(operation);
  }

  recover(): Worker {
    this.recoverCount += 1;
    throw new Error("worker reopened");
  }
}

function reopenRefusingServices(
  store: InMemoryEventStore,
  worker: ReopenRefusingAdapter
) {
  return { ...services(store, worker), recovery: "disabled" as const };
}

test("汎用ワーカー失敗の記録保存失敗後も観測した失敗理由を保つ", async () => {
  const store = new FailingOnceIntentStore("agent_settled", clock());
  const runtime = makeTestRuntime(
    reopenRefusingServices(
      store,
      new ReopenRefusingAdapter(new FakeWorkerAdapter({ failure: "agent_failed" }))
    )
  );
  const handle = await runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result().catch(() => undefined);
  await runtime.close();

  assert.equal(
    (await Effect.runPromise(store.read("operation-1"))).operation.failureReason,
    "agent_failed"
  );
});

test("汎用ワーカー失敗の記録保存失敗後も観測した実行証跡を保つ", async () => {
  const store = new FailingOnceIntentStore("agent_settled", clock());
  const runtime = makeTestRuntime(
    reopenRefusingServices(
      store,
      new ReopenRefusingAdapter(new FakeWorkerAdapter({ failure: "agent_failed" }))
    )
  );
  const handle = await runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result().catch(() => undefined);
  await runtime.close();

  assert.equal(
    (await Effect.runPromise(store.read("operation-1"))).operation.agentRunEvidence
      ?.toolUses[0]?.isError,
    true
  );
});

test("失敗保存の一時的な失敗後にワーカーの再開を要求しない", async () => {
  const store = new FailingOnceIntentStore("operation_failed", clock());
  const worker = new ReopenRefusingAdapter(
    new FakeWorkerAdapter({ failure: "agent_failed" })
  );
  const runtime = makeTestRuntime(reopenRefusingServices(store, worker));
  const handle = await runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await handle.result().catch(() => undefined);
  await runtime.close();

  assert.equal(worker.recoverCount, 0);
});

class FormatRejectedWorker implements WorkerAdapter {
  recoverCount = 0;

  open(): Worker {
    throw new Error("not used");
  }

  recover(operation: Operation): Worker {
    this.recoverCount += 1;
    return {
      run: (hooks) =>
        Effect.gen(function* () {
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
            acceptanceState: "accepted",
            acceptedInstruction: operation.startInstructionAcceptance!,
          });
          const body = "not a review";
          const bytes = Buffer.from(body, "utf8");
          const accepted = yield* hooks.acceptResult({
            acceptanceRequestId: "request-rejected",
            body,
            expectedByteCount: bytes.byteLength,
            expectedDigest: sha256Digest(bytes),
          });
          return yield* acknowledgeResultAcceptance(
            accepted,
            {
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
            () => Effect.void
          );
        }),
      cancel: () => Effect.succeed({ proof: "worker-stop" as const }),
    };
  }
}

async function seedFormatRejection(store: InMemoryEventStore) {
  const formats = makeResultFormatRegistry([{
    formatId: "review-result",
    version: "1",
    normalizationId: "identity.v1",
    validator: {
      validatorId: "review-validator",
      validatorVersion: "1",
      implementation: Buffer.from("rejecting-review-validator", "utf8"),
      validate: async () => ({ kind: "invalid", reason: "invalid_json" }),
    },
  }]);
  const resultFormat = formats.pin({
    formatId: "review-result",
    version: "1",
    expectations: {},
  });
  await seed(store, resultFormat);
  await advanceTestOperationToRunning(store, "operation-1");
  return { registry: formats, resultFormat };
}

test("結果形式拒否の保存失敗後も観測した拒否理由を保つ", async () => {
  const store = new FailingOnceIntentStore("operation_failed", clock());
  const formalReviewResultFormats = await seedFormatRejection(store);
  const runtime = makeTestRuntime({
    ...services(store, new FormatRejectedWorker()),
    formalReviewResultFormats,
  });
  await waitForState(store, "failed");
  await runtime.close();

  assert.equal(
    (await Effect.runPromise(store.read("operation-1"))).operation
      .resultFormatRejection?.reason,
    "invalid_json"
  );
});

test("結果形式拒否の保存失敗後にワーカーを再開しない", async () => {
  const store = new FailingOnceIntentStore("operation_failed", clock());
  const formalReviewResultFormats = await seedFormatRejection(store);
  const worker = new FormatRejectedWorker();
  const runtime = makeTestRuntime({
    ...services(store, worker),
    formalReviewResultFormats,
  });
  await waitForState(store, "failed");
  await runtime.close();

  assert.equal(worker.recoverCount, 1);
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

test("終端結果の再読込失敗を結果待機者へ通知する", async () => {
  class FailingResultStore extends InMemoryEventStore {
    private fail = true;

    override readResultBody(operationId: string) {
      if (this.fail) {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.readResultBody(operationId);
    }
  }
  const store = new FailingResultStore([], clock());
  const runtime = makeTestRuntime({
    ...services(
      store,
      new FakeWorkerAdapter({ successfulExitConfirmed: true })
    ),
    recovery: "disabled",
  });
  const handle = await runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });

  await assert.rejects(handle.result(), { name: "ResultRetrievalError" });
});

test("停止確認と受理済み結果からWorkerを再起動せず完了する", async () => {
  const store = new InMemoryEventStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(store.acceptResult({
    operationId: "operation-1",
    acceptanceRequestId: "request-1",
    bytes: Buffer.from("accepted result", "utf8"),
  }));
  await Effect.runPromise(store.advance("operation-1", {
    type: "worker_stop_confirmed",
    proof: "worker-stop",
  }));
  const runtime = makeTestRuntime(services(store, {
    open: () => { throw new Error("worker reopened"); },
    recover: () => { throw new Error("worker reopened"); },
  }));
  await runtime.ready();

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "completed");
});

test("停止確認後の完了保存失敗を自動で再処理する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override advance(operationId: string, intent: OperationIntent) {
      if (this.fail && intent.type === "operation_completed") {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.advance(operationId, intent);
    }
  }
  const store = new FailingOnceStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(store.acceptResult({
    operationId: "operation-1",
    acceptanceRequestId: "request-1",
    bytes: Buffer.from("accepted result", "utf8"),
  }));
  await Effect.runPromise(store.advance("operation-1", {
    type: "worker_stop_confirmed",
    proof: "worker-stop",
  }));
  makeTestRuntime(services(store, {
    open: () => { throw new Error("worker reopened"); },
    recover: () => { throw new Error("worker reopened"); },
  }));
  await waitForState(store, "completed");

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "completed");
});

test("停止確認済みのキャンセルをWorkerに再要求せず完了する", async () => {
  const store = new InMemoryEventStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(store.advance("operation-1", {
    type: "cancellation_requested",
    cancellationEpoch: 1,
  }));
  await Effect.runPromise(store.advance("operation-1", {
    type: "cancel_acknowledged",
    cancellationEpoch: 1,
    proof: "worker-stop",
  }));
  const runtime = makeTestRuntime(services(store, {
    open: () => { throw new Error("worker reopened"); },
    recover: () => { throw new Error("worker reopened"); },
  }));
  await runtime.ready();

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "cancelled");
});

test("停止確認後のキャンセル保存失敗を自動で再処理する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override advance(operationId: string, intent: OperationIntent) {
      if (this.fail && intent.type === "operation_cancelled") {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.advance(operationId, intent);
    }
  }
  const store = new FailingOnceStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(store.advance("operation-1", {
    type: "cancellation_requested",
    cancellationEpoch: 1,
  }));
  await Effect.runPromise(store.advance("operation-1", {
    type: "cancel_acknowledged",
    cancellationEpoch: 1,
    proof: "worker-stop",
  }));
  makeTestRuntime(services(store, {
    open: () => { throw new Error("worker reopened"); },
    recover: () => { throw new Error("worker reopened"); },
  }));
  await waitForState(store, "cancelled");

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "cancelled");
});

test("状態不明の保存失敗を自動で再処理する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override advance(operationId: string, intent: OperationIntent) {
      if (this.fail && intent.type === "operation_unknown") {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.advance(operationId, intent);
    }
  }
  const store = new FailingOnceStore([], clock());
  await seed(store);
  makeTestRuntime(services(store, {
    open: () => { throw new Error("worker opened"); },
    recover: () => { throw new Error("worker recovered"); },
  }));
  await waitForState(store, "unknown");

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "unknown");
});

test("復旧一覧の一時的な失敗をreadyが通知する", async () => {
  class FailingStore extends InMemoryEventStore {
    override listRecoverableOperations() {
      return Effect.fail({
        _tag: "StoreError" as const,
        code: "write_failed" as const,
        message: "temporary failure",
      });
    }
  }
  const runtime = makeTestRuntime(services(new FailingStore(), new RecoveryWorker("accepted", true)));

  await assert.rejects(runtime.ready(), { name: "OperationPersistenceError" });
  await runtime.close().catch(() => undefined);
});

test("復旧一覧の一時的な失敗を自動で再試行する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override listRecoverableOperations() {
      if (this.fail) {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.listRecoverableOperations();
    }
  }
  const store = new FailingOnceStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  makeTestRuntime(services(store, new RecoveryWorker("accepted", true)));
  await waitForState(store, "completed");

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "completed");
});

test("終了処理は待機中の復旧一覧再試行を実行する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    private fail = true;

    override listRecoverableOperations() {
      if (this.fail) {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.listRecoverableOperations();
    }
  }
  const store = new FailingOnceStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  const runtime = makeTestRuntime(services(store, new RecoveryWorker("accepted", true)));
  await runtime.ready().catch(() => undefined);
  await runtime.close();

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "completed");
});

test("終了時の復旧再試行失敗を呼び出し元へ返す", async () => {
  class FailingStore extends InMemoryEventStore {
    override listRecoverableOperations() {
      return Effect.fail({
        _tag: "StoreError" as const,
        code: "write_failed" as const,
        message: "temporary failure",
      });
    }
  }
  const runtime = makeTestRuntime(services(new FailingStore(), new FakeWorkerAdapter()));
  await runtime.ready().catch(() => undefined);

  await assert.rejects(runtime.close(), { name: "OperationPersistenceError" });
});

test("終了時の復旧再試行失敗後に別のRuntimeで再開する", async () => {
  class FailingTwiceStore extends InMemoryEventStore {
    private failures = 2;

    override listRecoverableOperations() {
      if (this.failures > 0) {
        this.failures -= 1;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.listRecoverableOperations();
    }
  }
  const store = new FailingTwiceStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  const first = makeTestRuntime(services(store, new RecoveryWorker("accepted", true)));
  await first.ready().catch(() => undefined);
  await first.close().catch(() => undefined);
  makeTestRuntime(services(store, new RecoveryWorker("accepted", true)));
  await waitForState(store, "completed");

  assert.equal((await Effect.runPromise(store.read("operation-1"))).operation.state, "completed");
});

test("表示終了処理一覧の一時的な失敗を自動で再試行する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    calls = 0;

    override listPendingPresentationCleanups() {
      this.calls += 1;
      if (this.calls === 1) {
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.listPendingPresentationCleanups();
    }
  }
  const store = new FailingOnceStore([], clock());
  makeTestRuntime(services(store, new FakeWorkerAdapter()));
  for (let index = 0; index < 100 && store.calls < 2; index += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));

  assert.equal(store.calls, 2);
});

for (const failedEvent of [
  "presentation_cleanup_started",
  "presentation_cleanup_unconfirmed",
  "presentation_cleanup_completed",
] as const) {
  test(`表示終了処理の${failedEvent}保存失敗を終了時に再処理する`, async () => {
    class FailingOnceStore extends InMemoryEventStore {
      private fail = true;

      override advance(operationId: string, intent: OperationIntent) {
        if (this.fail && intent.type === failedEvent) {
          this.fail = false;
          return Effect.fail({
            _tag: "StoreError" as const,
            code: "write_failed" as const,
            message: "temporary failure",
          });
        }
        return super.advance(operationId, intent);
      }
    }
    const store = new FailingOnceStore([], clock());
    const runtime = makeTestRuntime({
      ...services(store, new FakeWorkerAdapter({ successfulExitConfirmed: true })),
      presentation: new FakePresentation({
        workspaceInspection: failedEvent === "presentation_cleanup_unconfirmed"
          ? "missing"
          : "matching",
      }),
      recovery: "disabled",
    });
    const handle = await runtime.spawn({
      promptRef: "private://prompt",
      profile: "coding",
      idempotencyKey: "task-1",
    });
    await handle.result();
    await runtime.close();

    assert.equal(
      (await Effect.runPromise(store.read("operation-1"))).operation.presentationCleanup?.state,
      failedEvent === "presentation_cleanup_unconfirmed" ? "unconfirmed" : "completed"
    );
  });
}

test("復旧時に未着手の表示終了処理を開始する", async () => {
  const store = new InMemoryEventStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  await Effect.runPromise(store.acceptResult({
    operationId: "operation-1",
    acceptanceRequestId: "request-1",
    bytes: Buffer.from("accepted result", "utf8"),
  }));
  await Effect.runPromise(store.advance("operation-1", {
    type: "worker_stop_confirmed",
    proof: "worker-stop",
  }));
  await Effect.runPromise(store.advance("operation-1", { type: "operation_completed" }));
  const runtime = makeTestRuntime(services(store, new FakeWorkerAdapter()));
  await runtime.ready();

  assert.equal(
    (await Effect.runPromise(store.read("operation-1"))).operation.presentationCleanup?.state,
    "completed"
  );
});

test("終了処理は待機中の表示終了処理一覧再試行を実行する", async () => {
  class FailingOnceStore extends InMemoryEventStore {
    calls = 0;

    override listPendingPresentationCleanups() {
      this.calls += 1;
      if (this.calls === 1) {
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.listPendingPresentationCleanups();
    }
  }
  const store = new FailingOnceStore([], clock());
  const runtime = makeTestRuntime(services(store, new FakeWorkerAdapter()));
  await runtime.ready().catch(() => undefined);
  await runtime.close();

  assert.equal(store.calls, 2);
});

test("表示終了処理の復旧失敗後も起動済みWorkerを二重に回収しない", async () => {
  class FailingCleanupStore extends InMemoryEventStore {
    private fail = true;

    override listPendingPresentationCleanups() {
      if (this.fail) {
        this.fail = false;
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "write_failed" as const,
          message: "temporary failure",
        });
      }
      return super.listPendingPresentationCleanups();
    }
  }
  const store = new FailingCleanupStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  let recoverCount = 0;
  let release!: () => void;
  const workerFinished = new Promise<{ readonly state: "liveness-unproven" }>((resolve) => {
    release = () => resolve({ state: "liveness-unproven" });
  });
  const runtime = makeTestRuntime(services(store, {
    open: () => { throw new Error("not used"); },
    recover: () => {
      recoverCount += 1;
      return {
        run: () => Effect.promise(() => workerFinished),
        cancel: () => Effect.succeed({ proof: "worker-stop" as const }),
      };
    },
  }));
  await runtime.ready().catch(() => undefined);
  await runtime.ready();
  assert.equal(recoverCount, 1);
  release();
  await runtime.close();
});

test("終了処理は一覧取得後に回収されたWorkerも待つ", async () => {
  let releaseListing!: () => void;
  let enterListing!: () => void;
  let releaseWorker!: () => void;
  let enterWorker!: () => void;
  const listed = new Promise<void>((resolve) => { enterListing = resolve; });
  const listingHeld = new Promise<void>((resolve) => { releaseListing = resolve; });
  const workerStarted = new Promise<void>((resolve) => { enterWorker = resolve; });
  const workerFinished = new Promise<{ readonly state: "liveness-unproven" }>((resolve) => {
    releaseWorker = () => resolve({ state: "liveness-unproven" });
  });
  class HeldListingStore extends InMemoryEventStore {
    override listRecoverableOperations() {
      return Effect.promise(async () => {
        enterListing();
        await listingHeld;
        return Effect.runPromise(super.listRecoverableOperations());
      });
    }
  }
  const store = new HeldListingStore([], clock());
  await seed(store);
  await advanceTestOperationToRunning(store, "operation-1");
  const runtime = makeTestRuntime(services(store, {
    open: () => { throw new Error("not used"); },
    recover: () => ({
      run: () => Effect.promise(() => {
        enterWorker();
        return workerFinished;
      }),
      cancel: () => Effect.succeed({ proof: "worker-stop" as const }),
    }),
  }));
  await listed;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  releaseListing();
  await workerStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  releaseWorker();
  await closing;
});

test("終了処理は作成中の委譲を待つ", async () => {
  let enterPreflight!: () => void;
  let leavePreflight!: () => void;
  const entered = new Promise<void>((resolve) => { enterPreflight = resolve; });
  const held = new Promise<void>((resolve) => { leavePreflight = resolve; });
  class HeldPresentation extends FakePresentation {
    override preflight() {
      return Effect.promise(async () => {
        enterPreflight();
        await held;
      });
    }
  }
  const store = new InMemoryEventStore([], clock());
  const runtime = makeTestRuntime({
    ...services(store, new FakeWorkerAdapter()),
    presentation: new HeldPresentation(),
    recovery: "disabled",
  });
  const spawn = runtime.spawn({
    promptRef: "private://prompt",
    profile: "coding",
    idempotencyKey: "task-1",
  });
  await entered;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  leavePreflight();
  await spawn;
  await closing;
});
