import { isDeepStrictEqual } from "node:util";

import {
  EVENT_SCHEMA_VERSION,
  OPERATION_AUTHORITY,
  RUNTIME_ACTOR_ID,
} from "./model.js";
import type { Operation, OperationEvent } from "./model.js";
import { acceptedResultIsConsistent } from "../result-acceptance-transaction.js";
import {
  automaticStartScopeDigest,
  startInstructionReference,
} from "../start-instruction.js";
import type { StartInstructionReference } from "../types.js";

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
  return deepFreeze(operation);
}

function sameStringArray(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.length === right.length &&
        left.every((value, index) => value === right[index]);
}

function validInitialConfiguration(
  event: Extract<OperationEvent, { readonly type: "operation_requested" }>
): boolean {
  const requested = event.requestedConfig;
  const effective = event.effectiveConfig;
  const candidate = effective.modelPolicy.candidates[0];
  const attempted = effective.modelPolicy.attempted[0];
  return (
    requested.model?.provider === event.task.model?.provider &&
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
    attempted.id === effective.model.id &&
    Number.isSafeInteger(event.maxResultByteCount) &&
    event.maxResultByteCount > 0
  );
}

function validStartInstructionReference(
  operation: Operation,
  instruction: Readonly<StartInstructionReference>
): boolean {
  return (
    operation.workerIdentity !== undefined &&
    instruction.dispatcherId.length > 0 &&
    instruction.workerProcessInstanceId ===
      operation.workerIdentity.processInstanceId &&
    instruction.receiptDigest === automaticStartScopeDigest(operation) &&
    Number.isSafeInteger(instruction.deliveryGeneration) &&
    instruction.deliveryGeneration >= 1
  );
}

function terminal(operation: Operation): boolean {
  return (
    operation.state === "completed" ||
    operation.state === "failed" ||
    operation.state === "cancelled" ||
    operation.state === "unknown"
  );
}

/** Successful and stop-confirmed cancelled Operations may close their owned workspace. */
export function presentationCleanupEligible(operation: Operation): boolean {
  return (
    operation.workerStopConfirmedAt !== undefined &&
    ((operation.state === "completed" && operation.result !== undefined) ||
      operation.state === "cancelled")
  );
}

function validateEnvelope(event: OperationEvent): void {
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION)
    throw new TransitionError("unsupported_schema_version");
  if (event.actorId !== RUNTIME_ACTOR_ID)
    throw new TransitionError("actor_mismatch");
  if (event.authority !== OPERATION_AUTHORITY)
    throw new TransitionError("authority_mismatch");
  if (event.operationId.length === 0)
    throw new TransitionError("invalid_operation_id");
  if (event.eventId.length === 0) throw new TransitionError("invalid_event_id");
  if (!Number.isSafeInteger(event.seq) || event.seq < 1)
    throw new TransitionError("unexpected_sequence");
}

