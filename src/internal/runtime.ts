import { isDeepStrictEqual } from "node:util";

import { Cause, Effect, Exit, Schema } from "effect";

import { RUNTIME_ACTOR_ID } from "./event-store/index.js";
import type {
  Operation,
  OperationIntent,
  OperationLineage,
  OperationSnapshot as StoredOperationSnapshot,
  StoreError,
} from "./event-store/index.js";
import { makeResultAcceptance } from "./result-acceptance.js";
import {
  resolveWorkProductRequirements,
  resultAcceptanceManifestDocument,
} from "./result-acceptance-manifest.js";
import { resultAcceptanceRetentionPolicy } from "./result-acceptance-transaction.js";
import { permissionManifestDocument, validateWorkspaceScope } from "./resource-proof.js";
import {
  DEFAULT_WORKER_PROFILE_POLICY,
  RequestedWorkerConfigSchema,
  requestedWorkerConfig,
  resolveWorkerConfig,
} from "./worker-configuration.js";
import type {
  WorkerCancellationEvidence,
  RuntimeServices,
  Worker,
} from "./services.js";
import type { StartInstruction } from "./worker-protocol.js";
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
  StartAuthorizationAuthenticationError,
  ResourceProofRejectedError,
  ResultRetrievalError,
  SpawnRejectedError,
  WorkerConfigurationError,
} from "../public.js";
import type {
  CancellationResult,
  CancelOptions,
  OperationFailureReason,
  OperationHandle,
  OperationReader,
  OperationSnapshot as PublicOperationSnapshot,
  Result,
  Runtime,
  SpawnOptions,
  StartAuthorizationDecisionOutcome,
  StartAuthorizationDecisionRejectionReason,
  StartAuthorizationDecisionRequest,
  StartupReceiptPolicy,
  TaskSpec,
  WorkerProfilePolicy,
} from "../public.js";

const MAX_DEPTH = 2;
const MAX_CHILDREN_PER_OPERATION = 3;
const MAX_LIVE_DESCENDANTS_PER_ROOT = 4;
const DESCENDANT_FAILURE_POLICY = "fail_parent" as const;

const TaskSpecSchema = Schema.Struct({
  promptRef: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
  ...RequestedWorkerConfigSchema.fields,
});

class RuntimeError extends Error {
  override readonly name = "RuntimeError";

  constructor(readonly code: "operation_failed", message: string) {
    super(message);
  }
}

class StartRevalidationError extends Error {
  constructor(readonly reason: "timed_out" | "invalidated") {
    super(`Start authorization ${reason}`);
  }
}

interface OperationRecord {
  readonly operationId: string;
  readonly terminalPromise: Promise<Result>;
  readonly resolveTerminal: (result: Result) => void;
  readonly rejectTerminal: (error: unknown) => void;
  pendingAdmissions: number;
  finalizing?: Promise<void>;
  successfulExitConfirmed?: true;
  executionRejected?: true;
  worker?: Worker;
}

