import { createHash } from "node:crypto";

import { Effect } from "effect";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./domain.js";
import type {
  EventInput,
  Operation,
  OperationEvent,
  ResultReference,
} from "./domain.js";
import { reduceOperation, replayOperation, TransitionError } from "./reducer.js";
import type {
  EventStore,
  ResultDelivery,
  RuntimeClock,
  StoreError,
  StoreErrorCode,
} from "./services.js";
import { ResultConflictError } from "../public.js";
import type { Result } from "../public.js";

export interface StoredOperationRecord {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly events: ReadonlyArray<OperationEvent>;
}

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
  if (error instanceof StoreFailure) {
    return { _tag: "StoreError", code: error.code, message: error.message };
  }
  return {
    _tag: "StoreError",
    code: fallback,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw failure("corrupt_record", `Invalid ${key}`);
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field)) throw failure("corrupt_record", `Invalid ${key}`);
  return field as number;
}

function parseEvent(value: unknown): OperationEvent {
  if (!isObject(value)) throw failure("corrupt_record", "Invalid event");
  const schemaVersion = numberField(value, "schemaVersion");
  if (schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw failure("unsupported_schema", `Unsupported event schema ${schemaVersion}`);
  }
  const base = {
    eventId: stringField(value, "eventId"),
    operationId: stringField(value, "operationId"),
    seq: numberField(value, "seq"),
    timestamp: stringField(value, "timestamp"),
    actorId: stringField(value, "actorId"),
    authority: stringField(value, "authority"),
    schemaVersion,
  };
  const type = stringField(value, "type");
  let event: unknown;
  switch (type) {
    case "operation_requested": {
      const task = value.task;
      const lineage = value.lineage;
      if (!isObject(task) || !isObject(lineage)) {
        throw failure("corrupt_record", "Invalid operation request");
      }
      const parentOperationId = lineage.parentOperationId;
      if (parentOperationId !== undefined && typeof parentOperationId !== "string") {
        throw failure("corrupt_record", "Invalid parent Operation identifier");
      }
      event = {
        ...base,
        type,
        task: {
          promptRef: stringField(task, "promptRef"),
          profile: stringField(task, "profile"),
          idempotencyKey: stringField(task, "idempotencyKey"),
        },
        lineage: {
          rootOperationId: stringField(lineage, "rootOperationId"),
          ...(parentOperationId === undefined ? {} : { parentOperationId }),
          depth: numberField(lineage, "depth"),
        },
      };
      break;
    }
    case "presentation_owned": {
      const presentation = value.presentation;
      if (!isObject(presentation)) throw failure("corrupt_record", "Invalid Presentation ownership");
      if (
        stringField(presentation, "kind") !== "herdr_pane" ||
        presentation.ownedByPions !== true
      ) {
        throw failure("corrupt_record", "Invalid Presentation ownership");
      }
      event = {
        ...base,
        type,
        presentation: {
          kind: "herdr_pane",
          paneId: stringField(presentation, "paneId"),
          ownedByPions: true,
        },
      };
      break;
    }
    case "worker_identified": {
      const workerIdentity = value.workerIdentity;
      if (!isObject(workerIdentity)) throw failure("corrupt_record", "Invalid Worker identity");
      event = {
        ...base,
        type,
        workerIdentity: {
          processInstanceId: stringField(workerIdentity, "processInstanceId"),
          paneId: stringField(workerIdentity, "paneId"),
        },
      };
      break;
    }
    case "child_attached":
      event = { ...base, type, childOperationId: stringField(value, "childOperationId") };
      break;
    case "child_settled": {
      const outcome = stringField(value, "outcome");
      if (outcome !== "succeeded" && outcome !== "failed") {
        throw failure("corrupt_record", "Invalid child outcome");
      }
      event = { ...base, type, childOperationId: stringField(value, "childOperationId"), outcome };
      break;
    }
    case "result_persisted": {
      const result = value.result;
      if (!isObject(result)) throw failure("corrupt_record", "Invalid Result reference");
      const digest = stringField(result, "digest");
      if (!digest.startsWith("sha256:")) throw failure("corrupt_record", "Invalid Result digest");
      event = {
        ...base,
        type,
        result: {
          location: stringField(result, "location"),
          byteCount: numberField(result, "byteCount"),
          digest,
          deliverySequenceNumber: numberField(result, "deliverySequenceNumber"),
        },
      };
      break;
    }
    case "self_settled": {
      const outcome = stringField(value, "outcome");
      if (outcome === "succeeded") event = { ...base, type, outcome };
      else if (outcome === "failed") {
        const reason = stringField(value, "reason");
        if (reason !== "backend_start_failed" && reason !== "worker_protocol_failed" && reason !== "descendant_failed") {
          throw failure("corrupt_record", "Invalid failure reason");
        }
        event = { ...base, type, outcome, reason };
      } else throw failure("corrupt_record", "Invalid settlement outcome");
      break;
    }
    case "operation_failed": {
      const reason = stringField(value, "reason");
      if (reason !== "backend_start_failed" && reason !== "worker_protocol_failed" && reason !== "descendant_failed") {
        throw failure("corrupt_record", "Invalid failure reason");
      }
      event = { ...base, type, reason };
      break;
    }
    case "cancellation_requested":
    case "cancel_dispatched":
    case "operation_cancelled":
      event = { ...base, type, cancellationEpoch: numberField(value, "cancellationEpoch") };
      break;
    case "cancel_acknowledged": {
      const proof = stringField(value, "proof");
      if (proof !== "acknowledgement" && proof !== "backend-stop") {
        throw failure("corrupt_record", "Invalid cancellation proof");
      }
      event = { ...base, type, cancellationEpoch: numberField(value, "cancellationEpoch"), proof };
      break;
    }
    case "operation_unknown":
      if (stringField(value, "reason") !== "cancel-unproven") {
        throw failure("corrupt_record", "Invalid unknown reason");
      }
      event = { ...base, type, cancellationEpoch: numberField(value, "cancellationEpoch"), reason: "cancel-unproven" };
      break;
    case "operation_starting":
    case "operation_started":
    case "operation_blocked":
    case "operation_unblocked":
    case "operation_completed":
      event = { ...base, type };
      break;
    default:
      throw failure("corrupt_record", `Unknown event type ${type}`);
  }
  return event as OperationEvent;
}

