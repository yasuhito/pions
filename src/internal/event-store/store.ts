import { Effect } from "effect";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./model.js";
import type { EventInput, Operation, OperationEvent } from "./model.js";
import {
  presentationCleanupEligible,
  reduceOperation,
  replayOperation,
  TransitionError,
} from "./reducer.js";
import { decodeRecord, RecordDecodingError } from "./codec.js";
import type { StoredOperationRecord } from "./codec.js";
import type { RuntimeClock } from "../services.js";
import type {
  EventStore,
  OperationIntent,
  OperationRequest,
  OperationSnapshot,
  ResultAcceptanceRequest,
  StoreError,
  StoreErrorCode,
} from "./index.js";
import type {
  AcceptedResult,
  ResultAcceptanceTransactionOutcome,
} from "../types.js";
import { resultAcceptanceIdentifier } from "../result-acceptance-transaction.js";
import { sha256Digest } from "../result-digest.js";

export type { StoredOperationRecord } from "./codec.js";

interface LoadedRecord {
  readonly record: StoredOperationRecord;
  readonly operation: Operation;
}

class StoreFailure extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string
  ) {
    super(message);
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

function failure(code: StoreErrorCode, message: string): StoreFailure {
  return new StoreFailure(code, message);
}

function asStoreError(error: unknown, fallback: StoreErrorCode): StoreError {
  if (error instanceof StoreFailure || error instanceof RecordDecodingError)
    return { _tag: "StoreError", code: error.code, message: error.message };
  return {
    _tag: "StoreError",
    code: fallback,
    message: error instanceof Error ? error.message : String(error),
  };
}

function terminalAcceptanceFailure(
  reason: Extract<
    ResultAcceptanceTransactionOutcome,
    { readonly kind: "failed" }
  >["reason"]
): ResultAcceptanceTransactionOutcome {
  return { kind: "failed", terminal: true, reason };
}

function accepted(
  acceptance: Readonly<AcceptedResult>
): ResultAcceptanceTransactionOutcome {
  return { kind: "accepted", acceptance };
}

function validUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function acceptanceFailure(error: unknown): ResultAcceptanceTransactionOutcome {
  if (error instanceof StoreFailure || error instanceof RecordDecodingError) {
    if (error.code === "write_failed")
      return { kind: "continuable", reason: "write_failed" };
    if (error.code === "not_found")
      return terminalAcceptanceFailure("operation_not_found");
    if (error.code === "unsupported_schema")
      return terminalAcceptanceFailure("unsupported_schema");
  }
  return terminalAcceptanceFailure("corrupt_record");
}

export abstract class ValidatedEventStore implements EventStore {
  private readonly mutationTails = new Map<string, Promise<void>>();

  protected constructor(private readonly clock: RuntimeClock) {}

  protected abstract readRecord(
    operationId: string
  ): Promise<unknown | undefined>;
  protected abstract writeRecord(
    operationId: string,
    record: StoredOperationRecord
  ): Promise<void>;
  protected abstract listOperationIds(): Promise<ReadonlyArray<string>>;
  protected abstract writeResultBody(
    operationId: string,
    bytes: Uint8Array
  ): Promise<void>;
  protected abstract readResultBytes(
    operationId: string
  ): Promise<Uint8Array | undefined>;
  protected willAppend(_event: OperationEvent): void {}
  protected didAppend(_event: OperationEvent): void {}

  private serialize<Value>(
    operationId: string,
    action: () => Promise<Value>
  ): Promise<Value> {
    const previous = this.mutationTails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTails.set(operationId, current);
    return previous.then(action).finally(() => {
      release();
      if (this.mutationTails.get(operationId) === current)
        this.mutationTails.delete(operationId);
    });
  }

  private async load(
    operationId: string,
    required: boolean
  ): Promise<LoadedRecord | undefined> {
    const value = await this.readRecord(operationId);
    if (value === undefined) {
      if (required)
        throw failure("not_found", `Operation not found: ${operationId}`);
      return undefined;
    }
    const record = decodeRecord(value, operationId);
    let operation: Operation | undefined;
    try {
      operation = replayOperation(record.events);
    } catch (error) {
      if (
        error instanceof TransitionError &&
        error.code === "unsupported_schema_version"
      )
        throw failure("unsupported_schema", error.message);
      throw failure(
        "corrupt_record",
        error instanceof Error ? error.message : String(error)
      );
    }
    if (operation === undefined)
      throw failure("corrupt_record", "Operation record has no events");
    return { record, operation };
  }

  create(
    request: OperationRequest
  ): Effect.Effect<OperationSnapshot, StoreError> {
    return this.appendEvent(request.operationId, {
      type: "operation_requested",
      task: request.task,
      requestedConfig: request.requestedConfig,
      effectiveConfig: request.effectiveConfig,
      maxResultByteCount: request.maxResultByteCount,
    });
  }

  advance(
    operationId: string,
    intent: OperationIntent
  ): Effect.Effect<OperationSnapshot, StoreError> {
    return this.appendEvent(operationId, intent);
  }

  acceptResult(
    request: Readonly<ResultAcceptanceRequest>
  ): Effect.Effect<ResultAcceptanceTransactionOutcome> {
    return Effect.promise(() =>
      this.serialize(request.operationId, async () => {
        try {
          const loaded = await this.load(request.operationId, true);
          if (loaded === undefined)
            return terminalAcceptanceFailure("operation_not_found");
          if (!IDENTIFIER.test(request.acceptanceRequestId))
            return terminalAcceptanceFailure("request_mismatch");
          const bytes = Uint8Array.from(request.bytes);
          const byteCount = bytes.byteLength;
          const digest = sha256Digest(bytes);
          const existing = loaded.operation.result;
          if (existing !== undefined) {
            if (existing.digest === digest && existing.byteCount === byteCount)
              return accepted(existing);
            return terminalAcceptanceFailure(
              existing.acceptanceRequestId === request.acceptanceRequestId
                ? "request_mismatch"
                : "result_conflict"
            );
          }
          if (byteCount > loaded.operation.maxResultByteCount)
            return terminalAcceptanceFailure("limit_exceeded");
          if (!validUtf8(bytes))
            return terminalAcceptanceFailure("invalid_utf8");
          if (loaded.operation.state !== "running")
            return terminalAcceptanceFailure("invalid_operation_state");
          const acceptedAt = await Effect.runPromise(this.clock.now());
          const unidentified = {
            operationId: request.operationId,
            acceptanceRequestId: request.acceptanceRequestId,
            acceptedAt,
            eventSequenceNumber: loaded.operation.stateSeq + 1,
            byteCount,
            digest,
          };
          const acceptance: AcceptedResult = {
            acceptanceId: resultAcceptanceIdentifier(unidentified),
            ...unidentified,
          };
          const event = this.makeEvent(
            request.operationId,
            loaded.operation.stateSeq,
            { type: "result_accepted", acceptance },
            acceptedAt
          );
          const record = decodeRecord(
            { ...loaded.record, events: [...loaded.record.events, event] },
            request.operationId
          );
          const persistedEvent = record.events.at(-1);
          if (persistedEvent === undefined)
            return terminalAcceptanceFailure("corrupt_record");
          reduceOperation(loaded.operation, persistedEvent);
          try {
            this.willAppend(persistedEvent);
            await this.writeResultBody(request.operationId, bytes);
            await this.writeRecord(request.operationId, record);
          } catch {
            return { kind: "continuable", reason: "write_failed" };
          }
          this.didAppend(persistedEvent);
          return accepted(acceptance);
        } catch (error) {
          return acceptanceFailure(error);
        }
      })
    );
  }

  readResultBody(
    operationId: string
  ): Effect.Effect<Uint8Array | undefined, StoreError> {
    return Effect.tryPromise({
      try: () => this.readResultBytes(operationId),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  read(operationId: string): Effect.Effect<OperationSnapshot, StoreError> {
    return Effect.tryPromise({
      try: () =>
        this.serialize(operationId, async () => {
          const loaded = await this.load(operationId, true);
          if (loaded === undefined)
            throw failure("not_found", `Operation not found: ${operationId}`);
          const last = loaded.record.events.at(-1);
          if (last === undefined)
            throw failure("corrupt_record", "Operation record has no events");
          return {
            version: { sequenceNumber: last.seq, recordedAt: last.timestamp },
            operation: loaded.operation,
          };
        }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  listRecoverableOperations(): Effect.Effect<
    ReadonlyArray<OperationSnapshot>,
    StoreError
  > {
    return this.listMatching(
      ({ operation }) =>
        operation.state === "queued" ||
        operation.state === "starting" ||
        operation.state === "running" ||
        operation.state === "cancelling"
    );
  }

  listPendingPresentationCleanups(): Effect.Effect<
    ReadonlyArray<OperationSnapshot>,
    StoreError
  > {
    return this.listMatching(
      ({ operation }) =>
        operation.presentationCleanup?.state === "pending" ||
        (presentationCleanupEligible(operation) &&
          operation.presentation?.ownedByPions === true &&
          operation.presentationCleanup === undefined)
    );
  }

  private listMatching(
    predicate: (snapshot: OperationSnapshot) => boolean
  ): Effect.Effect<ReadonlyArray<OperationSnapshot>, StoreError> {
    return Effect.tryPromise({
      try: async () => {
        const ids = await this.listOperationIds();
        const snapshots = await Promise.all(
          ids.map((operationId) => Effect.runPromise(this.read(operationId)))
        );
        return snapshots.filter(predicate);
      },
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  private makeEvent(
    operationId: string,
    stateSeq: number,
    input: EventInput,
    timestamp: string
  ): OperationEvent {
    if (!Number.isFinite(Date.parse(timestamp)))
      throw failure(
        "corrupt_record",
        "Operation event timestamp is not absolute"
      );
    const seq = stateSeq + 1;
    return {
      ...input,
      actorId: RUNTIME_ACTOR_ID,
      authority: OPERATION_AUTHORITY,
      eventId: `${operationId}:${seq}`,
      operationId,
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq,
      timestamp,
    } as OperationEvent;
  }

  private async appendLoaded(
    operationId: string,
    loaded: LoadedRecord | undefined,
    input: EventInput,
    fixedTimestamp?: string
  ): Promise<LoadedRecord> {
    const event = this.makeEvent(
      operationId,
      loaded?.operation.stateSeq ?? 0,
      input,
      fixedTimestamp ?? (await Effect.runPromise(this.clock.now()))
    );
    const record = decodeRecord(
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        operationId,
        events: [...(loaded?.record.events ?? []), event],
      },
      operationId
    );
    const persistedEvent = record.events.at(-1);
    if (persistedEvent === undefined)
      throw failure("corrupt_record", "Operation record has no events");
    const operation = reduceOperation(loaded?.operation, persistedEvent);
    this.willAppend(persistedEvent);
    try {
      await this.writeRecord(operationId, record);
    } catch (error) {
      throw failure(
        "write_failed",
        error instanceof Error ? error.message : String(error)
      );
    }
    this.didAppend(persistedEvent);
    return { record, operation };
  }

  private appendEvent(
    operationId: string,
    input: EventInput,
    fixedTimestamp?: string
  ): Effect.Effect<OperationSnapshot, StoreError> {
    return Effect.tryPromise({
      try: () =>
        this.serialize(operationId, async () => {
          const loaded = await this.load(
            operationId,
            input.type !== "operation_requested"
          );
          const persisted = await this.appendLoaded(
            operationId,
            loaded,
            input,
            fixedTimestamp
          );
          const last = persisted.record.events.at(-1)!;
          return {
            version: { sequenceNumber: last.seq, recordedAt: last.timestamp },
            operation: persisted.operation,
          };
        }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }
}
