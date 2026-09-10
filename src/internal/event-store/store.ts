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
import type {
  AcceptedResult,
  ResultAcceptanceEventEvidence,
  ResultAcceptancePreparationEvidence,
  ResultAcceptanceReservation,
  ResultAcceptanceReservationRequest,
  ResultAcceptanceTransactionOutcome,
  StartupReceipt,
} from "../../public.js";
import { startupReceiptDigest } from "../startup-receipt.js";
import {
  preparationEvidenceMatchesReservation,
  resultAcceptanceIdentifier,
} from "../result-acceptance-transaction.js";

export type { StoredOperationRecord } from "./codec.js";

interface LoadedRecord {
  readonly record: StoredOperationRecord;
  readonly operation: Operation;
}

class StoreFailure extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

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

function terminalResultAcceptanceFailure(
  reason: Extract<ResultAcceptanceTransactionOutcome, { readonly kind: "failed" }>["reason"],
): ResultAcceptanceTransactionOutcome {
  return { kind: "failed", terminal: true, reason };
}

function acceptedResultOutcome(
  acceptance: Readonly<AcceptedResult>,
): ResultAcceptanceTransactionOutcome {
  const eventEvidence: ResultAcceptanceEventEvidence = {
    preparationId: acceptance.preparationId,
    operationId: acceptance.operationId,
    acceptanceRequestId: acceptance.acceptanceRequestId,
    manifestDigest: acceptance.manifestDigest,
    evidenceDigest: acceptance.preparationEvidence.digest,
    state: "accepted",
    observedAt: acceptance.acceptedAt,
    acceptedAt: acceptance.acceptedAt,
  };
  return { kind: "accepted", acceptance, eventEvidence };
}

function resultAcceptanceFailure(error: unknown): ResultAcceptanceTransactionOutcome {
  if (error instanceof StoreFailure || error instanceof RecordDecodingError) {
    if (error.code === "write_failed") return { kind: "continuable", reason: "write_failed" };
    if (error.code === "not_found") return terminalResultAcceptanceFailure("operation_not_found");
    if (error.code === "unsupported_schema") return terminalResultAcceptanceFailure("unsupported_schema");
  }
  return terminalResultAcceptanceFailure("corrupt_record");
}

export abstract class ValidatedEventStore implements EventStore {
  private readonly mutationTails = new Map<string, Promise<void>>();

  protected constructor(private readonly clock: RuntimeClock) {}

  protected abstract readRecord(operationId: string): Promise<unknown | undefined>;
  protected abstract writeRecord(
    operationId: string,
    record: StoredOperationRecord,
  ): Promise<void>;
  protected abstract listOperationIds(): Promise<ReadonlyArray<string>>;
  protected willAppend(_event: OperationEvent): void {}
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
    const recordValue = await this.readRecord(operationId);
    if (recordValue === undefined) {
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
    return { record, operation };
  }

