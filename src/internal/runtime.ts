import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Schema } from "effect";

import type {
  Operation,
  OperationIntent,
  OperationLineage,
  OperationSnapshot as StoredOperationSnapshot,
  StoreError,
} from "./event-store/index.js";
import { makeResultAcceptance } from "./result-acceptance.js";
import { resolveWorkProductRequirements } from "./result-acceptance-manifest.js";
import { resultAcceptanceRetentionPolicy } from "./result-acceptance-transaction.js";
import { validateWorkspaceScope } from "./resource-proof.js";
import { runtimeArtifactStore } from "./runtime-artifacts.js";
import {
  DEFAULT_WORKER_PROFILE_POLICY,
  RequestedWorkerConfigSchema,
  requestedWorkerConfig,
  resolveWorkerConfig,
} from "./worker-configuration.js";
import type {
  WorkerCancellationEvidence,
  RuntimeServices,
  Worker,
} from "./services.js";
import {
  CancellationRejectedError,
  OperationCancelledError,
  OperationFailedError,
  OperationPersistenceError,
  OperationUnknownError,
  StartAuthorizationAuthenticationError,
  ResourceProofRejectedError,
  ResultRetrievalError,
  SpawnRejectedError,
  WorkerConfigurationError,
} from "../public.js";
import type {
  CancellationResult,
  CancelOptions,
  OperationFailureReason,
  OperationHandle,
  OperationReader,
  OperationSnapshot as PublicOperationSnapshot,
  Result,
  Runtime,
  SpawnOptions,
  TaskSpec,
} from "../public.js";

const MAX_DEPTH = 2;
const MAX_CHILDREN_PER_OPERATION = 3;
const MAX_LIVE_DESCENDANTS_PER_ROOT = 4;
const DESCENDANT_FAILURE_POLICY = "fail_parent" as const;

const TaskSpecSchema = Schema.Struct({
  promptRef: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
  ...RequestedWorkerConfigSchema.fields,
});

class RuntimeError extends Error {
  override readonly name = "RuntimeError";

  constructor(readonly code: "operation_failed", message: string) {
    super(message);
  }
}

interface OperationRecord {
  readonly operationId: string;
  readonly terminalPromise: Promise<Result>;
  readonly resolveTerminal: (result: Result) => void;
  readonly rejectTerminal: (error: unknown) => void;
  pendingAdmissions: number;
  finalizing?: Promise<void>;
  successfulExitConfirmed?: true;
  executionRejected?: true;
  worker?: Worker;
}

