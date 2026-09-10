import { isDeepStrictEqual } from "node:util";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./model.js";
import type { StartInstructionReference, StartupReceipt } from "../../public.js";
import type { Operation, OperationEvent } from "./model.js";
import { startupReceiptDigest } from "../startup-receipt.js";
import {
  automaticStartScopeDigest,
  startInstructionReference,
} from "../start-instruction.js";
import {
  manifestReservationIsConsistent,
  preparationEvidenceMatchesReservation,
} from "../result-acceptance-transaction.js";

export type TransitionErrorCode =
  | "operation_required"
  | "operation_already_exists"
  | "operation_id_mismatch"
  | "invalid_operation_id"
  | "invalid_event_id"
  | "duplicate_event"
  | "unsupported_schema_version"
  | "actor_mismatch"
  | "authority_mismatch"
  | "unexpected_sequence"
  | "illegal_transition"
  | "terminal_state_immutable"
  | "result_required_before_self_settlement"
  | "successful_settlement_required_before_completion"
  | "descendants_must_be_settled"
  | "descendant_failure_prevents_completion"
  | "unknown_child"
  | "child_already_settled"
  | "failed_settlement_required_before_failure"
  | "failure_reason_mismatch"
  | "stale_cancellation_epoch"
  | "cancellation_epoch_mismatch";

export class TransitionError extends Error {
  override readonly name = "TransitionError";

