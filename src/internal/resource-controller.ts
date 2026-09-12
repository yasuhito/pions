import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  CanonicalProofDocument,
  CanonicalResourceRequest,
  PermissionGuaranteeEvidence,
  ResourceAuthorityRegistration,
  ResourceCleanupAuthenticator,
  ResourceEvidenceSnapshot,
  ResourcePreparationRequest,
  ResourceProofController,
  ResourceProofEvidence,
  ResourceProofRejectionReason,
  ResourceValidationEvidence,
  VersionedResourceEvidenceSnapshot,
} from "../public.js";
import { ResourceProofRejectedError } from "../public.js";
import type { OperationReviewInputTarget } from "./review-input-preparation.js";
import {
  parseProofDocument,
  permissionManifestDocument,
  permissionManifestsMatch,
  validateWorkspaceScope,
} from "./resource-proof.js";

const CONSTRAINTS = [
  "tools",
  "read",
  "write",
  "commands",
  "network",
  "externalResources",
] as const;

export type PersistedResourceRecord = {
  version: number;
  request: Readonly<ResourcePreparationRequest>;
  registrationGeneration: string;
  canonicalResources: ReadonlyArray<Readonly<CanonicalResourceRequest>>;
  snapshot: ResourceEvidenceSnapshot;
};
type InternalRecord = PersistedResourceRecord;

export interface ResourceEvidenceRepository {
  read(operationId: string): Promise<Readonly<InternalRecord> | undefined>;
  write(
    operationId: string,
    expectedVersion: number | undefined,
    record: Omit<InternalRecord, "version">
  ): Promise<Readonly<InternalRecord>>;
}

export class InMemoryResourceEvidenceRepository implements ResourceEvidenceRepository {
  private readonly records = new Map<string, InternalRecord>();

  async read(
    operationId: string
  ): Promise<Readonly<InternalRecord> | undefined> {
    return this.records.get(operationId);
  }

  async write(
    operationId: string,
    expectedVersion: number | undefined,
    input: Omit<InternalRecord, "version">
  ): Promise<Readonly<InternalRecord>> {
    const current = this.records.get(operationId);
    if (current?.version !== expectedVersion)
      throw new ResourceProofRejectedError(
        "persistence_failed",
        "Resource evidence changed concurrently"
      );
    const record = structuredClone({
      ...input,
      version: (expectedVersion ?? 0) + 1,
    });
    this.records.set(operationId, record);
    return record;
  }
}

export interface InternalResourceProofController extends ResourceProofController {
  automaticCleanup(
    operationId: string
  ): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  safetyCleanup(
    operationId: string
  ): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  markCleanupUnresolved(
    operationId: string
  ): Promise<Readonly<VersionedResourceEvidenceSnapshot>>;
  reviewInputTarget(
    operationId: string,
    paths: ReadonlyArray<string>
  ): Promise<Readonly<OperationReviewInputTarget>>;
}

