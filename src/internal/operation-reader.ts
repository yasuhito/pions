import { createHash } from "node:crypto";

import { Cause, Effect, Exit } from "effect";

import type {
  EventStore,
  OperationSnapshot as StoredOperationSnapshot,
  StoreError,
} from "./event-store/index.js";
import { sha256Digest } from "./result-digest.js";
import {
  OperationPersistenceError,
  ResultCursorError,
  ResultRetrievalError,
} from "./types.js";
import type {
  OperationReader,
  OperationSnapshot as PublicOperationSnapshot,
  Result,
  ResultAcceptanceId,
  ResultChunkReadOutcome,
  ResultReadOutcome,
} from "./types.js";

/** Read persisted Operation state and verified Result bytes without starting a Worker. */
export function makeOperationReader(
  store: Pick<EventStore, "read" | "readResultBody">
) {
  const runEffect = async <Value>(
    effect: Effect.Effect<Value, unknown>
  ): Promise<Value> => {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    throw new Error(Cause.pretty(exit.cause));
  };

  const persistenceError = (
    operationId: string,
    error: StoreError
  ): OperationPersistenceError =>
    new OperationPersistenceError(
      operationId,
      error.code === "not_found" ? "corrupt_record" : error.code
    );

  const storedSnapshot = (operationId: string) =>
    runEffect(
      store
        .read(operationId)
        .pipe(Effect.mapError((error) => persistenceError(operationId, error)))
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
      const stored = yield* store
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

  const createReader = (operationId: string): OperationReader => ({
    operationId,
    read: () => readPublicSnapshot(operationId),
    readResult: () => readResult(operationId),
    readResultChunk: (options) => readResultChunk(operationId, options),
  });

  return {
    storedSnapshot,
    forKnownOperation: createReader,
    async operation(operationId: string): Promise<OperationReader> {
      await storedSnapshot(operationId);
      return createReader(operationId);
    },
  };
}