  constructor(readonly code: TransitionErrorCode) {
    super(code);
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function immutable(operation: Operation): Operation {
  Object.freeze(operation.task);
  Object.freeze(operation.requestedConfig.model);
  Object.freeze(operation.requestedConfig.tools);
  Object.freeze(operation.requestedConfig);
  Object.freeze(operation.effectiveConfig.model);
  operation.effectiveConfig.modelPolicy.candidates.forEach(Object.freeze);
  operation.effectiveConfig.modelPolicy.attempted.forEach(Object.freeze);
  Object.freeze(operation.effectiveConfig.modelPolicy.candidates);
  Object.freeze(operation.effectiveConfig.modelPolicy.attempted);
  Object.freeze(operation.effectiveConfig.modelPolicy.aliases);
  Object.freeze(operation.effectiveConfig.modelPolicy);
  Object.freeze(operation.effectiveConfig.tools);
  Object.freeze(operation.effectiveConfig);
  deepFreeze(operation.workProductRequirements);
  deepFreeze(operation.resultRetentionPolicy);
  if (operation.observedConfig !== undefined) {
    if (operation.observedConfig.model.state === "observed") Object.freeze(operation.observedConfig.model.value);
    if (operation.observedConfig.tools.state === "observed") Object.freeze(operation.observedConfig.tools.value);
    Object.freeze(operation.observedConfig.model);
    Object.freeze(operation.observedConfig.thinkingLevel);
    Object.freeze(operation.observedConfig.tools);
    Object.freeze(operation.observedConfig.cwd);
    Object.freeze(operation.observedConfig);
  }
  Object.freeze(operation.lineage);
  if (operation.presentation !== undefined) Object.freeze(operation.presentation);
  if (operation.workerIdentity !== undefined) Object.freeze(operation.workerIdentity);
  deepFreeze(operation.startAuthorizationTiming);
  if (operation.startupReceiptPolicy !== undefined) deepFreeze(operation.startupReceiptPolicy);
  if (operation.startupReceipt !== undefined) deepFreeze(operation.startupReceipt);
  if (operation.startAuthorizationDecision !== undefined) {
    Object.freeze(operation.startAuthorizationDecision);
  }
  deepFreeze(operation.rejectedStartAuthorizationDecisions);
  if (operation.startDeliveryAuthority !== undefined) {
    Object.freeze(operation.startDeliveryAuthority);
  }
  if (operation.startDeliveryEntry !== undefined) {
    Object.freeze(operation.startDeliveryEntry);
  }
  if (operation.startInstructionDelivery !== undefined) {
    Object.freeze(operation.startInstructionDelivery);
  }
  if (operation.startInstructionAcceptance !== undefined) {
    Object.freeze(operation.startInstructionAcceptance);
  }
  if (operation.startInstructionAcknowledgement !== undefined) {
    Object.freeze(operation.startInstructionAcknowledgement);
  }
  deepFreeze(operation.startDeliveryHandoffs);
  if (operation.resourceEvidenceRecord !== undefined) deepFreeze(operation.resourceEvidenceRecord);
  if (operation.agentRunEvidence !== undefined) {
    Object.freeze(operation.agentRunEvidence.usage);
    operation.agentRunEvidence.toolUses.forEach(Object.freeze);
    Object.freeze(operation.agentRunEvidence.toolUses);
    Object.freeze(operation.agentRunEvidence);
  }
  Object.freeze(operation.childOperationIds);
  Object.freeze(operation.settledChildOperationIds);
  if (operation.result !== undefined) deepFreeze(operation.result);
  if (operation.resultAcceptanceReservation !== undefined) {
    deepFreeze(operation.resultAcceptanceReservation);
  }
  return Object.freeze(operation);
}

function sameStringArray(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.length === right.length &&
      left.every((value, index) => value === right[index]);
}

function validInitialConfiguration(
  event: Extract<OperationEvent, { readonly type: "operation_requested" }>,
): boolean {
  const requested = event.requestedConfig;
  const effective = event.effectiveConfig;
  const candidate = effective.modelPolicy.candidates[0];
  const attempted = effective.modelPolicy.attempted[0];
  return requested.model?.provider === event.task.model?.provider &&
    requested.model?.id === event.task.model?.id &&
    requested.thinkingLevel === event.task.thinkingLevel &&
    requested.cwd === event.task.cwd &&
    sameStringArray(requested.tools, event.task.tools) &&
    effective.model.provider.length > 0 &&
    effective.model.id.length > 0 &&
    effective.cwd.length > 0 &&
    effective.modelPolicy.candidates.length === 1 &&
    effective.modelPolicy.attempted.length === 1 &&
    effective.modelPolicy.maxAttempts === 1 &&
    effective.modelPolicy.fallback === "forbidden" &&
    effective.modelPolicy.aliases.length === 0 &&
    candidate?.provider === effective.model.provider &&
    candidate.id === effective.model.id &&
    attempted?.provider === effective.model.provider &&
    attempted.id === effective.model.id;
}

function sanitizedStartupReceipt(
  operation: Operation,
  receipt: Readonly<StartupReceipt>,
): StartupReceipt {
  const owner = receipt.workspace.owner.state === "known"
    ? { state: "known" as const, ownerId: receipt.workspace.owner.ownerId }
    : { state: "unknown" as const };
  return {
    operationId: receipt.operationId,
    digest: receipt.digest,
    recordedAt: receipt.recordedAt,
    workerIdentity: { ...operation.workerIdentity! },
    requestedConfig: structuredClone(operation.requestedConfig),
    effectiveConfig: structuredClone(operation.effectiveConfig),
    observedConfig: structuredClone(operation.observedConfig!),
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
    ...(receipt.resourceEvidence === undefined
      ? {}
      : { resourceEvidence: { ...receipt.resourceEvidence } }),
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
}

function validStartInstructionReference(
  operation: Operation,
  instruction: Readonly<StartInstructionReference>,
): boolean {
  if (
    operation.workerIdentity === undefined ||
    instruction.dispatcherId.length === 0 ||
    !Number.isSafeInteger(instruction.deliveryGeneration) ||
    instruction.deliveryGeneration < 1 ||
    instruction.workerProcessInstanceId !== operation.workerIdentity.processInstanceId
  ) return false;
  if (operation.startGate === "not_required") {
    return instruction.authorizationDecisionId === undefined &&
      instruction.receiptDigest === automaticStartScopeDigest(operation);
  }
  return operation.startGate === "authorized" &&
    operation.startupReceipt !== undefined &&
    instruction.receiptDigest === operation.startupReceipt.digest &&
    instruction.authorizationDecisionId === operation.startAuthorizationDecision?.decisionId;
}

function hasUnsettledChildren(operation: Operation): boolean {
  return (
    operation.childOperationIds.length !==
    operation.settledChildOperationIds.length
  );
}

function validStartAuthorizationTiming(
  event: Extract<OperationEvent, { readonly type: "operation_requested" }>,
): boolean {
  const timing = event.startAuthorizationTiming;
  const created = Date.parse(timing.createdAt);
  return timing.createdAt === event.timestamp &&
    Number.isSafeInteger(timing.windowMs) &&
    timing.windowMs >= 0 &&
    Number.isFinite(created) &&
    timing.deadline === new Date(created + timing.windowMs).toISOString() &&
    (timing.configuredPolicy === "optional" || timing.configuredPolicy === timing.policy) &&
    new Set(timing.authorizedSubjectIds).size === timing.authorizedSubjectIds.length &&
    timing.authorizedSubjectIds.every((subjectId) => subjectId.length > 0) &&
    (timing.policy === "disabled"
      ? timing.windowMs === 0 && timing.authorizedSubjectIds.length === 0
      : timing.windowMs > 0 && timing.authorizedSubjectIds.length > 0);
}

function validateEnvelope(event: OperationEvent): void {
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new TransitionError("unsupported_schema_version");
  }
  if (event.actorId !== RUNTIME_ACTOR_ID) {
    throw new TransitionError("actor_mismatch");
  }
  if (event.authority !== OPERATION_AUTHORITY) {
    throw new TransitionError("authority_mismatch");
  }
  if (event.operationId.length === 0) {
    throw new TransitionError("invalid_operation_id");
  }
  if (event.eventId.length === 0) {
    throw new TransitionError("invalid_event_id");
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) {
    throw new TransitionError("unexpected_sequence");
  }
}

export function reduceOperation(
  current: Operation | undefined,
  event: OperationEvent,
): Operation {
  validateEnvelope(event);

  if (current === undefined) {
    if (event.type !== "operation_requested") {
      throw new TransitionError("operation_required");
    }
    if (event.seq !== 1) throw new TransitionError("unexpected_sequence");
    if (
      !validInitialConfiguration(event) ||
      !validStartAuthorizationTiming(event) ||
      (event.startAuthorizationTiming.policy === "required") !==
        (event.startupReceiptPolicy !== undefined) ||
      event.resultRetentionPolicy.operationId !== event.operationId ||
      !Number.isSafeInteger(event.resultRetentionPolicy.acceptedArtifactRetentionMs) ||
      event.resultRetentionPolicy.acceptedArtifactRetentionMs <= 0
    ) {
      throw new TransitionError("illegal_transition");
    }

    return immutable({
      operationId: event.operationId,
      lineage: { ...event.lineage },
      state: "queued",
      stateSeq: event.seq,
      workerLaunched: false,
      task: { ...event.task },
      requestedConfig: {
        ...event.requestedConfig,
        ...(event.requestedConfig.model === undefined ? {} : { model: { ...event.requestedConfig.model } }),
        ...(event.requestedConfig.tools === undefined ? {} : { tools: [...event.requestedConfig.tools] }),
      },
      effectiveConfig: {
        ...event.effectiveConfig,
        model: { ...event.effectiveConfig.model },
        tools: [...event.effectiveConfig.tools],
        modelPolicy: {
          ...event.effectiveConfig.modelPolicy,
          candidates: event.effectiveConfig.modelPolicy.candidates.map((model) => ({ ...model })),
          attempted: event.effectiveConfig.modelPolicy.attempted.map((model) => ({ ...model })),
          aliases: [],
        },
      },
      startAuthorizationTiming: { ...event.startAuthorizationTiming },
      ...(event.startupReceiptPolicy === undefined
        ? {}
        : { startupReceiptPolicy: structuredClone(event.startupReceiptPolicy) }),
      workProductRequirements: structuredClone(event.workProductRequirements),
      resultRetentionPolicy: structuredClone(event.resultRetentionPolicy),
      startGate: "not_required",
      rejectedStartAuthorizationDecisions: [],
      startDeliveryHandoffs: [],
      childOperationIds: [],
      settledChildOperationIds: [],
      descendantFailure: false,
      spawnFrozen: false,
      cancellationEpoch: 0,
    });
  }

  if (event.type === "operation_requested") {
    throw new TransitionError("operation_already_exists");
  }
  if (event.operationId !== current.operationId) {
    throw new TransitionError("operation_id_mismatch");
  }
  if (event.seq !== current.stateSeq + 1) {
    throw new TransitionError("unexpected_sequence");
  }
  if (
    event.type !== "presentation_cleanup_failed" &&
    event.type !== "resource_evidence_recorded" &&
    event.type !== "start_authorization_decision_rejected" &&
    (current.state === "completed" ||
      current.state === "failed" ||
      current.state === "cancelled" ||
      current.state === "unknown")
  ) {
    throw new TransitionError("terminal_state_immutable");
  }

  switch (event.type) {
    case "presentation_owned":
      if (current.state !== "queued" || current.presentation !== undefined) {
        throw new TransitionError("illegal_transition");
      }
      if (
        event.presentation.kind !== "herdr_pane" ||
        event.presentation.paneId.length === 0 ||
        event.presentation.ownedByPions !== true
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        presentation: { ...event.presentation },
        stateSeq: event.seq,
      });

    case "child_attached":
      if (current.spawnFrozen || current.state === "draining_descendants") {
        throw new TransitionError("illegal_transition");
      }
      if (current.childOperationIds.includes(event.childOperationId)) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        childOperationIds: [...current.childOperationIds, event.childOperationId],
        state:
          current.state === "self_settled"
            ? "draining_descendants"
            : current.state,
        stateSeq: event.seq,
      });