function deferredResult(): {
  readonly promise: Promise<Result>;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function isTerminal(operation: Operation): boolean {
  return operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" || operation.state === "unknown";
}

export function makeRuntime(services: RuntimeServices): Runtime {
  const artifactServices = services.artifacts === undefined || services.artifactCredential === undefined
    ? runtimeArtifactStore(join(tmpdir(), `pions-runtime-${randomUUID()}`), services.store)
    : {
        artifacts: services.artifacts,
        credential: services.artifactCredential,
        synchronizeClock: undefined,
      };
  const resultAcceptance = makeResultAcceptance({
    store: services.store,
    artifacts: artifactServices.artifacts,
    artifactCredential: artifactServices.credential,
    clock: services.clock,
    ...(artifactServices.synchronizeClock === undefined
      ? {}
      : { synchronizeArtifactClock: artifactServices.synchronizeClock }),
  });
  const records = new Map<string, OperationRecord>();
  const spawnsByParent = new Map<
    string | undefined,
    Map<string, Promise<OperationHandle>>
  >();
  const cancellations = new Map<string, Promise<CancellationResult>>();
  const cancellingSubtreeRoots = new Set<string>();
  let treeMutationTail = Promise.resolve();

  const serializeTreeMutation = async <Value>(
    mutation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = treeMutationTail;
    let release!: () => void;
    treeMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  };

  const persistenceError = (
    operationId: string,
    error: StoreError,
  ): OperationPersistenceError =>
    new OperationPersistenceError(
      operationId,
      error.code === "not_found" ? "corrupt_record" : error.code,
    );

  const advanceOperation = (
    operationId: string,
    intent: OperationIntent,
  ): Effect.Effect<Operation, OperationPersistenceError> =>
    services.store.advance(operationId, intent).pipe(
      Effect.map((snapshot) => snapshot.operation),
      Effect.mapError((error) => persistenceError(operationId, error)),
    );

  const publicSnapshot = (
    stored: Readonly<StoredOperationSnapshot>,
  ): Readonly<PublicOperationSnapshot> => {
    const operation = stored.operation;
    const resultAcceptance = operation.result === undefined
      ? undefined
      : {
          acceptedAt: operation.result.acceptedAt,
          acceptanceId: operation.result.acceptanceId,
          manifestDigest: operation.result.manifestDigest,
          eventSequenceNumber: operation.result.eventSequenceNumber,
        };
    return Object.freeze({
      operationId: operation.operationId,
      version: Object.freeze({ ...stored.version }),
      state: operation.state,
      ...(operation.failureReason === undefined
        ? {}
        : { failureReason: operation.failureReason }),
      startAuthorization: Object.freeze({
        timing: Object.freeze({ ...operation.startAuthorizationTiming }),
        gate: operation.startGate,
        ...(operation.startupReceipt === undefined ? {} : { receipt: operation.startupReceipt }),
        ...(operation.startAuthorizationDecision === undefined
          ? {}
          : { decision: operation.startAuthorizationDecision }),
      }),
      ...(operation.startInstructionDelivery === undefined
        ? {}
        : { startInstructionDelivery: operation.startInstructionDelivery }),
      ...(operation.startInstructionAcceptance === undefined
        ? {}
        : { startInstructionAcceptance: operation.startInstructionAcceptance }),
      ...(resultAcceptance === undefined
        ? {}
        : { resultAcceptance: Object.freeze(resultAcceptance) }),
      ...(operation.workerStopConfirmedAt === undefined
        ? {}
        : { stopConfirmation: Object.freeze({ confirmedAt: operation.workerStopConfirmedAt, proof: "worker-stop" as const }) }),
      cleanupDiagnostics: Object.freeze(operation.presentationCleanupFailure === undefined
        ? []
        : [Object.freeze({ code: operation.presentationCleanupFailure })]),
      ...(operation.resourceEvidenceRecord === undefined
        ? {}
        : {
            resourceEvidence: Object.freeze({
              version: operation.resourceEvidenceRecord.version,
              evidence: operation.resourceEvidenceRecord.snapshot,
            }),
          }),
    });
  };

  const readStoredSnapshot = (operationId: string) =>
    runEffect(services.store.read(operationId).pipe(
      Effect.mapError((error) => persistenceError(operationId, error)),
    ));

  const getOperation = (operationId: string) =>
    services.store.read(operationId).pipe(
      Effect.map((snapshot) => snapshot.operation),
      Effect.mapError((error) => persistenceError(operationId, error)),
    );

  const project = (operation: Operation): Effect.Effect<void> =>
    Effect.catchAllCause(services.presentation.project(operation), () => Effect.void);

  const readResult = (
    operationId: string,
  ): Effect.Effect<Result, OperationPersistenceError | ResultRetrievalError> =>
    Effect.gen(function* () {
      const snapshot = yield* services.store.read(operationId).pipe(
        Effect.mapError((error) => persistenceError(operationId, error)),
      );
      const accepted = snapshot.operation.result;
      if (accepted === undefined) {
        return yield* Effect.fail(new OperationPersistenceError(operationId, "incomplete_record"));
      }
      const retrieved = yield* Effect.tryPromise({
        try: () => artifactServices.artifacts.retrieve(
          artifactServices.credential,
          accepted.bodyArtifactId,
        ),
        catch: () => new ResultRetrievalError(operationId, "storage_inspection_unavailable"),
      });
      if (retrieved.kind !== "retrieved") {
        return yield* Effect.fail(new ResultRetrievalError(operationId, retrieved.reason));
      }
      const bytes = Buffer.from(retrieved.bytes);
      return {
        body: bytes.toString("utf8"),
        byteCount: bytes.byteLength,
        digest: retrieved.artifact.digest,
      } as Result;
    });

  const runEffect = async <Value>(effect: Effect.Effect<Value, unknown>): Promise<Value> => {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    throw new Error(Cause.pretty(exit.cause));
  };

  const settleTerminal = async (
    record: OperationRecord,
    operation: Operation,
  ): Promise<void> => {
    await runEffect(project(operation));

    if (operation.state === "completed") {
      if (record.successfulExitConfirmed === true) {
        const cleanupFailed = await runEffect(
          services.presentation.closeOwnedPane(operation).pipe(
            Effect.as(false),
            Effect.catchAllCause(() => Effect.succeed(true)),
          ),
        );
        if (cleanupFailed) {
          await runEffect(
            advanceOperation(record.operationId, {
              type: "presentation_cleanup_failed",
              reason: "pane_close_failed",
            }).pipe(Effect.catchAllCause(() => Effect.void)),
          );
        }
      }
      const result = await runEffect(readResult(record.operationId));
      record.resolveTerminal(result);
    } else if (operation.state === "cancelled") {
      record.rejectTerminal(new OperationCancelledError(record.operationId));
    } else if (operation.state === "unknown") {
      record.rejectTerminal(
        new OperationUnknownError(
          record.operationId,
          operation.terminalReason === "liveness-unproven"
            ? "liveness-unproven"
            : "cancel-unproven",
        ),
      );
    } else {
      const reason =
        operation.terminalReason === "worker_start_failed" ||
        operation.terminalReason === "worker_protocol_failed" ||
        operation.terminalReason === "process-exited-without-result" ||
        operation.terminalReason === "agent_failed" ||
        operation.terminalReason === "model_mismatch" ||
        operation.terminalReason === "thinking_level_mismatch" ||
        operation.terminalReason === "model_not_found" ||
        operation.terminalReason === "model_auth_unavailable" ||
        operation.terminalReason === "unsupported_capability" ||
        operation.terminalReason === "tool_policy_violation" ||
        operation.terminalReason === "resource_proof_rejected" ||
        operation.terminalReason === "descendant_failed"
          ? operation.terminalReason
          : "descendant_failed";
      record.rejectTerminal(new OperationFailedError(record.operationId, reason));
    }

    const parentId = operation.lineage.parentOperationId;
    if (parentId === undefined) return;
    const parent = records.get(parentId);
    if (parent === undefined) return;
    const parentOperation = await runEffect(getOperation(parentId));
    if (isTerminal(parentOperation)) return;

    const parentAfterChild = await runEffect(
      advanceOperation(parentId, {
        type: "child_settled",
        childOperationId: record.operationId,
        outcome: operation.state === "completed" ? "succeeded" : "failed",
      }),
    );
    await runEffect(project(parentAfterChild));
    await tryFinalize(parent);
  };

  const finalizeOnce = async (record: OperationRecord): Promise<void> => {
    if (record.pendingAdmissions > 0) return;
    const operation = await runEffect(getOperation(record.operationId));
    if (isTerminal(operation) || operation.selfOutcome === undefined) return;
    if (
      operation.childOperationIds.length !==
      operation.settledChildOperationIds.length
    ) {
      return;
    }

    const failureReason: OperationFailureReason | undefined =
      operation.selfOutcome === "failed"
        ? operation.failureReason
        : operation.descendantFailure &&
            DESCENDANT_FAILURE_POLICY === "fail_parent"
          ? "descendant_failed"
          : undefined;
    const terminal = await runEffect(
      advanceOperation(
        record.operationId,
        failureReason === undefined
          ? { type: "operation_completed" }
          : { type: "operation_failed", reason: failureReason },
      ),
    );
    await settleTerminal(record, terminal);
  };

  const tryFinalize = async (record: OperationRecord): Promise<void> => {
    while (true) {
      const inProgress = record.finalizing;
      if (inProgress !== undefined) {
        await inProgress;
        continue;
      }

      const finalizing = finalizeOnce(record);
      record.finalizing = finalizing;
      try {
        await finalizing;
      } finally {
        delete record.finalizing;
      }
      return;
    }
  };

  const execute = async (record: OperationRecord): Promise<void> => {
    try {
      let operation = await runEffect(
        advanceOperation(record.operationId, { type: "operation_starting" }),
      );
      await runEffect(project(operation));

      const worker = record.worker;
      if (worker === undefined) {
        throw new Error("Worker was not opened");
      }
      const workerOutcome = await runEffect(worker.run({
        workerLaunched: () => advanceOperation(record.operationId, {
          type: "worker_launched",
        }).pipe(
          Effect.tap((launched) => project(launched)),
          Effect.asVoid,
        ),
        workerIdentified: (workerIdentity) => advanceOperation(record.operationId, {
          type: "worker_identified",
          workerIdentity: {
            processId: workerIdentity.processId,
            processInstanceId: workerIdentity.processInstanceId,
            processStartToken: workerIdentity.processStartToken,
            piSessionId: workerIdentity.piSessionId,
            paneId: operation.presentation?.paneId ?? "",
          },
          observedConfig: workerIdentity.observedConfig,
        }).pipe(
          Effect.tap((identified) => project(identified)),
          Effect.flatMap((identified) => {
            const runtimeConfiguration = services.configuration ?? {
              cwd: "/test/workspace",
              profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
            };
            const resourcePolicy = runtimeConfiguration.profiles[identified.task.profile]?.resources;
            if (resourcePolicy?.resourceProofPolicy !== "required") return Effect.void;
            const controller = services.resourceProofController;
            if (controller === undefined) {
              return Effect.fail(new ResourceProofRejectedError(
                "authority_unavailable",
                "Required resource proof adapters are unavailable",
              ));
            }
            return Effect.tryPromise({
              try: async () => {
                await controller.prepare({
                  operationId: identified.operationId,
                  workerProcessInstanceId: workerIdentity.processInstanceId,
                  startAttemptId: `${identified.operationId}:start:1`,
                  workspace: resourcePolicy.workspace,
                  requestedManifest: resourcePolicy.permissionManifest,
                  effectiveManifest: resourcePolicy.permissionManifest,
                  requirements: resourcePolicy,
                });
                await controller.revalidate(identified.operationId);
              },
              catch: (error) => error instanceof ResourceProofRejectedError
                ? error
                : new ResourceProofRejectedError(
                    "validation_unknown",
                    error instanceof Error ? error.message : String(error),
                  ),
            });
          }),
          Effect.flatMap(() => advanceOperation(record.operationId, {
            type: "automatic_operation_started",
          })),
          Effect.tap((started) => project(started)),
          Effect.asVoid,
        ),
        acceptResult: (result) => resultAcceptance.accept(record.operationId, result),
      }));
      if (workerOutcome.state !== "result_acknowledged") {
        const current = await runEffect(getOperation(record.operationId));
        if (isTerminal(current) || current.state === "cancelling") return;
        if (workerOutcome.state === "process-exited-without-result") {
          await services.resourceProofController?.safetyCleanup(record.operationId).catch(() => undefined);
        } else if (
          workerOutcome.state === "liveness-unproven" ||
          workerOutcome.state === "worker_protocol_failed" ||
          workerOutcome.state === "agent_failed"
        ) {
          await services.resourceProofController?.markCleanupUnresolved(record.operationId).catch(() => undefined);
        }
        if (workerOutcome.state === "liveness-unproven") {
          operation = await runEffect(
            advanceOperation(record.operationId, {
              type: "operation_unknown",
              reason: "liveness-unproven",
            }),
          );
          await settleTerminal(record, operation);
          return;
        }
        if (workerOutcome.state === "worker_start_failed") {
          await runEffect(
            Effect.catchAllCause(
              services.presentation.onWorkerStartFailure(current),
              () => Effect.void,
            ),
          );
        }
        if (workerOutcome.state === "agent_failed") {
          operation = await runEffect(
            advanceOperation(record.operationId, {
              type: "agent_settled",
              evidence: workerOutcome.evidence,
            }),
          );
          await runEffect(project(operation));
        }
        operation = await runEffect(
          advanceOperation(record.operationId, {
            type: "self_settled",
            outcome: "failed",
            reason: workerOutcome.state,
          }),
        );
        await runEffect(project(operation));
        await tryFinalize(record);
        return;
      }
      if (workerOutcome.successfulExitConfirmed === true) {
        record.successfulExitConfirmed = true;
        operation = await runEffect(
          advanceOperation(record.operationId, {
            type: "worker_stop_confirmed",
            proof: "worker-stop",
          }),
        );
        await runEffect(project(operation));
        const runtimeConfiguration = services.configuration ?? {
          cwd: "/test/workspace",
          profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
        };
        const resources = runtimeConfiguration.profiles[operation.task.profile]?.resources;
        if (resources?.resourceProofPolicy === "required" && resources.cleanupPolicy === "automatic") {
          await services.resourceProofController?.automaticCleanup(record.operationId).catch(() => undefined);
        }
      }

      operation = await runEffect(
        advanceOperation(record.operationId, {
          type: "agent_settled",
          evidence: workerOutcome.evidence,
        }),
      );
      await runEffect(project(operation));
      operation = await runEffect(
        advanceOperation(record.operationId, {
          type: "self_settled",
          outcome: "succeeded",
        }),
      );
      await runEffect(project(operation));
      await tryFinalize(record);
    } catch (error) {
      const current = await runEffect(getOperation(record.operationId)).catch(() => undefined);
      if (
        current !== undefined &&
        (isTerminal(current) || current.state === "cancelling")
      ) {
        return;
      }
      if (error instanceof ResourceProofRejectedError && current !== undefined) {
        const stopped = record.worker === undefined
          ? undefined
          : await runEffect(record.worker.cancel(current.cancellationEpoch + 1, 1_000)).catch(() => undefined);
        if (stopped === undefined) {
          const unknown = await runEffect(advanceOperation(record.operationId, {
            type: "operation_unknown",
            reason: "liveness-unproven",
          }));
          await settleTerminal(record, unknown);
          return;
        }
        await services.resourceProofController?.safetyCleanup(record.operationId).catch(() => undefined);
        const failed = await runEffect(advanceOperation(record.operationId, {
          type: "self_settled",
          outcome: "failed",
          reason: "resource_proof_rejected",
        }));
        await runEffect(project(failed));
        await tryFinalize(record);
        return;
      }
      record.rejectTerminal(
        error instanceof OperationPersistenceError
          ? error
          : new RuntimeError(
              "operation_failed",
              error instanceof Error ? error.message : String(error),
            ),
      );
    }
  };

  const countLiveDescendants = async (rootOperationId: string): Promise<number> => {
    let count = 0;
    for (const active of records.values()) {
      const operation = await runEffect(getOperation(active.operationId));
      if (
        operation.lineage.rootOperationId === rootOperationId &&
        operation.lineage.parentOperationId !== undefined &&
        !isTerminal(operation)
      ) {
        count += 1;
      }
    }
    return count;
  };

  const createOperationUnlocked = async (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationRecord> => {
    await runEffect(services.presentation.preflight());
    const decodedTask = await Effect.runPromise(
      Schema.decodeUnknown(TaskSpecSchema)(taskInput),
    );
    const task: TaskSpec = {
      promptRef: decodedTask.promptRef,
      profile: decodedTask.profile,
      idempotencyKey: decodedTask.idempotencyKey,
      ...(decodedTask.model === undefined ? {} : { model: decodedTask.model }),
      ...(decodedTask.thinkingLevel === undefined ? {} : { thinkingLevel: decodedTask.thinkingLevel }),
      ...(decodedTask.tools === undefined ? {} : { tools: decodedTask.tools }),
      ...(decodedTask.cwd === undefined ? {} : { cwd: decodedTask.cwd }),
    };
    const parentId = options?.parentOperationId;
    const parent = parentId === undefined ? undefined : records.get(parentId);

    if (parentId !== undefined && parent === undefined) {
      throw new SpawnRejectedError("parent_not_found", parentId);
    }
    const parentOperation = parent === undefined
      ? undefined
      : await runEffect(getOperation(parent.operationId));
    if (parent !== undefined && parentOperation !== undefined) {
      let cancellationInProgress = parentOperation.spawnFrozen;
      for (const cancellingRootId of cancellingSubtreeRoots) {
        if (await isAncestor(cancellingRootId, parent.operationId)) {
          cancellationInProgress = true;
          break;
        }
      }
      if (cancellationInProgress) {
        throw new SpawnRejectedError(
          "cancellation_in_progress",
          parent.operationId,
        );
      }
      if (isTerminal(parentOperation) || parentOperation.selfOutcome !== undefined) {
        throw new SpawnRejectedError("parent_terminal", parent.operationId);
      }
      if (parentOperation.lineage.depth + 1 > MAX_DEPTH) {
        throw new SpawnRejectedError("depth_limit_exceeded", parent.operationId);
      }
      if (
        parentOperation.childOperationIds.length + parent.pendingAdmissions >=
        MAX_CHILDREN_PER_OPERATION
      ) {
        throw new SpawnRejectedError("child_limit_exceeded", parent.operationId);
      }
      const live = await countLiveDescendants(parentOperation.lineage.rootOperationId);
      if (live >= MAX_LIVE_DESCENDANTS_PER_ROOT) {
        throw new SpawnRejectedError(
          "live_descendant_limit_exceeded",
          parent.operationId,
        );
      }
      parent.pendingAdmissions += 1;
    }

    const requestedConfig = requestedWorkerConfig(task);
    const runtimeConfiguration = services.configuration ?? {
      cwd: "/test/workspace",
      profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
    };
    let effectiveConfig;
    let resourceConfigurationRejected = false;
    const configuredProfile = runtimeConfiguration.profiles[task.profile];
    try {
      effectiveConfig = resolveWorkerConfig({
        requested: requestedConfig,
        profile: configuredProfile,
        runtimeCwd: runtimeConfiguration.cwd,
        ...(parentOperation === undefined ? {} : { parent: parentOperation.effectiveConfig }),
      });
    } catch (error) {
      if (!(error instanceof ResourceProofRejectedError) || configuredProfile === undefined) {
        if (parent !== undefined) parent.pendingAdmissions -= 1;
        throw error;
      }
      resourceConfigurationRejected = true;
      try {
        effectiveConfig = resolveWorkerConfig({
          requested: requestedConfig,
          profile: { ...configuredProfile, resources: { resourceProofPolicy: "disabled" } },
          runtimeCwd: runtimeConfiguration.cwd,
          ...(parentOperation === undefined ? {} : { parent: parentOperation.effectiveConfig }),
        });
      } catch (configurationError) {
        if (parent !== undefined) parent.pendingAdmissions -= 1;
        throw configurationError;
      }
    }

    const workProductRequirements = resolveWorkProductRequirements(configuredProfile!);
    if (
      services.worker.producesWorkProducts !== true &&
      workProductRequirements.workProducts.some(({ minCount }) => minCount > 0)
    ) {
      if (parent !== undefined) parent.pendingAdmissions -= 1;
      throw new WorkerConfigurationError(
        "unsupported_capability",
        "The Worker adapter cannot produce required work products",
      );
    }

    const resourcePolicy = configuredProfile?.resources;
    const resourceAdmissionRejected = resourceConfigurationRejected ||
      resourcePolicy?.resourceProofPolicy === "required" && services.resourceProofController === undefined;
    if (!resourceConfigurationRejected && resourcePolicy?.resourceProofPolicy === "required") {
      await validateWorkspaceScope(resourcePolicy.workspace.normalizedPath, resourcePolicy.permissionManifest.read);
      await validateWorkspaceScope(resourcePolicy.workspace.normalizedPath, resourcePolicy.permissionManifest.write);
    }

    let operationId: string;
    try {
      operationId = await Effect.runPromise(services.ids.nextOperationId());
    } catch (error) {
      if (parent !== undefined) parent.pendingAdmissions -= 1;
      throw error;
    }

    const lineage: OperationLineage =
      parentOperation === undefined
        ? { rootOperationId: operationId, depth: 0 }
        : {
            rootOperationId: parentOperation.lineage.rootOperationId,
            parentOperationId: parentOperation.operationId,
            depth: parentOperation.lineage.depth + 1,
          };
    const deferred = deferredResult();
    const record: OperationRecord = {
      operationId,
      terminalPromise: deferred.promise,
      resolveTerminal: deferred.resolve,
      rejectTerminal: deferred.reject,
      pendingAdmissions: 0,
    };

    if (parent !== undefined) {
      const updatedParent = await runEffect(
        advanceOperation(parent.operationId, {
          type: "child_attached",
          childOperationId: operationId,
        }),
      );
      parent.pendingAdmissions -= 1;
      await runEffect(project(updatedParent));
    }

    records.set(operationId, record);
    let operation = await runEffect(
      services.store.create({
        operationId,
        task,
        requestedConfig,
        effectiveConfig,
        workProductRequirements,
        resultRetentionPolicy: resultAcceptanceRetentionPolicy(
          operationId,
          configuredProfile!.acceptedArtifactRetentionMs,
        ),
        lineage,
      }).pipe(
        Effect.map((snapshot) => snapshot.operation),
        Effect.mapError((error) => persistenceError(operationId, error)),
      ),
    );
    await runEffect(project(operation));

    if (resourceAdmissionRejected) {
      operation = await runEffect(advanceOperation(operationId, { type: "operation_starting" }));
      operation = await runEffect(advanceOperation(operationId, {
        type: "self_settled",
        outcome: "failed",
        reason: "resource_proof_rejected",
      }));
      operation = await runEffect(advanceOperation(operationId, {
        type: "operation_failed",
        reason: "resource_proof_rejected",
      }));
      record.executionRejected = true;
      await settleTerminal(record, operation);
      return record;
    }

    const createdPresentation = await runEffect(services.presentation.create(operation));
    try {
      operation = await runEffect(
        advanceOperation(operationId, {
          type: "presentation_owned",
          presentation: { ...createdPresentation, ownedByPions: true },
        }),
      );
    } catch (error) {
      await runEffect(
        Effect.catchAllCause(
          services.presentation.rollbackCreated(createdPresentation),
          () => Effect.void,
        ),
      );
      records.delete(operationId);
      throw error;
    }
    await runEffect(project(operation));
    record.worker = services.worker.open(operation);
    return record;
  };

  const createOperation = (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationRecord> =>
    serializeTreeMutation(() => createOperationUnlocked(taskInput, options));

  const isAncestor = async (
    possibleAncestorId: string,
    operationId: string,
  ): Promise<boolean> => {
    let currentId: string | undefined = operationId;
    while (currentId !== undefined) {
      if (currentId === possibleAncestorId) return true;
      const current = records.get(currentId);
      if (current === undefined) return false;
      const operation = await runEffect(getOperation(current.operationId));
      currentId = operation.lineage.parentOperationId;
    }
    return false;
  };

  interface CancellationNode {
    readonly record: OperationRecord;
    readonly childOperationIds: ReadonlyArray<string>;
  }

  const collectPostOrder = async (
    record: OperationRecord,
    postOrder: Array<CancellationNode>,
  ): Promise<void> => {
    const operation = await runEffect(getOperation(record.operationId));
    if (isTerminal(operation)) return;
    const activeChildIds: Array<string> = [];
    for (const childId of operation.childOperationIds) {
      const child = records.get(childId);
      if (child === undefined) continue;
      const childOperation = await runEffect(getOperation(childId));
      if (isTerminal(childOperation)) continue;
      activeChildIds.push(childId);
      await collectPostOrder(child, postOrder);
    }
    postOrder.push({ record, childOperationIds: activeChildIds });
  };

  const beginCancellation = async (
    root: OperationRecord,
    options: CancelOptions,
  ): Promise<CancellationResult> => {
    const rootOperation = await runEffect(getOperation(root.operationId));
    const epoch = options.cancellationEpoch ?? rootOperation.cancellationEpoch + 1;
    if (epoch <= rootOperation.cancellationEpoch) {
      throw new CancellationRejectedError("stale_epoch", epoch);
    }

    let overlapsCancellation = false;
    for (const rootId of cancellingSubtreeRoots) {
      if (rootId === root.operationId) continue;
      if (
        await isAncestor(rootId, root.operationId) ||
        await isAncestor(root.operationId, rootId)
      ) {
        overlapsCancellation = true;
        break;
      }
    }
    if (
      rootOperation.spawnFrozen ||
      epoch > rootOperation.cancellationEpoch + 1 ||
      overlapsCancellation
    ) {
      throw new CancellationRejectedError("future_epoch", epoch);
    }
    const cancellation: Promise<CancellationResult> = serializeTreeMutation(async () => {
      const postOrder: Array<CancellationNode> = [];
      await collectPostOrder(root, postOrder);
      for (const { record } of postOrder) {
        const operation = await runEffect(
          advanceOperation(record.operationId, {
            type: "cancellation_requested",
            cancellationEpoch: epoch,
          }),
        );
        await runEffect(project(operation));
      }
      return postOrder;
    }).then(async (postOrder) => {
      const responses: Array<
        Promise<WorkerCancellationEvidence | undefined>
      > = [];
      const timeoutMs = options.timeoutMs ?? 1_000;
      for (const { record } of postOrder) {
        const operation = await runEffect(
          advanceOperation(record.operationId, {
            type: "cancel_dispatched",
            cancellationEpoch: epoch,
          }),
        );
        await runEffect(project(operation));
        const response = Promise.race([
          record.worker === undefined
            ? Promise.resolve(undefined)
            : runEffect(record.worker.cancel(epoch, timeoutMs)),
          runEffect(services.clock.sleep(timeoutMs)).then(
            () => undefined,
          ),
        ]).catch(() => undefined);
        responses.push(response);
      }

      const evidence = await Promise.all(responses);
      const unprovenSubtrees = new Set<string>();
      let rootState: CancellationResult["state"] = "cancelled";
      for (let index = 0; index < postOrder.length; index += 1) {
        const node = postOrder[index];
        if (node === undefined) continue;
        const descendantUnproven = node.childOperationIds.some((childId) =>
          unprovenSubtrees.has(childId),
        );
        const response = evidence[index];
        const unproven = response === undefined || descendantUnproven;
        if (unproven) unprovenSubtrees.add(node.record.operationId);

        if (response !== undefined) {
          const acknowledged = await runEffect(
            advanceOperation(node.record.operationId, {
              type: "cancel_acknowledged",
              cancellationEpoch: epoch,
              proof: response.proof,
            }),
          );
          await runEffect(project(acknowledged));
          await services.resourceProofController?.safetyCleanup(node.record.operationId).catch(() => undefined);
        }

        const terminal = unproven
          ? await runEffect(
              advanceOperation(node.record.operationId, {
                type: "operation_unknown",
                cancellationEpoch: epoch,
                reason: "cancel-unproven",
              }),
            )
          : await runEffect(
              advanceOperation(node.record.operationId, {
                type: "operation_cancelled",
                cancellationEpoch: epoch,
              }),
            );
        await settleTerminal(node.record, terminal);
        if (node.record === root) {
          rootState = terminal.state as CancellationResult["state"];
        }
      }

      return rootState === "unknown"
        ? {
            cancellationEpoch: epoch,
            state: rootState,
            reason: "cancel-unproven" as const,
          }
        : { cancellationEpoch: epoch, state: rootState };
    });
    return cancellation;
  };

  const cancelSubtree = (
    operationId: string,
    options: CancelOptions,
  ): Promise<CancellationResult> => {
    const record = records.get(operationId);
    if (record === undefined) {
      return Promise.reject(new Error(`Operation not admitted: ${operationId}`));
    }
    const requestedEpoch = options.cancellationEpoch;
    if (requestedEpoch !== undefined) {
      const key = `${operationId}:${requestedEpoch}`;
      const existing = cancellations.get(key);
      if (existing !== undefined) return existing;
      cancellingSubtreeRoots.add(operationId);
      const cancellation = beginCancellation(record, options);
      cancellations.set(key, cancellation);
      return cancellation;
    }
    if (cancellingSubtreeRoots.has(operationId)) {
      return runEffect(getOperation(operationId)).then((operation) =>
        Promise.reject(
          new CancellationRejectedError(
            "future_epoch",
            operation.cancellationEpoch + 2,
          ),
        ),
      );
    }
    cancellingSubtreeRoots.add(operationId);
    return beginCancellation(record, options);
  };

  const readPublicSnapshot = async (operationId: string): Promise<Readonly<PublicOperationSnapshot>> =>
    publicSnapshot(await readStoredSnapshot(operationId));

  const createReader = (operationId: string): OperationReader => ({
    operationId,
    read: () => readPublicSnapshot(operationId),
    waitForStartupReceipt: async () => {
      while (true) {
        const snapshot = await readPublicSnapshot(operationId);
        const receipt = snapshot.startAuthorization.receipt;
        if (receipt !== undefined) return receipt;
        if (snapshot.state === "completed" || snapshot.state === "failed" ||
            snapshot.state === "cancelled" || snapshot.state === "unknown") {
          return undefined;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    },
  });

  const createHandle = async (
    task: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationHandle> => {
    const record = await createOperation(task, options);
    if (record.executionRejected !== true) void execute(record);
    return {
      ...createReader(record.operationId),
      result: () => record.terminalPromise,
      cancel: (cancelOptions) =>
        cancelSubtree(record.operationId, cancelOptions),
    };
  };

  return {
    spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle> {
      const parentOperationId = options?.parentOperationId;
      let spawnsByKey = spawnsByParent.get(parentOperationId);
      if (spawnsByKey === undefined) {
        spawnsByKey = new Map();
        spawnsByParent.set(parentOperationId, spawnsByKey);
      }

      const existing = spawnsByKey.get(task.idempotencyKey);
      if (existing !== undefined) return existing;

      const spawn = createHandle(task, options);
      spawnsByKey.set(task.idempotencyKey, spawn);
      return spawn;
    },

    async operation(operationId: string): Promise<OperationReader> {
      await readStoredSnapshot(operationId);
      return createReader(operationId);
    },

    resourceProofs() {
      const controller = services.resourceProofController;
      if (controller === undefined) {
        throw new ResourceProofRejectedError(
          "authority_unavailable",
          "Resource proof adapters are unavailable",
        );
      }
      return {
        prepare: async (request) => {
          const stored = await readStoredSnapshot(request.operationId);
          const profile = services.configuration?.profiles[stored.operation.task.profile];
          if (profile?.resources.resourceProofPolicy !== "required" ||
              !isDeepStrictEqual(profile.resources, request.requirements)) {
            throw new ResourceProofRejectedError(
              "binding_mismatch",
              "Resource request differs from the Operation's fixed profile",
            );
          }
          if (stored.operation.state !== "starting" ||
              stored.operation.workerIdentity?.processInstanceId !== request.workerProcessInstanceId) {
            throw new ResourceProofRejectedError(
              "binding_mismatch",
              "Resource request is not bound to the Operation Worker",
            );
          }
          return controller.prepare(request);
        },
        revalidate: async (operationId) => {
          await readStoredSnapshot(operationId);
          return controller.revalidate(operationId);
        },
        cleanup: async (operationId, credential) => {
          await readStoredSnapshot(operationId);
          return controller.cleanup(operationId, credential);
        },
        read: async (operationId) => {
          await readStoredSnapshot(operationId);
          return controller.read(operationId);
        },
      };
    },

    async startAuthorizationInbox(credential: string) {
      const authenticator = services.startAuthorizationAuthenticator;
      if (authenticator === undefined) {
        throw new StartAuthorizationAuthenticationError("Start authorization authentication is unavailable");
      }
      const principal = await authenticator.authenticate(credential);
      return {
        listWaiting: async () => {
          const stored = await runEffect(services.store.listWaitingStartAuthorizations().pipe(
            Effect.mapError((error) => persistenceError("start-authorization-inbox", error)),
          ));
          const allowed = [];
          for (const snapshot of stored) {
            if (!(await principal.canAuthorize(snapshot.operation.operationId))) continue;
            const receipt = snapshot.operation.startupReceipt;
            if (receipt === undefined) continue;
            allowed.push(Object.freeze({
              operationId: snapshot.operation.operationId,
              version: Object.freeze({ ...snapshot.version }),
              deadline: snapshot.operation.startAuthorizationTiming.deadline,
              receipt,
            }));
          }
          return Object.freeze(allowed);
        },
      };
    },
  };
}
