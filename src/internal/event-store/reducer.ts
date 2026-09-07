import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./model.js";
import type { Operation, OperationEvent } from "./model.js";

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
  if (operation.agentRunEvidence !== undefined) {
    Object.freeze(operation.agentRunEvidence.usage);
    operation.agentRunEvidence.toolUses.forEach(Object.freeze);
    Object.freeze(operation.agentRunEvidence.toolUses);
    Object.freeze(operation.agentRunEvidence);
  }
  Object.freeze(operation.childOperationIds);
  Object.freeze(operation.settledChildOperationIds);
  if (operation.result !== undefined) Object.freeze(operation.result);
  if (operation.resultConflict !== undefined) Object.freeze(operation.resultConflict);
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

function hasUnsettledChildren(operation: Operation): boolean {
  return (
    operation.childOperationIds.length !==
    operation.settledChildOperationIds.length
  );
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
    if (!validInitialConfiguration(event)) {
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
    event.type !== "result_conflict_recorded" &&
    event.type !== "presentation_cleanup_failed" &&
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

    case "operation_started":
      if (current.state !== "starting" || !current.workerLaunched) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, state: "running", stateSeq: event.seq });

    case "worker_identified":
      if (
        current.state !== "running" ||
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

    case "result_persisted":
      if (current.state !== "running" && current.state !== "blocked") {
        throw new TransitionError("illegal_transition");
      }
      return immutable({ ...current, result: { ...event.result }, stateSeq: event.seq });

    case "result_conflict_recorded":
      if (
        current.result === undefined ||
        current.resultConflict !== undefined ||
        event.conflict.acceptedDigest !== current.result.digest ||
        event.conflict.conflictingDigest === current.result.digest
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        resultConflict: { ...event.conflict },
        stateSeq: event.seq,
      });

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
      return immutable({ ...current, stateSeq: event.seq });

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
    if (eventIds.has(event.eventId)) {
      throw new TransitionError("duplicate_event");
    }
    operation = reduceOperation(operation, event);
    eventIds.add(event.eventId);
  }
  return operation;
}
