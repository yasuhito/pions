import { isDeepStrictEqual } from "node:util";

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
  RevisionAdoptionCommand,
  RevisionReservationCommand,
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
  RevisionReservation,
  RevisionReservationOutcome,
  RevisionResultAdoptionOutcome,
  RevisionSeriesSnapshot,
  StartupReceipt,
} from "../../public.js";
import { startupReceiptDigest } from "../startup-receipt.js";
import { revisionSeriesId, revisionSeriesOrigin } from "../revision-series.js";
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
        ...(request.revisionMembership === undefined
          ? {}
          : { revisionMembership: request.revisionMembership }),
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

  reserveRevision(
    command: Readonly<RevisionReservationCommand>,
  ): Effect.Effect<RevisionReservationOutcome, StoreError> {
    return Effect.tryPromise({
      try: () => this.serialize(command.seriesOriginOperationId, async () => {
        const origin = await this.load(command.seriesOriginOperationId, true);
        if (origin === undefined) throw failure("not_found", "Revision series origin not found");
        const series = origin.operation.revisionSeries;
        const existing = series?.reservations.find(({ requestId }) => requestId === command.requestId);
        if (existing !== undefined) {
          const matches = existing.kind === command.kind &&
            existing.targetOperationId === command.targetOperationId &&
            existing.targetResultId === command.targetResultId &&
            existing.targetResultDigest === command.targetResultDigest &&
            existing.retryOfOperationId === command.retryOfOperationId &&
            existing.reason === command.reason && existing.requestedBy === command.requestedBy &&
            (command.maxAttempts === undefined || existing.maxAttempts === command.maxAttempts) &&
            (command.artifactAcceptanceSubjectIds === undefined ||
              isDeepStrictEqual(existing.artifactAcceptanceSubjectIds, command.artifactAcceptanceSubjectIds)) &&
            isDeepStrictEqual(existing.task, command.task) &&
            existing.retryClearanceId === command.clearance?.clearanceId;
          return matches
            ? { status: "idempotent", reservation: existing } as const
            : { status: "rejected", reason: "request_conflict" } as const;
        }
        const maxAttempts = series?.maxAttempts ?? command.maxAttempts;
        if (maxAttempts === undefined || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
          return { status: "rejected", reason: "invalid_target" } as const;
        }
        if (
          command.maxAttempts !== undefined && command.maxAttempts !== maxAttempts ||
          series !== undefined && command.artifactAcceptanceSubjectIds !== undefined &&
            !isDeepStrictEqual(series.artifactAcceptanceSubjectIds, command.artifactAcceptanceSubjectIds)
        ) {
          return { status: "rejected", reason: "request_conflict" } as const;
        }
        const artifactAcceptanceSubjectIds = series?.artifactAcceptanceSubjectIds ?? command.artifactAcceptanceSubjectIds;
        if (
          artifactAcceptanceSubjectIds === undefined || artifactAcceptanceSubjectIds.length < 1 ||
          new Set(artifactAcceptanceSubjectIds).size !== artifactAcceptanceSubjectIds.length
        ) return { status: "rejected", reason: "invalid_target" } as const;
        if ((series?.reservations.length ?? 0) >= maxAttempts) {
          return { status: "rejected", reason: "limit_exceeded" } as const;
        }
        const target = await this.load(command.targetOperationId, false);
        if (target === undefined) return { status: "rejected", reason: "not_found" } as const;

        let revisionNumber: number;
        if (command.kind === "revision") {
          const accepted = target.operation.result;
          const latestRevisionNumber = series?.reservations.reduce(
            (max, reservation) => Math.max(max, reservation.revisionNumber),
            0,
          ) ?? 0;
          const latestRevisionReservations = series?.reservations.filter(({ revisionNumber }) =>
            revisionNumber === latestRevisionNumber
          ) ?? [];
          const directRevision = latestRevisionReservations.find(({ kind }) => kind === "revision");
          const latestRevisionHasRetry = latestRevisionReservations.some(({ kind }) => kind === "retry");
          const adoptedResult = series?.adoptions.find(({ revisionNumber }) =>
            revisionNumber === latestRevisionNumber
          );
          const expectedTargetOperationId = series === undefined
            ? command.seriesOriginOperationId
            : latestRevisionHasRetry ? adoptedResult?.retryOperationId : directRevision?.operationId;
          const expected = expectedTargetOperationId === command.targetOperationId ? accepted : undefined;
          if (
            expected === undefined ||
            series === undefined && target.operation.revisionMembership !== undefined ||
            target.operation.state !== "completed" ||
            target.operation.workerStopConfirmedAt === undefined ||
            target.operation.resourceEvidenceRecord !== undefined &&
              target.operation.resourceEvidenceRecord.snapshot.state !== "released" ||
            command.retryOfOperationId !== undefined || command.clearance !== undefined ||
            expected.acceptanceId !== command.targetResultId || expected.manifestDigest !== command.targetResultDigest ||
            series?.reservations.some((reservation) =>
              reservation.kind === "revision" && reservation.targetResultId === command.targetResultId
            ) === true
          ) {
            return { status: "rejected", reason: "invalid_target" } as const;
          }
          revisionNumber = (series?.reservations.reduce((max, item) => Math.max(max, item.revisionNumber), 0) ?? 0) + 1;
        } else {
          const failedId = command.retryOfOperationId;
          const previous = series?.reservations.find(({ operationId }) => operationId === failedId);
          if (
            failedId === undefined || previous === undefined || command.targetOperationId !== failedId ||
            target.operation.result !== undefined ||
            target.operation.state !== "failed" && target.operation.state !== "unknown" && target.operation.state !== "cancelled" ||
            series?.reservations.some(({ retryOfOperationId }) => retryOfOperationId === failedId) === true
          ) {
            return { status: "rejected", reason: "invalid_target" } as const;
          }
          const clearanceRequired = target.operation.state === "unknown" ||
            target.operation.workerStopConfirmedAt === undefined ||
            target.operation.resourceEvidenceRecord !== undefined &&
              target.operation.resourceEvidenceRecord.snapshot.state !== "released";
          if (clearanceRequired && command.clearance === undefined) {
            return { status: "rejected", reason: "retry_clearance_required" } as const;
          }
          if (command.clearance !== undefined && (
            command.clearance.failedOperationId !== failedId ||
            !command.clearance.workerStoppedOrAccessBlocked || !command.clearance.noConflict ||
            !command.clearance.handoffConfirmed || command.clearance.affectedResourceIds.length === 0 ||
            target.operation.resourceEvidenceRecord !== undefined &&
              !command.clearance.affectedResourceIds.includes(
                target.operation.resourceEvidenceRecord.snapshot.acquisitionId
              )
          )) {
            return { status: "rejected", reason: "retry_clearance_invalid" } as const;
          }
          revisionNumber = previous.revisionNumber;
        }

        let loaded = origin;
        if (command.clearance !== undefined) {
          const recordedClearance = series?.retryClearances.find(({ clearanceId }) =>
            clearanceId === command.clearance!.clearanceId
          );
          if (recordedClearance !== undefined && !isDeepStrictEqual(recordedClearance, command.clearance)) {
            return { status: "rejected", reason: "request_conflict" } as const;
          }
          if (recordedClearance === undefined) {
            loaded = await this.appendLoaded(command.seriesOriginOperationId, loaded, {
              type: "retry_clearance_recorded",
              clearance: structuredClone(command.clearance),
            });
          }
        }
        const reservedAt = await Effect.runPromise(this.clock.now());
        const reservation: RevisionReservation = {
          requestId: command.requestId,
          kind: command.kind,
          seriesId: revisionSeriesId(command.seriesOriginOperationId),
          seriesOriginOperationId: command.seriesOriginOperationId,
          revisionNumber,
          attemptNumber: (series?.reservations.length ?? 0) + 1,
          operationId: command.operationId,
          targetOperationId: command.targetOperationId,
          ...(command.targetResultId === undefined ? {} : { targetResultId: command.targetResultId }),
          ...(command.targetResultDigest === undefined ? {} : { targetResultDigest: command.targetResultDigest }),
          ...(command.retryOfOperationId === undefined ? {} : { retryOfOperationId: command.retryOfOperationId }),
          reason: command.reason,
          requestedBy: command.requestedBy,
          maxAttempts,
          artifactAcceptanceSubjectIds: [...artifactAcceptanceSubjectIds],
          task: structuredClone(command.task),
          reservedAt,
          ...(command.clearance === undefined ? {} : { retryClearanceId: command.clearance.clearanceId }),
        };
        await this.appendLoaded(command.seriesOriginOperationId, loaded, {
          type: "revision_reserved",
          reservation,
        }, reservedAt);
        return { status: "reserved", reservation } as const;
      }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  adoptRevisionResult(
    command: Readonly<RevisionAdoptionCommand>,
  ): Effect.Effect<RevisionResultAdoptionOutcome, StoreError> {
    const originId = revisionSeriesOrigin(command.seriesId);
    if (originId === undefined) {
      return Effect.succeed({ status: "rejected", reason: "series_not_found" });
    }
    return Effect.tryPromise({
      try: () => this.serialize(originId, async () => {
        const origin = await this.load(originId, false);
        const series = origin?.operation.revisionSeries;
        if (origin === undefined || series === undefined || series.seriesId !== command.seriesId) {
          return { status: "rejected", reason: "series_not_found" } as const;
        }
        const byDecision = series.adoptions.find(({ decisionId }) => decisionId === command.decisionId);
        const byRevision = series.adoptions.find(({ revisionNumber }) => revisionNumber === command.revisionNumber);
        if (byDecision !== undefined || byRevision !== undefined) {
          const existing = byDecision ?? byRevision!;
          return isDeepStrictEqual(
            { ...existing, decidedAt: undefined },
            { ...command, decidedAt: undefined },
          )
            ? { status: "idempotent", adoption: existing } as const
            : { status: "rejected", reason: "decision_conflict" } as const;
        }
        const reservation = series.reservations.find(({ operationId, revisionNumber }) =>
          operationId === command.retryOperationId && revisionNumber === command.revisionNumber
        );
        if (reservation === undefined) return { status: "rejected", reason: "invalid_successor" } as const;
        const resultOperation = await this.load(command.retryOperationId, false);
        const result = resultOperation?.operation.result;
        if (result === undefined || result.acceptanceId !== command.resultId || result.manifestDigest !== command.resultDigest) {
          return { status: "rejected", reason: "result_not_accepted" } as const;
        }
        const adoption = { ...command, decidedAt: await Effect.runPromise(this.clock.now()) };
        await this.appendLoaded(originId, origin, { type: "revision_result_adopted", adoption }, adoption.decidedAt);
        return { status: "adopted", adoption } as const;
      }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  readRevisionSeries(seriesOriginOperationId: string): Effect.Effect<RevisionSeriesSnapshot, StoreError> {
    return Effect.flatMap(this.read(seriesOriginOperationId), ({ operation }) =>
      operation.revisionSeries === undefined
        ? Effect.fail({ _tag: "StoreError" as const, code: "not_found" as const, message: "Revision series not found" })
        : Effect.succeed(operation.revisionSeries));
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

  listPendingPresentationCleanups(): Effect.Effect<ReadonlyArray<OperationSnapshot>, StoreError> {
    return Effect.tryPromise({
      try: async () => {
        const operationIds = await this.listOperationIds();
        const snapshots = await Promise.all(operationIds.map((operationId) =>
          Effect.runPromise(this.read(operationId)),
        ));
        return snapshots.filter(({ operation }) => operation.presentationCleanup?.state === "pending");
      },
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  listPendingRevisionReservations(): Effect.Effect<ReadonlyArray<Readonly<RevisionReservation>>, StoreError> {
    return Effect.tryPromise({
      try: async () => {
        const operationIds = await this.listOperationIds();
        const existing = new Set(operationIds);
        const snapshots = await Promise.all(operationIds.map((operationId) =>
          Effect.runPromise(this.read(operationId)),
        ));
        return snapshots.flatMap(({ operation }) =>
          operation.revisionSeries?.reservations.filter(({ operationId }) => !existing.has(operationId)) ?? []
        );
      },
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

  private async appendLoaded(
    operationId: string,
    loaded: LoadedRecord | undefined,
    input: EventInput,
    fixedTimestamp?: string,
  ): Promise<LoadedRecord> {
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
    if (persistedEvent === undefined) throw failure("corrupt_record", "Operation record has no events");
    const operation = reduceOperation(loaded?.operation, persistedEvent);
    this.willAppend(persistedEvent);
    try {
      await this.writeRecord(operationId, record);
    } catch (error) {
      throw failure("write_failed", error instanceof Error ? error.message : String(error));
    }
    this.didAppend(persistedEvent);
    return { record, operation };
  }

  private appendEvent(
    operationId: string,
    input: EventInput,
    fixedTimestamp?: string,
  ): Effect.Effect<OperationSnapshot, StoreError> {
    return Effect.tryPromise({
      try: () => this.serialize(operationId, async () => {
        const loaded = await this.load(operationId, input.type !== "operation_requested");
        const persisted = await this.appendLoaded(operationId, loaded, input, fixedTimestamp);
        const lastEvent = persisted.record.events.at(-1)!;
        return {
          version: { sequenceNumber: lastEvent.seq, recordedAt: lastEvent.timestamp },
          operation: persisted.operation,
        };
      }),
      catch: (error) => asStoreError(error, "corrupt_record"),
    });
  }

}