function parseRecord(value: unknown, operationId: string): StoredOperationRecord {
  if (!isObject(value)) throw failure("corrupt_record", "Invalid Operation record");
  const schemaVersion = numberField(value, "schemaVersion");
  if (schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw failure("unsupported_schema", `Unsupported record schema ${schemaVersion}`);
  }
  if (stringField(value, "operationId") !== operationId) {
    throw failure("corrupt_record", "Operation identifier does not match record path");
  }
  if (!Array.isArray(value.events)) throw failure("corrupt_record", "Invalid event list");
  const events = value.events.map(parseEvent);
  for (const event of events) {
    if (
      event.eventId !== `${operationId}:${event.seq}` ||
      event.timestamp.length === 0
    ) {
      throw failure("corrupt_record", "Invalid event envelope");
    }
  }
  return { schemaVersion, operationId, events };
}

function resultDigest(bytes: Buffer): Result["digest"] {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
    const record = parseRecord(recordValue, operationId);
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

  append(operationId: string, input: EventInput): Effect.Effect<Operation, StoreError> {
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
        return operation;
      }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  acceptResult(operationId: string, delivery: ResultDelivery): Effect.Effect<
    { readonly operation: Operation; readonly result: Result },
    StoreError | ResultConflictError
  > {
    return Effect.tryPromise({
      try: () => this.serialize(operationId, async () => {
        const loaded = await this.load(operationId, true);
        if (loaded === undefined) throw failure("not_found", `Operation not found: ${operationId}`);
        if (loaded.result !== undefined && loaded.resultReference !== undefined) {
          if (loaded.result.digest !== delivery.digest) {
            throw new ResultConflictError(operationId, loaded.result.digest, delivery.digest);
          }
          if (loaded.resultReference.deliverySequenceNumber !== delivery.sequenceNumber) {
            throw failure("corrupt_record", "Result sequence number does not match accepted delivery");
          }
          return { operation: loaded.operation, result: loaded.result };
        }
        const bytes = Buffer.from(delivery.body, "utf8");
        const digest = resultDigest(bytes);
        if (delivery.digest !== digest) throw failure("corrupt_record", "Result digest does not match body");
        const result: Result = Object.freeze({ body: delivery.body, byteCount: bytes.byteLength, digest });
        const reference: ResultReference = Object.freeze({
          location: "result.utf8",
          byteCount: result.byteCount,
          digest,
          deliverySequenceNumber: delivery.sequenceNumber,
        });
        try {
          await this.writeResultBytes(operationId, bytes);
          this.didPersistResultBytes(operationId);
          const seq = loaded.operation.stateSeq + 1;
          const event = {
            type: "result_persisted",
            result: reference,
            actorId: RUNTIME_ACTOR_ID,
            authority: OPERATION_AUTHORITY,
            eventId: `${operationId}:${seq}`,
            operationId,
            schemaVersion: EVENT_SCHEMA_VERSION,
            seq,
            timestamp: await Effect.runPromise(this.clock.now()),
          } satisfies OperationEvent;
          const operation = reduceOperation(loaded.operation, event);
          await this.writeRecord(operationId, {
            ...loaded.record,
            events: [...loaded.record.events, event],
          });
          this.didAppend(event);
          return { operation, result };
        } catch (error) {
          throw failure("write_failed", error instanceof Error ? error.message : String(error));
        }
      }),
      catch: (error) => error instanceof ResultConflictError ? error : asStoreError(error, "corrupt_record"),
    });
  }

  get(operationId: string): Effect.Effect<Operation, StoreError> {
    return Effect.tryPromise({
      try: async () => {
        const loaded = await this.load(operationId, true);
        if (loaded === undefined) throw failure("not_found", `Operation not found: ${operationId}`);
        return loaded.operation;
      },
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  readResult(operationId: string): Effect.Effect<Result, StoreError> {
    return Effect.tryPromise({
      try: async () => {
        const loaded = await this.load(operationId, true);
        if (loaded?.result === undefined) throw failure("incomplete_record", "Operation has no Result");
        return loaded.result;
      },
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }
}