    case "child_settled": {
      if (!current.childOperationIds.includes(event.childOperationId)) {
        throw new TransitionError("unknown_child");
      }
      if (current.settledChildOperationIds.includes(event.childOperationId)) {
        throw new TransitionError("child_already_settled");
      }
      const settledChildOperationIds = [
        ...current.settledChildOperationIds,
        event.childOperationId,
      ];
      const descendantsDrained =
        settledChildOperationIds.length === current.childOperationIds.length;
      return immutable({
        ...current,
        descendantFailure:
          current.descendantFailure || event.outcome === "failed",
        settledChildOperationIds,
        state:
          current.state === "draining_descendants" && descendantsDrained
            ? "self_settled"
            : current.state,
        stateSeq: event.seq,
      });
    }

    case "startup_receipt_recorded": {
      if (
        current.state !== "starting" ||
        current.workerIdentity === undefined ||
        current.observedConfig === undefined ||
        current.startupReceipt !== undefined
      ) {
        throw new TransitionError("illegal_transition");
      }
      const sanitizedReceipt = sanitizedStartupReceipt(current, event.receipt);
      if (
        event.receipt.operationId !== current.operationId ||
        event.receipt.authorizationDeadline !== current.startAuthorizationTiming.deadline ||
        event.receipt.configuredAuthorizationPolicy !== current.startAuthorizationTiming.configuredPolicy ||
        event.receipt.authorizationPolicy !== current.startAuthorizationTiming.policy ||
        (event.receipt.authorizationPolicy === "required" &&
          (current.startupReceiptPolicy === undefined ||
            !isDeepStrictEqual(event.receipt.workspace, current.startupReceiptPolicy.workspace) ||
            !isDeepStrictEqual(event.receipt.permissionManifest, current.startupReceiptPolicy.permissionManifest) ||
            !isDeepStrictEqual(event.receipt.reviewSubject, current.startupReceiptPolicy.reviewSubject) ||
            event.receipt.reviewSubjectVerification !== current.startupReceiptPolicy.reviewSubjectVerification)) ||
        event.receipt.recordedAt !== event.timestamp ||
        !Number.isFinite(Date.parse(event.receipt.recordedAt)) ||
        event.receipt.workspace.workspaceId.length === 0 ||
        event.receipt.workspace.normalizedPath.length === 0 ||
        event.receipt.workspace.baseRevision.length === 0 ||
        event.receipt.permissionManifest.manifestId.length === 0 ||
        event.receipt.reviewSubject.artifactId.length === 0 ||
        event.receipt.workerIdentity.processInstanceId !== current.workerIdentity.processInstanceId ||
        !isDeepStrictEqual(event.receipt.workerIdentity, current.workerIdentity) ||
        !isDeepStrictEqual(event.receipt.requestedConfig, current.requestedConfig) ||
        !isDeepStrictEqual(event.receipt.effectiveConfig, current.effectiveConfig) ||
        !isDeepStrictEqual(event.receipt.observedConfig, current.observedConfig) ||
        (event.gate === "waiting" || event.gate === "expired") !==
          (event.receipt.authorizationPolicy === "required") ||
        (event.gate === "waiting") !==
          (Date.parse(event.receipt.recordedAt) < Date.parse(current.startAuthorizationTiming.deadline)) ||
        (event.receipt.configuredAuthorizationPolicy !== "optional" &&
          event.receipt.configuredAuthorizationPolicy !== event.receipt.authorizationPolicy) ||
        startupReceiptDigest((({ digest: _digest, ...receipt }) => receipt)(sanitizedReceipt)) !== event.receipt.digest
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        startupReceipt: sanitizedReceipt,
        startGate: event.gate,
        stateSeq: event.seq,
      });
    }

    case "start_authorization_decided":
      if (
        current.state !== "starting" ||
        current.startGate !== "waiting" ||
        current.startupReceipt === undefined ||
        current.startAuthorizationDecision !== undefined ||
        event.decision.decisionId.length === 0 ||
        event.decision.actorId.length === 0 ||
        event.decision.decidedAt !== event.timestamp ||
        Date.parse(event.decision.decidedAt) >= Date.parse(current.startAuthorizationTiming.deadline) ||
        event.decision.receiptDigest !== current.startupReceipt.digest ||
        (event.gate === "authorized") !== (event.decision.kind === "authorize")
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        startGate: event.gate,
        startAuthorizationDecision: { ...event.decision },
        stateSeq: event.seq,
      });

    case "start_gate_closed":
      if (
        current.state !== "starting" ||
        (event.gate === "expired" && current.startGate !== "waiting" && current.startGate !== "authorized") ||
        (event.gate === "invalidated" && current.startGate !== "authorized")
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, startGate: event.gate, stateSeq: event.seq });

    case "start_authorization_decision_rejected":
      if (
        event.attempt.decisionId.length === 0 || event.attempt.actorId.length === 0 ||
        event.attempt.attemptedAt !== event.timestamp
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        rejectedStartAuthorizationDecisions: [
          ...current.rejectedStartAuthorizationDecisions,
          { ...event.attempt },
        ],
        stateSeq: event.seq,
      });

    case "start_delivery_authority_acquired": {
      const handoff = current.startDeliveryHandoffs.at(-1);
      const replacesRevokedAuthority = handoff !== undefined &&
        handoff.workerGenerationConfirmedAt !== undefined &&
        handoff.acceptanceState === "not_accepted" &&
        event.instruction.dispatcherId === handoff.successorDispatcherId &&
        event.instruction.deliveryGeneration === handoff.deliveryGeneration;
      if (
        current.state !== "starting" ||
        !current.workerLaunched ||
        current.startGate !== "not_required" && current.startGate !== "authorized" ||
        current.startDeliveryAuthority !== undefined && !replacesRevokedAuthority ||
        current.startAuthorizationTiming.policy === "required" &&
          Date.parse(event.timestamp) >= Date.parse(current.startAuthorizationTiming.deadline) ||
        !validStartInstructionReference(current, event.instruction)
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        startDeliveryAuthority: { ...event.instruction, acquiredAt: event.timestamp },
        stateSeq: event.seq,
      });
    }

    case "start_delivery_authority_revoked": {
      const authority = current.startDeliveryAuthority;
      const pendingHandoff = current.startDeliveryHandoffs.at(-1);
      const resumesPendingHandoff =
        pendingHandoff !== undefined &&
        pendingHandoff.workerGenerationConfirmedAt === undefined &&
        event.successorDispatcherId === pendingHandoff.successorDispatcherId &&
        event.deliveryGeneration === pendingHandoff.deliveryGeneration;
      if (
        current.state !== "starting" && current.state !== "running" && current.state !== "blocked" ||
        authority === undefined ||
        event.successorDispatcherId === authority.dispatcherId ||
        event.deliveryGeneration !== authority.deliveryGeneration + 1 ||
        !Number.isSafeInteger(event.writerOwnership.pid) ||
        event.writerOwnership.pid < 1 ||
        event.writerOwnership.processStartToken.length === 0 ||
        pendingHandoff !== undefined &&
          pendingHandoff.workerGenerationConfirmedAt === undefined &&
          !resumesPendingHandoff
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        startDeliveryHandoffs: [
          ...current.startDeliveryHandoffs,
          {
            previousDispatcherId: authority.dispatcherId,
            previousDeliveryGeneration: authority.deliveryGeneration,
            successorDispatcherId: event.successorDispatcherId,
            deliveryGeneration: event.deliveryGeneration,
            authorityRevokedAt: event.timestamp,
            writerOwnership: { ...event.writerOwnership },
          },
        ],
        stateSeq: event.seq,
      });
    }

    case "start_delivery_generation_confirmed": {
      const handoff = current.startDeliveryHandoffs.at(-1);
      if (
        handoff === undefined ||
        handoff.workerGenerationConfirmedAt !== undefined ||
        event.dispatcherId !== handoff.successorDispatcherId ||
        event.deliveryGeneration !== handoff.deliveryGeneration ||
        (event.acceptanceState === "accepted") !== (event.acceptedInstruction !== undefined) ||
        event.acceptedInstruction !== undefined &&
          current.startInstructionDelivery !== undefined &&
          !isDeepStrictEqual(
            event.acceptedInstruction,
            startInstructionReference(current.startInstructionDelivery),
          )
      ) {
        throw new TransitionError("illegal_transition");
      }
      const confirmed = {
        ...handoff,
        workerGenerationConfirmedAt: event.timestamp,
        acceptanceState: event.acceptanceState,
      };
      return immutable({
        ...current,
        startDeliveryHandoffs: [...current.startDeliveryHandoffs.slice(0, -1), confirmed],
        stateSeq: event.seq,
      });
    }

    case "start_delivery_entered": {
      const authority = current.startDeliveryAuthority;
      if (
        current.state !== "starting" || authority === undefined ||
        current.startDeliveryEntry !== undefined &&
          current.startDeliveryEntry.deliveryGeneration === event.instruction.deliveryGeneration ||
        !isDeepStrictEqual(event.instruction, startInstructionReference(authority))
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        startDeliveryEntry: { ...event.instruction, enteredAt: event.timestamp },
        stateSeq: event.seq,
      });
    }

    case "start_instruction_dispatched": {
      const entry = current.startDeliveryEntry;
      if (
        current.state !== "starting" || entry === undefined ||
        current.startInstructionDelivery !== undefined &&
          current.startInstructionDelivery.deliveryGeneration === event.instruction.deliveryGeneration ||
        !isDeepStrictEqual(event.instruction, startInstructionReference(entry))
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        startInstructionDelivery: { ...event.instruction, dispatchedAt: event.timestamp },
        stateSeq: event.seq,
      });
    }

    case "start_instruction_accepted": {
      const deliveryEvidence = current.startInstructionDelivery ?? current.startDeliveryEntry;
      if (
        current.state !== "starting" || deliveryEvidence === undefined ||
        current.startInstructionAcceptance !== undefined &&
          current.startInstructionAcceptance.deliveryGeneration === event.instruction.deliveryGeneration ||
        event.proof !== "worker-durable-acceptance" ||
        !isDeepStrictEqual(event.instruction, startInstructionReference(deliveryEvidence))
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        startInstructionAcceptance: {
          ...event.instruction,
          acceptedAt: event.timestamp,
          proof: event.proof,
        },
        stateSeq: event.seq,
      });
    }

    case "start_instruction_acknowledged": {
      const acceptance = current.startInstructionAcceptance;
      if (
        current.state !== "starting" || acceptance === undefined ||
        current.startInstructionAcknowledgement !== undefined &&
          current.startInstructionAcknowledgement.deliveryGeneration === event.instruction.deliveryGeneration ||
        event.proof !== "authenticated-worker-acknowledgement" &&
          event.proof !== "authenticated-generation-acknowledgement" ||
        !isDeepStrictEqual(event.instruction, startInstructionReference(acceptance))
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        startInstructionAcknowledgement: {
          ...event.instruction,
          acknowledgedAt: event.timestamp,
          proof: event.proof,
        },
        state: "running",
        stateSeq: event.seq,
      });
    }

    case "resource_evidence_recorded":
      if (
        event.record.request.operationId !== current.operationId ||
        event.record.version !== (current.resourceEvidenceRecord?.version ?? 0) + 1 ||
        event.record.snapshot.acquisitionId.length === 0
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        resourceEvidenceRecord: structuredClone(event.record),
        stateSeq: event.seq,
      });

    case "worker_stop_confirmed":
      if (
        !current.workerLaunched ||
        current.state !== "starting" && current.state !== "running" && current.state !== "blocked" ||
        current.workerStopConfirmedAt !== undefined ||
        event.proof !== "worker-stop"
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        workerStopConfirmedAt: event.timestamp,
        stateSeq: event.seq,
      });

    case "operation_starting":
      if (current.state !== "queued") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, state: "starting", stateSeq: event.seq });

    case "worker_launched":
      if (current.state !== "starting" || current.workerLaunched) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, workerLaunched: true, stateSeq: event.seq });

    case "worker_identified":
      if (
        current.state !== "starting" && current.state !== "running" ||
        !current.workerLaunched ||
        current.workerIdentity !== undefined ||
        current.presentation === undefined ||
        !Number.isSafeInteger(event.workerIdentity.processId) ||
        event.workerIdentity.processId < 1 ||
        event.workerIdentity.processInstanceId.length === 0 ||
        event.workerIdentity.processStartToken.length === 0 ||
        event.workerIdentity.piSessionId.length === 0 ||
        event.workerIdentity.paneId !== current.presentation.paneId ||
        current.observedConfig !== undefined
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        workerIdentity: { ...event.workerIdentity },
        observedConfig: {
          model: event.observedConfig.model.state === "observed"
            ? { state: "observed", value: { ...event.observedConfig.model.value } }
            : { state: "unavailable" },
          thinkingLevel: { ...event.observedConfig.thinkingLevel },
          tools: event.observedConfig.tools.state === "observed"
            ? { state: "observed", value: [...event.observedConfig.tools.value] }
            : { state: "unavailable" },
          cwd: { ...event.observedConfig.cwd },
        },
        stateSeq: event.seq,
      });

    case "agent_settled":
      if (
        current.state !== "running" && current.state !== "blocked" ||
        current.agentRunEvidence !== undefined
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        agentRunEvidence: {
          usage: { ...event.evidence.usage },
          toolUses: event.evidence.toolUses.map((toolUse) => ({ ...toolUse })),
        },
        stateSeq: event.seq,
      });

    case "presentation_cleanup_failed":
      if (
        current.state !== "completed" ||
        current.presentation === undefined ||
        current.presentationCleanupFailure !== undefined
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        presentationCleanupFailure: event.reason,
        stateSeq: event.seq,
      });

    case "operation_blocked":
      if (current.state !== "running") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, state: "blocked", stateSeq: event.seq });

    case "operation_unblocked":
      if (current.state !== "blocked") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, state: "running", stateSeq: event.seq });

    case "result_acceptance_prepared":
      if (
        current.state !== "running" && current.state !== "blocked" ||
        current.resultAcceptanceReservation !== undefined ||
        current.result !== undefined ||
        event.reservation.operationId !== current.operationId ||
        event.reservation.preparedAt !== event.timestamp ||
        event.reservation.preparationId.length === 0 ||
        event.reservation.acceptanceRequestId.length === 0 ||
        !manifestReservationIsConsistent(event.reservation)
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        resultAcceptanceReservation: structuredClone(event.reservation),
        stateSeq: event.seq,
      });

    case "result_accepted": {
      const reservation = current.resultAcceptanceReservation;
      const evidence = event.preparationEvidence;
      if (
        current.state !== "running" && current.state !== "blocked" ||
        reservation === undefined ||
        current.result !== undefined ||
        event.acceptance.acceptedAt !== event.timestamp ||
        event.acceptance.eventSequenceNumber !== event.seq ||
        event.acceptance.operationId !== current.operationId ||
        event.acceptance.preparationId !== reservation.preparationId ||
        event.acceptance.acceptanceRequestId !== reservation.acceptanceRequestId ||
        event.acceptance.manifestFormatId !== reservation.manifest.formatId ||
        event.acceptance.manifestNormalizationId !== reservation.manifest.normalizationId ||
        event.acceptance.manifestDigest !== reservation.manifestDigest ||
        event.acceptance.requirementSetId !== reservation.requirementSetId ||
        event.acceptance.requirementsDigest !== reservation.requirementsDigest ||
        event.acceptance.bodyArtifactId !== reservation.manifest.bodyArtifactId ||
        !isDeepStrictEqual(event.acceptance.workProducts, reservation.manifest.workProducts) ||
        !isDeepStrictEqual(event.acceptance.artifactIds, reservation.artifactIds) ||
        !isDeepStrictEqual(event.acceptance.preparationEvidence, evidence) ||
        event.acceptance.acceptedArtifactRetentionMs !== evidence.acceptedArtifactRetentionMs ||
        event.acceptance.retentionPolicyDigest !== evidence.retentionPolicyDigest ||
        !preparationEvidenceMatchesReservation(evidence, reservation)
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        result: structuredClone(event.acceptance),
        resultAcceptedAt: event.timestamp,
        stateSeq: event.seq,
      });
    }

    case "self_settled":
      if (
        current.state !== "starting" &&
        current.state !== "running" &&
        current.state !== "blocked"
      ) {
        throw new TransitionError("illegal_transition");
      }
      if (event.outcome === "succeeded") {
        if (current.state === "starting") {
          throw new TransitionError("illegal_transition");
        }
        if (current.result === undefined) {
          throw new TransitionError("result_required_before_self_settlement");
        }
        return immutable({
          ...current,
          selfOutcome: "succeeded",
          state: hasUnsettledChildren(current)
            ? "draining_descendants"
            : "self_settled",
          stateSeq: event.seq,
        });
      }
      return immutable({
        ...current,
        failureReason: event.reason,
        selfOutcome: "failed",
        state: hasUnsettledChildren(current)
          ? "draining_descendants"
          : "self_settled",
        stateSeq: event.seq,
      });

    case "cancellation_requested":
      if (event.cancellationEpoch <= current.cancellationEpoch) {
        throw new TransitionError("stale_cancellation_epoch");
      }
      return immutable({
        ...current,
        state: "cancelling",
        stateSeq: event.seq,
        spawnFrozen: true,
        cancellationEpoch: event.cancellationEpoch,
      });

    case "cancel_dispatched":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch
      ) {
        throw new TransitionError("cancellation_epoch_mismatch");
      }
      return immutable({ ...current, stateSeq: event.seq });

    case "cancel_acknowledged":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch
      ) {
        throw new TransitionError("cancellation_epoch_mismatch");
      }
      return immutable({
        ...current,
        workerStopConfirmedAt: current.workerStopConfirmedAt ?? event.timestamp,
        stateSeq: event.seq,
      });

    case "operation_cancelled":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch
      ) {
        throw new TransitionError("cancellation_epoch_mismatch");
      }
      return immutable({ ...current, state: "cancelled", stateSeq: event.seq });

    case "operation_unknown":
      if (event.reason === "cancel-unproven") {
        if (
          current.state !== "cancelling" ||
          event.cancellationEpoch !== current.cancellationEpoch
        ) {
          throw new TransitionError("cancellation_epoch_mismatch");
        }
      } else if (
        current.state !== "starting" &&
        current.state !== "running" &&
        current.state !== "blocked"
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        state: "unknown",
        stateSeq: event.seq,
        terminalReason: event.reason,
        ...(event.reason === "liveness-unproven" && event.failureReason !== undefined
          ? { failureReason: event.failureReason }
          : {}),
      });

    case "operation_completed":
      if (current.state !== "self_settled" || current.selfOutcome !== "succeeded") {
        throw new TransitionError(
          "successful_settlement_required_before_completion",
        );
      }
      if (hasUnsettledChildren(current)) {
        throw new TransitionError("descendants_must_be_settled");
      }
      if (current.descendantFailure) {
        throw new TransitionError("descendant_failure_prevents_completion");
      }
      if (current.result === undefined) {
        throw new TransitionError("result_required_before_self_settlement");
      }
      return immutable({ ...current, state: "completed", stateSeq: event.seq });

    case "operation_failed":
      if (
        current.state !== "self_settled" ||
        (current.selfOutcome !== "failed" && !current.descendantFailure)
      ) {
        throw new TransitionError("failed_settlement_required_before_failure");
      }
      if (hasUnsettledChildren(current)) {
        throw new TransitionError("descendants_must_be_settled");
      }
      if (
        current.selfOutcome === "failed" &&
        current.failureReason !== event.reason
      ) {
        throw new TransitionError("failure_reason_mismatch");
      }
      if (
        current.selfOutcome === "succeeded" &&
        (!current.descendantFailure || event.reason !== "descendant_failed")
      ) {
        throw new TransitionError("failure_reason_mismatch");
      }
      return immutable({
        ...current,
        state: "failed",
        stateSeq: event.seq,
        terminalReason: event.reason,
      });
  }
}

export function replayOperation(
  events: ReadonlyArray<OperationEvent>,
): Operation | undefined {
  const eventIds = new Set<string>();
  let operation: Operation | undefined;
  for (const event of events) {
    if (!Number.isFinite(Date.parse(event.timestamp))) {
      throw new TransitionError("illegal_transition");
    }
    if (eventIds.has(event.eventId)) {
      throw new TransitionError("duplicate_event");
    }
    operation = reduceOperation(operation, event);
    eventIds.add(event.eventId);
  }
  return operation;
}
