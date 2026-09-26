import { Cause, Effect, Exit, Schema } from "effect";

import {
  presentationCleanupEligible,
  RUNTIME_ACTOR_ID,
} from "./event-store/index.js";
import type {
  Operation,
  OperationIntent,
  StoreError,
} from "./event-store/index.js";
import { makeResultAcceptance } from "./result-acceptance.js";
import { makeOperationReader } from "./operation-reader.js";
import {
  DEFAULT_WORKER_PROFILE_POLICY,
  RequestedWorkerConfigSchema,
  requestedWorkerConfig,
  resolveWorkerConfig,
} from "./worker-configuration.js";
import { StartDeliveryAbortedError } from "./services.js";
import type { RuntimeServices, Worker, WorkerRunOutcome } from "./services.js";
import {
  automaticStartScopeDigest,
  startInstructionReference,
} from "./start-instruction.js";
import {
  CancellationRejectedError,
  OperationCancelledError,
  OperationFailedError,
  OperationPersistenceError,
  OperationUnknownError,
  RuntimeClosedError,
  WorkerConfigurationError,
} from "./types.js";
import type {
  CancellationResult,
  CancelOptions,
  CleanupDiagnosticCode,
  OperationCompletion,
  OperationFailureReason,
  OperationHandle,
  OperationRuntime,
  TaskSpec,
} from "./types.js";

const INITIAL_RECOVERY_DELAY_MS = 20;
const MAX_RECOVERY_DELAY_MS = 5_000;

const TaskSpecSchema = Schema.Struct({
  promptRef: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
  ...RequestedWorkerConfigSchema.fields,
});

interface OperationRecord {
  readonly operationId: string;
  readonly terminalPromise: Promise<Readonly<OperationCompletion>>;
  readonly resolveTerminal: (completion: Readonly<OperationCompletion>) => void;
  readonly rejectTerminal: (error: unknown) => void;
  worker?: Worker;
  observedOutcome?: WorkerRunOutcome;
  recoverable?: boolean;
  retryDelayMs?: number;
  retryAfter?: number;
  cancelEvidence?: {
    readonly cancellationEpoch: number;
    readonly proof: "worker-stop";
  };
}