  create(request: OperationRequest): Effect.Effect<OperationSnapshot, StoreError> {
    return Effect.flatMap(this.clock.now(), (createdAt) => {
      const authorizationWindowMs = request.startAuthorization.windowMs;
      if (!Number.isSafeInteger(authorizationWindowMs) || authorizationWindowMs < 0) {
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "corrupt_record" as const,
          message: "Authorization window must be a non-negative safe integer",
        });
      }
      const parsed = Date.parse(createdAt);
      if (!Number.isFinite(parsed)) {
        return Effect.fail({
          _tag: "StoreError" as const,
          code: "corrupt_record" as const,
          message: "Creation timestamp must be an absolute timestamp",
        });
      }
      const deadline = new Date(parsed + authorizationWindowMs).toISOString();
      return this.appendEvent(request.operationId, {
        type: "operation_requested",
        task: request.task,
        requestedConfig: request.requestedConfig,
        effectiveConfig: request.effectiveConfig,
        workProductRequirements: request.workProductRequirements,
        resultRetentionPolicy: request.resultRetentionPolicy,
        lineage: request.lineage,
        startAuthorizationTiming: {
          createdAt,
          windowMs: authorizationWindowMs,
          deadline,
          configuredPolicy: request.startAuthorization.configuredPolicy,
          policy: request.startAuthorization.policy,
          authorizedSubjectIds: [...request.startAuthorization.authorizedSubjectIds],
        },
        ...(request.startAuthorization.receipt === undefined
          ? {}
          : { startupReceiptPolicy: structuredClone(request.startAuthorization.receipt) }),
      }, createdAt);
    });
  }

  advance(
    operationId: string,
    intent: OperationIntent,
  ): Effect.Effect<OperationSnapshot, StoreError> {
    if (intent.type === "startup_receipt_recorded") {
      return Effect.flatMap(this.read(operationId), (snapshot) => {
        const observedConfig = snapshot.operation.observedConfig;
        if (observedConfig === undefined) {
          return Effect.fail({
            _tag: "StoreError" as const,
            code: "corrupt_record" as const,
            message: "Startup receipt requires observed Worker configuration",
          });
        }
        return Effect.flatMap(this.clock.now(), (recordedAt) => {
          const receipt = intent.receipt;
          const owner = receipt.workspace.owner.state === "known"
            ? { state: "known" as const, ownerId: receipt.workspace.owner.ownerId }
            : { state: "unknown" as const };
          const receiptWithoutDigest: Omit<StartupReceipt, "digest"> = {
            operationId: receipt.operationId,
            recordedAt,
            workerIdentity: {
              processId: receipt.workerIdentity.processId,
              processInstanceId: receipt.workerIdentity.processInstanceId,
              processStartToken: receipt.workerIdentity.processStartToken,
              piSessionId: receipt.workerIdentity.piSessionId,
              paneId: receipt.workerIdentity.paneId,
            },
            requestedConfig: structuredClone(snapshot.operation.requestedConfig),
            effectiveConfig: structuredClone(snapshot.operation.effectiveConfig),
            observedConfig: structuredClone(observedConfig),
            workspace: {
              workspaceId: receipt.workspace.workspaceId,
              normalizedPath: receipt.workspace.normalizedPath,
              baseRevision: receipt.workspace.baseRevision,
              owner,
              pionsMayDelete: false,
            },
            permissionManifest: {
              manifestId: receipt.permissionManifest.manifestId,
              digest: receipt.permissionManifest.digest,
            },
            reviewSubject: {
              artifactId: receipt.reviewSubject.artifactId,
              byteCount: receipt.reviewSubject.byteCount,
              digest: receipt.reviewSubject.digest,
              format: receipt.reviewSubject.format,
              normalization: receipt.reviewSubject.normalization,
            },
            reviewSubjectVerification: receipt.reviewSubjectVerification,
            configuredAuthorizationPolicy: receipt.configuredAuthorizationPolicy,
            authorizationPolicy: receipt.authorizationPolicy,
            authorizationDeadline: receipt.authorizationDeadline,
          };
          return this.appendEvent(operationId, {
            ...intent,
            gate: intent.gate === "waiting" &&
                Date.parse(recordedAt) >= Date.parse(snapshot.operation.startAuthorizationTiming.deadline)
              ? "expired"
              : intent.gate,
            receipt: {
              ...receiptWithoutDigest,
              digest: startupReceiptDigest(receiptWithoutDigest),
            },
          }, recordedAt);
        });
      });
    }
    if (intent.type === "start_authorization_decided") {
      return this.appendEvent(operationId, intent, intent.decision.decidedAt);
    }
    if (intent.type === "start_authorization_decision_rejected") {
      return Effect.flatMap(this.clock.now(), (attemptedAt) => this.appendEvent(
        operationId,
        { ...intent, attempt: { ...intent.attempt, attemptedAt } },
        attemptedAt,
      ));
    }
    return this.appendEvent(operationId, intent);
  }

  prepareResultAcceptance(
    request: Readonly<ResultAcceptanceReservationRequest>,
  ): Effect.Effect<ResultAcceptanceTransactionOutcome> {
    return Effect.promise(() => this.serialize(request.operationId, async () => {
      try {
        const loaded = await this.load(request.operationId, true);
        if (loaded === undefined) return terminalResultAcceptanceFailure("operation_not_found");
        if (
          !IDENTIFIER.test(request.preparationId) ||
          !IDENTIFIER.test(request.acceptanceRequestId) ||
          request.manifest.value.requirementSetId !== request.requirements.requirementSetId ||
          request.manifest.value.requirementSetDigest !== request.requirements.digest
        ) {
          return terminalResultAcceptanceFailure("request_mismatch");
        }
        if (
          request.requirements.requirementSetId !== loaded.operation.workProductRequirements.requirementSetId ||
          request.requirements.digest !== loaded.operation.workProductRequirements.digest
        ) {
          return terminalResultAcceptanceFailure("request_mismatch");
        }
        const existing = loaded.operation.resultAcceptanceReservation;
        if (existing !== undefined) {
          if (existing.manifestDigest !== request.manifest.digest) {
            return terminalResultAcceptanceFailure(
              existing.acceptanceRequestId === request.acceptanceRequestId
                ? "request_mismatch"
                : "manifest_conflict",
            );
          }
          return loaded.operation.result === undefined
            ? { kind: "prepared", reservation: existing }
            : acceptedResultOutcome(loaded.operation.result);
        }
        if (loaded.operation.state !== "running" && loaded.operation.state !== "blocked") {
          return terminalResultAcceptanceFailure("invalid_operation_state");
        }
        const timestamp = await Effect.runPromise(this.clock.now());
        const reservation: ResultAcceptanceReservation = {
          preparationId: request.preparationId,
          operationId: request.operationId,
          acceptanceRequestId: request.acceptanceRequestId,
          manifest: structuredClone(request.manifest.value),
          manifestCanonicalJson: request.manifest.json,
          manifestDigest: request.manifest.digest,
          requirementSetId: request.requirements.requirementSetId,
          requirementsDigest: request.requirements.digest,
          artifactIds: [...request.manifest.artifactIds],
          totalByteCount: request.manifest.totalByteCount,
          preparedAt: timestamp,
        };
        const event = this.makeEvent(request.operationId, loaded.operation.stateSeq, {
          type: "result_acceptance_prepared",
          reservation,
        }, timestamp);
        const record = decodeRecord({
          ...loaded.record,
          events: [...loaded.record.events, event],
        }, request.operationId);
        const persistedEvent = record.events.at(-1);
        if (persistedEvent === undefined) {
          return terminalResultAcceptanceFailure("corrupt_record");
        }
        const operation = reduceOperation(loaded.operation, persistedEvent);
        try {
          this.willAppend(persistedEvent);
          await this.writeRecord(request.operationId, record);
        } catch {
          return { kind: "continuable", reason: "write_failed" };
        }
        this.didAppend(persistedEvent);
        if (operation.resultAcceptanceReservation === undefined) {
          return terminalResultAcceptanceFailure("corrupt_record");
        }
        return { kind: "prepared", reservation: operation.resultAcceptanceReservation };
      } catch (error) {
        return resultAcceptanceFailure(error);
      }
    }));
  }

  publishResultAcceptance(
    evidence: Readonly<ResultAcceptancePreparationEvidence>,
  ): Effect.Effect<ResultAcceptanceTransactionOutcome> {
    return Effect.promise(() => this.serialize(evidence.operationId, async () => {
      try {
        const loaded = await this.load(evidence.operationId, true);
        if (loaded === undefined) return terminalResultAcceptanceFailure("operation_not_found");
        const reservation = loaded.operation.resultAcceptanceReservation;
        if (reservation === undefined) {
          return terminalResultAcceptanceFailure("preparation_mismatch");
        }
        if (loaded.operation.result !== undefined) {
          const accepted = loaded.operation.result;
          if (evidence.manifestDigest !== accepted.manifestDigest) {
            return terminalResultAcceptanceFailure(
              evidence.acceptanceRequestId === accepted.acceptanceRequestId
                ? "request_mismatch"
                : "manifest_conflict",
            );
          }
          if (
            evidence.acceptanceRequestId === accepted.acceptanceRequestId &&
            !preparationEvidenceMatchesReservation(evidence, reservation)
          ) {
            return terminalResultAcceptanceFailure("preparation_mismatch");
          }
          return acceptedResultOutcome(accepted);
        }
        if (!preparationEvidenceMatchesReservation(evidence, reservation)) {
          return terminalResultAcceptanceFailure("preparation_mismatch");
        }
        if (loaded.operation.state !== "running" && loaded.operation.state !== "blocked") {
          return terminalResultAcceptanceFailure("invalid_operation_state");
        }
        const acceptedAt = await Effect.runPromise(this.clock.now());
        const acceptance: AcceptedResult = {
          acceptanceId: resultAcceptanceIdentifier(reservation),
          preparationId: reservation.preparationId,
          operationId: reservation.operationId,
          acceptanceRequestId: reservation.acceptanceRequestId,
          acceptedAt,
          eventSequenceNumber: loaded.operation.stateSeq + 1,
          manifestFormatId: reservation.manifest.formatId,
          manifestNormalizationId: reservation.manifest.normalizationId,
          manifestDigest: reservation.manifestDigest,
          requirementSetId: reservation.requirementSetId,
          requirementsDigest: reservation.requirementsDigest,
          bodyArtifactId: reservation.manifest.bodyArtifactId,
          workProducts: structuredClone(reservation.manifest.workProducts),
          artifactIds: [...reservation.artifactIds],
          preparationEvidence: structuredClone(evidence),
          acceptedArtifactRetentionMs: evidence.acceptedArtifactRetentionMs,
          retentionPolicyDigest: evidence.retentionPolicyDigest,
        };
        const event = this.makeEvent(evidence.operationId, loaded.operation.stateSeq, {
          type: "result_accepted",
          acceptance,
          preparationEvidence: structuredClone(evidence),
        }, acceptedAt);
        const record = decodeRecord({
          ...loaded.record,
          events: [...loaded.record.events, event],
        }, evidence.operationId);
        const persistedEvent = record.events.at(-1);
        if (persistedEvent === undefined) {
          return terminalResultAcceptanceFailure("corrupt_record");
        }
        reduceOperation(loaded.operation, persistedEvent);
        try {
          this.willAppend(persistedEvent);
          await this.writeRecord(evidence.operationId, record);
        } catch {
          return { kind: "continuable", reason: "write_failed", reservation };
        }
        this.didAppend(persistedEvent);
        const persisted = await this.load(evidence.operationId, true);
        if (persisted?.operation.result === undefined) {
          return terminalResultAcceptanceFailure("corrupt_record");
        }
        return acceptedResultOutcome(persisted.operation.result);
      } catch (error) {
        return resultAcceptanceFailure(error);
      }
    }));
  }

  private makeEvent(
    operationId: string,
    stateSeq: number,
    input: EventInput,
    timestamp: string,
  ): OperationEvent {
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw failure("corrupt_record", "Operation event timestamp is not absolute");
    }
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

  read(operationId: string): Effect.Effect<OperationSnapshot, StoreError> {
    return Effect.tryPromise({
      try: () => this.serialize(operationId, async () => {
        const loaded = await this.load(operationId, true);
        if (loaded === undefined) throw failure("not_found", `Operation not found: ${operationId}`);
        const lastEvent = loaded.record.events.at(-1);
        if (lastEvent === undefined) throw failure("corrupt_record", "Operation record has no events");
        return {
          version: { sequenceNumber: lastEvent.seq, recordedAt: lastEvent.timestamp },
          operation: loaded.operation,
        };
      }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  listWaitingStartAuthorizations(): Effect.Effect<ReadonlyArray<OperationSnapshot>, StoreError> {
    return Effect.tryPromise({
      try: async () => {
        const operationIds = await this.listOperationIds();
        const snapshots = await Promise.all(operationIds.map((operationId) =>
          Effect.runPromise(this.read(operationId)),
        ));
        return snapshots.filter((snapshot) =>
          snapshot.operation.startGate === "waiting" &&
          snapshot.operation.startupReceipt !== undefined,
        );
      },
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  listRecoverableOperations(): Effect.Effect<ReadonlyArray<OperationSnapshot>, StoreError> {
    return Effect.tryPromise({
      try: async () => {
        const operationIds = await this.listOperationIds();
        const snapshots = await Promise.all(operationIds.map((operationId) =>
          Effect.runPromise(this.read(operationId)),
        ));
        return snapshots.filter(({ operation }) =>
          (
            operation.state === "starting" || operation.state === "running" ||
            operation.state === "blocked" || operation.state === "cancelling"
          ) &&
          operation.workerIdentity !== undefined &&
          operation.startDeliveryAuthority !== undefined &&
          operation.workerStopConfirmedAt === undefined,
        );
      },
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  private appendEvent(
    operationId: string,
    input: EventInput,
    fixedTimestamp?: string,
  ): Effect.Effect<OperationSnapshot, StoreError> {
    return Effect.tryPromise({
      try: () => this.serialize(operationId, async () => {
        const loaded = await this.load(operationId, input.type !== "operation_requested");
        const event = this.makeEvent(
          operationId,
          loaded?.operation.stateSeq ?? 0,
          input,
          fixedTimestamp ?? await Effect.runPromise(this.clock.now()),
        );
        const record = decodeRecord({
          schemaVersion: EVENT_SCHEMA_VERSION,
          operationId,
          events: [...(loaded?.record.events ?? []), event],
        }, operationId);
        const persistedEvent = record.events.at(-1);
        if (persistedEvent === undefined) {
          throw failure("corrupt_record", "Operation record has no events");
        }
        const operation = reduceOperation(loaded?.operation, persistedEvent);
        try {
          await this.writeRecord(operationId, record);
        } catch (error) {
          throw failure("write_failed", error instanceof Error ? error.message : String(error));
        }
        this.didAppend(persistedEvent);
        return {
          version: {
            sequenceNumber: persistedEvent.seq,
            recordedAt: persistedEvent.timestamp,
          },
          operation,
        };
      }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

}