function deferredResult(): {
  readonly promise: Promise<Result>;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function isTerminal(operation: Operation): boolean {
  return operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" || operation.state === "unknown";
}

export function makeRuntime(services: RuntimeServices): Runtime {
  const artifactServices = {
    artifacts: services.artifacts,
    credential: services.artifactCredential,
    synchronizeClock: services.synchronizeArtifactClock,
  };
  const resultAcceptance = makeResultAcceptance({
    store: services.store,
    artifacts: artifactServices.artifacts,
    artifactCredential: artifactServices.credential,
    clock: services.clock,
    ...(artifactServices.synchronizeClock === undefined
      ? {}
      : { synchronizeArtifactClock: artifactServices.synchronizeClock }),
  });
  const records = new Map<string, OperationRecord>();
  const spawnsByParent = new Map<
    string | undefined,
    Map<string, Promise<OperationHandle>>
  >();
  const cancellations = new Map<string, Promise<CancellationResult>>();
  const cancellingSubtreeRoots = new Set<string>();
  const startGateWaiters = new Map<string, {
    readonly resolve: (instruction: Readonly<StartInstruction>) => void;
    readonly reject: (error: unknown) => void;
  }>();
  const authorizationMutationTails = new Map<string, Promise<void>>();
  const authorizationMonotonicDeadlines = new Map<string, number>();
  let treeMutationTail = Promise.resolve();

  const serializeTreeMutation = async <Value>(
    mutation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = treeMutationTail;
    let release!: () => void;
    treeMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  };

  const serializeAuthorizationMutation = async <Value>(
    operationId: string,
    mutation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = authorizationMutationTails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    authorizationMutationTails.set(operationId, current);
    await previous;
    try {
      return await mutation();
    } finally {
      release();
      if (authorizationMutationTails.get(operationId) === current) {
        authorizationMutationTails.delete(operationId);
      }
    }
  };

  const persistenceError = (
    operationId: string,
    error: StoreError,
  ): OperationPersistenceError =>
    new OperationPersistenceError(
      operationId,
      error.code === "not_found" ? "corrupt_record" : error.code,
    );

  const advanceOperation = (
    operationId: string,
    intent: OperationIntent,
  ): Effect.Effect<Operation, OperationPersistenceError> =>
    services.store.advance(operationId, intent).pipe(
      Effect.map((snapshot) => snapshot.operation),
      Effect.mapError((error) => persistenceError(operationId, error)),
    );

  const advanceAndProject = (
    operationId: string,
    intent: OperationIntent,
  ): Effect.Effect<void, OperationPersistenceError> =>
    advanceOperation(operationId, intent).pipe(
      Effect.tap((operation) => project(operation)),
      Effect.asVoid,
    );

  const publicSnapshot = (
    stored: Readonly<StoredOperationSnapshot>,
  ): Readonly<PublicOperationSnapshot> => {
    const operation = stored.operation;
    const resultAcceptance = operation.result === undefined
      ? undefined
      : {
          acceptedAt: operation.result.acceptedAt,
          acceptanceId: operation.result.acceptanceId,
          manifestDigest: operation.result.manifestDigest,
          eventSequenceNumber: operation.result.eventSequenceNumber,
        };
    return Object.freeze({
      operationId: operation.operationId,
      version: Object.freeze({ ...stored.version }),
      state: operation.state,
      ...(operation.failureReason === undefined
        ? {}
        : { failureReason: operation.failureReason }),
      startAuthorization: Object.freeze({
        timing: Object.freeze({
          ...operation.startAuthorizationTiming,
          authorizedSubjectIds: Object.freeze([...operation.startAuthorizationTiming.authorizedSubjectIds]),
        }),
        gate: operation.startGate,
        ...(operation.startupReceipt === undefined ? {} : { receipt: operation.startupReceipt }),
        ...(operation.startAuthorizationDecision === undefined
          ? {}
          : { decision: operation.startAuthorizationDecision }),
        rejectedDecisions: Object.freeze(operation.rejectedStartAuthorizationDecisions),
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
        : { startInstructionAcknowledgement: operation.startInstructionAcknowledgement }),
      startDeliveryHandoffs: operation.startDeliveryHandoffs,
      ...(resultAcceptance === undefined
        ? {}
        : { resultAcceptance: Object.freeze(resultAcceptance) }),
      ...(operation.workerStopConfirmedAt === undefined
        ? {}
        : { stopConfirmation: Object.freeze({ confirmedAt: operation.workerStopConfirmedAt, proof: "worker-stop" as const }) }),
      cleanupDiagnostics: Object.freeze(operation.presentationCleanupFailure === undefined
        ? []
        : [Object.freeze({ code: operation.presentationCleanupFailure })]),
      ...(operation.resourceEvidenceRecord === undefined
        ? {}
        : {
            resourceEvidence: Object.freeze({
              version: operation.resourceEvidenceRecord.version,
              evidence: operation.resourceEvidenceRecord.snapshot,
            }),
          }),
    });
  };

  const readStoredSnapshot = (operationId: string) =>
    runEffect(services.store.read(operationId).pipe(
      Effect.mapError((error) => persistenceError(operationId, error)),
    ));

  const getOperation = (operationId: string) =>
    services.store.read(operationId).pipe(
      Effect.map((snapshot) => snapshot.operation),
      Effect.mapError((error) => persistenceError(operationId, error)),
    );

  const project = (operation: Operation): Effect.Effect<void> =>
    Effect.catchAllCause(services.presentation.project(operation), () => Effect.void);

  const readResult = (
    operationId: string,
  ): Effect.Effect<Result, OperationPersistenceError | ResultRetrievalError> =>
    Effect.gen(function* () {
      const snapshot = yield* services.store.read(operationId).pipe(
        Effect.mapError((error) => persistenceError(operationId, error)),
      );
      const accepted = snapshot.operation.result;
      if (accepted === undefined) {
        return yield* Effect.fail(new OperationPersistenceError(operationId, "incomplete_record"));
      }
      const manifest = resultAcceptanceManifestDocument({
        formatId: accepted.manifestFormatId,
        normalizationId: accepted.manifestNormalizationId,
        bodyArtifactId: accepted.bodyArtifactId,
        requirementSetId: accepted.requirementSetId,
        requirementSetDigest: accepted.requirementsDigest,
        workProducts: accepted.workProducts,
      });
      if (manifest.digest !== accepted.manifestDigest) {
        return yield* Effect.fail(new ResultRetrievalError(operationId, "stored_artifact_corrupt"));
      }
      const retrieved = yield* Effect.tryPromise({
        try: () => artifactServices.artifacts.retrieve(
          artifactServices.credential,
          accepted.bodyArtifactId,
        ),
        catch: () => new ResultRetrievalError(operationId, "storage_inspection_unavailable"),
      });
      if (retrieved.kind !== "retrieved") {
        return yield* Effect.fail(new ResultRetrievalError(operationId, retrieved.reason));
      }
      const bytes = Buffer.from(retrieved.bytes);
      return {
        body: bytes.toString("utf8"),
        byteCount: bytes.byteLength,
        digest: retrieved.artifact.digest,
      } as Result;
    });

  const runEffect = async <Value>(effect: Effect.Effect<Value, unknown>): Promise<Value> => {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    throw new Error(Cause.pretty(exit.cause));
  };

  const settleTerminal = async (
    record: OperationRecord,
    operation: Operation,
  ): Promise<void> => {
    await runEffect(project(operation));
    authorizationMonotonicDeadlines.delete(record.operationId);

    if (operation.state === "completed") {
      if (record.successfulExitConfirmed === true) {
        const cleanupFailed = await runEffect(
          services.presentation.closeOwnedPane(operation).pipe(
            Effect.as(false),
            Effect.catchAllCause(() => Effect.succeed(true)),
          ),
        );
        if (cleanupFailed) {
          await runEffect(
            advanceOperation(record.operationId, {
              type: "presentation_cleanup_failed",
              reason: "pane_close_failed",
            }).pipe(Effect.catchAllCause(() => Effect.void)),
          );
        }
      }
      const result = await runEffect(readResult(record.operationId));
      record.resolveTerminal(result);
    } else if (operation.state === "cancelled") {
      record.rejectTerminal(new OperationCancelledError(record.operationId));
    } else if (operation.state === "unknown") {
      record.rejectTerminal(
        new OperationUnknownError(
          record.operationId,
          operation.terminalReason === "liveness-unproven"
            ? "liveness-unproven"
            : "cancel-unproven",
        ),
      );
    } else {
      const reason =
        operation.terminalReason === "worker_start_failed" ||
        operation.terminalReason === "worker_protocol_failed" ||
        operation.terminalReason === "process-exited-without-result" ||
        operation.terminalReason === "agent_failed" ||
        operation.terminalReason === "model_mismatch" ||
        operation.terminalReason === "thinking_level_mismatch" ||
        operation.terminalReason === "model_not_found" ||
        operation.terminalReason === "model_auth_unavailable" ||
        operation.terminalReason === "unsupported_capability" ||
        operation.terminalReason === "tool_policy_violation" ||
        operation.terminalReason === "resource_proof_rejected" ||
        operation.terminalReason === "start_rejected" ||
        operation.terminalReason === "start_authorization_timed_out" ||
        operation.terminalReason === "start_authorization_invalidated" ||
        operation.terminalReason === "descendant_failed"
          ? operation.terminalReason
          : "descendant_failed";
      record.rejectTerminal(new OperationFailedError(record.operationId, reason));
    }

    const parentId = operation.lineage.parentOperationId;
    if (parentId === undefined) return;
    const parent = records.get(parentId);
    if (parent === undefined) return;
    const parentOperation = await runEffect(getOperation(parentId));
    if (isTerminal(parentOperation)) return;

    const parentAfterChild = await runEffect(
      advanceOperation(parentId, {
        type: "child_settled",
        childOperationId: record.operationId,
        outcome: operation.state === "completed" ? "succeeded" : "failed",
      }),
    );
    await runEffect(project(parentAfterChild));
    await tryFinalize(parent);
  };

  const finalizeOnce = async (record: OperationRecord): Promise<void> => {
    if (record.pendingAdmissions > 0) return;
    const operation = await runEffect(getOperation(record.operationId));
    if (isTerminal(operation) || operation.selfOutcome === undefined) return;
    if (
      operation.childOperationIds.length !==
      operation.settledChildOperationIds.length
    ) {
      return;
    }

    const failureReason: OperationFailureReason | undefined =
      operation.selfOutcome === "failed"
        ? operation.failureReason
        : operation.descendantFailure &&
            DESCENDANT_FAILURE_POLICY === "fail_parent"
          ? "descendant_failed"
          : undefined;
    const terminal = await runEffect(
      advanceOperation(
        record.operationId,
        failureReason === undefined
          ? { type: "operation_completed" }
          : { type: "operation_failed", reason: failureReason },
      ),
    );
    await settleTerminal(record, terminal);
  };

  const tryFinalize = async (record: OperationRecord): Promise<void> => {
    while (true) {
      const inProgress = record.finalizing;
      if (inProgress !== undefined) {
        await inProgress;
        continue;
      }

      const finalizing = finalizeOnce(record);
      record.finalizing = finalizing;
      try {
        await finalizing;
      } finally {
        delete record.finalizing;
      }
      return;
    }
  };

  const resolvedStartAuthorization = (profile: Readonly<WorkerProfilePolicy>) => {
    const configured = profile.startAuthorization;
    if (configured.policy === "disabled") {
      return {
        configuredPolicy: "disabled" as const,
        policy: "disabled" as const,
        windowMs: 0,
        authorizedSubjectIds: [],
      };
    }
    if (configured.policy === "optional" && configured.resolution === "disabled") {
      return {
        configuredPolicy: "optional" as const,
        policy: "disabled" as const,
        windowMs: 0,
        authorizedSubjectIds: [],
      };
    }
    return {
      configuredPolicy: configured.policy,
      policy: "required" as const,
      windowMs: configured.windowMs,
      authorizedSubjectIds: [...configured.authorizedSubjectIds],
      receipt: structuredClone(configured.receipt),
    };
  };

  const terminateBeforeStart = async (
    record: OperationRecord,
    reason: OperationFailureReason,
  ): Promise<void> => {
    const current = await runEffect(getOperation(record.operationId));
    const stopped = record.worker === undefined
      ? undefined
      : await runEffect(record.worker.cancel(current.cancellationEpoch + 1, 1_000)).catch(() => undefined);
    const waiter = startGateWaiters.get(record.operationId);
    startGateWaiters.delete(record.operationId);
    if (stopped === undefined) {
      const unknown = await runEffect(advanceOperation(record.operationId, {
        type: "operation_unknown",
        reason: "liveness-unproven",
        ...(reason === "start_rejected" || reason === "start_authorization_timed_out" ||
            reason === "start_authorization_invalidated"
          ? { failureReason: reason }
          : {}),
      }));
      await settleTerminal(record, unknown);
      waiter?.reject(new Error(reason));
      return;
    }
    let operation = await runEffect(advanceOperation(record.operationId, {
      type: "worker_stop_confirmed",
      proof: stopped.proof,
    }));
    await runEffect(project(operation));
    await services.resourceProofController?.safetyCleanup(record.operationId).catch(() => undefined);
    operation = await runEffect(advanceOperation(record.operationId, {
      type: "self_settled",
      outcome: "failed",
      reason,
    }));
    await runEffect(project(operation));
    await tryFinalize(record);
    waiter?.reject(new Error(reason));
  };

  const authorizationDeadlineElapsed = (
    operationId: string,
    deadline: string,
    observedAt: string,
  ): boolean => {
    if (Date.parse(observedAt) >= Date.parse(deadline)) return true;
    if (!records.has(operationId)) return false;
    const monotonicDeadline = authorizationMonotonicDeadlines.get(operationId);
    return monotonicDeadline === undefined ||
      services.clock.monotonicMilliseconds() >= monotonicDeadline;
  };

  const expireStartAuthorization = async (operationId: string): Promise<void> => {
    const current = await runEffect(getOperation(operationId));
    if (
      current.state !== "starting" ||
      (current.startGate !== "waiting" && current.startGate !== "authorized")
    ) return;
    await runEffect(advanceOperation(operationId, { type: "start_gate_closed", gate: "expired" }));
    const record = records.get(operationId);
    if (record !== undefined) {
      await terminateBeforeStart(record, "start_authorization_timed_out");
      return;
    }
    await runEffect(advanceOperation(operationId, {
      type: "operation_unknown",
      reason: "liveness-unproven",
      failureReason: "start_authorization_timed_out",
    }));
  };

  const verifyReviewSubject = async (
    operationId: string,
    policy: Readonly<StartupReceiptPolicy>,
    prepare: boolean,
  ): Promise<void> => {
    if (policy.reviewSubjectVerification === "disabled") return;
    const bindingId = `${operationId}.review-subject`;
    if (prepare) {
      const binding = await services.artifacts.prepareUseBinding(services.artifactCredential, {
        bindingId,
        operationId,
        artifactId: policy.reviewSubject.artifactId,
        purpose: "review_subject",
        decisionId: `${operationId}.start-authorization`,
        authorityBasis: "fixed-start-authorization-policy",
      });
      if (binding.kind !== "available") {
        throw new ResourceProofRejectedError("binding_mismatch", "Review subject could not be retained");
      }
    }
    const retrieval = await services.artifacts.retrieveForUseBinding(services.artifactCredential, bindingId);
    const subject = policy.reviewSubject;
    if (
      retrieval.kind !== "retrieved" || retrieval.integrity !== "verified" ||
      retrieval.artifact.artifactId !== subject.artifactId ||
      retrieval.artifact.byteCount !== subject.byteCount || retrieval.artifact.digest !== subject.digest ||
      retrieval.artifact.formatId !== subject.format ||
      retrieval.artifact.normalizationId !== subject.normalization
    ) {
      throw new ResourceProofRejectedError("binding_mismatch", "Review subject integrity could not be verified");
    }
  };

  const waitAtStartGate = async (
    record: OperationRecord,
    identified: Operation,
  ): Promise<Readonly<StartInstruction>> => {
    const authorization = identified.startAuthorizationTiming;
    if (authorization.policy === "disabled") {
      const instruction = {
        dispatcherId: RUNTIME_ACTOR_ID,
        workerProcessInstanceId: identified.workerIdentity!.processInstanceId,
        receiptDigest: automaticStartScopeDigest(identified),
        deliveryGeneration: 1,
      };
      await runEffect(advanceAndProject(record.operationId, {
        type: "start_delivery_authority_acquired",
        instruction: startInstructionReference(instruction),
      }));
      return instruction;
    }
    const receiptPolicy = identified.startupReceiptPolicy;
    if (receiptPolicy === undefined) {
      throw new ResourceProofRejectedError("binding_mismatch", "Fixed Startup receipt policy is unavailable");
    }
    const latest = await runEffect(getOperation(record.operationId));
    const resource = latest.resourceEvidenceRecord;
    const resourceGeneration = resource?.snapshot.validations.at(-1)?.generation;
    const resourceEvidence = resource?.snapshot.state === "held" &&
        resource.snapshot.proof !== undefined && resource.snapshot.workspaceProof !== undefined
      ? {
          startAttemptId: resource.request.startAttemptId,
          acquisitionId: resource.snapshot.acquisitionId,
          requestDigest: resource.snapshot.requestDigest,
          proofDigest: resource.snapshot.proof.digest,
          workspaceProofDigest: resource.snapshot.workspaceProof.digest,
          acquisitionState: "held" as const,
          ...(resourceGeneration === undefined ? {} : { generation: resourceGeneration }),
        }
      : undefined;
    if (resource !== undefined) {
      const manifestDigest = permissionManifestDocument(resource.request.effectiveManifest).digest;
      if (
        resourceEvidence === undefined ||
        !isDeepStrictEqual(receiptPolicy.workspace, resource.request.workspace) ||
        receiptPolicy.permissionManifest.digest !== manifestDigest
      ) {
        throw new ResourceProofRejectedError("binding_mismatch", "Startup receipt differs from fixed resource evidence");
      }
    }
    await verifyReviewSubject(record.operationId, receiptPolicy, true);
    const waiting = await runEffect(advanceOperation(record.operationId, {
      type: "startup_receipt_recorded",
      gate: "waiting",
      receipt: {
        operationId: identified.operationId,
        workerIdentity: latest.workerIdentity!,
        requestedConfig: latest.requestedConfig,
        effectiveConfig: latest.effectiveConfig,
        observedConfig: latest.observedConfig!,
        workspace: receiptPolicy.workspace,
        permissionManifest: receiptPolicy.permissionManifest,
        ...(resourceEvidence === undefined ? {} : { resourceEvidence }),
        reviewSubject: receiptPolicy.reviewSubject,
        reviewSubjectVerification: receiptPolicy.reviewSubjectVerification,
        configuredAuthorizationPolicy: authorization.configuredPolicy,
        authorizationPolicy: "required",
        authorizationDeadline: latest.startAuthorizationTiming.deadline,
      },
    }));
    await runEffect(project(waiting));
    if (waiting.startGate === "expired") {
      await terminateBeforeStart(record, "start_authorization_timed_out");
      throw new Error("Start authorization expired before publication");
    }

    const gate = new Promise<Readonly<StartInstruction>>((resolve, reject) => {
      startGateWaiters.set(record.operationId, { resolve, reject });
    });
    void (async () => {
      const observedAt = await runEffect(services.clock.now());
      const wallRemaining = Date.parse(latest.startAuthorizationTiming.deadline) - Date.parse(observedAt);
      const monotonicRemaining = (authorizationMonotonicDeadlines.get(record.operationId) ?? -Infinity) -
        services.clock.monotonicMilliseconds();
      const remaining = Math.min(wallRemaining, monotonicRemaining);
      if (remaining > 0) await runEffect(services.clock.sleep(remaining));
      await serializeAuthorizationMutation(record.operationId, () =>
        expireStartAuthorization(record.operationId)
      );
    })().catch((error) => startGateWaiters.get(record.operationId)?.reject(error));
    return gate;
  };

  const revalidateRequiredResourceProof = (operation: Operation) => {
    const runtimeConfiguration = services.configuration ?? {
      cwd: "/test/workspace",
      profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
    };
    const resourcePolicy = runtimeConfiguration.profiles[operation.task.profile]?.resources;
    if (resourcePolicy?.resourceProofPolicy !== "required") return Effect.void;
    const controller = services.resourceProofController;
    if (controller === undefined) {
      return Effect.fail(new ResourceProofRejectedError(
        "authority_unavailable",
        "Required resource proof adapters are unavailable",
      ));
    }
    return Effect.tryPromise({
      try: () => controller.revalidate(operation.operationId),
      catch: (error) => error instanceof ResourceProofRejectedError
        ? error
        : new ResourceProofRejectedError(
            "validation_unknown",
            error instanceof Error ? error.message : String(error),
          ),
    }).pipe(Effect.asVoid);
  };

  const execute = async (record: OperationRecord, recovering = false): Promise<void> => {
    try {
      let operation = recovering
        ? await runEffect(getOperation(record.operationId))
        : await runEffect(advanceOperation(record.operationId, { type: "operation_starting" }));
      if (!recovering) await runEffect(project(operation));

      const worker = record.worker;
      if (worker === undefined) {
        throw new Error("Worker was not opened");
      }
      const workerOutcome = await runEffect(worker.run({
        workerLaunched: () => recovering
          ? Effect.void
          : advanceAndProject(record.operationId, { type: "worker_launched" }),
        workerIdentified: (workerIdentity) => recovering
          ? Effect.tryPromise({
              try: async () => {
                const current = await runEffect(getOperation(record.operationId));
                const existingIdentity = current.workerIdentity;
                const previous = current.startDeliveryAuthority;
                if (
                  existingIdentity === undefined ||
                  previous === undefined ||
                  existingIdentity.processInstanceId !== workerIdentity.processInstanceId ||
                  existingIdentity.processStartToken !== workerIdentity.processStartToken
                ) {
                  throw new OperationPersistenceError(record.operationId, "corrupt_record");
                }
                const pendingHandoff = current.startDeliveryHandoffs.at(-1);
                const resumesHandoff =
                  pendingHandoff !== undefined &&
                  pendingHandoff.deliveryGeneration === previous.deliveryGeneration + 1;
                const deliveryGeneration = resumesHandoff
                  ? pendingHandoff.deliveryGeneration
                  : previous.deliveryGeneration + 1;
                const dispatcherId = resumesHandoff
                  ? pendingHandoff.successorDispatcherId
                  : `${RUNTIME_ACTOR_ID}-recovery-${deliveryGeneration}`;
                return {
                  dispatcherId,
                  workerProcessInstanceId: previous.workerProcessInstanceId,
                  receiptDigest: previous.receiptDigest,
                  ...(previous.authorizationDecisionId === undefined
                    ? {}
                    : { authorizationDecisionId: previous.authorizationDecisionId }),
                  deliveryGeneration,
                  ...(current.startAuthorizationTiming.policy === "required"
                    ? { deadline: current.startAuthorizationTiming.deadline }
                    : {}),
                };
              },
              catch: (error) => error instanceof OperationPersistenceError
                ? error
                : new OperationPersistenceError(record.operationId, "write_failed"),
            })
          : advanceOperation(record.operationId, {
          type: "worker_identified",
          workerIdentity: {
            processId: workerIdentity.processId,
            processInstanceId: workerIdentity.processInstanceId,
            processStartToken: workerIdentity.processStartToken,
            piSessionId: workerIdentity.piSessionId,
            paneId: operation.presentation?.paneId ?? "",
          },
          observedConfig: workerIdentity.observedConfig,
        }).pipe(
          Effect.tap((identified) => project(identified)),
          Effect.tap((identified) => {
            const runtimeConfiguration = services.configuration ?? {
              cwd: "/test/workspace",
              profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
            };
            const resourcePolicy = runtimeConfiguration.profiles[identified.task.profile]?.resources;
            if (resourcePolicy?.resourceProofPolicy !== "required") return Effect.void;
            const controller = services.resourceProofController;
            if (controller === undefined) {
              return Effect.fail(new ResourceProofRejectedError(
                "authority_unavailable",
                "Required resource proof adapters are unavailable",
              ));
            }
            return Effect.tryPromise({
              try: async () => {
                await controller.prepare({
                  operationId: identified.operationId,
                  workerProcessInstanceId: workerIdentity.processInstanceId,
                  startAttemptId: `${identified.operationId}:start:1`,
                  workspace: resourcePolicy.workspace,
                  requestedManifest: resourcePolicy.permissionManifest,
                  effectiveManifest: resourcePolicy.permissionManifest,
                  requirements: resourcePolicy,
                });
                await controller.revalidate(identified.operationId);
              },
              catch: (error) => error instanceof ResourceProofRejectedError
                ? error
                : new ResourceProofRejectedError(
                    "validation_unknown",
                    error instanceof Error ? error.message : String(error),
                  ),
            });
          }),
          Effect.flatMap((identified) => Effect.tryPromise({
            try: () => waitAtStartGate(record, identified),
            catch: (error) => error instanceof OperationPersistenceError || error instanceof ResourceProofRejectedError
              ? error
              : new OperationPersistenceError(record.operationId, "write_failed"),
          })),
        ),
        startDeliveryAuthorityRevoked: (successorDispatcherId, deliveryGeneration) =>
          Effect.tryPromise({
            try: () => services.artifacts.writerOwnership(),
            catch: () => new OperationPersistenceError(record.operationId, "write_failed"),
          }).pipe(
            Effect.flatMap((writerOwnership) => advanceAndProject(record.operationId, {
              type: "start_delivery_authority_revoked",
              successorDispatcherId,
              deliveryGeneration,
              writerOwnership,
            })),
          ),
        deliveryGenerationConfirmed: (confirmation) => Effect.gen(function* () {
          yield* advanceAndProject(record.operationId, {
            type: "start_delivery_generation_confirmed",
            dispatcherId: confirmation.dispatcherId,
            deliveryGeneration: confirmation.deliveryGeneration,
            acceptanceState: confirmation.acceptanceState,
            ...(confirmation.acceptedInstruction === undefined
              ? {}
              : { acceptedInstruction: startInstructionReference(confirmation.acceptedInstruction) }),
          });
          const current = yield* getOperation(record.operationId);
          if (confirmation.acceptanceState === "accepted") {
            const accepted = confirmation.acceptedInstruction;
            if (accepted === undefined) {
              return yield* Effect.fail(new OperationPersistenceError(record.operationId, "corrupt_record"));
            }
            if (current.startInstructionAcceptance === undefined) {
              yield* advanceAndProject(record.operationId, {
                type: "start_instruction_accepted",
                instruction: startInstructionReference(accepted),
                proof: "worker-durable-acceptance",
              });
            }
            const acceptedCurrent = yield* getOperation(record.operationId);
            if (acceptedCurrent.startInstructionAcknowledgement === undefined) {
              yield* advanceAndProject(record.operationId, {
                type: "start_instruction_acknowledged",
                instruction: startInstructionReference(accepted),
                proof: "authenticated-generation-acknowledgement",
              });
            }
            return;
          }
          if (confirmation.acceptanceState === "unknown") return;
          const workerIdentity = current.workerIdentity;
          const previousAuthority = current.startDeliveryAuthority;
          if (current.state !== "starting") {
            return yield* Effect.fail(new OperationPersistenceError(record.operationId, "write_failed"));
          }
          if (
            workerIdentity === undefined ||
            previousAuthority === undefined ||
            current.startGate !== "not_required" && current.startGate !== "authorized"
          ) {
            return yield* Effect.fail(new OperationPersistenceError(record.operationId, "corrupt_record"));
          }
          if (
            current.startAuthorizationTiming.policy === "required" &&
            Date.parse(yield* services.clock.now()) >= Date.parse(current.startAuthorizationTiming.deadline)
          ) {
            yield* Effect.promise(() => expireStartAuthorization(record.operationId));
            return yield* Effect.fail(new OperationPersistenceError(record.operationId, "write_failed"));
          }
          if (current.startAuthorizationTiming.policy === "required") {
            const receiptPolicy = current.startupReceiptPolicy;
            if (receiptPolicy === undefined) {
              return yield* Effect.fail(new OperationPersistenceError(record.operationId, "corrupt_record"));
            }
            yield* Effect.tryPromise({
              try: () => verifyReviewSubject(record.operationId, receiptPolicy, true),
              catch: (error) => error instanceof ResourceProofRejectedError
                ? error
                : new OperationPersistenceError(record.operationId, "write_failed"),
            });
          }
          yield* revalidateRequiredResourceProof(current);
          yield* advanceAndProject(record.operationId, {
            type: "start_delivery_authority_acquired",
            instruction: {
              dispatcherId: confirmation.dispatcherId,
              workerProcessInstanceId: workerIdentity.processInstanceId,
              receiptDigest: previousAuthority.receiptDigest,
              ...(previousAuthority.authorizationDecisionId === undefined
                ? {}
                : { authorizationDecisionId: previousAuthority.authorizationDecisionId }),
              deliveryGeneration: confirmation.deliveryGeneration,
            },
          });
        }),
        startDeliveryEntered: (instruction) => advanceAndProject(record.operationId, {
          type: "start_delivery_entered",
          instruction: startInstructionReference(instruction),
        }),
        startInstructionDispatched: (instruction) => advanceAndProject(record.operationId, {
          type: "start_instruction_dispatched",
          instruction: startInstructionReference(instruction),
        }),
        startInstructionAccepted: (instruction) => advanceAndProject(record.operationId, {
          type: "start_instruction_accepted",
          instruction: startInstructionReference(instruction),
          proof: "worker-durable-acceptance",
        }),
        startInstructionAcknowledged: (instruction) => advanceAndProject(record.operationId, {
          type: "start_instruction_acknowledged",
          instruction: startInstructionReference(instruction),
          proof: "authenticated-worker-acknowledgement",
        }),
        acceptResult: (result) => resultAcceptance.accept(record.operationId, result),
      }));
      if (workerOutcome.successfulExitConfirmed === true) {
        const current = await runEffect(getOperation(record.operationId));
        if (!isTerminal(current) && current.state !== "cancelling") {
          record.successfulExitConfirmed = true;
          await runEffect(advanceAndProject(record.operationId, {
            type: "worker_stop_confirmed",
            proof: "worker-stop",
          }));
          operation = await runEffect(getOperation(record.operationId));
        }
      }
      if (workerOutcome.state !== "result_acknowledged") {
        const current = await runEffect(getOperation(record.operationId));
        if (isTerminal(current) || current.state === "cancelling") return;
        if (workerOutcome.state === "process-exited-without-result") {
          await services.resourceProofController?.safetyCleanup(record.operationId).catch(() => undefined);
        } else if (
          workerOutcome.state === "liveness-unproven" ||
          workerOutcome.state === "worker_protocol_failed" ||
          workerOutcome.state === "agent_failed"
        ) {
          await services.resourceProofController?.markCleanupUnresolved(record.operationId).catch(() => undefined);
        }
        if (workerOutcome.state === "liveness-unproven") {
          operation = await runEffect(
            advanceOperation(record.operationId, {
              type: "operation_unknown",
              reason: "liveness-unproven",
            }),
          );
          await settleTerminal(record, operation);
          return;
        }
        if (workerOutcome.state === "worker_start_failed") {
          await runEffect(
            Effect.catchAllCause(
              services.presentation.onWorkerStartFailure(current),
              () => Effect.void,
            ),
          );
        }
        if (workerOutcome.state === "agent_failed") {
          operation = await runEffect(
            advanceOperation(record.operationId, {
              type: "agent_settled",
              evidence: workerOutcome.evidence,
            }),
          );
          await runEffect(project(operation));
        }
        operation = await runEffect(
          advanceOperation(record.operationId, {
            type: "self_settled",
            outcome: "failed",
            reason: workerOutcome.state,
          }),
        );
        await runEffect(project(operation));
        await tryFinalize(record);
        return;
      }
      if (workerOutcome.successfulExitConfirmed === true) {
        const runtimeConfiguration = services.configuration ?? {
          cwd: "/test/workspace",
          profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
        };
        const resources = runtimeConfiguration.profiles[operation.task.profile]?.resources;
        if (resources?.resourceProofPolicy === "required" && resources.cleanupPolicy === "automatic") {
          await services.resourceProofController?.automaticCleanup(record.operationId).catch(() => undefined);
        }
      }

      operation = await runEffect(
        advanceOperation(record.operationId, {
          type: "agent_settled",
          evidence: workerOutcome.evidence,
        }),
      );
      await runEffect(project(operation));
      operation = await runEffect(
        advanceOperation(record.operationId, {
          type: "self_settled",
          outcome: "succeeded",
        }),
      );
      await runEffect(project(operation));
      await tryFinalize(record);
    } catch (error) {
      const current = await runEffect(getOperation(record.operationId)).catch(() => undefined);
      if (
        current !== undefined &&
        (isTerminal(current) || current.state === "cancelling")
      ) {
        return;
      }
      if (error instanceof ResourceProofRejectedError && current !== undefined) {
        const stopped = record.worker === undefined
          ? undefined
          : await runEffect(record.worker.cancel(current.cancellationEpoch + 1, 1_000)).catch(() => undefined);
        if (stopped === undefined) {
          const unknown = await runEffect(advanceOperation(record.operationId, {
            type: "operation_unknown",
            reason: "liveness-unproven",
          }));
          await settleTerminal(record, unknown);
          return;
        }
        await services.resourceProofController?.safetyCleanup(record.operationId).catch(() => undefined);
        const failed = await runEffect(advanceOperation(record.operationId, {
          type: "self_settled",
          outcome: "failed",
          reason: "resource_proof_rejected",
        }));
        await runEffect(project(failed));
        await tryFinalize(record);
        return;
      }
      record.rejectTerminal(
        error instanceof OperationPersistenceError
          ? error
          : new RuntimeError(
              "operation_failed",
              error instanceof Error ? error.message : String(error),
            ),
      );
    }
  };

  const countLiveDescendants = async (rootOperationId: string): Promise<number> => {
    let count = 0;
    for (const active of records.values()) {
      const operation = await runEffect(getOperation(active.operationId));
      if (
        operation.lineage.rootOperationId === rootOperationId &&
        operation.lineage.parentOperationId !== undefined &&
        !isTerminal(operation)
      ) {
        count += 1;
      }
    }
    return count;
  };

  const createOperationUnlocked = async (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationRecord> => {
    await runEffect(services.presentation.preflight());
    const decodedTask = await Effect.runPromise(
      Schema.decodeUnknown(TaskSpecSchema)(taskInput),
    );
    const task: TaskSpec = {
      promptRef: decodedTask.promptRef,
      profile: decodedTask.profile,
      idempotencyKey: decodedTask.idempotencyKey,
      ...(decodedTask.model === undefined ? {} : { model: decodedTask.model }),
      ...(decodedTask.thinkingLevel === undefined ? {} : { thinkingLevel: decodedTask.thinkingLevel }),
      ...(decodedTask.tools === undefined ? {} : { tools: decodedTask.tools }),
      ...(decodedTask.cwd === undefined ? {} : { cwd: decodedTask.cwd }),
    };
    const parentId = options?.parentOperationId;
    const parent = parentId === undefined ? undefined : records.get(parentId);

    if (parentId !== undefined && parent === undefined) {
      throw new SpawnRejectedError("parent_not_found", parentId);
    }
    const parentOperation = parent === undefined
      ? undefined
      : await runEffect(getOperation(parent.operationId));
    if (parent !== undefined && parentOperation !== undefined) {
      let cancellationInProgress = parentOperation.spawnFrozen;
      for (const cancellingRootId of cancellingSubtreeRoots) {
        if (await isAncestor(cancellingRootId, parent.operationId)) {
          cancellationInProgress = true;
          break;
        }
      }
      if (cancellationInProgress) {
        throw new SpawnRejectedError(
          "cancellation_in_progress",
          parent.operationId,
        );
      }
      if (isTerminal(parentOperation) || parentOperation.selfOutcome !== undefined) {
        throw new SpawnRejectedError("parent_terminal", parent.operationId);
      }
      if (parentOperation.lineage.depth + 1 > MAX_DEPTH) {
        throw new SpawnRejectedError("depth_limit_exceeded", parent.operationId);
      }
      if (
        parentOperation.childOperationIds.length + parent.pendingAdmissions >=
        MAX_CHILDREN_PER_OPERATION
      ) {
        throw new SpawnRejectedError("child_limit_exceeded", parent.operationId);
      }
      const live = await countLiveDescendants(parentOperation.lineage.rootOperationId);
      if (live >= MAX_LIVE_DESCENDANTS_PER_ROOT) {
        throw new SpawnRejectedError(
          "live_descendant_limit_exceeded",
          parent.operationId,
        );
      }
      parent.pendingAdmissions += 1;
    }

    const requestedConfig = requestedWorkerConfig(task);
    const runtimeConfiguration = services.configuration ?? {
      cwd: "/test/workspace",
      profiles: { coding: DEFAULT_WORKER_PROFILE_POLICY },
    };
    let effectiveConfig;
    let resourceConfigurationRejected = false;
    const configuredProfile = runtimeConfiguration.profiles[task.profile];
    if (configuredProfile === undefined) {
      if (parent !== undefined) parent.pendingAdmissions -= 1;
      throw new WorkerConfigurationError("unsupported_capability", "Unknown Worker profile");
    }
    try {
      effectiveConfig = resolveWorkerConfig({
        requested: requestedConfig,
        profile: configuredProfile,
        runtimeCwd: runtimeConfiguration.cwd,
        ...(parentOperation === undefined ? {} : { parent: parentOperation.effectiveConfig }),
      });
    } catch (error) {
      if (!(error instanceof ResourceProofRejectedError)) {
        if (parent !== undefined) parent.pendingAdmissions -= 1;
        throw error;
      }
      resourceConfigurationRejected = true;
      try {
        effectiveConfig = resolveWorkerConfig({
          requested: requestedConfig,
          profile: { ...configuredProfile, resources: { resourceProofPolicy: "disabled" } },
          runtimeCwd: runtimeConfiguration.cwd,
          ...(parentOperation === undefined ? {} : { parent: parentOperation.effectiveConfig }),
        });
      } catch (configurationError) {
        if (parent !== undefined) parent.pendingAdmissions -= 1;
        throw configurationError;
      }
    }

    const workProductRequirements = resolveWorkProductRequirements(configuredProfile);
    if (
      services.worker.producesWorkProducts !== true &&
      workProductRequirements.workProducts.some(({ minCount }) => minCount > 0)
    ) {
      if (parent !== undefined) parent.pendingAdmissions -= 1;
      throw new WorkerConfigurationError(
        "unsupported_capability",
        "The Worker adapter cannot produce required work products",
      );
    }

    const resourcePolicy = configuredProfile.resources;
    const resourceAdmissionRejected = resourceConfigurationRejected ||
      resourcePolicy?.resourceProofPolicy === "required" && services.resourceProofController === undefined;
    if (!resourceConfigurationRejected && resourcePolicy?.resourceProofPolicy === "required") {
      await validateWorkspaceScope(resourcePolicy.workspace.normalizedPath, resourcePolicy.permissionManifest.read);
      await validateWorkspaceScope(resourcePolicy.workspace.normalizedPath, resourcePolicy.permissionManifest.write);
    }

    let operationId: string;
    try {
      operationId = await Effect.runPromise(services.ids.nextOperationId());
    } catch (error) {
      if (parent !== undefined) parent.pendingAdmissions -= 1;
      throw error;
    }

    const lineage: OperationLineage =
      parentOperation === undefined
        ? { rootOperationId: operationId, depth: 0 }
        : {
            rootOperationId: parentOperation.lineage.rootOperationId,
            parentOperationId: parentOperation.operationId,
            depth: parentOperation.lineage.depth + 1,
          };
    const deferred = deferredResult();
    const authorization = resolvedStartAuthorization(configuredProfile);
    const authorizationMonotonicDeadline = services.clock.monotonicMilliseconds() + authorization.windowMs;
    const record: OperationRecord = {
      operationId,
      terminalPromise: deferred.promise,
      resolveTerminal: deferred.resolve,
      rejectTerminal: deferred.reject,
      pendingAdmissions: 0,
    };

    if (parent !== undefined) {
      const updatedParent = await runEffect(
        advanceOperation(parent.operationId, {
          type: "child_attached",
          childOperationId: operationId,
        }),
      );
      parent.pendingAdmissions -= 1;
      await runEffect(project(updatedParent));
    }

    records.set(operationId, record);
    authorizationMonotonicDeadlines.set(operationId, authorizationMonotonicDeadline);
    let operation = await runEffect(
      services.store.create({
        operationId,
        task,
        requestedConfig,
        effectiveConfig,
        workProductRequirements,
        resultRetentionPolicy: resultAcceptanceRetentionPolicy(
          operationId,
          configuredProfile.acceptedArtifactRetentionMs,
        ),
        lineage,
        startAuthorization: authorization,
      }).pipe(
        Effect.map((snapshot) => snapshot.operation),
        Effect.mapError((error) => persistenceError(operationId, error)),
      ),
    );
    await runEffect(project(operation));

    if (resourceAdmissionRejected) {
      operation = await runEffect(advanceOperation(operationId, { type: "operation_starting" }));
      operation = await runEffect(advanceOperation(operationId, {
        type: "self_settled",
        outcome: "failed",
        reason: "resource_proof_rejected",
      }));
      operation = await runEffect(advanceOperation(operationId, {
        type: "operation_failed",
        reason: "resource_proof_rejected",
      }));
      record.executionRejected = true;
      await settleTerminal(record, operation);
      return record;
    }

    const createdPresentation = await runEffect(services.presentation.create(operation));
    try {
      operation = await runEffect(
        advanceOperation(operationId, {
          type: "presentation_owned",
          presentation: { ...createdPresentation, ownedByPions: true },
        }),
      );
    } catch (error) {
      await runEffect(
        Effect.catchAllCause(
          services.presentation.rollbackCreated(createdPresentation),
          () => Effect.void,
        ),
      );
      records.delete(operationId);
      throw error;
    }
    await runEffect(project(operation));
    record.worker = services.worker.open(operation);
    return record;
  };

  const createOperation = (
    taskInput: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationRecord> =>
    serializeTreeMutation(() => createOperationUnlocked(taskInput, options));

  const isAncestor = async (
    possibleAncestorId: string,
    operationId: string,
  ): Promise<boolean> => {
    let currentId: string | undefined = operationId;
    while (currentId !== undefined) {
      if (currentId === possibleAncestorId) return true;
      const current = records.get(currentId);
      if (current === undefined) return false;
      const operation = await runEffect(getOperation(current.operationId));
      currentId = operation.lineage.parentOperationId;
    }
    return false;
  };

  interface CancellationNode {
    readonly record: OperationRecord;
    readonly childOperationIds: ReadonlyArray<string>;
  }

  const collectPostOrder = async (
    record: OperationRecord,
    postOrder: Array<CancellationNode>,
  ): Promise<void> => {
    const operation = await runEffect(getOperation(record.operationId));
    if (isTerminal(operation)) return;
    const activeChildIds: Array<string> = [];
    for (const childId of operation.childOperationIds) {
      const child = records.get(childId);
      if (child === undefined) continue;
      const childOperation = await runEffect(getOperation(childId));
      if (isTerminal(childOperation)) continue;
      activeChildIds.push(childId);
      await collectPostOrder(child, postOrder);
    }
    postOrder.push({ record, childOperationIds: activeChildIds });
  };

  const beginCancellation = async (
    root: OperationRecord,
    options: CancelOptions,
  ): Promise<CancellationResult> => {
    const rootOperation = await runEffect(getOperation(root.operationId));
    const epoch = options.cancellationEpoch ?? rootOperation.cancellationEpoch + 1;
    if (epoch <= rootOperation.cancellationEpoch) {
      throw new CancellationRejectedError("stale_epoch", epoch);
    }

    let overlapsCancellation = false;
    for (const rootId of cancellingSubtreeRoots) {
      if (rootId === root.operationId) continue;
      if (
        await isAncestor(rootId, root.operationId) ||
        await isAncestor(root.operationId, rootId)
      ) {
        overlapsCancellation = true;
        break;
      }
    }
    if (
      rootOperation.spawnFrozen ||
      epoch > rootOperation.cancellationEpoch + 1 ||
      overlapsCancellation
    ) {
      throw new CancellationRejectedError("future_epoch", epoch);
    }
    const cancellation: Promise<CancellationResult> = serializeTreeMutation(async () => {
      const postOrder: Array<CancellationNode> = [];
      await collectPostOrder(root, postOrder);
      for (const { record } of postOrder) {
        const operation = await runEffect(
          advanceOperation(record.operationId, {
            type: "cancellation_requested",
            cancellationEpoch: epoch,
          }),
        );
        await runEffect(project(operation));
        const startGateWaiter = startGateWaiters.get(record.operationId);
        if (startGateWaiter !== undefined) {
          startGateWaiters.delete(record.operationId);
          startGateWaiter.reject(new OperationCancelledError(record.operationId));
        }
      }
      return postOrder;
    }).then(async (postOrder) => {
      const responses: Array<
        Promise<WorkerCancellationEvidence | undefined>
      > = [];
      const timeoutMs = options.timeoutMs ?? 1_000;
      for (const { record } of postOrder) {
        const operation = await runEffect(
          advanceOperation(record.operationId, {
            type: "cancel_dispatched",
            cancellationEpoch: epoch,
          }),
        );
        await runEffect(project(operation));
        const response = Promise.race([
          record.worker === undefined
            ? Promise.resolve(undefined)
            : runEffect(record.worker.cancel(epoch, timeoutMs)),
          runEffect(services.clock.sleep(timeoutMs)).then(
            () => undefined,
          ),
        ]).catch(() => undefined);
        responses.push(response);
      }

      const evidence = await Promise.all(responses);
      const unprovenSubtrees = new Set<string>();
      let rootState: CancellationResult["state"] = "cancelled";
      for (let index = 0; index < postOrder.length; index += 1) {
        const node = postOrder[index];
        if (node === undefined) continue;
        const descendantUnproven = node.childOperationIds.some((childId) =>
          unprovenSubtrees.has(childId),
        );
        const response = evidence[index];
        const unproven = response === undefined || descendantUnproven;
        if (unproven) unprovenSubtrees.add(node.record.operationId);

        if (response !== undefined) {
          const acknowledged = await runEffect(
            advanceOperation(node.record.operationId, {
              type: "cancel_acknowledged",
              cancellationEpoch: epoch,
              proof: response.proof,
            }),
          );
          await runEffect(project(acknowledged));
          await services.resourceProofController?.safetyCleanup(node.record.operationId).catch(() => undefined);
        }

        const terminal = unproven
          ? await runEffect(
              advanceOperation(node.record.operationId, {
                type: "operation_unknown",
                cancellationEpoch: epoch,
                reason: "cancel-unproven",
              }),
            )
          : await runEffect(
              advanceOperation(node.record.operationId, {
                type: "operation_cancelled",
                cancellationEpoch: epoch,
              }),
            );
        await settleTerminal(node.record, terminal);
        if (node.record === root) {
          rootState = terminal.state as CancellationResult["state"];
        }
      }

      return rootState === "unknown"
        ? {
            cancellationEpoch: epoch,
            state: rootState,
            reason: "cancel-unproven" as const,
          }
        : { cancellationEpoch: epoch, state: rootState };
    });
    return cancellation;
  };

  const cancelSubtree = (
    operationId: string,
    options: CancelOptions,
  ): Promise<CancellationResult> => {
    const record = records.get(operationId);
    if (record === undefined) {
      return Promise.reject(new Error(`Operation not admitted: ${operationId}`));
    }
    const requestedEpoch = options.cancellationEpoch;
    if (requestedEpoch !== undefined) {
      const key = `${operationId}:${requestedEpoch}`;
      const existing = cancellations.get(key);
      if (existing !== undefined) return existing;
      cancellingSubtreeRoots.add(operationId);
      const cancellation = beginCancellation(record, options);
      cancellations.set(key, cancellation);
      return cancellation;
    }
    if (cancellingSubtreeRoots.has(operationId)) {
      return runEffect(getOperation(operationId)).then((operation) =>
        Promise.reject(
          new CancellationRejectedError(
            "future_epoch",
            operation.cancellationEpoch + 2,
          ),
        ),
      );
    }
    cancellingSubtreeRoots.add(operationId);
    return beginCancellation(record, options);
  };

  const readPublicSnapshot = async (operationId: string): Promise<Readonly<PublicOperationSnapshot>> =>
    publicSnapshot(await readStoredSnapshot(operationId));

  const createReader = (operationId: string): OperationReader => ({
    operationId,
    read: () => readPublicSnapshot(operationId),
    waitForStartupReceipt: async () => {
      while (true) {
        const snapshot = await readPublicSnapshot(operationId);
        const receipt = snapshot.startAuthorization.receipt;
        if (receipt !== undefined) return receipt;
        if (snapshot.state === "completed" || snapshot.state === "failed" ||
            snapshot.state === "cancelled" || snapshot.state === "unknown") {
          return undefined;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    },
  });

  const createHandle = async (
    task: TaskSpec,
    options: SpawnOptions | undefined,
  ): Promise<OperationHandle> => {
    const record = await createOperation(task, options);
    if (record.executionRejected !== true) void execute(record);
    return {
      ...createReader(record.operationId),
      result: () => record.terminalPromise,
      cancel: (cancelOptions) =>
        cancelSubtree(record.operationId, cancelOptions),
    };
  };

  const recovery = runEffect(services.store.listRecoverableOperations().pipe(
    Effect.mapError((error) => persistenceError("runtime-recovery", error)),
  )).then((snapshots) => {
    for (const { operation } of snapshots) {
      if (records.has(operation.operationId)) continue;
      const deferred = deferredResult();
      const record: OperationRecord = {
        operationId: operation.operationId,
        terminalPromise: deferred.promise,
        resolveTerminal: deferred.resolve,
        rejectTerminal: deferred.reject,
        pendingAdmissions: 0,
        worker: services.worker.recover(operation),
      };
      records.set(operation.operationId, record);
      void execute(record, true);
    }
  });
  void recovery.catch(() => undefined);

  return {
    async close(): Promise<void> {
      await recovery.catch(() => undefined);
      await artifactServices.artifacts.close();
    },

    spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle> {
      const parentOperationId = options?.parentOperationId;
      let spawnsByKey = spawnsByParent.get(parentOperationId);
      if (spawnsByKey === undefined) {
        spawnsByKey = new Map();
        spawnsByParent.set(parentOperationId, spawnsByKey);
      }

      const existing = spawnsByKey.get(task.idempotencyKey);
      if (existing !== undefined) return existing;

      const spawn = createHandle(task, options);
      spawnsByKey.set(task.idempotencyKey, spawn);
      return spawn;
    },

    async operation(operationId: string): Promise<OperationReader> {
      await readStoredSnapshot(operationId);
      return createReader(operationId);
    },

    resourceProofs() {
      const controller = services.resourceProofController;
      if (controller === undefined) {
        throw new ResourceProofRejectedError(
          "authority_unavailable",
          "Resource proof adapters are unavailable",
        );
      }
      return {
        prepare: async (request) => {
          const stored = await readStoredSnapshot(request.operationId);
          const profile = services.configuration?.profiles[stored.operation.task.profile];
          if (profile?.resources.resourceProofPolicy !== "required" ||
              !isDeepStrictEqual(profile.resources, request.requirements)) {
            throw new ResourceProofRejectedError(
              "binding_mismatch",
              "Resource request differs from the Operation's fixed profile",
            );
          }
          if (stored.operation.state !== "starting" ||
              stored.operation.workerIdentity?.processInstanceId !== request.workerProcessInstanceId) {
            throw new ResourceProofRejectedError(
              "binding_mismatch",
              "Resource request is not bound to the Operation Worker",
            );
          }
          return controller.prepare(request);
        },
        revalidate: async (operationId) => {
          await readStoredSnapshot(operationId);
          return controller.revalidate(operationId);
        },
        cleanup: async (operationId, credential) => {
          await readStoredSnapshot(operationId);
          return controller.cleanup(operationId, credential);
        },
        read: async (operationId) => {
          await readStoredSnapshot(operationId);
          return controller.read(operationId);
        },
      };
    },

    async startAuthorizationInbox(credential: string) {
      const authenticator = services.startAuthorizationAuthenticator;
      if (authenticator === undefined) {
        throw new StartAuthorizationAuthenticationError("Start authorization authentication is unavailable");
      }
      const principal = await authenticator.authenticate(credential).catch((error) => {
        throw error instanceof StartAuthorizationAuthenticationError
          ? error
          : new StartAuthorizationAuthenticationError("Start authorization authentication failed");
      });
      const currentAuthorization = (operationId: string) =>
        principal.currentAuthorization(operationId).catch(() => "unknown" as const);
      return {
        listWaiting: async () => {
          const stored = await runEffect(services.store.listWaitingStartAuthorizations().pipe(
            Effect.mapError((error) => persistenceError("start-authorization-inbox", error)),
          ));
          const allowed = [];
          for (const snapshot of stored) {
            const operationId = snapshot.operation.operationId;
            if (!snapshot.operation.startAuthorizationTiming.authorizedSubjectIds.includes(principal.subjectId)) continue;
            if (await currentAuthorization(operationId) !== "authorized") continue;
            const observedAt = await runEffect(services.clock.now());
            const recoveryTimeUnreliable = !records.has(operationId) &&
              !services.clock.recoveredElapsedTimeIsReliable();
            if (
              recoveryTimeUnreliable ||
              authorizationDeadlineElapsed(
                operationId,
                snapshot.operation.startAuthorizationTiming.deadline,
                observedAt,
              )
            ) {
              await serializeAuthorizationMutation(operationId, () =>
                expireStartAuthorization(operationId)
              );
              continue;
            }
            const receipt = snapshot.operation.startupReceipt;
            if (receipt === undefined) continue;
            allowed.push(Object.freeze({
              operationId: snapshot.operation.operationId,
              version: Object.freeze({ ...snapshot.version }),
              deadline: snapshot.operation.startAuthorizationTiming.deadline,
              receipt,
            }));
          }
          return Object.freeze(allowed);
        },
        decide: (request: Readonly<StartAuthorizationDecisionRequest>): Promise<Readonly<StartAuthorizationDecisionOutcome>> =>
          serializeAuthorizationMutation(request.operationId, async () => {
            const storedRead = await runEffect(Effect.either(services.store.read(request.operationId)));
            if (storedRead._tag === "Left") {
              if (storedRead.left.code === "not_found") {
                return { status: "rejected", reason: "operation_not_found" };
              }
              throw persistenceError(request.operationId, storedRead.left);
            }
            const stored = storedRead.right;
            const operation = stored.operation;
            const rejectDecision = async (
              reason: Exclude<StartAuthorizationDecisionRejectionReason, "operation_not_found">,
            ): Promise<Readonly<StartAuthorizationDecisionOutcome>> => {
              const alreadyRecorded = operation.rejectedStartAuthorizationDecisions.some((attempt) =>
                attempt.decisionId === request.decisionId &&
                attempt.kind === request.kind &&
                attempt.actorId === principal.subjectId &&
                attempt.receiptDigest === request.receiptDigest &&
                attempt.reason === reason
              );
              if (!alreadyRecorded) {
                await runEffect(advanceOperation(request.operationId, {
                  type: "start_authorization_decision_rejected",
                  attempt: {
                    decisionId: request.decisionId,
                    kind: request.kind,
                    actorId: principal.subjectId,
                    receiptDigest: request.receiptDigest,
                    reason,
                  },
                }));
              }
              return { status: "rejected", reason };
            };
            if (!operation.startAuthorizationTiming.authorizedSubjectIds.includes(principal.subjectId)) {
              return { status: "rejected", reason: "fixed_scope_denied" };
            }
            const authorization = await currentAuthorization(request.operationId);
            if (authorization !== "authorized") {
              return {
                status: "rejected",
                reason: authorization === "revoked"
                  ? "authority_revoked"
                  : authorization === "unknown"
                    ? "authority_unknown"
                    : "current_authority_denied",
              };
            }
            const existing = operation.startAuthorizationDecision;
            if (existing !== undefined) {
              const sameContent = existing.kind === request.kind &&
                existing.receiptDigest === request.receiptDigest && existing.actorId === principal.subjectId;
              if (sameContent) {
                return {
                  status: existing.decisionId === request.decisionId ? "idempotent" : "duplicate",
                  decision: existing,
                  gate: existing.kind === "authorize" ? "authorized" : "rejected",
                };
              }
              if (existing.decisionId === request.decisionId) {
                return rejectDecision("decision_id_conflict");
              }
              return rejectDecision(operation.startupReceipt?.digest === request.receiptDigest
                ? "gate_closed"
                : "receipt_mismatch");
            }
            if (operation.startupReceipt?.digest !== request.receiptDigest) {
              return rejectDecision("receipt_mismatch");
            }
            if (operation.startGate !== "waiting") {
              return rejectDecision("gate_closed");
            }
            const decidedAt = await runEffect(services.clock.now());
            const recoveryTimeUnreliable = !records.has(request.operationId) &&
              !services.clock.recoveredElapsedTimeIsReliable();
            if (
              recoveryTimeUnreliable ||
              authorizationDeadlineElapsed(
                request.operationId,
                operation.startAuthorizationTiming.deadline,
                decidedAt,
              )
            ) {
              await expireStartAuthorization(request.operationId);
              return rejectDecision("deadline_elapsed");
            }
            const decided = await runEffect(advanceOperation(request.operationId, {
              type: "start_authorization_decided",
              gate: request.kind === "authorize" ? "authorized" : "rejected",
              decision: {
                decisionId: request.decisionId,
                kind: request.kind,
                actorId: principal.subjectId,
                receiptDigest: request.receiptDigest,
                decidedAt,
              },
            }));
            const decision = decided.startAuthorizationDecision!;
            const accepted = {
              status: "accepted" as const,
              decision,
              gate: request.kind === "authorize" ? "authorized" as const : "rejected" as const,
            };
            const record = records.get(request.operationId);
            if (record === undefined) {
              await runEffect(advanceOperation(request.operationId, {
                type: "operation_unknown",
                reason: "liveness-unproven",
                ...(request.kind === "reject" ? { failureReason: "start_rejected" as const } : {}),
              }));
              return accepted;
            }
            if (request.kind === "reject") {
              await terminateBeforeStart(record, "start_rejected");
              return accepted;
            }

            const latest = await runEffect(getOperation(request.operationId));
            const targetMatches = latest.state === "starting" && latest.startGate === "authorized" &&
              latest.startupReceipt?.digest === request.receiptDigest &&
              latest.workerIdentity?.processInstanceId === latest.startupReceipt.workerIdentity.processInstanceId;
            const deadlineStillOpen = !authorizationDeadlineElapsed(
              request.operationId,
              latest.startAuthorizationTiming.deadline,
              await runEffect(services.clock.now()),
            );
            const currentlyAuthorized = await currentAuthorization(request.operationId)
              .then((authorization) => authorization === "authorized");
            try {
              if (!targetMatches) throw new StartRevalidationError("invalidated");
              if (!deadlineStillOpen) throw new StartRevalidationError("timed_out");
              if (!currentlyAuthorized) throw new StartRevalidationError("invalidated");
              if (latest.resourceEvidenceRecord !== undefined) {
                if (services.resourceProofController === undefined) throw new Error("Resource proof controller unavailable");
                await services.resourceProofController.revalidate(request.operationId);
              }
              if (latest.startupReceiptPolicy === undefined) {
                throw new Error("Fixed Startup receipt policy unavailable");
              }
              await verifyReviewSubject(request.operationId, latest.startupReceiptPolicy, false);
              const revalidated = await runEffect(getOperation(request.operationId));
              const revalidatedAt = await runEffect(services.clock.now());
              const authorityStillCurrent = await currentAuthorization(request.operationId)
                .then((authorization) => authorization === "authorized");
              if (
                revalidated.state !== "starting" || revalidated.startGate !== "authorized" ||
                revalidated.startupReceipt?.digest !== request.receiptDigest ||
                authorizationDeadlineElapsed(
                  request.operationId,
                  revalidated.startAuthorizationTiming.deadline,
                  revalidatedAt,
                ) ||
                !authorityStillCurrent
              ) {
                const timedOut = authorizationDeadlineElapsed(
                  request.operationId,
                  revalidated.startAuthorizationTiming.deadline,
                  revalidatedAt,
                );
                throw new StartRevalidationError(timedOut ? "timed_out" : "invalidated");
              }
              const instruction = {
                dispatcherId: RUNTIME_ACTOR_ID,
                workerProcessInstanceId: latest.workerIdentity!.processInstanceId,
                receiptDigest: request.receiptDigest,
                authorizationDecisionId: request.decisionId,
                deliveryGeneration: 1,
              };
              await runEffect(advanceAndProject(request.operationId, {
                type: "start_delivery_authority_acquired",
                instruction,
              }));
              const dispatchCheckedAt = await runEffect(services.clock.now());
              if (authorizationDeadlineElapsed(
                request.operationId,
                revalidated.startAuthorizationTiming.deadline,
                dispatchCheckedAt,
              )) {
                await expireStartAuthorization(request.operationId);
                throw new Error("Start authorization expired before begin");
              }
              startGateWaiters.get(request.operationId)?.resolve({
                ...instruction,
                deadline: revalidated.startAuthorizationTiming.deadline,
              });
              startGateWaiters.delete(request.operationId);
            } catch (error) {
              const current = await runEffect(getOperation(request.operationId));
              if (current.state === "starting" && current.startGate === "authorized") {
                const timedOut = error instanceof StartRevalidationError && error.reason === "timed_out";
                await runEffect(advanceOperation(request.operationId, {
                  type: "start_gate_closed",
                  gate: timedOut ? "expired" : "invalidated",
                }));
                await terminateBeforeStart(
                  record,
                  timedOut ? "start_authorization_timed_out" : "start_authorization_invalidated",
                );
              } else {
                const waiter = startGateWaiters.get(request.operationId);
                startGateWaiters.delete(request.operationId);
                waiter?.reject(new Error("Start authorization superseded"));
              }
            }
            return accepted;
          }),
      };
    },
  };
}