function deferredResult(): {
  readonly promise: Promise<Readonly<OperationCompletion>>;
  readonly resolve: (completion: Readonly<OperationCompletion>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (completion: Readonly<OperationCompletion>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Readonly<OperationCompletion>>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    }
  );
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function terminal(operation: Operation): boolean {
  return (
    operation.state === "completed" ||
    operation.state === "failed" ||
    operation.state === "cancelled" ||
    operation.state === "unknown"
  );
}

export function makeRuntime(services: RuntimeServices): OperationRuntime {
  const resultAcceptance = makeResultAcceptance({ store: services.store });
  const reader = makeOperationReader(services.store);
  const records = new Map<string, OperationRecord>();
  const spawns = new Map<string, Promise<OperationHandle>>();
  const cancellations = new Map<string, Promise<CancellationResult>>();
  const volatileCleanupDiagnostics = new Map<
    string,
    Set<CleanupDiagnosticCode>
  >();
  const inFlight = new Set<Promise<void>>();
  let closing = false;

  const runEffect = async <Value>(
    effect: Effect.Effect<Value, unknown>
  ): Promise<Value> => {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    throw new Error(Cause.pretty(exit.cause));
  };

  const track = (execution: Promise<void>): void => {
    const tracked = execution
      .catch(() => undefined)
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  };

  const persistenceError = (
    operationId: string,
    error: StoreError
  ): OperationPersistenceError =>
    new OperationPersistenceError(
      operationId,
      error.code === "not_found" ? "corrupt_record" : error.code
    );

  const advance = (
    operationId: string,
    intent: OperationIntent
  ): Effect.Effect<Operation, OperationPersistenceError> =>
    services.store.advance(operationId, intent).pipe(
      Effect.map((snapshot) => snapshot.operation),
      Effect.mapError((error) => persistenceError(operationId, error))
    );

  const project = (operation: Operation): Effect.Effect<void> =>
    Effect.catchAllCause(
      services.presentation.project(operation),
      () => Effect.void
    );

  const advanceAndProject = (
    operationId: string,
    intent: OperationIntent
  ): Effect.Effect<void, OperationPersistenceError> =>
    advance(operationId, intent).pipe(
      Effect.tap((operation) => project(operation)),
      Effect.asVoid
    );

  const { storedSnapshot } = reader;

  const getOperation = (operationId: string) =>
    services.store.read(operationId).pipe(
      Effect.map((snapshot) => snapshot.operation),
      Effect.mapError((error) => persistenceError(operationId, error))
    );

  const noteVolatileDiagnostic = (
    operationId: string,
    code: CleanupDiagnosticCode
  ): void => {
    const diagnostics =
      volatileCleanupDiagnostics.get(operationId) ??
      new Set<CleanupDiagnosticCode>();
    diagnostics.add(code);
    volatileCleanupDiagnostics.set(operationId, diagnostics);
  };

  const performCleanup = async (
    initial: Operation,
    directResponseAvailable: boolean
  ): Promise<void> => {
    if (
      !presentationCleanupEligible(initial) ||
      initial.presentation === undefined
    )
      return;
    const presentation = initial.presentation;
    let operation = initial;
    let cleanup = operation.presentationCleanup;
    const persistenceFailed = (
      error: unknown,
      reason?: CleanupDiagnosticCode
    ): void => {
      if (!directResponseAvailable) throw error;
      noteVolatileDiagnostic(
        operation.operationId,
        "cleanup_record_unavailable"
      );
      if (reason !== undefined)
        noteVolatileDiagnostic(operation.operationId, reason);
      cleanupsRecovered = false;
      deferRecovery(recordFor(operation.operationId));
    };
    if (cleanup === undefined) {
      try {
        operation = await runEffect(
          advance(operation.operationId, {
            type: "presentation_cleanup_started",
            cleanupId: `presentation-cleanup:${operation.operationId}`,
            workspaceId: presentation.workspaceId,
          })
        );
        cleanup = operation.presentationCleanup;
      } catch (error) {
        persistenceFailed(error);
        return;
      }
    }
    if (cleanup?.state !== "pending") return;
    const unconfirmed = async (code: CleanupDiagnosticCode): Promise<void> => {
      try {
        await runEffect(
          advance(operation.operationId, {
            type: "presentation_cleanup_unconfirmed",
            cleanupId: cleanup!.cleanupId,
            workspaceId: cleanup!.workspaceId,
            reason: code,
          })
        );
      } catch (error) {
        persistenceFailed(error, code);
      }
    };
    let identity: "matching" | "missing";
    try {
      identity = await runEffect(
        services.presentation.inspectOwnedWorkspace(operation)
      );
    } catch {
      await unconfirmed("workspace_identity_unavailable");
      return;
    }
    if (identity === "missing") {
      await unconfirmed("workspace_identity_missing");
      return;
    }
    try {
      await runEffect(services.presentation.closeOwnedWorkspace(operation));
    } catch {
      await unconfirmed("workspace_close_failed");
      return;
    }
    try {
      await runEffect(
        advance(operation.operationId, {
          type: "presentation_cleanup_completed",
          cleanupId: cleanup.cleanupId,
          workspaceId: cleanup.workspaceId,
        })
      );
    } catch (error) {
      persistenceFailed(error);
    }
  };

  const settleTerminal = async (
    record: OperationRecord,
    operation: Operation
  ): Promise<void> => {
    try {
      await settleTerminalOnce(record, operation);
      if (record.retryAfter === undefined) delete record.retryDelayMs;
    } catch (error) {
      record.rejectTerminal(error);
      throw error;
    }
  };

  const settleTerminalOnce = async (
    record: OperationRecord,
    operation: Operation
  ): Promise<void> => {
    await runEffect(project(operation));
    if (operation.state === "completed") {
      await performCleanup(operation, true);
      const outcome = await reader
        .forKnownOperation(record.operationId)
        .readResult();
      if (outcome.kind !== "retrieved")
        throw new OperationPersistenceError(
          record.operationId,
          "incomplete_record"
        );
      const snapshot = await reader
        .forKnownOperation(record.operationId)
        .read();
      const volatile = [
        ...(volatileCleanupDiagnostics.get(record.operationId) ?? []),
      ]
        .filter(
          (code) =>
            !snapshot.cleanupDiagnostics.some(
              (diagnostic) => diagnostic.code === code
            )
        )
        .map((code) => Object.freeze({ code }));
      volatileCleanupDiagnostics.delete(record.operationId);
      record.resolveTerminal(
        Object.freeze({
          result: outcome.result,
          ...(snapshot.presentationCleanup === undefined
            ? {}
            : { presentationCleanup: snapshot.presentationCleanup }),
          cleanupDiagnostics: Object.freeze([
            ...snapshot.cleanupDiagnostics,
            ...volatile,
          ]),
        })
      );
      return;
    }
    if (operation.state === "cancelled") {
      await performCleanup(operation, false);
      record.rejectTerminal(new OperationCancelledError(record.operationId));
      return;
    }
    if (operation.state === "unknown") {
      record.rejectTerminal(
        new OperationUnknownError(
          record.operationId,
          operation.terminalReason === "cancel-unproven"
            ? "cancel-unproven"
            : operation.terminalReason === "start-acceptance-unknown"
              ? "start-acceptance-unknown"
              : "liveness-unproven"
        )
      );
      return;
    }
    record.rejectTerminal(
      new OperationFailedError(
        record.operationId,
        operation.failureReason ?? "worker_protocol_failed",
        operation.agentRunEvidence?.errorMessage
      )
    );
  };

  const runWorker = async (
    record: OperationRecord,
    recovering: boolean
  ): Promise<WorkerRunOutcome> => {
    let operation = await runEffect(getOperation(record.operationId));
    if (!recovering) {
      operation = await runEffect(
        advance(record.operationId, { type: "operation_starting" })
      );
      await runEffect(project(operation));
    }
    const worker = record.worker;
    if (worker === undefined) throw new Error("Worker was not opened");
    return runEffect(
      worker.run({
        workerLaunched: () =>
          recovering
            ? Effect.void
            : advanceAndProject(record.operationId, {
                type: "worker_launched",
              }),
        workerIdentified: (identity) =>
          recovering
            ? Effect.tryPromise({
                try: async () => {
                  const current = await runEffect(
                    getOperation(record.operationId)
                  );
                  const existing = current.workerIdentity;
                  const previous = current.startDeliveryAuthority;
                  if (
                    existing === undefined ||
                    previous === undefined ||
                    existing.processInstanceId !== identity.processInstanceId ||
                    existing.processStartToken !== identity.processStartToken
                  )
                    throw new OperationPersistenceError(
                      record.operationId,
                      "corrupt_record"
                    );
                  const pending = current.startDeliveryHandoffs.at(-1);
                  const resumes =
                    pending !== undefined &&
                    pending.workerGenerationConfirmedAt === undefined &&
                    pending.deliveryGeneration ===
                      previous.deliveryGeneration + 1;
                  const deliveryGeneration = resumes
                    ? pending.deliveryGeneration
                    : previous.deliveryGeneration + 1;
                  return {
                    dispatcherId: resumes
                      ? pending.successorDispatcherId
                      : `${RUNTIME_ACTOR_ID}-recovery-${deliveryGeneration}`,
                    workerProcessInstanceId: previous.workerProcessInstanceId,
                    receiptDigest: previous.receiptDigest,
                    deliveryGeneration,
                  };
                },
                catch: (error) =>
                  error instanceof OperationPersistenceError
                    ? error
                    : new OperationPersistenceError(
                        record.operationId,
                        "write_failed"
                      ),
              })
            : advance(record.operationId, {
                type: "worker_identified",
                workerIdentity: {
                  processId: identity.processId,
                  processInstanceId: identity.processInstanceId,
                  processStartToken: identity.processStartToken,
                  piSessionId: identity.piSessionId,
                  paneId: operation.presentation?.paneId ?? "",
                },
                observedConfig: identity.observedConfig,
              }).pipe(
                Effect.tap((identified) => project(identified)),
                Effect.flatMap((identified) => {
                  const instruction = {
                    dispatcherId: RUNTIME_ACTOR_ID,
                    workerProcessInstanceId: identity.processInstanceId,
                    receiptDigest: automaticStartScopeDigest(identified),
                    deliveryGeneration: 1,
                  };
                  return advance(record.operationId, {
                    type: "start_delivery_authority_acquired",
                    instruction,
                  }).pipe(
                    Effect.tap((started) => project(started)),
                    Effect.as(instruction)
                  );
                })
              ),
        startDeliveryAuthorityRevoked: (
          successorDispatcherId,
          deliveryGeneration
        ) =>
          advanceAndProject(record.operationId, {
            type: "start_delivery_authority_revoked",
            successorDispatcherId,
            deliveryGeneration,
          }),
        deliveryGenerationConfirmed: (confirmation) =>
          Effect.gen(function* () {
            yield* advanceAndProject(record.operationId, {
              type: "start_delivery_generation_confirmed",
              dispatcherId: confirmation.dispatcherId,
              deliveryGeneration: confirmation.deliveryGeneration,
              acceptanceState: confirmation.acceptanceState,
              ...(confirmation.acceptedInstruction === undefined
                ? {}
                : {
                    acceptedInstruction: startInstructionReference(
                      confirmation.acceptedInstruction
                    ),
                  }),
            });
            if (confirmation.acceptanceState === "unknown") {
              const unknown = yield* advance(record.operationId, {
                type: "operation_unknown",
                reason: "start-acceptance-unknown",
              });
              yield* project(unknown);
              return yield* Effect.fail(
                new StartDeliveryAbortedError(
                  `Start acceptance is unknown for Operation ${record.operationId}`
                )
              );
            }
            const current = yield* getOperation(record.operationId);
            if (confirmation.acceptanceState === "accepted") {
              const accepted = confirmation.acceptedInstruction;
              if (accepted === undefined)
                return yield* Effect.fail(
                  new OperationPersistenceError(
                    record.operationId,
                    "corrupt_record"
                  )
                );
              if (current.startInstructionAcceptance === undefined)
                yield* advanceAndProject(record.operationId, {
                  type: "start_instruction_accepted",
                  instruction: startInstructionReference(accepted),
                  proof: "worker-durable-acceptance",
                });
              const acceptedCurrent = yield* getOperation(record.operationId);
              if (acceptedCurrent.startInstructionAcknowledgement === undefined)
                yield* advanceAndProject(record.operationId, {
                  type: "start_instruction_acknowledged",
                  instruction: startInstructionReference(accepted),
                  proof: "authenticated-generation-acknowledgement",
                });
              return;
            }
            const previous = current.startDeliveryAuthority;
            if (previous === undefined || current.workerIdentity === undefined)
              return yield* Effect.fail(
                new OperationPersistenceError(
                  record.operationId,
                  "corrupt_record"
                )
              );
            yield* advanceAndProject(record.operationId, {
              type: "start_delivery_authority_acquired",
              instruction: {
                dispatcherId: confirmation.dispatcherId,
                workerProcessInstanceId:
                  current.workerIdentity.processInstanceId,
                receiptDigest: previous.receiptDigest,
                deliveryGeneration: confirmation.deliveryGeneration,
              },
            });
          }),
        startDeliveryEntered: (instruction) =>
          advanceAndProject(record.operationId, {
            type: "start_delivery_entered",
            instruction: startInstructionReference(instruction),
          }),
        startInstructionDispatched: (instruction) =>
          advanceAndProject(record.operationId, {
            type: "start_instruction_dispatched",
            instruction: startInstructionReference(instruction),
          }),
        startInstructionAccepted: (instruction) =>
          advanceAndProject(record.operationId, {
            type: "start_instruction_accepted",
            instruction: startInstructionReference(instruction),
            proof: "worker-durable-acceptance",
          }),
        startInstructionAcknowledged: (instruction) =>
          advanceAndProject(record.operationId, {
            type: "start_instruction_acknowledged",
            instruction: startInstructionReference(instruction),
            proof: "authenticated-worker-acknowledgement",
          }),
        acceptResult: (result) =>
          resultAcceptance.accept(record.operationId, result),
      })
    );
  };

  const settleObserved = async (
    record: OperationRecord,
    outcome: WorkerRunOutcome
  ): Promise<void> => {
    if (outcome.successfulExitConfirmed === true) {
      const current = await runEffect(getOperation(record.operationId));
      if (
        !terminal(current) &&
        current.state !== "cancelling" &&
        current.workerStopConfirmedAt === undefined
      )
        await runEffect(
          advanceAndProject(record.operationId, {
            type: "worker_stop_confirmed",
            proof: "worker-stop",
          })
        );
    }

    let current = await runEffect(getOperation(record.operationId));
    if (terminal(current) || current.state === "cancelling") return;
    if (
      current.result !== undefined &&
      current.workerStopConfirmedAt !== undefined
    ) {
      if (
        outcome.state === "result_acknowledged" &&
        current.agentRunEvidence === undefined
      )
        await runEffect(
          advanceAndProject(record.operationId, {
            type: "agent_settled",
            evidence: outcome.evidence,
          })
        );
      current = await runEffect(
        advance(record.operationId, { type: "operation_completed" })
      );
      await settleTerminal(record, current);
      return;
    }
    if (outcome.state === "liveness-unproven") {
      current = await runEffect(
        advance(record.operationId, {
          type: "operation_unknown",
          reason: "liveness-unproven",
        })
      );
      await settleTerminal(record, current);
      return;
    }
    if (outcome.state !== "result_acknowledged") {
      if (
        outcome.state === "agent_failed" &&
        current.agentRunEvidence === undefined
      )
        await runEffect(
          advanceAndProject(record.operationId, {
            type: "agent_settled",
            evidence: outcome.evidence,
          })
        );
      const reason: OperationFailureReason = outcome.state;
      current = await runEffect(
        advance(record.operationId, {
          type: "operation_failed",
          reason,
        })
      );
      await settleTerminal(record, current);
      return;
    }
    if (current.agentRunEvidence === undefined)
      await runEffect(
        advanceAndProject(record.operationId, {
          type: "agent_settled",
          evidence: outcome.evidence,
        })
      );
    current = await runEffect(getOperation(record.operationId));
    if (current.workerStopConfirmedAt === undefined) {
      current = await runEffect(
        advance(record.operationId, {
          type: "operation_unknown",
          reason: "liveness-unproven",
        })
      );
    } else {
      current = await runEffect(
        advance(record.operationId, { type: "operation_completed" })
      );
    }
    await settleTerminal(record, current);
  };

  const execute = async (
    record: OperationRecord,
    recovering: boolean
  ): Promise<void> => {
    try {
      const outcome =
        record.observedOutcome ?? (await runWorker(record, recovering));
      record.observedOutcome = outcome;
      await settleObserved(record, outcome);
    } catch (error) {
      const current = await runEffect(getOperation(record.operationId)).catch(
        () => undefined
      );
      if (current !== undefined && terminal(current)) {
        try {
          await settleTerminal(record, current);
        } catch (settlementError) {
          if (recovering) throw settlementError;
          deferRecovery(record);
        }
        return;
      }
      const failure =
        error instanceof OperationPersistenceError
          ? error
          : new OperationPersistenceError(record.operationId, "write_failed");
      if (recovering) throw failure;
      record.rejectTerminal(failure);
      if (current?.state !== "cancelling") deferRecovery(record);
    }
  };

  const createOperation = async (
    taskInput: TaskSpec
  ): Promise<OperationRecord> => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(TaskSpecSchema)(taskInput)
    );
    const task: TaskSpec = {
      promptRef: decoded.promptRef,
      profile: decoded.profile,
      idempotencyKey: decoded.idempotencyKey,
      ...(decoded.model === undefined ? {} : { model: decoded.model }),
      ...(decoded.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: decoded.thinkingLevel }),
      ...(decoded.tools === undefined ? {} : { tools: decoded.tools }),
      ...(decoded.cwd === undefined ? {} : { cwd: decoded.cwd }),
    };
    await runEffect(services.presentation.preflight());
    const configuration = services.configuration ?? {
      cwd: "/test/workspace",
      profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
    };
    const profile = configuration.profiles[task.profile];
    if (profile === undefined)
      throw new WorkerConfigurationError(
        "unsupported_capability",
        "Unknown Worker profile"
      );
    const requestedConfig = requestedWorkerConfig(task);
    const effectiveConfig = resolveWorkerConfig({
      requested: requestedConfig,
      profile,
      runtimeCwd: configuration.cwd,
    });
    const operationId = await Effect.runPromise(services.ids.nextOperationId());
    const deferred = deferredResult();
    const record: OperationRecord = {
      operationId,
      terminalPromise: deferred.promise,
      resolveTerminal: deferred.resolve,
      rejectTerminal: deferred.reject,
    };
    records.set(operationId, record);
    let operation = await runEffect(
      services.store
        .create({
          operationId,
          task,
          requestedConfig,
          effectiveConfig,
          maxResultByteCount: profile.maxResultByteCount,
        })
        .pipe(
          Effect.map((snapshot) => snapshot.operation),
          Effect.mapError((error) => persistenceError(operationId, error))
        )
    );
    await runEffect(project(operation));
    const created = await runEffect(services.presentation.create(operation));
    try {
      operation = await runEffect(
        advance(operationId, {
          type: "presentation_owned",
          presentation: { ...created, ownedByPions: true },
        })
      );
    } catch (error) {
      await runEffect(
        Effect.catchAllCause(
          services.presentation.rollbackCreated(created),
          () => Effect.void
        )
      );
      records.delete(operationId);
      throw error;
    }
    await runEffect(project(operation));
    record.worker = services.worker.open(operation);
    return record;
  };

  const cancel = (
    record: OperationRecord,
    options: CancelOptions
  ): Promise<CancellationResult> => {
    const key = `${record.operationId}:${options.cancellationEpoch ?? "next"}`;
    const existing = cancellations.get(key);
    if (existing !== undefined) return existing;
    const cancellation: Promise<CancellationResult> = (async () => {
      const initial = await runEffect(getOperation(record.operationId));
      const epoch = options.cancellationEpoch ?? initial.cancellationEpoch + 1;
      if (epoch <= initial.cancellationEpoch)
        throw new CancellationRejectedError("stale_epoch", epoch);
      if (epoch > initial.cancellationEpoch + 1)
        throw new CancellationRejectedError("future_epoch", epoch);
      let operation = await runEffect(
        advance(record.operationId, {
          type: "cancellation_requested",
          cancellationEpoch: epoch,
        })
      );
      await runEffect(project(operation));
      operation = await runEffect(
        advance(record.operationId, {
          type: "cancel_dispatched",
          cancellationEpoch: epoch,
        })
      );
      await runEffect(project(operation));
      const timeoutMs = options.timeoutMs ?? 1_000;
      const evidence = await Promise.race([
        record.worker === undefined
          ? Promise.resolve(undefined)
          : runEffect(record.worker.cancel(epoch, timeoutMs)),
        runEffect(services.clock.sleep(timeoutMs)).then(() => undefined),
      ]).catch(() => undefined);
      if (evidence === undefined) {
        operation = await runEffect(
          advance(record.operationId, {
            type: "operation_unknown",
            reason: "cancel-unproven",
            cancellationEpoch: epoch,
          })
        );
        await settleTerminal(record, operation);
        return {
          cancellationEpoch: epoch,
          state: "unknown" as const,
          reason: "cancel-unproven" as const,
        };
      }
      record.cancelEvidence = {
        cancellationEpoch: epoch,
        proof: evidence.proof,
      };
      operation = await runEffect(
        advance(record.operationId, {
          type: "cancel_acknowledged",
          cancellationEpoch: epoch,
          proof: evidence.proof,
        })
      );
      await runEffect(project(operation));
      operation = await runEffect(
        advance(record.operationId, {
          type: "operation_cancelled",
          cancellationEpoch: epoch,
        })
      );
      await settleTerminal(record, operation);
      return { cancellationEpoch: epoch, state: "cancelled" as const };
    })().catch(async (error) => {
      const current = await runEffect(getOperation(record.operationId)).catch(
        () => undefined
      );
      if (
        current?.state === "cancelling" ||
        (current !== undefined && terminal(current))
      )
        deferRecovery(record);
      throw error;
    });
    cancellations.set(key, cancellation);
    track(cancellation.then(() => undefined));
    return cancellation;
  };

  const recoverCancellation = async (
    record: OperationRecord,
    operation: Operation
  ): Promise<void> => {
    const worker = record.worker;
    const acceptedStop = record.cancelEvidence;
    if (
      acceptedStop !== undefined &&
      acceptedStop.cancellationEpoch === operation.cancellationEpoch
    ) {
      await runEffect(
        advanceAndProject(record.operationId, {
          type: "cancel_acknowledged",
          cancellationEpoch: operation.cancellationEpoch,
          proof: acceptedStop.proof,
        })
      );
      const cancelled = await runEffect(
        advance(record.operationId, {
          type: "operation_cancelled",
          cancellationEpoch: operation.cancellationEpoch,
        })
      );
      await settleTerminal(record, cancelled);
      return;
    }
    const dispatched = await runEffect(
      advance(record.operationId, {
        type: "cancel_dispatched",
        cancellationEpoch: operation.cancellationEpoch,
      })
    );
    await runEffect(project(dispatched));
    const evidence =
      worker === undefined
        ? undefined
        : await runEffect(
            worker.cancel(operation.cancellationEpoch, 1_000)
          ).catch(() => undefined);
    if (evidence === undefined) {
      const unknown = await runEffect(
        advance(record.operationId, {
          type: "operation_unknown",
          reason: "cancel-unproven",
          cancellationEpoch: operation.cancellationEpoch,
        })
      );
      await settleTerminal(record, unknown);
      return;
    }
    record.cancelEvidence = {
      cancellationEpoch: operation.cancellationEpoch,
      proof: evidence.proof,
    };
    await runEffect(
      advanceAndProject(record.operationId, {
        type: "cancel_acknowledged",
        cancellationEpoch: operation.cancellationEpoch,
        proof: evidence.proof,
      })
    );
    const cancelled = await runEffect(
      advance(record.operationId, {
        type: "operation_cancelled",
        cancellationEpoch: operation.cancellationEpoch,
      })
    );
    await settleTerminal(record, cancelled);
  };

  let workersRecovered = false;
  let listingDelayMs = INITIAL_RECOVERY_DELAY_MS;
  const recordFor = (operationId: string): OperationRecord => {
    const existing = records.get(operationId);
    if (existing !== undefined) return existing;
    const deferred = deferredResult();
    const record: OperationRecord = {
      operationId,
      terminalPromise: deferred.promise,
      resolveTerminal: deferred.resolve,
      rejectTerminal: deferred.reject,
    };
    records.set(operationId, record);
    return record;
  };
  const deferRecovery = (record: OperationRecord): void => {
    const delayMs = record.retryDelayMs ?? INITIAL_RECOVERY_DELAY_MS;
    record.retryDelayMs = Math.min(delayMs * 2, MAX_RECOVERY_DELAY_MS);
    record.retryAfter = Date.now() + delayMs;
    record.recoverable = true;
    workersRecovered = false;
    scheduleRecovery(delayMs);
  };
  const recoverWorkers = async (): Promise<void> => {
    const persisted =
      services.recovery === "disabled"
        ? []
        : await runEffect(
            services.store
              .listRecoverableOperations()
              .pipe(
                Effect.mapError((error) =>
                  persistenceError("runtime-recovery", error)
                )
              )
          );
    const local = await Promise.all(
      [...records.values()]
        .filter((record) => record.recoverable)
        .map((record) => storedSnapshot(record.operationId))
    );
    const snapshots = [
      ...new Map(
        [...persisted, ...local].map(
          (snapshot) => [snapshot.operation.operationId, snapshot] as const
        )
      ).values(),
    ];
    const now = Date.now();
    let earliestRetry: number | undefined;
    for (const { operation } of snapshots) {
      let record = records.get(operation.operationId);
      if (record !== undefined && !record.recoverable) continue;
      if (
        !closing &&
        record?.retryAfter !== undefined &&
        record.retryAfter > now
      ) {
        earliestRetry = Math.min(earliestRetry ?? Infinity, record.retryAfter);
        continue;
      }
      if (record === undefined) record = recordFor(operation.operationId);
      record.recoverable = false;
      delete record.retryAfter;
      const recoveredRecord = record;
      try {
        if (terminal(operation)) {
          await settleTerminal(record, operation);
          continue;
        }
        if (
          operation.state === "cancelling" &&
          operation.workerStopConfirmedAt !== undefined
        ) {
          const cancelled = await runEffect(
            advance(operation.operationId, {
              type: "operation_cancelled",
              cancellationEpoch: operation.cancellationEpoch,
            })
          );
          await settleTerminal(record, cancelled);
          continue;
        }
        if (
          operation.state === "running" &&
          operation.result !== undefined &&
          operation.workerStopConfirmedAt !== undefined
        ) {
          const completed = await runEffect(
            advance(operation.operationId, { type: "operation_completed" })
          );
          await settleTerminal(record, completed);
          continue;
        }
        const settle = (work: Promise<void>): void =>
          track(
            work.catch((error) => {
              recoveredRecord.rejectTerminal(error);
              deferRecovery(recoveredRecord);
            })
          );
        if (
          operation.state !== "cancelling" &&
          record.observedOutcome !== undefined
        ) {
          settle(execute(record, true));
          continue;
        }
        const retainedCancellationWorker =
          operation.state === "cancelling" && record.worker !== undefined;
        if (
          !retainedCancellationWorker &&
          (operation.workerIdentity === undefined ||
            operation.startDeliveryAuthority === undefined)
        ) {
          const unknown = await runEffect(
            advance(operation.operationId, {
              type: "operation_unknown",
              ...(operation.state === "cancelling"
                ? {
                    reason: "cancel-unproven" as const,
                    cancellationEpoch: operation.cancellationEpoch,
                  }
                : { reason: "liveness-unproven" as const }),
            })
          );
          await settleTerminal(record, unknown);
          continue;
        }
        if (!retainedCancellationWorker) {
          try {
            record.worker = services.worker.recover(operation);
          } catch {
            const unknown = await runEffect(
              advance(operation.operationId, {
                type: "operation_unknown",
                ...(operation.state === "cancelling"
                  ? {
                      reason: "cancel-unproven" as const,
                      cancellationEpoch: operation.cancellationEpoch,
                    }
                  : { reason: "liveness-unproven" as const }),
              })
            );
            await settleTerminal(record, unknown);
            continue;
          }
        }
        settle(
          operation.state === "cancelling"
            ? recoverCancellation(record, operation)
            : execute(record, true)
        );
      } catch (error) {
        record.recoverable = true;
        throw error;
      }
    }
    if (earliestRetry !== undefined) {
      workersRecovered = false;
      scheduleRecovery(Math.max(0, earliestRetry - Date.now()));
    }
  };

  const recoverCleanups = async (): Promise<void> => {
    if (services.recovery === "disabled") return;
    const snapshots = await runEffect(
      services.store
        .listPendingPresentationCleanups()
        .pipe(
          Effect.mapError((error) =>
            persistenceError("presentation-cleanup-recovery", error)
          )
        )
    );
    const now = Date.now();
    let earliestRetry: number | undefined;
    for (const { operation } of snapshots) {
      const record = records.get(operation.operationId);
      if (record !== undefined && !record.recoverable) continue;
      if (
        !closing &&
        record?.retryAfter !== undefined &&
        record.retryAfter > now
      ) {
        earliestRetry = Math.min(earliestRetry ?? Infinity, record.retryAfter);
        continue;
      }
      try {
        await performCleanup(operation, false);
        if (record !== undefined) delete record.retryDelayMs;
      } catch {
        deferRecovery(recordFor(operation.operationId));
      }
    }
    if (earliestRetry !== undefined) {
      cleanupsRecovered = false;
      scheduleRecovery(Math.max(0, earliestRetry - Date.now()));
    }
  };

  let cleanupsRecovered = false;
  let recovery: Promise<void> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryDue = 0;
  const scheduleRecovery = (delayMs: number): void => {
    if (closing) return;
    const due = Date.now() + delayMs;
    if (recoveryTimer !== undefined) {
      if (recoveryDue <= due) return;
      clearTimeout(recoveryTimer);
    }
    recoveryDue = due;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void Promise.resolve(recovery)
        .catch(() => undefined)
        .then(() => {
          if (!closing) return recover();
        })
        .catch(() => undefined);
    }, delayMs);
    recoveryTimer.unref();
  };
  const recover = (duringClose = false): Promise<void> => {
    if (recovery !== undefined) return recovery;
    if (workersRecovered && cleanupsRecovered) return Promise.resolve();
    if (closing && !duringClose)
      return Promise.reject(new RuntimeClosedError());
    const started = (async () => {
      if (!workersRecovered) {
        workersRecovered = true;
        try {
          await recoverWorkers();
        } catch (error) {
          workersRecovered = false;
          throw error;
        }
      }
      if (!cleanupsRecovered) {
        cleanupsRecovered = true;
        try {
          await recoverCleanups();
        } catch (error) {
          cleanupsRecovered = false;
          throw error;
        }
      }
      listingDelayMs = INITIAL_RECOVERY_DELAY_MS;
    })().catch((error) => {
      scheduleRecovery(listingDelayMs);
      listingDelayMs = Math.min(listingDelayMs * 2, MAX_RECOVERY_DELAY_MS);
      throw error;
    });
    recovery = started;
    void started
      .finally(() => {
        if (recovery === started) recovery = undefined;
      })
      .catch(() => undefined);
    return started;
  };
  void recover().catch(() => undefined);

  return {
    async ready(): Promise<void> {
      await recover();
    },
    async close(): Promise<void> {
      closing = true;
      if (recoveryTimer !== undefined) {
        clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
      }
      await Promise.allSettled([
        ...spawns.values(),
        ...(recovery === undefined ? [] : [recovery]),
      ]);
      let attemptedRecovery = false;
      while (inFlight.size > 0 || !workersRecovered || !cleanupsRecovered) {
        if (!workersRecovered || !cleanupsRecovered) {
          if (attemptedRecovery)
            throw new OperationPersistenceError(
              "runtime-recovery",
              "write_failed"
            );
          attemptedRecovery = true;
          await recover(true);
          continue;
        }
        await Promise.race([...inFlight]);
      }
    },
    spawn(task: TaskSpec): Promise<OperationHandle> {
      if (closing) return Promise.reject(new RuntimeClosedError());
      const existing = spawns.get(task.idempotencyKey);
      if (existing !== undefined) return existing;
      const admitted = (async () => {
        await recover();
        const record = await createOperation(task);
        track(execute(record, false).then(() => undefined));
        return {
          ...reader.forKnownOperation(record.operationId),
          result: () => record.terminalPromise,
          cancel: (options: CancelOptions) => cancel(record, options),
        };
      })();
      spawns.set(task.idempotencyKey, admitted);
      return admitted;
    },
    operation: reader.operation,
  };
}