export function reduceOperation(
  current: Operation | undefined,
  event: OperationEvent
): Operation {
  validateEnvelope(event);

  if (current === undefined) {
    if (event.type !== "operation_requested")
      throw new TransitionError("operation_required");
    if (event.seq !== 1) throw new TransitionError("unexpected_sequence");
    if (!validInitialConfiguration(event))
      throw new TransitionError("illegal_transition");
    return immutable({
      operationId: event.operationId,
      state: "queued",
      stateSeq: event.seq,
      workerLaunched: false,
      task: structuredClone(event.task),
      requestedConfig: structuredClone(event.requestedConfig),
      effectiveConfig: structuredClone(event.effectiveConfig),
      maxResultByteCount: event.maxResultByteCount,
      startDeliveryHandoffs: [],
      cancellationEpoch: 0,
    });
  }

  if (event.type === "operation_requested")
    throw new TransitionError("operation_already_exists");
  if (event.operationId !== current.operationId)
    throw new TransitionError("operation_id_mismatch");
  if (event.seq !== current.stateSeq + 1)
    throw new TransitionError("unexpected_sequence");
  const cleanupEvent =
    event.type === "presentation_cleanup_started" ||
    event.type === "presentation_cleanup_completed" ||
    event.type === "presentation_cleanup_unconfirmed";
  if (terminal(current) && !cleanupEvent)
    throw new TransitionError("terminal_state_immutable");

  switch (event.type) {
    case "presentation_owned":
      if (
        current.state !== "queued" ||
        current.presentation !== undefined ||
        event.presentation.kind !== "herdr_workspace" ||
        event.presentation.workspaceId.length === 0 ||
        event.presentation.paneId.length === 0 ||
        event.presentation.ownedByPions !== true
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        presentation: { ...event.presentation },
        stateSeq: event.seq,
      });

    case "operation_starting":
      if (current.state !== "queued" || current.presentation === undefined)
        throw new TransitionError("illegal_transition");
      return immutable({ ...current, state: "starting", stateSeq: event.seq });

    case "worker_launched":
      if (current.state !== "starting" || current.workerLaunched)
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        workerLaunched: true,
        stateSeq: event.seq,
      });

    case "worker_identified":
      if (
        (current.state !== "starting" && current.state !== "running") ||
        !current.workerLaunched ||
        current.workerIdentity !== undefined ||
        current.presentation === undefined ||
        !Number.isSafeInteger(event.workerIdentity.processId) ||
        event.workerIdentity.processId < 1 ||
        event.workerIdentity.processInstanceId.length === 0 ||
        event.workerIdentity.processStartToken.length === 0 ||
        event.workerIdentity.piSessionId.length === 0 ||
        event.workerIdentity.paneId !== current.presentation.paneId
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        workerIdentity: structuredClone(event.workerIdentity),
        observedConfig: structuredClone(event.observedConfig),
        stateSeq: event.seq,
      });

    case "start_delivery_authority_acquired": {
      const handoff = current.startDeliveryHandoffs.at(-1);
      const replacesRevoked =
        handoff?.workerGenerationConfirmedAt !== undefined &&
        handoff.acceptanceState === "not_accepted" &&
        event.instruction.dispatcherId === handoff.successorDispatcherId &&
        event.instruction.deliveryGeneration === handoff.deliveryGeneration;
      if (
        (current.state !== "starting" && current.state !== "running") ||
        !current.workerLaunched ||
        (current.startDeliveryAuthority !== undefined && !replacesRevoked) ||
        !validStartInstructionReference(current, event.instruction)
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        startDeliveryAuthority: {
          ...event.instruction,
          acquiredAt: event.timestamp,
        },
        stateSeq: event.seq,
      });
    }

    case "start_delivery_authority_revoked": {
      const authority = current.startDeliveryAuthority;
      const pending = current.startDeliveryHandoffs.at(-1);
      const resumes =
        pending !== undefined &&
        pending.workerGenerationConfirmedAt === undefined &&
        pending.successorDispatcherId === event.successorDispatcherId &&
        pending.deliveryGeneration === event.deliveryGeneration;
      if (
        (current.state !== "starting" && current.state !== "running") ||
        authority === undefined ||
        event.successorDispatcherId === authority.dispatcherId ||
        event.deliveryGeneration !== authority.deliveryGeneration + 1 ||
        (pending !== undefined &&
          pending.workerGenerationConfirmedAt === undefined &&
          !resumes)
      )
        throw new TransitionError("illegal_transition");
      return resumes
        ? immutable({ ...current, stateSeq: event.seq })
        : immutable({
            ...current,
            startDeliveryHandoffs: [
              ...current.startDeliveryHandoffs,
              {
                previousDispatcherId: authority.dispatcherId,
                previousDeliveryGeneration: authority.deliveryGeneration,
                successorDispatcherId: event.successorDispatcherId,
                deliveryGeneration: event.deliveryGeneration,
                authorityRevokedAt: event.timestamp,
              },
            ],
            stateSeq: event.seq,
          });
    }

    case "start_delivery_generation_confirmed": {
      const handoff = current.startDeliveryHandoffs.at(-1);
      if (
        (current.state !== "starting" && current.state !== "running") ||
        handoff === undefined ||
        handoff.workerGenerationConfirmedAt !== undefined ||
        event.dispatcherId !== handoff.successorDispatcherId ||
        event.deliveryGeneration !== handoff.deliveryGeneration ||
        (event.acceptanceState === "accepted") !==
          (event.acceptedInstruction !== undefined) ||
        (event.acceptedInstruction !== undefined &&
          !validStartInstructionReference(current, event.acceptedInstruction))
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        startDeliveryHandoffs: [
          ...current.startDeliveryHandoffs.slice(0, -1),
          {
            ...handoff,
            workerGenerationConfirmedAt: event.timestamp,
            acceptanceState: event.acceptanceState,
          },
        ],
        stateSeq: event.seq,
      });
    }

    case "start_delivery_entered":
      if (
        current.state !== "starting" ||
        current.startDeliveryAuthority === undefined ||
        !isDeepStrictEqual(
          event.instruction,
          startInstructionReference(current.startDeliveryAuthority)
        ) ||
        current.startDeliveryEntry?.deliveryGeneration ===
          event.instruction.deliveryGeneration
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        startDeliveryEntry: {
          ...event.instruction,
          enteredAt: event.timestamp,
        },
        stateSeq: event.seq,
      });

    case "start_instruction_dispatched":
      if (
        current.state !== "starting" ||
        current.startDeliveryEntry === undefined ||
        !isDeepStrictEqual(
          event.instruction,
          startInstructionReference(current.startDeliveryEntry)
        ) ||
        current.startInstructionDelivery?.deliveryGeneration ===
          event.instruction.deliveryGeneration
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        startInstructionDelivery: {
          ...event.instruction,
          dispatchedAt: event.timestamp,
        },
        stateSeq: event.seq,
      });

    case "start_instruction_accepted": {
      const delivery =
        current.startInstructionDelivery ?? current.startDeliveryEntry;
      if (
        current.state !== "starting" ||
        delivery === undefined ||
        event.proof !== "worker-durable-acceptance" ||
        !isDeepStrictEqual(
          event.instruction,
          startInstructionReference(delivery)
        ) ||
        current.startInstructionAcceptance?.deliveryGeneration ===
          event.instruction.deliveryGeneration
      )
        throw new TransitionError("illegal_transition");
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

    case "start_instruction_acknowledged":
      if (
        current.state !== "starting" ||
        current.startInstructionAcceptance === undefined ||
        !isDeepStrictEqual(
          event.instruction,
          startInstructionReference(current.startInstructionAcceptance)
        ) ||
        current.startInstructionAcknowledgement?.deliveryGeneration ===
          event.instruction.deliveryGeneration
      )
        throw new TransitionError("illegal_transition");
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

    case "result_accepted":
      if (
        current.state !== "running" ||
        current.result !== undefined ||
        event.acceptance.acceptedAt !== event.timestamp ||
        event.acceptance.eventSequenceNumber !== event.seq ||
        event.acceptance.operationId !== current.operationId ||
        !acceptedResultIsConsistent(
          event.acceptance,
          current.maxResultByteCount
        )
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        result: structuredClone(event.acceptance),
        stateSeq: event.seq,
      });

    case "worker_stop_confirmed":
      if (
        !current.workerLaunched ||
        (current.state !== "starting" && current.state !== "running") ||
        current.workerStopConfirmedAt !== undefined ||
        event.proof !== "worker-stop"
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        workerStopConfirmedAt: event.timestamp,
        stateSeq: event.seq,
      });

    case "agent_settled":
      if (current.state !== "running" || current.agentRunEvidence !== undefined)
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        agentRunEvidence: structuredClone(event.evidence),
        stateSeq: event.seq,
      });

    case "operation_completed":
      if (
        current.state !== "running" ||
        current.result === undefined ||
        current.workerStopConfirmedAt === undefined
      )
        throw new TransitionError("illegal_transition");
      return immutable({ ...current, state: "completed", stateSeq: event.seq });

    case "operation_failed":
      if (current.state !== "starting" && current.state !== "running")
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        state: "failed",
        failureReason: event.reason,
        terminalReason: event.reason,
        stateSeq: event.seq,
      });

    case "cancellation_requested":
      if (
        (current.state !== "queued" &&
          current.state !== "starting" &&
          current.state !== "running") ||
        event.cancellationEpoch <= current.cancellationEpoch
      )
        throw new TransitionError("stale_cancellation_epoch");
      return immutable({
        ...current,
        state: "cancelling",
        cancellationEpoch: event.cancellationEpoch,
        stateSeq: event.seq,
      });

    case "cancel_dispatched":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch
      )
        throw new TransitionError("cancellation_epoch_mismatch");
      return immutable({ ...current, stateSeq: event.seq });

    case "cancel_acknowledged":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch ||
        event.proof !== "worker-stop"
      )
        throw new TransitionError("cancellation_epoch_mismatch");
      return immutable({
        ...current,
        workerStopConfirmedAt: current.workerStopConfirmedAt ?? event.timestamp,
        stateSeq: event.seq,
      });

    case "operation_cancelled":
      if (
        current.state !== "cancelling" ||
        event.cancellationEpoch !== current.cancellationEpoch ||
        current.workerStopConfirmedAt === undefined
      )
        throw new TransitionError("cancellation_epoch_mismatch");
      return immutable({ ...current, state: "cancelled", stateSeq: event.seq });

    case "operation_unknown":
      if (event.reason === "cancel-unproven") {
        if (
          current.state !== "cancelling" ||
          event.cancellationEpoch !== current.cancellationEpoch
        )
          throw new TransitionError("cancellation_epoch_mismatch");
      } else if (
        current.state !== "queued" &&
        current.state !== "starting" &&
        current.state !== "running"
      ) {
        throw new TransitionError("illegal_transition");
      }
      return immutable({
        ...current,
        state: "unknown",
        terminalReason: event.reason,
        stateSeq: event.seq,
      });

    case "presentation_cleanup_started":
      if (
        !presentationCleanupEligible(current) ||
        current.presentation === undefined ||
        current.presentation.workspaceId !== event.workspaceId ||
        current.presentationCleanup !== undefined ||
        event.cleanupId.length === 0
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        presentationCleanup: {
          cleanupId: event.cleanupId,
          workspaceId: event.workspaceId,
          state: "pending",
          startedAt: event.timestamp,
        },
        stateSeq: event.seq,
      });

    case "presentation_cleanup_completed": {
      const cleanup = current.presentationCleanup;
      if (
        !presentationCleanupEligible(current) ||
        cleanup?.state !== "pending" ||
        cleanup.cleanupId !== event.cleanupId ||
        cleanup.workspaceId !== event.workspaceId
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        presentationCleanup: {
          ...cleanup,
          state: "completed",
          finishedAt: event.timestamp,
        },
        stateSeq: event.seq,
      });
    }

    case "presentation_cleanup_unconfirmed": {
      const cleanup = current.presentationCleanup;
      if (
        !presentationCleanupEligible(current) ||
        cleanup?.state !== "pending" ||
        cleanup.cleanupId !== event.cleanupId ||
        cleanup.workspaceId !== event.workspaceId
      )
        throw new TransitionError("illegal_transition");
      return immutable({
        ...current,
        presentationCleanup: {
          ...cleanup,
          state: "unconfirmed",
          finishedAt: event.timestamp,
          diagnostic: event.reason,
        },
        stateSeq: event.seq,
      });
    }
  }
}

export function replayOperation(
  events: ReadonlyArray<OperationEvent>
): Operation | undefined {
  const eventIds = new Set<string>();
  let operation: Operation | undefined;
  for (const event of events) {
    if (!Number.isFinite(Date.parse(event.timestamp)))
      throw new TransitionError("illegal_transition");
    if (eventIds.has(event.eventId))
      throw new TransitionError("duplicate_event");
    operation = reduceOperation(operation, event);
    eventIds.add(event.eventId);
  }
  return operation;
}
