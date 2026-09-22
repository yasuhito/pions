import { createHash } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";

import {
  presentationCleanupEligible,
  RUNTIME_ACTOR_ID,
} from "./event-store/index.js";
import type {
  Operation,
  OperationIntent,
  OperationSnapshot as StoredOperationSnapshot,
  StoreError,
} from "./event-store/index.js";
import { makeResultAcceptance } from "./result-acceptance.js";
import { sha256Digest } from "./result-digest.js";
import {
  DEFAULT_WORKER_PROFILE_POLICY,
  RequestedWorkerConfigSchema,
  requestedWorkerConfig,
  resolveWorkerConfig,
} from "./worker-configuration.js";
import { StartDeliveryAbortedError } from "./services.js";
import type { RuntimeServices, Worker } from "./services.js";
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
  ResultCursorError,
  ResultRetrievalError,
  RuntimeClosedError,
  WorkerConfigurationError,
} from "../public.js";
import type {
  CancellationResult,
  CancelOptions,
  CleanupDiagnosticCode,
  OperationCompletion,
  OperationFailureReason,
  OperationHandle,
  OperationReader,
  OperationSnapshot as PublicOperationSnapshot,
  Result,
  ResultAcceptanceId,
  ResultChunkReadOutcome,
  ResultReadOutcome,
  Runtime,
  TaskSpec,
} from "../public.js";

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

