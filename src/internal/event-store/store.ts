import { Effect } from "effect";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./model.js";
import type {
  EventInput,
  Operation,
  OperationEvent,
  ResultReference,
} from "./model.js";
import { reduceOperation, replayOperation, TransitionError } from "./reducer.js";
import { decodeRecord, RecordDecodingError } from "./codec.js";
import type { StoredOperationRecord } from "./codec.js";
import type { RuntimeClock } from "../services.js";
import type {
  EventStore,
  OperationIntent,
  OperationRequest,
  OperationSnapshot,
  StoreError,
  StoreErrorCode,
} from "./index.js";
import { ResultConflictError } from "../../public.js";
import type { Result } from "../../public.js";
import type {
  ResultAcceptanceProof,
  ResultDelivery,
} from "../worker-protocol.js";
import { resultDigest } from "../result-digest.js";

export type { StoredOperationRecord } from "./codec.js";

interface LoadedRecord {
  readonly record: StoredOperationRecord;
  readonly operation: Operation;
  readonly result?: Result;
  readonly resultReference?: ResultReference;
}

class StoreFailure extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function failure(code: StoreErrorCode, message: string): StoreFailure {
  return new StoreFailure(code, message);
}

function asStoreError(error: unknown, fallback: StoreErrorCode): StoreError {
  if (error instanceof StoreFailure || error instanceof RecordDecodingError) {
    return { _tag: "StoreError", code: error.code, message: error.message };
  }
  return {
    _tag: "StoreError",
    code: fallback,
    message: error instanceof Error ? error.message : String(error),
  };
}

function acceptedDeliveryProof(
  operationId: string,
  delivery: Readonly<ResultDelivery>,
): ResultAcceptanceProof {
  return Object.freeze({
    operationId,
    digest: delivery.digest,
    sequenceNumber: delivery.sequenceNumber,
  }) as ResultAcceptanceProof;
}

export abstract class ValidatedEventStore implements EventStore {
  private readonly mutationTails = new Map<string, Promise<void>>();

  protected constructor(private readonly clock: RuntimeClock) {}

  protected abstract readRecord(operationId: string): Promise<unknown | undefined>;
  protected abstract writeRecord(
    operationId: string,
    record: StoredOperationRecord,
  ): Promise<void>;
  protected abstract readResultBytes(operationId: string): Promise<Buffer | undefined>;
  protected abstract writeResultBytes(operationId: string, bytes: Buffer): Promise<void>;
  protected didPersistResultBytes(_operationId: string): void {}
  protected didAppend(_event: OperationEvent): void {}

  private serialize<Value>(operationId: string, action: () => Promise<Value>): Promise<Value> {
    const previous = this.mutationTails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.mutationTails.set(operationId, current);
    return previous.then(action).finally(() => {
      release();
      if (this.mutationTails.get(operationId) === current) this.mutationTails.delete(operationId);
    });
  }

  private async load(operationId: string, required: boolean): Promise<LoadedRecord | undefined> {
    const [recordValue, resultBytes] = await Promise.all([
      this.readRecord(operationId),
      this.readResultBytes(operationId),
    ]);
    if (recordValue === undefined) {
      if (resultBytes !== undefined) {
        throw failure("incomplete_record", "Result exists without its event record");
      }
      if (required) throw failure("not_found", `Operation not found: ${operationId}`);
      return undefined;
    }
    const record = decodeRecord(recordValue, operationId);
    let operation: Operation | undefined;
    try {
      operation = replayOperation(record.events);
    } catch (error) {
      if (error instanceof TransitionError && error.code === "unsupported_schema_version") {
        throw failure("unsupported_schema", error.message);
      }
      throw failure("corrupt_record", error instanceof Error ? error.message : String(error));
    }
    if (operation === undefined) throw failure("corrupt_record", "Operation record has no events");
    const persisted = record.events.filter((event) => event.type === "result_persisted");
    if (persisted.length > 1) throw failure("corrupt_record", "Conflicting Result events");
    const resultReference = persisted[0]?.type === "result_persisted" ? persisted[0].result : undefined;
    if (resultReference === undefined) {
      if (resultBytes !== undefined) throw failure("incomplete_record", "Result exists without result_persisted");
      return { record, operation };
    }
    if (resultReference.location !== "result.utf8" || resultBytes === undefined) {
      throw failure("corrupt_record", "Persisted Result is missing");
    }
    const digest = resultDigest(resultBytes);
    if (resultBytes.byteLength !== resultReference.byteCount || digest !== resultReference.digest) {
      throw failure("corrupt_record", "Persisted Result integrity check failed");
    }
    return {
      record,
      operation,
      resultReference,
      result: Object.freeze({ body: resultBytes.toString("utf8"), byteCount: resultBytes.byteLength, digest }),
    };
  }