export interface ResourceProofControllerOptions {
  readonly registrations: ReadonlyArray<
    Readonly<ResourceAuthorityRegistration>
  >;
  readonly cleanupAuthenticator?: ResourceCleanupAuthenticator;
  readonly repository?: ResourceEvidenceRepository;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function snapshot(
  record: Readonly<InternalRecord>
): Readonly<VersionedResourceEvidenceSnapshot> {
  return Object.freeze({
    version: record.version,
    evidence: structuredClone(record.snapshot),
  });
}

function rejected(
  reason: ResourceProofRejectionReason,
  message: string
): never {
  throw new ResourceProofRejectedError(reason, message);
}

function evidenceDocument(value: unknown): Readonly<CanonicalProofDocument> {
  return parseProofDocument(Buffer.from(JSON.stringify(value), "utf8"));
}

function requireDocumentBinding(
  document: Readonly<CanonicalProofDocument>,
  expected: unknown,
  message: string
): void {
  if (document.json !== evidenceDocument(expected).json)
    rejected("binding_mismatch", message);
}

function completeGuarantees(
  guarantees: ReadonlyArray<Readonly<PermissionGuaranteeEvidence>>,
  proof: Readonly<ResourceProofEvidence>
): boolean {
  return (
    guarantees.length === CONSTRAINTS.length &&
    CONSTRAINTS.every((constraint) => {
      const guarantee = guarantees.find(
        (candidate) => candidate.constraint === constraint
      );
      return (
        guarantee !== undefined &&
        guarantee.authorityId === proof.authorityId &&
        guarantee.operationId === proof.operationId &&
        guarantee.workerProcessInstanceId === proof.workerProcessInstanceId &&
        guarantee.permissionManifestDigest === proof.permissionManifestDigest &&
        guarantee.method.length > 0 &&
        guarantee.scope.length > 0 &&
        guarantee.basis.length > 0 &&
        guarantee.result === "satisfied" &&
        Number.isFinite(Date.parse(guarantee.checkedAt)) &&
        validDate(guarantee.validUntil) &&
        (guarantee.validUntil !== undefined ||
          guarantee.generation !== undefined)
      );
    })
  );
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  milliseconds: number
): Promise<Value> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, rejectTimeout) => {
        timeout = setTimeout(
          () =>
            rejectTimeout(
              new ResourceProofRejectedError(
                "cleanup_unresolved",
                "Resource cleanup timed out"
              )
            ),
          milliseconds
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function validDate(value: string | undefined, now = Date.now()): boolean {
  return (
    value === undefined ||
    (Number.isFinite(Date.parse(value)) && Date.parse(value) > now)
  );
}

function validateProofBinding(
  proof: Readonly<ResourceProofEvidence>,
  request: Readonly<ResourcePreparationRequest>,
  acquisitionId: string,
  requestDigest: `sha256:${string}`,
  manifestDigest: `sha256:${string}`
): void {
  if (
    proof.acquisitionId !== acquisitionId ||
    proof.startAttemptId !== request.startAttemptId ||
    proof.requestDigest !== requestDigest ||
    proof.operationId !== request.operationId ||
    proof.workerProcessInstanceId !== request.workerProcessInstanceId ||
    proof.permissionManifestDigest !== manifestDigest ||
    proof.authorityId !== request.requirements.authorityId ||
    proof.authorityRegistrationId !==
      request.requirements.authorityRegistrationId ||
    proof.authorityGeneration !== request.requirements.authorityGeneration ||
    !isDeepStrictEqual(proof.workspace, request.workspace) ||
    proof.workspace.pionsMayDelete !== false
  )
    rejected(
      "binding_mismatch",
      "Resource proof is bound to a different request"
    );
  if (!proof.noConflict || proof.conflictControlId.length === 0)
    rejected("resource_conflict", "Resource conflict prevention is not proven");
  if (proof.revocationOwner.length === 0)
    rejected(
      "enforcement_missing",
      "Resource revocation responsibility is missing"
    );
  if (!completeGuarantees(proof.observations, proof))
    rejected(
      "observation_missing",
      "Current permission observation is incomplete"
    );
  if (!completeGuarantees(proof.enforcements, proof))
    rejected(
      "enforcement_missing",
      "Runtime permission enforcement is incomplete"
    );
  if (
    !validDate(proof.validUntil) ||
    (proof.validUntil === undefined && proof.generation === undefined)
  ) {
    rejected(
      "binding_mismatch",
      "Resource proof is expired or has no validity binding"
    );
  }
}

function validateValidationBinding(
  evidence: Readonly<ResourceValidationEvidence>,
  record: Readonly<InternalRecord>
): void {
  const current = record.snapshot;
  if (
    evidence.acquisitionId !== current.acquisitionId ||
    evidence.startAttemptId !== record.request.startAttemptId ||
    evidence.requestDigest !== current.requestDigest ||
    evidence.operationId !== record.request.operationId ||
    evidence.workerProcessInstanceId !==
      record.request.workerProcessInstanceId ||
    evidence.authorityId !== record.request.requirements.authorityId ||
    evidence.authorityRegistrationId !==
      record.request.requirements.authorityRegistrationId ||
    evidence.authorityGeneration !== record.registrationGeneration ||
    evidence.proofDigest !== current.proof?.digest
  )
    rejected(
      "binding_mismatch",
      "Resource validation is bound to a different acquisition"
    );
}

function requireValidHandoff(
  evidence: Readonly<ResourceValidationEvidence>
): void {
  if (
    !validDate(evidence.validUntil) ||
    (evidence.validUntil === undefined && evidence.generation === undefined)
  ) {
    rejected(
      "binding_mismatch",
      "Resource validation is expired or has no validity binding"
    );
  }
  if (evidence.state === "unknown")
    rejected("validation_unknown", "Resource validation is unknown");
  if (evidence.state !== "valid")
    rejected("authority_revoked", "Resource validation is invalid");
  if (!evidence.handoffConfirmed)
    rejected("handoff_unconfirmed", "Resource handoff is not confirmed");
  if (!evidence.relatedExecutionAccessBlocked)
    rejected("resource_conflict", "Related execution access remains possible");
}

export function makeResourceProofController(
  options: Readonly<ResourceProofControllerOptions>
): InternalResourceProofController {
  const repository =
    options.repository ?? new InMemoryResourceEvidenceRepository();
  const registrations = new Map(
    options.registrations.map((registration) => [
      registration.authorityId,
      registration,
    ])
  );
  if (registrations.size !== options.registrations.length)
    throw new ResourceProofRejectedError(
      "invalid_profile",
      "Authority identifiers must be unique"
    );
  const cleanupInProgress = new Set<string>();
  const automaticCleanupCredential = `pions-internal:${randomUUID()}`;
  const safetyCleanupCredential = `pions-safety:${randomUUID()}`;

  const registrationFor = (request: Readonly<ResourcePreparationRequest>) => {
    const registration = registrations.get(request.requirements.authorityId);
    if (registration === undefined)
      rejected("authority_unavailable", "Resource authority is not registered");
    if (
      registration.registrationId !==
        request.requirements.authorityRegistrationId ||
      registration.generation !== request.requirements.authorityGeneration ||
      registration.normalizationVersion !==
        request.requirements.normalizationVersion
    )
      rejected(
        "binding_mismatch",
        "Resource authority registration does not match the fixed profile"
      );
    return registration;
  };

  const persistDiagnostic = async (
    record: Readonly<InternalRecord>,
    reason: ResourceProofRejectionReason
  ) => {
    try {
      await repository.write(record.request.operationId, record.version, {
        request: record.request,
        registrationGeneration: record.registrationGeneration,
        canonicalResources: record.canonicalResources,
        snapshot: {
          ...record.snapshot,
          state: "unresolved",
          diagnostic: reason,
          ...(record.snapshot.cleanup === undefined
            ? {}
            : { cleanup: { ...record.snapshot.cleanup, state: "unresolved" } }),
        },
      });
    } catch {
      // The direct typed rejection still reports the original failure; no success is returned.
    }
  };

  const prepare = async (request: Readonly<ResourcePreparationRequest>) => {
    if (!isDeepStrictEqual(request.workspace, request.requirements.workspace)) {
      rejected(
        "binding_mismatch",
        "Workspace differs from the fixed resource profile"
      );
    }
    if (
      !permissionManifestsMatch(
        request.requestedManifest,
        request.effectiveManifest
      ) ||
      !permissionManifestsMatch(
        request.requestedManifest,
        request.requirements.permissionManifest
      )
    ) {
      rejected(
        "permission_mismatch",
        "Requested, effective, and fixed permission manifests differ"
      );
    }
    await validateWorkspaceScope(
      request.workspace.normalizedPath,
      request.requestedManifest.read
    );
    await validateWorkspaceScope(
      request.workspace.normalizedPath,
      request.requestedManifest.write
    );
    const registration = registrationFor(request);
    const trust = await registration.issuer.isCurrentlyTrusted(
      registration.generation
    );
    if (trust === "revoked")
      rejected("authority_revoked", "Resource authority is revoked");
    if (trust === "unknown")
      rejected(
        "validation_unknown",
        "Resource authority trust cannot be inspected"
      );
    const manifest = permissionManifestDocument(request.requestedManifest);
    const canonicalResources: Array<Readonly<CanonicalResourceRequest>> = [];
    for (const resource of request.requestedManifest.externalResources) {
      if (resource.authorityId !== registration.authorityId) {
        rejected(
          "resource_conflict",
          "One acquisition cannot span unrelated resource authorities"
        );
      }
      const normalized = await registration.adapter.normalizeSelector(
        resource.selector,
        registration.normalizationVersion
      );
      if (
        normalized.namespace.length === 0 ||
        normalized.selector.length === 0 ||
        normalized.conflictScopes.length === 0 ||
        normalized.conflictScopes.some((scope) => scope.length === 0)
      ) {
        rejected(
          "binding_mismatch",
          "Resource selector normalization is incomplete"
        );
      }
      canonicalResources.push(
        Object.freeze({
          authorityId: registration.authorityId,
          namespace: normalized.namespace,
          normalizationVersion: registration.normalizationVersion,
          selector: normalized.selector,
          conflictScopes: Object.freeze(
            [...new Set(normalized.conflictScopes)].sort()
          ),
          usage: resource.usage,
        })
      );
    }
    canonicalResources.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
    const requestDigest = digest(
      JSON.stringify({
        operationId: request.operationId,
        workerProcessInstanceId: request.workerProcessInstanceId,
        startAttemptId: request.startAttemptId,
        authorityId: registration.authorityId,
        authorityRegistrationId: registration.registrationId,
        authorityGeneration: registration.generation,
        normalizationVersion: registration.normalizationVersion,
        permissionManifestDigest: manifest.digest,
        workspace: request.workspace,
        resources: canonicalResources,
      })
    );
    const acquisitionId = digest(
      `${request.operationId}\u0000${requestDigest}`
    ).slice("sha256:".length);
    const adapterRequest = {
      acquisitionId,
      startAttemptId: request.startAttemptId,
      requestDigest,
      operationId: request.operationId,
      workerProcessInstanceId: request.workerProcessInstanceId,
      permissionManifest: request.requestedManifest,
      workspace: request.workspace,
      resources: canonicalResources,
      permissionManifestDigest: manifest.digest,
    } as const;
    let record = await repository.read(request.operationId);
    const recovering =
      record?.snapshot.state === "acquiring" ||
      record?.snapshot.state === "unresolved";
    if (record !== undefined) {
      if (record.snapshot.requestDigest !== requestDigest)
        rejected(
          "binding_mismatch",
          "Operation already has a different resource request"
        );
      if (record.snapshot.state === "held") return snapshot(record);
    } else {
      record = await repository.write(request.operationId, undefined, {
        request: structuredClone(request),
        registrationGeneration: registration.generation,
        canonicalResources,
        snapshot: {
          state: "planned",
          acquisitionId,
          requestDigest,
          validations: [],
          cleanupAttempts: 0,
        },
      });
    }
    if (record.snapshot.state === "planned") {
      record = await repository.write(request.operationId, record.version, {
        request: record.request,
        registrationGeneration: record.registrationGeneration,
        canonicalResources: record.canonicalResources,
        snapshot: { ...record.snapshot, state: "acquiring" },
      });
    }
    let acquisitionReachedAdapter = false;
    let proof: Readonly<ResourceProofEvidence>;
    try {
      if (recovering) {
        const recovered = await registration.adapter.recover(adapterRequest);
        if (recovered === "released") {
          record = await repository.write(request.operationId, record.version, {
            request: record.request,
            registrationGeneration: record.registrationGeneration,
            canonicalResources: record.canonicalResources,
            snapshot: { ...record.snapshot, state: "released" },
          });
          rejected("handoff_unconfirmed", "Resource acquisition was not held");
        }
        if (recovered === "unknown")
          rejected(
            "validation_unknown",
            "Resource acquisition state is unknown"
          );
        proof = recovered;
      } else {
        acquisitionReachedAdapter = true;
        proof = await registration.adapter.acquire(adapterRequest);
      }
      acquisitionReachedAdapter = true;
      validateProofBinding(
        proof,
        request,
        acquisitionId,
        requestDigest,
        manifest.digest
      );
      if (
        !(await registration.issuer.verify(proof.evidence)) ||
        !(await registration.issuer.verify(proof.workspaceEvidence))
      ) {
        rejected("invalid_proof", "Resource proof issuer verification failed");
      }
      const document = parseProofDocument(proof.evidence);
      const workspaceDocument = parseProofDocument(proof.workspaceEvidence);
      requireDocumentBinding(
        workspaceDocument,
        {
          schemaVersion: 1,
          kind: "workspace-proof",
          authorityId: proof.authorityId,
          authorityRegistrationId: proof.authorityRegistrationId,
          authorityGeneration: proof.authorityGeneration,
          operationId: proof.operationId,
          workspace: proof.workspace,
        },
        "Workspace proof bytes do not bind the declared workspace"
      );
      requireDocumentBinding(
        document,
        {
          schemaVersion: 1,
          kind: "resource-proof",
          acquisitionId: proof.acquisitionId,
          startAttemptId: proof.startAttemptId,
          requestDigest: proof.requestDigest,
          authorityId: proof.authorityId,
          authorityRegistrationId: proof.authorityRegistrationId,
          authorityGeneration: proof.authorityGeneration,
          operationId: proof.operationId,
          workerProcessInstanceId: proof.workerProcessInstanceId,
          permissionManifestDigest: proof.permissionManifestDigest,
          workspaceProofDigest: workspaceDocument.digest,
          conflictControlId: proof.conflictControlId,
          noConflict: proof.noConflict,
          revocationOwner: proof.revocationOwner,
          observations: proof.observations,
          enforcements: proof.enforcements,
          ...(proof.validUntil === undefined
            ? {}
            : { validUntil: proof.validUntil }),
          ...(proof.generation === undefined
            ? {}
            : { generation: proof.generation }),
        },
        "Resource proof bytes do not bind the declared acquisition"
      );
      record = await repository.write(request.operationId, record.version, {
        request: record.request,
        registrationGeneration: record.registrationGeneration,
        canonicalResources: record.canonicalResources,
        snapshot: {
          ...record.snapshot,
          state: "held",
          proof: document,
          workspaceProof: workspaceDocument,
        },
      });
      return snapshot(record);
    } catch (error) {
      const reason =
        error instanceof ResourceProofRejectedError
          ? error.reason
          : "validation_unknown";
      await persistDiagnostic(record, reason);
      if (acquisitionReachedAdapter) {
        await resourceController
          .safetyCleanup(request.operationId)
          .catch(() => undefined);
      }
      throw error instanceof ResourceProofRejectedError
        ? error
        : new ResourceProofRejectedError(
            reason,
            error instanceof Error ? error.message : String(error)
          );
    }
  };

  const readRecord = async (
    operationId: string
  ): Promise<Readonly<InternalRecord>> => {
    const record = await repository.read(operationId);
    if (record === undefined)
      rejected("binding_mismatch", "Operation has no resource evidence");
    return record;
  };

  const resourceController: InternalResourceProofController = {
    prepare,
    read: async (operationId) => snapshot(await readRecord(operationId)),
    reviewInputTarget: async (operationId, paths) => {
      await resourceController.revalidate(operationId);
      const record = await readRecord(operationId);
      if (record.snapshot.state !== "held")
        rejected("handoff_unconfirmed", "Resource acquisition is not held");
      const write = record.request.effectiveManifest.write;
      if (
        write.kind === "none" ||
        (write.kind === "literals" &&
          paths.some((path) => !write.paths.includes(path)))
      ) {
        rejected(
          "permission_mismatch",
          "Current resource evidence does not authorize the review input files"
        );
      }
      const registration = registrationFor(record.request);
      const connection = registration.reviewInputPreparation;
      if (connection === undefined)
        rejected(
          "authority_unavailable",
          "Trusted resource authority has no review input preparation connection"
        );
      const acquisitionId = record.snapshot.acquisitionId;
      return Object.freeze({
        operationId,
        acquisitionId,
        workspace: structuredClone(record.request.workspace),
        connection,
        confirmCurrentAuthority: async () => {
          const current = await resourceController.revalidate(operationId);
          if (
            current.evidence.state !== "held" ||
            current.evidence.acquisitionId !== acquisitionId
          ) {
            rejected(
              "handoff_unconfirmed",
              "Review input resource authority did not remain held"
            );
          }
        },
      });
    },
    revalidate: async (operationId) => {
      let record = await readRecord(operationId);
      if (
        (record.snapshot.state !== "held" &&
          record.snapshot.state !== "releasing") ||
        record.snapshot.proof === undefined
      )
        rejected("handoff_unconfirmed", "Resource acquisition is not held");
      const registration = registrationFor(record.request);
      const trust = await registration.issuer.isCurrentlyTrusted(
        record.registrationGeneration
      );
      if (trust !== "trusted")
        rejected(
          trust === "revoked" ? "authority_revoked" : "validation_unknown",
          "Resource authority is not currently trusted"
        );
      const manifest = permissionManifestDocument(
        record.request.requestedManifest
      );
      const adapterRequest = {
        acquisitionId: record.snapshot.acquisitionId,
        startAttemptId: record.request.startAttemptId,
        requestDigest: record.snapshot.requestDigest,
        operationId,
        workerProcessInstanceId: record.request.workerProcessInstanceId,
        permissionManifest: record.request.requestedManifest,
        workspace: record.request.workspace,
        resources: record.canonicalResources,
        permissionManifestDigest: manifest.digest,
      } as const;
      const validation = await registration.adapter.inspect(adapterRequest);
      validateValidationBinding(validation, record);
      if (!(await registration.issuer.verify(validation.evidence)))
        rejected(
          "invalid_proof",
          "Validation evidence issuer verification failed"
        );
      const document: Readonly<CanonicalProofDocument> = parseProofDocument(
        validation.evidence
      );
      requireDocumentBinding(
        document,
        {
          schemaVersion: 1,
          kind: "resource-validation",
          validationId: validation.validationId,
          acquisitionId: validation.acquisitionId,
          startAttemptId: validation.startAttemptId,
          state: validation.state,
          authorityId: validation.authorityId,
          authorityRegistrationId: validation.authorityRegistrationId,
          authorityGeneration: validation.authorityGeneration,
          operationId: validation.operationId,
          workerProcessInstanceId: validation.workerProcessInstanceId,
          requestDigest: validation.requestDigest,
          proofDigest: validation.proofDigest,
          checkedAt: validation.checkedAt,
          ...(validation.validUntil === undefined
            ? {}
            : { validUntil: validation.validUntil }),
          ...(validation.generation === undefined
            ? {}
            : { generation: validation.generation }),
          handoffConfirmed: validation.handoffConfirmed,
          relatedExecutionAccessBlocked:
            validation.relatedExecutionAccessBlocked,
        },
        "Validation proof bytes do not bind the declared validation"
      );
      record = await repository.write(operationId, record.version, {
        request: record.request,
        registrationGeneration: record.registrationGeneration,
        canonicalResources: record.canonicalResources,
        snapshot: {
          ...record.snapshot,
          validations: [
            ...record.snapshot.validations,
            { ...validation, evidence: document },
          ],
        },
      });
      requireValidHandoff(validation);
      return snapshot(record);
    },
    cleanup: async (operationId, credential) => {
      if (cleanupInProgress.has(operationId))
        rejected("cleanup_unresolved", "Resource cleanup is already running");
      let record: Readonly<InternalRecord> | undefined;
      cleanupInProgress.add(operationId);
      try {
        record = await readRecord(operationId);
        let actorId = "pions-runtime";
        if (credential === safetyCleanupCredential) {
          const delegated = record.request.requirements.safetyCleanupOperations;
          if (
            !["inspect", "revoke", "release"].every((operation) =>
              delegated.includes(operation as "inspect" | "revoke" | "release")
            )
          ) {
            rejected(
              "authority_unavailable",
              "Required safety cleanup operations were not delegated"
            );
          }
          actorId = "pions-runtime-safety";
        } else if (credential === automaticCleanupCredential) {
          if (record.request.requirements.cleanupPolicy !== "automatic") {
            rejected(
              "authority_unavailable",
              "Automatic cleanup was not delegated for this Operation"
            );
          }
        } else {
          const authenticator = options.cleanupAuthenticator;
          if (authenticator === undefined)
            rejected(
              "authority_unavailable",
              "Resource cleanup authentication is unavailable"
            );
          const principal = await authenticator.authenticate(credential);
          actorId = principal.subjectId;
          if (
            !(await principal.canCleanup(operationId, [
              "inspect",
              "revoke",
              "release",
            ]))
          ) {
            rejected(
              "authority_unavailable",
              "Actor lacks resource cleanup authority"
            );
          }
        }
        if (
          record.snapshot.cleanupAttempts >=
          record.request.requirements.maxCleanupAttempts
        ) {
          rejected(
            "cleanup_unresolved",
            "Resource cleanup recovery budget is exhausted"
          );
        }
        const registration = registrationFor(record.request);
        const manifest = permissionManifestDocument(
          record.request.requestedManifest
        );
        const adapterRequest = {
          acquisitionId: record.snapshot.acquisitionId,
          startAttemptId: record.request.startAttemptId,
          requestDigest: record.snapshot.requestDigest,
          operationId,
          workerProcessInstanceId: record.request.workerProcessInstanceId,
          permissionManifest: record.request.requestedManifest,
          workspace: record.request.workspace,
          resources: record.canonicalResources,
          permissionManifestDigest: manifest.digest,
        } as const;
        const attempt = record.snapshot.cleanupAttempts + 1;
        const cleanupId = digest(
          `${operationId}\u0000${actorId}\u0000${attempt}`
        ).slice("sha256:".length);
        record = await repository.write(operationId, record.version, {
          request: record.request,
          registrationGeneration: record.registrationGeneration,
          canonicalResources: record.canonicalResources,
          snapshot: {
            ...record.snapshot,
            state: "releasing",
            cleanupAttempts: attempt,
            cleanup: { cleanupId, actorId, state: "running", attempt },
          },
        });
        try {
          await withTimeout(
            resourceController.revalidate(operationId),
            record.request.requirements.cleanupTimeoutMs
          );
        } catch (error) {
          if (
            error instanceof ResourceProofRejectedError &&
            error.reason === "persistence_failed"
          )
            throw error;
          // Invalid or unknown current state still requires access revocation before any release.
        }
        record = await readRecord(operationId);
        const blocked = await withTimeout(
          registration.adapter.revokeAccess(adapterRequest),
          record.request.requirements.cleanupTimeoutMs
        );
        if (blocked !== "blocked") {
          record = await repository.write(operationId, record.version, {
            request: record.request,
            registrationGeneration: record.registrationGeneration,
            canonicalResources: record.canonicalResources,
            snapshot: {
              ...record.snapshot,
              state: "unresolved",
              accessRevocation: "unknown",
              cleanup: { ...record.snapshot.cleanup!, state: "unresolved" },
              diagnostic: "cleanup_unresolved",
            },
          });
          rejected(
            "cleanup_unresolved",
            "Resource access blocking is unresolved"
          );
        }
        record = await repository.write(operationId, record.version, {
          request: record.request,
          registrationGeneration: record.registrationGeneration,
          canonicalResources: record.canonicalResources,
          snapshot: { ...record.snapshot, accessRevocation: "blocked" },
        });
        const released = await withTimeout(
          registration.adapter.release(adapterRequest),
          record.request.requirements.cleanupTimeoutMs
        );
        record = await repository.write(operationId, record.version, {
          request: record.request,
          registrationGeneration: record.registrationGeneration,
          canonicalResources: record.canonicalResources,
          snapshot:
            released === "released"
              ? {
                  ...record.snapshot,
                  state: "released",
                  release: "released",
                  cleanup: { ...record.snapshot.cleanup!, state: "completed" },
                }
              : {
                  ...record.snapshot,
                  state: "unresolved",
                  release: "unknown",
                  cleanup: { ...record.snapshot.cleanup!, state: "unresolved" },
                  diagnostic: "cleanup_unresolved",
                },
        });
        if (released !== "released")
          rejected("cleanup_unresolved", "Resource release is unresolved");
        return snapshot(record);
      } catch (error) {
        if (record !== undefined && record.snapshot.state !== "unresolved") {
          await persistDiagnostic(record, "cleanup_unresolved");
        }
        throw error instanceof ResourceProofRejectedError
          ? error
          : new ResourceProofRejectedError(
              "cleanup_unresolved",
              error instanceof Error ? error.message : String(error)
            );
      } finally {
        cleanupInProgress.delete(operationId);
      }
    },
    automaticCleanup: (operationId) =>
      resourceController.cleanup(operationId, automaticCleanupCredential),
    safetyCleanup: (operationId) =>
      resourceController.cleanup(operationId, safetyCleanupCredential),
    markCleanupUnresolved: async (operationId) => {
      const record = await readRecord(operationId);
      const updated = await repository.write(operationId, record.version, {
        request: record.request,
        registrationGeneration: record.registrationGeneration,
        canonicalResources: record.canonicalResources,
        snapshot: {
          ...record.snapshot,
          state: "unresolved",
          diagnostic: "cleanup_unresolved",
        },
      });
      return snapshot(updated);
    },
  };
  return resourceController;
}