export function makeRuntime(services: RuntimeServices): Runtime {
  const resultAcceptance = makeResultAcceptance({
    store: services.store,
    ...(services.formalReviewResultFormats === undefined
      ? {}
      : { resultFormats: services.formalReviewResultFormats.registry }),
  });
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

  const storedSnapshot = (operationId: string) =>
    runEffect(
      services.store
        .read(operationId)
        .pipe(Effect.mapError((error) => persistenceError(operationId, error)))
    );

  const getOperation = (operationId: string) =>
    services.store.read(operationId).pipe(
      Effect.map((snapshot) => snapshot.operation),
      Effect.mapError((error) => persistenceError(operationId, error))
    );

  const publicSnapshot = (
    stored: Readonly<StoredOperationSnapshot>
  ): Readonly<PublicOperationSnapshot> => {
    const operation = stored.operation;
    return Object.freeze({
      operationId: operation.operationId,
      version: Object.freeze({ ...stored.version }),
      state: operation.state,
      ...(operation.state !== "unknown"
        ? {}
        : {
            unknownReason:
              operation.terminalReason === "cancel-unproven"
                ? "cancel-unproven"
                : operation.terminalReason === "start-acceptance-unknown"
                  ? "start-acceptance-unknown"
                  : "liveness-unproven",
          }),
      ...(operation.failureReason === undefined
        ? {}
        : { failureReason: operation.failureReason }),
      ...(operation.resultFormat === undefined
        ? {}
        : { resultFormat: structuredClone(operation.resultFormat) }),
      ...(operation.resultFormatRejection === undefined
        ? {}
        : {
            resultFormatRejection: structuredClone(
              operation.resultFormatRejection
            ),
          }),
      ...(operation.workerIdentity === undefined
        ? {}
        : { workerIdentity: structuredClone(operation.workerIdentity) }),
      effectiveConfig: structuredClone(operation.effectiveConfig),
      ...(operation.observedConfig === undefined
        ? {}
        : { observedConfig: structuredClone(operation.observedConfig) }),
      ...(operation.agentRunEvidence === undefined
        ? {}
        : {
            workerExecutionEvidence: structuredClone(
              operation.agentRunEvidence
            ),
          }),
      ...(operation.startDeliveryAuthority === undefined
        ? {}
        : { startDeliveryAuthority: operation.startDeliveryAuthority }),
      ...(operation.startDeliveryEntry === undefined
        ? {}
        : { startDeliveryEntry: operation.startDeliveryEntry }),
      ...(operation.startInstructionDelivery === undefined
        ? {}
        : { startInstructionDelivery: operation.startInstructionDelivery }),
      ...(operation.startInstructionAcceptance === undefined
        ? {}
        : { startInstructionAcceptance: operation.startInstructionAcceptance }),
      ...(operation.startInstructionAcknowledgement === undefined
        ? {}
        : {
            startInstructionAcknowledgement:
              operation.startInstructionAcknowledgement,
          }),
      startDeliveryHandoffs: operation.startDeliveryHandoffs,
      ...(operation.result === undefined
        ? {}
        : {
            resultAcceptance: Object.freeze({
              acceptedAt: operation.result.acceptedAt,
              acceptanceId: operation.result.acceptanceId,
              byteCount: operation.result.byteCount,
              digest: operation.result.digest,
              eventSequenceNumber: operation.result.eventSequenceNumber,
            }),
          }),
      ...(operation.workerStopConfirmedAt === undefined
        ? {}
        : {
            stopConfirmation: Object.freeze({
              confirmedAt: operation.workerStopConfirmedAt,
              proof: "worker-stop" as const,
            }),
          }),
      ...(operation.presentationCleanup === undefined
        ? {}
        : {
            presentationCleanup: Object.freeze({
              cleanupId: operation.presentationCleanup.cleanupId,
              workspaceId: operation.presentationCleanup.workspaceId,
              state: operation.presentationCleanup.state,
              startedAt: operation.presentationCleanup.startedAt,
              ...(operation.presentationCleanup.finishedAt === undefined
                ? {}
                : { finishedAt: operation.presentationCleanup.finishedAt }),
            }),
          }),
      cleanupDiagnostics: Object.freeze(
        operation.presentationCleanup?.diagnostic === undefined
          ? []
          : [Object.freeze({ code: operation.presentationCleanup.diagnostic })]
      ),
    });
  };

  const readPublicSnapshot = async (operationId: string) =>
    publicSnapshot(await storedSnapshot(operationId));

  const notAccepted = (
    snapshot: Readonly<StoredOperationSnapshot>
  ): Exclude<ResultReadOutcome, { readonly kind: "retrieved" }> => ({
    kind: "not_accepted",
    version: Object.freeze({ ...snapshot.version }),
    state: snapshot.operation.state,
    ...(snapshot.operation.failureReason === undefined
      ? {}
      : { failureReason: snapshot.operation.failureReason }),
  });

  const retrieveResult = (
    operationId: string,
    accepted: NonNullable<StoredOperationSnapshot["operation"]["result"]>
  ): Effect.Effect<
    {
      readonly result: Readonly<Result>;
      readonly bytes: Buffer;
      readonly acceptanceId: ResultAcceptanceId;
    },
    ResultRetrievalError
  > =>
    Effect.gen(function* () {
      const stored = yield* services.store
        .readResultBody(operationId)
        .pipe(
          Effect.mapError(
            () =>
              new ResultRetrievalError(
                operationId,
                "storage_inspection_unavailable"
              )
          )
        );
      if (
        stored === undefined ||
        stored.byteLength !== accepted.byteCount ||
        sha256Digest(stored) !== accepted.digest
      )
        return yield* Effect.fail(
          new ResultRetrievalError(operationId, "stored_result_corrupt")
        );
      const bytes = Buffer.from(stored);
      return {
        result: {
          body: bytes.toString("utf8"),
          byteCount: bytes.byteLength,
          digest: accepted.digest,
        },
        bytes,
        acceptanceId: accepted.acceptanceId,
      };
    });

  const readResult = async (
    operationId: string
  ): Promise<ResultReadOutcome> => {
    const snapshot = await storedSnapshot(operationId);
    if (snapshot.operation.result === undefined) return notAccepted(snapshot);
    const retrieved = await runEffect(
      retrieveResult(operationId, snapshot.operation.result)
    );
    return {
      kind: "retrieved",
      acceptanceId: retrieved.acceptanceId,
      result: retrieved.result,
    };
  };

  interface ResultCursorPayload {
    readonly version: 1;
    readonly operationId: string;
    readonly acceptanceId: ResultAcceptanceId;
    readonly digest: string;
    readonly maxBytes: number;
    readonly startByte: number;
  }

  const encodeCursor = (payload: ResultCursorPayload): string => {
    const document = JSON.stringify(payload);
    const checksum = createHash("sha256").update(document).digest("base64url");
    return Buffer.from(JSON.stringify({ document, checksum })).toString(
      "base64url"
    );
  };

  const decodeCursor = (
    operationId: string,
    cursor: string
  ): ResultCursorPayload => {
    try {
      const decoded = Buffer.from(cursor, "base64url");
      if (decoded.toString("base64url") !== cursor)
        throw new Error("non-canonical cursor");
      const envelope = JSON.parse(decoded.toString("utf8")) as {
        readonly document?: unknown;
        readonly checksum?: unknown;
      };
      if (
        typeof envelope.document !== "string" ||
        typeof envelope.checksum !== "string" ||
        createHash("sha256").update(envelope.document).digest("base64url") !==
          envelope.checksum
      )
        throw new Error("invalid checksum");
      const payload = JSON.parse(
        envelope.document
      ) as Partial<ResultCursorPayload>;
      if (
        payload.version !== 1 ||
        typeof payload.operationId !== "string" ||
        typeof payload.acceptanceId !== "string" ||
        typeof payload.digest !== "string" ||
        !Number.isSafeInteger(payload.maxBytes) ||
        !Number.isSafeInteger(payload.startByte)
      )
        throw new Error("invalid payload");
      if (payload.operationId !== operationId)
        throw new ResultCursorError(operationId, "wrong_operation");
      return payload as ResultCursorPayload;
    } catch (error) {
      if (error instanceof ResultCursorError) throw error;
      throw new ResultCursorError(operationId, "invalid");
    }
  };

  const readResultChunk = async (
    operationId: string,
    options: { readonly maxBytes: number; readonly cursor?: string }
  ): Promise<Readonly<ResultChunkReadOutcome>> => {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 4)
      throw new RangeError("maxBytes must be a safe integer of at least 4");
    const cursor =
      options.cursor === undefined
        ? undefined
        : decodeCursor(operationId, options.cursor);
    const snapshot = await storedSnapshot(operationId);
    if (snapshot.operation.result === undefined) return notAccepted(snapshot);
    const retrieved = await runEffect(
      retrieveResult(operationId, snapshot.operation.result)
    );
    if (
      cursor !== undefined &&
      (cursor.acceptanceId !== retrieved.acceptanceId ||
        cursor.digest !== retrieved.result.digest ||
        cursor.maxBytes !== options.maxBytes)
    )
      throw new ResultCursorError(operationId, "result_mismatch");
    const startByte = cursor?.startByte ?? 0;
    if (
      startByte < 0 ||
      startByte > retrieved.bytes.byteLength ||
      (startByte === retrieved.bytes.byteLength && cursor !== undefined)
    )
      throw new ResultCursorError(operationId, "invalid");
    let endByte = Math.min(
      startByte + options.maxBytes,
      retrieved.bytes.byteLength
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (endByte > startByte) {
      try {
        decoder.decode(retrieved.bytes.subarray(startByte, endByte));
        break;
      } catch {
        endByte -= 1;
      }
    }
    if (endByte === startByte && retrieved.bytes.byteLength > 0)
      throw new ResultCursorError(operationId, "invalid");
    const nextCursor =
      endByte === retrieved.bytes.byteLength
        ? undefined
        : encodeCursor({
            version: 1,
            operationId,
            acceptanceId: retrieved.acceptanceId,
            digest: retrieved.result.digest,
            maxBytes: options.maxBytes,
            startByte: endByte,
          });
    return {
      kind: "retrieved",
      chunk: {
        acceptanceId: retrieved.acceptanceId,
        body: retrieved.bytes.subarray(startByte, endByte).toString("utf8"),
        startByte,
        totalByteCount: retrieved.bytes.byteLength,
        digest: retrieved.result.digest,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    };
  };

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
      } catch {
        if (directResponseAvailable)
          noteVolatileDiagnostic(
            operation.operationId,
            "cleanup_record_unavailable"
          );
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
      } catch {
        if (directResponseAvailable) {
          noteVolatileDiagnostic(
            operation.operationId,
            "cleanup_record_unavailable"
          );
          noteVolatileDiagnostic(operation.operationId, code);
        }
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
    } catch {
      if (directResponseAvailable)
        noteVolatileDiagnostic(
          operation.operationId,
          "cleanup_record_unavailable"
        );
    }
  };

  const settleTerminal = async (
    record: OperationRecord,
    operation: Operation
  ): Promise<void> => {
    try {
      await runEffect(project(operation));
      if (operation.state === "completed") {
        await performCleanup(operation, true);
        const outcome = await readResult(record.operationId);
        if (outcome.kind !== "retrieved")
          throw new OperationPersistenceError(
            record.operationId,
            "incomplete_record"
          );
        const snapshot = await readPublicSnapshot(record.operationId);
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
          operation.failureReason ?? "worker_protocol_failed"
        )
      );
    } catch (error) {
      record.rejectTerminal(error);
      throw error;
    }
  };

  const execute = async (
    record: OperationRecord,
    recovering: boolean
  ): Promise<void> => {
    try {
      let operation = await runEffect(getOperation(record.operationId));
      if (!recovering) {
        operation = await runEffect(
          advance(record.operationId, { type: "operation_starting" })
        );
        await runEffect(project(operation));
      }
      const worker = record.worker;
      if (worker === undefined) throw new Error("Worker was not opened");
      const outcome = await runEffect(
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
                      existing.processInstanceId !==
                        identity.processInstanceId ||
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
                if (
                  acceptedCurrent.startInstructionAcknowledgement === undefined
                )
                  yield* advanceAndProject(record.operationId, {
                    type: "start_instruction_acknowledged",
                    instruction: startInstructionReference(accepted),
                    proof: "authenticated-generation-acknowledgement",
                  });
                return;
              }
              const previous = current.startDeliveryAuthority;
              if (
                previous === undefined ||
                current.workerIdentity === undefined
              )
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

      if (outcome.successfulExitConfirmed === true) {
        const current = await runEffect(getOperation(record.operationId));
        if (!terminal(current) && current.state !== "cancelling" && current.workerStopConfirmedAt === undefined)
          await runEffect(
            advanceAndProject(record.operationId, {
              type: "worker_stop_confirmed",
              proof: "worker-stop",
            })
          );
      }

      let current = await runEffect(getOperation(record.operationId));
      if (terminal(current) || current.state === "cancelling") return;
      if (current.result !== undefined && current.workerStopConfirmedAt !== undefined) {
        if (outcome.state === "result_acknowledged" && current.agentRunEvidence === undefined)
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
      if (outcome.state === "validator_unavailable")
        return "validator_unavailable" as const;
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
        if (outcome.state === "agent_failed")
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
            ...(outcome.state === "result_format_rejected"
              ? { resultFormatRejection: outcome.rejection }
              : {}),
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
    } catch (error) {
      const current = await runEffect(getOperation(record.operationId)).catch(
        () => undefined
      );
      if (current !== undefined && terminal(current)) {
        await settleTerminal(record, current);
        return;
      }
      const failure =
        error instanceof OperationPersistenceError
          ? error
          : new OperationPersistenceError(record.operationId, "write_failed");
      if (recovering) throw failure;
      record.rejectTerminal(failure);
    }
  };

  const createOperation = async (taskInput: TaskSpec): Promise<OperationRecord> => {
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
    if (task.profile === "formal-review")
      throw new WorkerConfigurationError(
        "unsupported_capability",
        "Formal review creation is paused"
      );
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
    })();
    cancellations.set(key, cancellation);
    track(cancellation.then(() => undefined));
    return cancellation;
  };

  const recoverCancellation = async (
    record: OperationRecord,
    operation: Operation
  ): Promise<void> => {
    const worker = record.worker;
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
  const recoverWorkers = async (): Promise<void> => {
    if (services.recovery === "disabled") return;
    const snapshots = await runEffect(
      services.store
        .listRecoverableOperations()
        .pipe(
          Effect.mapError((error) =>
            persistenceError("runtime-recovery", error)
          )
        )
    );
    for (const { operation } of snapshots) {
      if (records.has(operation.operationId)) continue;
      const deferred = deferredResult();
      const record: OperationRecord = {
        operationId: operation.operationId,
        terminalPromise: deferred.promise,
        resolveTerminal: deferred.resolve,
        rejectTerminal: deferred.reject,
      };
      records.set(operation.operationId, record);
      try {
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
        if (
          operation.workerIdentity === undefined ||
          operation.startDeliveryAuthority === undefined
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
        const resume = (): void => {
          records.delete(operation.operationId);
          workersRecovered = false;
          scheduleRecovery();
        };
        track(
          (operation.state === "cancelling"
            ? recoverCancellation(record, operation)
            : execute(record, true)
          )
            .then((outcome) => {
              if (outcome === "validator_unavailable") resume();
            })
            .catch((error) => {
              record.rejectTerminal(error);
              resume();
            })
        );
      } catch (error) {
        records.delete(operation.operationId);
        throw error;
      }
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
    for (const { operation } of snapshots)
      await performCleanup(operation, false);
  };

  let cleanupsRecovered = false;
  let recovery: Promise<void> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRecovery = (): void => {
    if (closing || recoveryTimer !== undefined) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void Promise.resolve(recovery)
        .catch(() => undefined)
        .then(() => {
          if (!closing) return recover();
        })
        .catch(() => undefined);
    }, 20);
    recoveryTimer.unref();
  };
  const recover = (duringClose = false): Promise<void> => {
    if (recovery !== undefined) return recovery;
    if (workersRecovered && cleanupsRecovered) return Promise.resolve();
    if (closing && !duringClose) return Promise.reject(new RuntimeClosedError());
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
        await recoverCleanups();
        cleanupsRecovered = true;
      }
    })().catch((error) => {
      scheduleRecovery();
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

  const createReader = (operationId: string): OperationReader => ({
    operationId,
    read: () => readPublicSnapshot(operationId),
    readResult: () => readResult(operationId),
    readResultChunk: (options) => readResultChunk(operationId, options),
  });

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
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      if (!workersRecovered || !cleanupsRecovered) {
        const [attempt] = await Promise.allSettled([recover(true)]);
        while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
        if (attempt.status === "rejected") throw attempt.reason;
        if (!workersRecovered || !cleanupsRecovered)
          throw new OperationPersistenceError("runtime-recovery", "write_failed");
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
          ...createReader(record.operationId),
          result: () => record.terminalPromise,
          cancel: (options: CancelOptions) => cancel(record, options),
        };
      })();
      spawns.set(task.idempotencyKey, admitted);
      return admitted;
    },
    async operation(operationId: string): Promise<OperationReader> {
      await storedSnapshot(operationId);
      return createReader(operationId);
    },
  };
}