  create(request: OperationRequest): Effect.Effect<OperationSnapshot, StoreError> {
    return this.appendEvent(request.operationId, {
      type: "operation_requested",
      task: request.task,
      requestedConfig: request.requestedConfig,
      effectiveConfig: request.effectiveConfig,
      lineage: request.lineage,
    });
  }

  advance(
    operationId: string,
    intent: OperationIntent,
  ): Effect.Effect<OperationSnapshot, StoreError | ResultConflictError> {
    if (intent.type === "accept_result") {
      return this.acceptResult(operationId, intent.delivery).pipe(
        Effect.map(({ operation, result, resultAcceptanceProof }) => ({
          operation,
          result,
          resultAcceptanceProof,
        })),
      );
    }
    return this.appendEvent(operationId, intent);
  }

  read(operationId: string): Effect.Effect<OperationSnapshot, StoreError> {
    return Effect.tryPromise({
      try: async () => {
        const loaded = await this.load(operationId, true);
        if (loaded === undefined) throw failure("not_found", `Operation not found: ${operationId}`);
        return {
          operation: loaded.operation,
          ...(loaded.result === undefined ? {} : { result: loaded.result }),
        };
      },
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  private appendEvent(operationId: string, input: EventInput): Effect.Effect<OperationSnapshot, StoreError> {
    return Effect.tryPromise({
      try: () => this.serialize(operationId, async () => {
        const loaded = await this.load(operationId, input.type !== "operation_requested");
        const seq = (loaded?.operation.stateSeq ?? 0) + 1;
        const event = {
          ...input,
          actorId: RUNTIME_ACTOR_ID,
          authority: OPERATION_AUTHORITY,
          eventId: `${operationId}:${seq}`,
          operationId,
          schemaVersion: EVENT_SCHEMA_VERSION,
          seq,
          timestamp: await Effect.runPromise(this.clock.now()),
        } as OperationEvent;
        const operation = reduceOperation(loaded?.operation, event);
        const record: StoredOperationRecord = {
          schemaVersion: EVENT_SCHEMA_VERSION,
          operationId,
          events: [...(loaded?.record.events ?? []), event],
        };
        try {
          await this.writeRecord(operationId, record);
        } catch (error) {
          throw failure("write_failed", error instanceof Error ? error.message : String(error));
        }
        this.didAppend(event);
        return {
          operation,
          ...(loaded?.result === undefined ? {} : { result: loaded.result }),
        };
      }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  private acceptResult(operationId: string, delivery: ResultDelivery): Effect.Effect<
    {
      readonly operation: Operation;
      readonly result: Result;
      readonly resultAcceptanceProof: ResultAcceptanceProof;
    },
    StoreError | ResultConflictError
  > {
    return Effect.tryPromise({
      try: () => this.serialize(operationId, async () => {
        const loaded = await this.load(operationId, true);
        if (loaded === undefined) throw failure("not_found", `Operation not found: ${operationId}`);
        const bytes = Buffer.from(delivery.body, "utf8");
        const digest = resultDigest(bytes);
        if (delivery.digest !== digest) {
          throw failure("corrupt_record", "Result digest does not match body");
        }
        if (loaded.result !== undefined && loaded.resultReference !== undefined) {
          if (loaded.result.digest === delivery.digest) {
            return {
              operation: loaded.operation,
              result: loaded.result,
              resultAcceptanceProof: acceptedDeliveryProof(operationId, delivery),
            };
          }
          if (loaded.operation.resultConflict !== undefined) {
            throw new ResultConflictError(
              operationId,
              loaded.operation.resultConflict.acceptedDigest,
              loaded.operation.resultConflict.conflictingDigest,
            );
          }
          const conflict = {
            acceptedDigest: loaded.result.digest,
            conflictingDigest: delivery.digest,
            deliverySequenceNumber: delivery.sequenceNumber,
          } as const;
          const seq = loaded.operation.stateSeq + 1;
          const eventWithoutTimestamp = {
            type: "result_conflict_recorded",
            conflict,
            actorId: RUNTIME_ACTOR_ID,
            authority: OPERATION_AUTHORITY,
            eventId: `${operationId}:${seq}`,
            operationId,
            schemaVersion: EVENT_SCHEMA_VERSION,
            seq,
          } as const;
          try {
            reduceOperation(loaded.operation, {
              ...eventWithoutTimestamp,
              timestamp: "result-conflict-preflight",
            });
          } catch (error) {
            throw failure(
              "corrupt_record",
              error instanceof Error ? error.message : String(error),
            );
          }
          try {
            const event = {
              ...eventWithoutTimestamp,
              timestamp: await Effect.runPromise(this.clock.now()),
            } satisfies OperationEvent;
            await this.writeRecord(operationId, {
              ...loaded.record,
              events: [...loaded.record.events, event],
            });
            this.didAppend(event);
          } catch (error) {
            throw failure(
              "write_failed",
              error instanceof Error ? error.message : String(error),
            );
          }
          throw new ResultConflictError(
            operationId,
            conflict.acceptedDigest,
            conflict.conflictingDigest,
          );
        }
        const result: Result = Object.freeze({ body: delivery.body, byteCount: bytes.byteLength, digest });
        const reference: ResultReference = Object.freeze({
          location: "result.utf8",
          byteCount: result.byteCount,
          digest,
          deliverySequenceNumber: delivery.sequenceNumber,
        });
        const seq = loaded.operation.stateSeq + 1;
        const eventWithoutTimestamp = {
          type: "result_persisted",
          result: reference,
          actorId: RUNTIME_ACTOR_ID,
          authority: OPERATION_AUTHORITY,
          eventId: `${operationId}:${seq}`,
          operationId,
          schemaVersion: EVENT_SCHEMA_VERSION,
          seq,
        } as const;
        let operation: Operation;
        try {
          operation = reduceOperation(loaded.operation, {
            ...eventWithoutTimestamp,
            timestamp: "result-acceptance-preflight",
          });
        } catch (error) {
          throw failure(
            "corrupt_record",
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          await this.writeResultBytes(operationId, bytes);
          this.didPersistResultBytes(operationId);
          const event = {
            ...eventWithoutTimestamp,
            timestamp: await Effect.runPromise(this.clock.now()),
          } satisfies OperationEvent;
          await this.writeRecord(operationId, {
            ...loaded.record,
            events: [...loaded.record.events, event],
          });
          this.didAppend(event);
          return {
            operation,
            result,
            resultAcceptanceProof: acceptedDeliveryProof(operationId, delivery),
          };
        } catch (error) {
          throw failure("write_failed", error instanceof Error ? error.message : String(error));
        }
      }),
      catch: (error) => error instanceof ResultConflictError ? error : asStoreError(error, "corrupt_record"),
    });
  }

}
