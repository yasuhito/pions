import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  ArtifactStoreOpenError,
  ResultAcceptanceManifestError,
  type ArtifactAuthorityDecision,
  type ArtifactFailureReason,
  type ArtifactGarbageCollectionOutcome,
  type ArtifactGarbageCollectionRequest,
  type ArtifactMetadata,
  type ArtifactPrincipal,
  type ArtifactRegistrationOutcome,
  type ArtifactRegistrationRequest,
  type ArtifactRegistrationSnapshot,
  type ArtifactRetentionPinOutcome,
  type ArtifactRetentionPinRequest,
  type ArtifactRetentionPinSnapshot,
  type ArtifactRetrievalOutcome,
  type ArtifactStore,
  type ArtifactUseBindingOutcome,
  type ArtifactUseBindingRequest,
  type ArtifactUseBindingSnapshot,
  type OpenArtifactStoreOptions,
  type ResultAcceptanceEventEvidence,
  type ResultAcceptancePreparationEvidence,
  type ResultAcceptancePreparationOutcome,
  type ResultAcceptancePreparationRequest,
  type ResultAcceptancePreparationSnapshot,
  type ResultAcceptanceRetentionPolicyEvidence,
  type ResolvedWorkProductRequirements,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";
import {
  resultAcceptanceManifestDocument,
  validateResultAcceptanceManifest,
} from "./result-acceptance-manifest.js";

export type ArtifactStoreFaultPoint =
  | "temporary_bytes_persisted"
  | "data_synced"
  | "directory_synced"
  | "prepared_record_persisted"
  | "before_recovery_attempt_persisted"
  | "recovery_attempt_persisted"
  | "artifact_published"
  | "registration_committed"
  | "success_response"
  | "use_binding_record_persisted"
  | "use_binding_retention_persisted"
  | "use_binding_parent_pin_persisted"
  | "use_binding_dependency_pin_persisted"
  | "use_binding_available_persisted"
  | "use_binding_rejection_persisted"
  | "before_use_binding_pins_released"
  | "before_explicit_pin_records_released"
  | "result_acceptance_record_persisted"
  | "before_result_acceptance_first_pin_persisted"
  | "result_acceptance_pin_persisted"
  | "before_result_acceptance_retention_persisted"
  | "result_acceptance_retention_persisted"
  | "result_acceptance_prepared_persisted"
  | "before_result_acceptance_active_retention_persisted"
  | "result_acceptance_active_retention_persisted"
  | "result_acceptance_accepted_persisted"
  | "before_result_acceptance_pins_released"
  | "gc_eligibility_checked"
  | "deletion_pending_persisted"
  | "before_gc_diagnostic_persisted"
  | "artifact_bytes_deleted"
  | "deletion_committed";

interface InternalOpenArtifactStoreOptions extends OpenArtifactStoreOptions {
  readonly faultInjector?: (point: ArtifactStoreFaultPoint) => void | Promise<void>;
}

interface StoredFormat {
  readonly formatId: string;
  readonly normalizationId: string;
  readonly validatorId: string;
}

interface ArtifactFormat extends StoredFormat {
  validate(bytes: Uint8Array): boolean | Promise<boolean>;
}

class ArtifactStoreInjectedFault extends Error {
  override readonly name = "ArtifactStoreInjectedFault";
}

const ROOT_SCHEMA = "pions-artifacts.v3";
const RECORD_SCHEMA = "pions-artifact-registration.v2";
const ARTIFACT_SCHEMA = "pions-artifact.v2";
const USE_SCHEMA = "pions-artifact-use-binding.v1";
const PIN_SCHEMA = "pions-artifact-pin.v1";
const RETENTION_SCHEMA = "pions-artifact-retention.v1";
const EXPLICIT_PIN_SCHEMA = "pions-artifact-explicit-pin.v1";
const GC_DIAGNOSTIC_SCHEMA = "pions-artifact-gc-diagnostic.v1";
const RESULT_ACCEPTANCE_PREPARATION_SCHEMA = "pions-result-acceptance-preparation.v1";
const RESULT_ACCEPTANCE_RETENTION_SCHEMA = "pions-result-acceptance-retention.v1";
const ROOT_FILE = "root.json";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

type RegistrationState = "receiving" | "prepared" | "registered" | "aborted" | "unresolved";

interface RegistrationRecord {
  readonly schema: typeof RECORD_SCHEMA;
  readonly request: ArtifactRegistrationRequest;
  readonly requestDigest: `sha256:${string}`;
  readonly subjectId: string;
  readonly artifactId: string;
  readonly effectivePolicy: OpenArtifactStoreOptions["policy"];
  readonly state: RegistrationState;
  readonly transferGeneration: number;
  readonly temporaryFile?: string;
  readonly recoveryAttempts: number;
  readonly failureReason?: ArtifactFailureReason;
  readonly artifact?: ArtifactMetadata;
}

interface ArtifactRecord extends ArtifactMetadata {
  readonly schema: typeof ARTIFACT_SCHEMA;
  readonly dataFile: string;
  readonly lifecycle: "available" | "deletion_pending" | "deleted";
  readonly storageStatus: "verified" | "corrupt" | "uninspectable";
  readonly registeredAt: string;
  readonly unusedRetentionUntil: string;
  readonly deletionRecoveryAttempts: number;
  readonly deletionRecoveryBudget?: number;
}

interface UseBindingRecord extends ArtifactUseBindingSnapshot {
  readonly schema: typeof USE_SCHEMA;
  readonly requestDigest: `sha256:${string}`;
  readonly effectiveReviewRetentionMs: number;
  readonly failureReason?: ArtifactFailureReason;
}

interface PinRecord {
  readonly schema: typeof PIN_SCHEMA;
  readonly pinId: string;
  readonly ownerType: "artifact_use_binding" | "principal" | "result_acceptance_preparation";
  readonly ownerId: string;
  readonly purpose: string;
  readonly artifactId: string;
  readonly state: "held" | "released";
}

interface ExplicitPinRecord extends ArtifactRetentionPinSnapshot {
  readonly schema: typeof EXPLICIT_PIN_SCHEMA;
  readonly requestDigest: `sha256:${string}`;
}

interface RetentionRecord {
  readonly schema: typeof RETENTION_SCHEMA;
  readonly retentionId: string;
  readonly ownerType: "registration_grace" | "artifact_use_binding";
  readonly ownerId: string;
  readonly artifactId: string;
  readonly retainUntil: string;
}

interface ResultAcceptancePreparationRecord {
  readonly schema: typeof RESULT_ACCEPTANCE_PREPARATION_SCHEMA;
  readonly request: ResultAcceptancePreparationRequest;
  readonly requestDigest: `sha256:${string}`;
  readonly subjectId: string;
  readonly evidence: ResultAcceptancePreparationEvidence;
  readonly requirements: ResolvedWorkProductRequirements;
  readonly state: ResultAcceptancePreparationSnapshot["state"];
  readonly effectiveAcceptedRetentionMs: number;
  readonly retentionPolicy: ResultAcceptanceRetentionPolicyEvidence;
  readonly retentionUntil?: string;
  readonly eventEvidence?: ResultAcceptanceEventEvidence;
  readonly failureReason?: ArtifactFailureReason;
}

interface ResultAcceptanceRetentionRecord {
  readonly schema: typeof RESULT_ACCEPTANCE_RETENTION_SCHEMA;
  readonly preparationId: string;
  readonly operationId: string;
  readonly acceptanceRequestId: string;
  readonly artifactIds: ReadonlyArray<string>;
  readonly retentionMs: number;
  readonly state: "pending" | "active" | "cancelled";
  readonly retainUntil?: string;
  readonly eventEvidence?: ResultAcceptanceEventEvidence;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return sha256Digest(bytes);
}

function temporaryPrefix(registrationId: string): string {
  return `transfer-${sha256(registrationId).slice("sha256:".length)}-`;
}

function protectionId(ownerType: string, ownerId: string, artifactId: string): string {
  return sha256(`${ownerType}\0${ownerId}\0${artifactId}`).slice("sha256:".length);
}

function requestDigest(request: Readonly<ArtifactRegistrationRequest>): `sha256:${string}` {
  return sha256(JSON.stringify({
    registrationId: request.registrationId,
    expectedByteCount: request.expectedByteCount,
    expectedDigest: request.expectedDigest,
    formatId: request.formatId,
    normalizationId: request.normalizationId,
    dependencies: request.dependencies,
    deadline: request.deadline,
    recoveryBudget: request.recoveryBudget,
  }));
}

function failed(reason: ArtifactFailureReason, terminal = true): ArtifactRegistrationOutcome {
  return { kind: "failed", terminal, reason };
}

function useBindingFailed(reason: ArtifactFailureReason, terminal = true): ArtifactUseBindingOutcome {
  return { kind: "failed", terminal, reason };
}

function gcFailed(reason: ArtifactFailureReason, terminal = true): ArtifactGarbageCollectionOutcome {
  return { kind: "failed", terminal, reason };
}

function useBindingRequestDigest(request: Readonly<ArtifactUseBindingRequest>): `sha256:${string}` {
  return sha256(JSON.stringify(request));
}

function pinRequestDigest(request: Readonly<ArtifactRetentionPinRequest>): `sha256:${string}` {
  return sha256(JSON.stringify(request));
}

function resultAcceptanceRequestDigest(request: Readonly<ResultAcceptancePreparationRequest>): `sha256:${string}` {
  return sha256(JSON.stringify({
    preparationId: request.preparationId,
    operationId: request.operationId,
    acceptanceRequestId: request.acceptanceRequestId,
    manifestDigest: request.manifestDigest,
    requirementsDigest: request.requirementsDigest,
    retentionPolicyDigest: request.retentionPolicyDigest,
    manifest: resultAcceptanceManifestDocument(request.manifest).value,
  }));
}

function resultAcceptanceEvidenceDigest(
  evidence: Omit<ResultAcceptancePreparationEvidence, "digest">,
): `sha256:${string}` {
  return sha256(JSON.stringify(evidence));
}

function retentionPolicyDigest(
  policy: Omit<ResultAcceptanceRetentionPolicyEvidence, "digest">,
): `sha256:${string}` {
  return sha256(JSON.stringify(policy));
}

function resultAcceptanceOutcome(record: ResultAcceptancePreparationRecord): ResultAcceptancePreparationOutcome {
  const preparation: ResultAcceptancePreparationSnapshot = {
    ...(record.state === "preparing" || record.state === "unresolved" ? {} : { evidence: record.evidence }),
    state: record.state,
    ...(record.retentionUntil === undefined ? {} : { retentionUntil: record.retentionUntil }),
  };
  if (record.state === "prepared") return { kind: "prepared", preparation: { ...preparation, evidence: record.evidence } };
  if (record.state === "accepted") return { kind: "accepted", preparation: { ...preparation, evidence: record.evidence } };
  if (record.state === "aborted") return { kind: "aborted", preparation: { ...preparation, evidence: record.evidence } };
  if (record.state === "preparing") return { kind: "continuable", preparation };
  return { kind: "failed", terminal: false, reason: record.failureReason ?? "storage_inspection_unavailable" };
}

function resultAcceptanceFailed(
  reason: ArtifactFailureReason | ResultAcceptanceManifestError["reason"],
  terminal = true,
): ResultAcceptancePreparationOutcome {
  return { kind: "failed", terminal, reason };
}

function pinOutcome(record: ExplicitPinRecord): ArtifactRetentionPinOutcome {
  return { kind: record.state, pin: record };
}

function pinFailed(reason: ArtifactFailureReason, terminal = true): ArtifactRetentionPinOutcome {
  return { kind: "failed", terminal, reason };
}

function useBindingOutcome(record: UseBindingRecord): ArtifactUseBindingOutcome {
  if (record.state === "available") return { kind: "available", binding: record };
  if (record.state === "released") return { kind: "released", binding: record };
  if (record.state === "preparing") return { kind: "continuable", binding: record };
  return useBindingFailed(record.failureReason ?? "storage_inspection_unavailable", record.state === "rejected");
}

function retrievalFailed(reason: ArtifactFailureReason, terminal = true): ArtifactRetrievalOutcome {
  return { kind: "failed", terminal, reason };
}

function authorityFailure(decision: ArtifactAuthorityDecision): ArtifactFailureReason | undefined {
  switch (decision) {
    case "allowed": return undefined;
    case "denied": return "unauthorized";
    case "revoked": return "authority_revoked";
    case "unknown": return "authority_unavailable";
  }
}

function registrationSnapshot(record: RegistrationRecord): ArtifactRegistrationSnapshot {
  return {
    registrationId: record.request.registrationId,
    artifactId: record.artifactId,
    state: record.state === "prepared" ? "prepared" : "receiving",
    expectedByteCount: record.request.expectedByteCount,
    expectedDigest: record.request.expectedDigest,
    formatId: record.request.formatId,
    normalizationId: record.request.normalizationId,
    dependencies: [...record.request.dependencies],
  };
}

function outcome(record: RegistrationRecord): ArtifactRegistrationOutcome {
  if (record.state === "registered" && record.artifact !== undefined) {
    return { kind: "registered", artifact: record.artifact };
  }
  if (record.state === "receiving" || record.state === "prepared") {
    return { kind: "continuable", reason: "transfer_incomplete", registration: registrationSnapshot(record) };
  }
  return failed(record.failureReason ?? "storage_inspection_unavailable");
}

function builtInFormats(): ReadonlyArray<ArtifactFormat> {
  return [
    {
      formatId: "pions.opaque.v1",
      normalizationId: "identity.v1",
      validatorId: "pions.opaque-validator.v1",
      validate: () => true,
    },
    {
      formatId: "pions.result-body.v1",
      normalizationId: "identity.v1",
      validatorId: "pions.utf8-validator.v1",
      validate(bytes) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          return true;
        } catch {
          return false;
        }
      },
    },
  ];
}

function configuredFormats(): ReadonlyArray<Readonly<ArtifactFormat>> {
  return builtInFormats();
}

function policyIsValid(value: unknown): value is OpenArtifactStoreOptions["policy"] {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Partial<OpenArtifactStoreOptions["policy"]>;
  return [
    policy.maxArtifactBytes,
    policy.maxConcurrentRegistrations,
    policy.maxTemporaryBytes,
    policy.maxDirectDependencies,
    policy.maxDependencyDepth,
    policy.maxDependencyCount,
    policy.maxRegistrationWindowMs,
    policy.maxRecoveryAttempts,
    policy.unusedArtifactRetentionMs,
    policy.reviewInputRetentionMs,
    policy.maxGarbageCollectionScan,
    policy.maxGarbageCollectionDeletes,
    policy.maxGarbageCollectionRecoveryAttempts,
  ].every((limit) => Number.isSafeInteger(limit) && (limit ?? 0) > 0);
}

function validatePolicy(policy: OpenArtifactStoreOptions["policy"]): void {
  if (!policyIsValid(policy)) {
    throw new ArtifactStoreOpenError("invalid_policy", "Artifact storage limits must be positive safe integers");
  }
}

function storedFormats(formats: ReadonlyArray<Readonly<ArtifactFormat>>): ReadonlyArray<StoredFormat> {
  return formats.map(({ formatId, normalizationId, validatorId }) => ({ formatId, normalizationId, validatorId }))
    .sort((left, right) => `${left.formatId}\0${left.normalizationId}`.localeCompare(`${right.formatId}\0${right.normalizationId}`));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function validRequestShape(request: Readonly<ArtifactRegistrationRequest>): boolean {
  return IDENTIFIER.test(request.registrationId) &&
    Number.isSafeInteger(request.expectedByteCount) && request.expectedByteCount >= 0 &&
    /^sha256:[a-f0-9]{64}$/u.test(request.expectedDigest) &&
    IDENTIFIER.test(request.formatId) && IDENTIFIER.test(request.normalizationId) &&
    request.dependencies.every((dependency) => IDENTIFIER.test(dependency)) &&
    Number.isSafeInteger(request.recoveryBudget) && request.recoveryBudget > 0 &&
    Number.isFinite(Date.parse(request.deadline));
}

class FileArtifactStore implements ArtifactStore {
  private readonly registrationDirectory: string;
  private readonly artifactDirectory: string;
  private readonly useBindingDirectory: string;
  private readonly pinDirectory: string;
  private readonly retentionDirectory: string;
  private readonly explicitPinDirectory: string;
  private readonly resultAcceptancePreparationDirectory: string;
  private readonly resultAcceptanceRetentionDirectory: string;
  private readonly garbageCollectionDiagnosticDirectory: string;
  private readonly formats = new Map<string, Readonly<ArtifactFormat>>();
  private readonly transferTokens = new Map<string, symbol>();
  private readonly transferStops = new Map<string, Promise<void>>();
  private readonly transferCancellations = new Map<symbol, () => void>();
  private readonly transferByteCounts = new Map<symbol, number>();
  private temporaryBytes = 0;
  private closed = false;
  private updateTail: Promise<void> = Promise.resolve();
  private ioTail: Promise<void> = Promise.resolve();
  private readonly activeTransfers = new Set<Promise<ArtifactRegistrationOutcome>>();
  private closing: Promise<void> | undefined;

  constructor(
    private readonly options: InternalOpenArtifactStoreOptions,
    private readonly lockDirectory: string,
  ) {
    this.registrationDirectory = join(options.rootDirectory, "registrations");
    this.artifactDirectory = join(options.rootDirectory, "artifacts");
    this.useBindingDirectory = join(options.rootDirectory, "use-bindings");
    this.pinDirectory = join(options.rootDirectory, "pins");
    this.retentionDirectory = join(options.rootDirectory, "retentions");
    this.explicitPinDirectory = join(options.rootDirectory, "explicit-pins");
    this.resultAcceptancePreparationDirectory = join(options.rootDirectory, "result-acceptance-preparations");
    this.resultAcceptanceRetentionDirectory = join(options.rootDirectory, "result-acceptance-retentions");
    this.garbageCollectionDiagnosticDirectory = join(options.rootDirectory, "gc-diagnostics");
    for (const format of configuredFormats()) {
      this.formats.set(`${format.formatId}\0${format.normalizationId}`, format);
    }
  }

  async writerOwnership(): Promise<Readonly<{ readonly pid: number; readonly processStartToken: string }>> {
    const owner = await readJson(join(this.lockDirectory, "owner.json")) as {
      readonly pid?: unknown;
      readonly startToken?: unknown;
    };
    if (owner.pid !== process.pid || typeof owner.startToken !== "string") {
      throw new ArtifactStoreOpenError("writer_locked", "Artifact writer ownership changed");
    }
    const current = await processStartToken(process.pid);
    if (current !== owner.startToken) {
      throw new ArtifactStoreOpenError("writer_locked", "Artifact writer ownership changed");
    }
    return { pid: owner.pid, processStartToken: owner.startToken };
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private async fault(point: ArtifactStoreFaultPoint): Promise<void> {
    try {
      await this.options.faultInjector?.(point);
    } catch (error) {
      throw new ArtifactStoreInjectedFault(`Injected Artifact storage fault at ${point}`, { cause: error });
    }
  }

  private async serialize<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.updateTail;
    let release!: () => void;
    this.updateTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async serializeIo<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.ioTail;
    let release!: () => void;
    this.ioTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private recordPath(registrationId: string): string {
    return join(this.registrationDirectory, `${registrationId}.json`);
  }

  private artifactPath(artifactId: string): string {
    return join(this.artifactDirectory, `${artifactId}.json`);
  }

  private useBindingPath(bindingId: string): string {
    return join(this.useBindingDirectory, `${bindingId}.json`);
  }

  private pinPath(pinId: string): string {
    return join(this.pinDirectory, `${pinId}.json`);
  }

  private retentionPath(retentionId: string): string {
    return join(this.retentionDirectory, `${retentionId}.json`);
  }

  private explicitPinPath(pinId: string): string {
    return join(this.explicitPinDirectory, `${pinId}.json`);
  }

  private resultAcceptancePreparationPath(preparationId: string): string {
    return join(this.resultAcceptancePreparationDirectory, `${preparationId}.json`);
  }

  private resultAcceptanceRetentionPath(preparationId: string): string {
    return join(this.resultAcceptanceRetentionDirectory, `${preparationId}.json`);
  }

  private async readResultAcceptancePreparation(
    preparationId: string,
  ): Promise<ResultAcceptancePreparationRecord | undefined> {
    if (!IDENTIFIER.test(preparationId)) return undefined;
    try {
      const value = await readJson(this.resultAcceptancePreparationPath(preparationId)) as Partial<ResultAcceptancePreparationRecord>;
      if (value.schema !== RESULT_ACCEPTANCE_PREPARATION_SCHEMA || value.request?.preparationId !== preparationId ||
        value.requestDigest !== resultAcceptanceRequestDigest(value.request) || typeof value.subjectId !== "string" ||
        value.evidence?.preparationId !== preparationId || value.evidence.digest !== resultAcceptanceEvidenceDigest({
          formatId: value.evidence.formatId,
          preparationId: value.evidence.preparationId,
          operationId: value.evidence.operationId,
          acceptanceRequestId: value.evidence.acceptanceRequestId,
          manifestDigest: value.evidence.manifestDigest,
          requirementsDigest: value.evidence.requirementsDigest,
          bodyArtifactId: value.evidence.bodyArtifactId,
          workProducts: value.evidence.workProducts,
          artifactIds: value.evidence.artifactIds,
          totalByteCount: value.evidence.totalByteCount,
          acceptedArtifactRetentionMs: value.evidence.acceptedArtifactRetentionMs,
          retentionPolicyDigest: value.evidence.retentionPolicyDigest,
        }) || value.retentionPolicy?.formatId !== "pions.result-acceptance-retention-policy.v1" ||
        value.retentionPolicy.operationId !== value.request.operationId ||
        value.retentionPolicy.digest !== value.request.retentionPolicyDigest ||
        value.retentionPolicy.digest !== retentionPolicyDigest({
          formatId: value.retentionPolicy.formatId,
          operationId: value.retentionPolicy.operationId,
          acceptedArtifactRetentionMs: value.retentionPolicy.acceptedArtifactRetentionMs,
        }) || value.retentionPolicy.acceptedArtifactRetentionMs !== value.effectiveAcceptedRetentionMs ||
        value.requirements?.digest !== value.request.requirementsDigest ||
        !["preparing", "prepared", "accepted", "aborted", "unresolved"].includes(value.state ?? "") ||
        !Number.isSafeInteger(value.effectiveAcceptedRetentionMs) || (value.effectiveAcceptedRetentionMs ?? 0) <= 0) {
        throw new Error("Invalid Result acceptance preparation record");
      }
      return value as ResultAcceptancePreparationRecord;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async readResultAcceptanceRetention(preparationId: string): Promise<ResultAcceptanceRetentionRecord | undefined> {
    try {
      const value = await readJson(this.resultAcceptanceRetentionPath(preparationId)) as Partial<ResultAcceptanceRetentionRecord>;
      if (value.schema !== RESULT_ACCEPTANCE_RETENTION_SCHEMA || value.preparationId !== preparationId ||
        !IDENTIFIER.test(value.operationId ?? "") || !IDENTIFIER.test(value.acceptanceRequestId ?? "") ||
        !Array.isArray(value.artifactIds) || !value.artifactIds.every((id) => typeof id === "string" && IDENTIFIER.test(id)) ||
        !Number.isSafeInteger(value.retentionMs) || (value.retentionMs ?? 0) <= 0 ||
        !["pending", "active", "cancelled"].includes(value.state ?? "") ||
        (value.state === "active" && (!Number.isFinite(Date.parse(value.retainUntil ?? "")) ||
          value.eventEvidence?.state !== "accepted" || value.eventEvidence.preparationId !== preparationId))) {
        throw new Error("Invalid Result acceptance retention record");
      }
      return value as ResultAcceptanceRetentionRecord;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async readExplicitPin(pinId: string): Promise<ExplicitPinRecord | undefined> {
    if (!IDENTIFIER.test(pinId)) return undefined;
    try {
      const value = await readJson(this.explicitPinPath(pinId)) as Partial<ExplicitPinRecord>;
      const request: ArtifactRetentionPinRequest = {
        pinId: value.pinId ?? "",
        artifactId: value.artifactId ?? "",
        ownerId: value.ownerId ?? "",
        purpose: value.purpose ?? "",
        retention: value.retention as "indefinite",
      };
      if (value.schema !== EXPLICIT_PIN_SCHEMA || value.pinId !== pinId ||
        !IDENTIFIER.test(request.artifactId) || !IDENTIFIER.test(request.ownerId) ||
        typeof request.purpose !== "string" || request.purpose.length === 0 || request.retention !== "indefinite" ||
        value.requestDigest !== pinRequestDigest(request) || typeof value.subjectId !== "string" ||
        !Array.isArray(value.dependencyClosure) || !value.dependencyClosure.every((id) => typeof id === "string" && IDENTIFIER.test(id)) ||
        (value.state !== "held" && value.state !== "released")) throw new Error("Invalid explicit Artifact pin");
      return value as ExplicitPinRecord;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async readUseBinding(bindingId: string): Promise<UseBindingRecord | undefined> {
    if (!IDENTIFIER.test(bindingId)) return undefined;
    try {
      const value = await readJson(this.useBindingPath(bindingId)) as Partial<UseBindingRecord>;
      const states = ["preparing", "available", "rejected", "released", "unresolved"];
      const request: ArtifactUseBindingRequest = {
        bindingId: value.bindingId ?? "",
        operationId: value.operationId ?? "",
        artifactId: value.artifactId ?? "",
        purpose: value.purpose as "review_subject",
        decisionId: value.decisionId ?? "",
        authorityBasis: value.authorityBasis ?? "",
      };
      if (value.schema !== USE_SCHEMA || !IDENTIFIER.test(bindingId) || value.bindingId !== bindingId ||
        !IDENTIFIER.test(request.operationId) || !IDENTIFIER.test(request.artifactId) ||
        request.purpose !== "review_subject" || !IDENTIFIER.test(request.decisionId) ||
        typeof request.authorityBasis !== "string" || request.authorityBasis.length === 0 ||
        value.requestDigest !== useBindingRequestDigest(request) || typeof value.subjectId !== "string" ||
        !Array.isArray(value.dependencyClosure) || !value.dependencyClosure.every((id) => typeof id === "string" && IDENTIFIER.test(id)) ||
        !Number.isFinite(Date.parse(value.retentionUntil ?? "")) || !states.includes(value.state ?? "") ||
        !Number.isSafeInteger(value.effectiveReviewRetentionMs) || (value.effectiveReviewRetentionMs ?? 0) <= 0) {
        throw new Error("Invalid Artifact use binding record");
      }
      return value as UseBindingRecord;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private writeUseBinding(record: UseBindingRecord): Promise<void> {
    return this.serializeIo(() => writeJson(this.useBindingPath(record.bindingId), record));
  }

  private async readRecord(registrationId: string): Promise<RegistrationRecord | undefined> {
    try {
      const path = this.recordPath(registrationId);
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink()) throw new Error("Invalid Artifact registration path");
      const value = await readJson(path) as Partial<RegistrationRecord>;
      const states: ReadonlyArray<RegistrationState> = ["receiving", "prepared", "registered", "aborted", "unresolved"];
      if (value.schema !== RECORD_SCHEMA || value.request?.registrationId !== registrationId ||
        !validRequestShape(value.request) || value.requestDigest !== requestDigest(value.request) ||
        typeof value.subjectId !== "string" || value.subjectId.length === 0 ||
        typeof value.artifactId !== "string" || !IDENTIFIER.test(value.artifactId) ||
        !policyIsValid(value.effectivePolicy) || !states.includes(value.state as RegistrationState) ||
        !Number.isSafeInteger(value.transferGeneration) || (value.transferGeneration ?? -1) < 0 ||
        !Number.isSafeInteger(value.recoveryAttempts) || (value.recoveryAttempts ?? -1) < 0 ||
        (value.temporaryFile !== undefined &&
          (!value.temporaryFile.startsWith(`${temporaryPrefix(registrationId)}${value.transferGeneration}-`) ||
            !value.temporaryFile.endsWith(".part"))) ||
        (value.state === "prepared" && typeof value.temporaryFile !== "string") ||
        (value.state === "registered" &&
          (value.artifact?.artifactId !== value.artifactId || value.artifact.digest !== value.request.expectedDigest ||
            value.artifact.byteCount !== value.request.expectedByteCount ||
            value.artifact.formatId !== value.request.formatId ||
            value.artifact.normalizationId !== value.request.normalizationId ||
            JSON.stringify(value.artifact.dependencies) !== JSON.stringify(value.request.dependencies)))) {
        throw new Error("Invalid Artifact registration record");
      }
      return value as RegistrationRecord;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private writeRecord(record: RegistrationRecord): Promise<void> {
    return this.serializeIo(() => this.writeRecordUnserialized(record));
  }

  private async writeRecordUnserialized(record: RegistrationRecord): Promise<void> {
    await writeJson(this.recordPath(record.request.registrationId), record);
  }

  private async abort(record: RegistrationRecord, reason: ArtifactFailureReason): Promise<ArtifactRegistrationOutcome> {
    const aborted: RegistrationRecord = { ...record, state: "aborted", failureReason: reason };
    await this.writeRecord(aborted);
    return outcome(aborted);
  }

  private async removeTemporaryFiles(registrationId: string): Promise<void> {
    for (const entry of await readdir(this.registrationDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(temporaryPrefix(registrationId)) || !entry.name.endsWith(".part")) continue;
      const path = join(this.registrationDirectory, entry.name);
      const size = (await lstat(path)).size;
      await unlink(path).catch(() => undefined);
      this.temporaryBytes = Math.max(0, this.temporaryBytes - size);
    }
    await syncDirectory(this.registrationDirectory);
  }

  private async authenticate(credential: string): Promise<Readonly<ArtifactPrincipal> | undefined> {
    try {
      return await this.options.authenticator.authenticate(credential);
    } catch {
      return undefined;
    }
  }

  private async registrationAuthority(
    principal: Readonly<ArtifactPrincipal>,
    record: RegistrationRecord,
  ): Promise<ArtifactFailureReason | undefined> {
    if (principal.subjectId !== record.subjectId) return "unauthorized";
    try {
      return authorityFailure(await principal.canRegister(record.request));
    } catch {
      return "authority_unavailable";
    }
  }

  private requestLimitFailure(request: Readonly<ArtifactRegistrationRequest>): ArtifactFailureReason | undefined {
    const { policy } = this.options;
    if (!validRequestShape(request) || request.expectedByteCount > policy.maxArtifactBytes ||
      request.dependencies.length > policy.maxDirectDependencies ||
      request.recoveryBudget > policy.maxRecoveryAttempts ||
      Date.parse(request.deadline) - this.now().getTime() > policy.maxRegistrationWindowMs) {
      return "limit_exceeded";
    }
    if (Date.parse(request.deadline) <= this.now().getTime()) return "deadline_expired";
    if (!this.formats.has(`${request.formatId}\0${request.normalizationId}`)) return "invalid_format";
    return undefined;
  }

  private async readArtifactRecord(artifactId: string): Promise<ArtifactRecord | undefined> {
    if (!IDENTIFIER.test(artifactId)) return undefined;
    try {
      const path = this.artifactPath(artifactId);
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink()) throw new Error("Invalid Artifact record path");
      const value = await readJson(path) as Partial<ArtifactRecord>;
      if (value.schema !== ARTIFACT_SCHEMA || value.artifactId !== artifactId ||
        value.dataFile !== `${artifactId}.bin` ||
        (value.lifecycle !== "available" && value.lifecycle !== "deletion_pending" && value.lifecycle !== "deleted") ||
        (value.storageStatus !== "verified" && value.storageStatus !== "corrupt" && value.storageStatus !== "uninspectable") ||
        !Number.isSafeInteger(value.byteCount) || (value.byteCount ?? -1) < 0 ||
        typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.digest) ||
        typeof value.formatId !== "string" || typeof value.normalizationId !== "string" ||
        !this.formats.has(`${value.formatId}\0${value.normalizationId}`) ||
        !Array.isArray(value.dependencies) ||
        !value.dependencies.every((dependency) => typeof dependency === "string" && IDENTIFIER.test(dependency)) ||
        !Number.isFinite(Date.parse(value.registeredAt ?? "")) ||
        !Number.isFinite(Date.parse(value.unusedRetentionUntil ?? "")) ||
        !Number.isSafeInteger(value.deletionRecoveryAttempts) || (value.deletionRecoveryAttempts ?? -1) < 0 ||
        (value.deletionRecoveryBudget !== undefined &&
          (!Number.isSafeInteger(value.deletionRecoveryBudget) || value.deletionRecoveryBudget <= 0))) {
        throw new Error("Invalid Artifact record");
      }
      return value as ArtifactRecord;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async dependencyClosure(
    dependencies: ReadonlyArray<string>,
    policy: OpenArtifactStoreOptions["policy"],
    authorize?: (artifactId: string) => Promise<ArtifactAuthorityDecision>,
  ): Promise<{ readonly records: ReadonlyArray<ArtifactRecord>; readonly reason?: ArtifactFailureReason }> {
    const records: Array<ArtifactRecord> = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const walk = async (artifactId: string, depth: number): Promise<ArtifactFailureReason | undefined> => {
      if (visiting.has(artifactId)) return "dependency_cycle";
      if (visited.has(artifactId)) return undefined;
      if (depth > policy.maxDependencyDepth || visited.size + visiting.size >= policy.maxDependencyCount) return "limit_exceeded";
      if (authorize !== undefined) {
        let decision: ArtifactAuthorityDecision;
        try { decision = await authorize(artifactId); } catch { return "authority_unavailable"; }
        const denied = authorityFailure(decision);
        if (denied !== undefined) return denied;
      }
      const record = await this.readArtifactRecord(artifactId);
      if (record === undefined) return "dependency_not_found";
      if (record.lifecycle === "deletion_pending") return "artifact_deletion_pending";
      if (record.lifecycle === "deleted") return "artifact_deleted";
      visiting.add(artifactId);
      for (const dependency of record.dependencies) {
        const reason = await walk(dependency, depth + 1);
        if (reason !== undefined) return reason;
      }
      visiting.delete(artifactId);
      visited.add(artifactId);
      records.push(record);
      return undefined;
    };
    for (const dependency of dependencies) {
      const reason = await walk(dependency, 1);
      if (reason !== undefined) return { records, reason };
    }
    return { records };
  }

  async startRegistration(
    credential: string,
    request: Readonly<ArtifactRegistrationRequest>,
  ): Promise<ArtifactRegistrationOutcome> {
    return this.serialize(() => this.startRegistrationUnserialized(credential, request))
      .catch(() => failed("storage_inspection_unavailable"));
  }

  private async startRegistrationUnserialized(
    credential: string,
    request: Readonly<ArtifactRegistrationRequest>,
  ): Promise<ArtifactRegistrationOutcome> {
    if (this.closed) return failed("storage_inspection_unavailable");
    const principal = await this.authenticate(credential);
    if (principal === undefined) return failed("unauthorized");
    const existing = IDENTIFIER.test(request.registrationId) ? await this.readRecord(request.registrationId) : undefined;
    if (existing !== undefined) {
      const authority = await this.registrationAuthority(principal, existing);
      if (authority === "authority_revoked" && existing.state !== "registered") return this.abort(existing, authority);
      if (authority !== undefined) return failed(authority, authority !== "authority_unavailable");
      if (requestDigest(request) !== existing.requestDigest) return failed("request_mismatch");
      return outcome(existing);
    }
    const limitFailure = this.requestLimitFailure(request);
    if (limitFailure !== undefined) return failed(limitFailure);
    let authority: ArtifactFailureReason | undefined;
    try { authority = authorityFailure(await principal.canRegister(request)); } catch { authority = "authority_unavailable"; }
    if (authority !== undefined) return failed(authority, authority !== "authority_unavailable");
    const closure = await this.dependencyClosure(
      request.dependencies,
      this.options.policy,
      (artifactId) => principal.canReference(artifactId),
    );
    if (closure.reason !== undefined) return failed(closure.reason, closure.reason !== "authority_unavailable");
    const entries = await readdir(this.registrationDirectory);
    let active = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.readRecord(entry.slice(0, -5));
      if (record?.state === "receiving" && Date.parse(record.request.deadline) <= this.now().getTime()) {
        await this.abort(record, "deadline_expired");
        await this.removeTemporaryFiles(record.request.registrationId);
        continue;
      }
      if (record?.state === "receiving" || record?.state === "prepared") active += 1;
    }
    if (active >= this.options.policy.maxConcurrentRegistrations) return failed("limit_exceeded");
    const artifactId = (this.options.idGenerator ?? randomUUID)();
    if (!IDENTIFIER.test(artifactId)) return failed("limit_exceeded");
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.readRecord(entry.slice(0, -5));
      if (record?.artifactId === artifactId) return failed("conflict");
    }
    if (await this.readArtifactRecord(artifactId) !== undefined) return failed("conflict");
    const record: RegistrationRecord = {
      schema: RECORD_SCHEMA,
      request: { ...request, dependencies: [...request.dependencies] },
      requestDigest: requestDigest(request),
      subjectId: principal.subjectId,
      artifactId,
      effectivePolicy: { ...this.options.policy },
      state: "receiving",
      transferGeneration: 0,
      recoveryAttempts: 0,
    };
    try {
      await this.writeRecord(record);
    } catch (error) {
      if (hasCode(error, "EEXIST")) return failed("conflict");
      throw error;
    }
    return outcome(record);
  }

  async transfer(
    credential: string,
    registrationId: string,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<ArtifactRegistrationOutcome> {
    if (this.closed) return failed("storage_inspection_unavailable");
    const predecessor = this.transferStops.get(registrationId);
    const previousToken = this.transferTokens.get(registrationId);
    if (previousToken !== undefined) this.transferCancellations.get(previousToken)?.();
    const token = Symbol(registrationId);
    this.transferTokens.set(registrationId, token);
    let signalCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => { signalCancelled = resolve; });
    this.transferCancellations.set(token, signalCancelled);
    let signalStopped!: () => void;
    const stopped = new Promise<void>((resolve) => { signalStopped = resolve; });
    this.transferStops.set(registrationId, stopped);
    const transfer = (async () => {
      try {
        await predecessor;
        return await this.transferUntracked(credential, registrationId, bytes, token, cancelled);
      } finally {
        signalStopped();
        this.transferCancellations.delete(token);
        if (this.transferTokens.get(registrationId) === token) this.transferTokens.delete(registrationId);
        if (this.transferStops.get(registrationId) === stopped) this.transferStops.delete(registrationId);
      }
    })();
    this.activeTransfers.add(transfer);
    try {
      return await transfer;
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      return failed("storage_inspection_unavailable");
    } finally {
      this.activeTransfers.delete(transfer);
    }
  }

  private async transferUntracked(
    credential: string,
    registrationId: string,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
    token: symbol,
    cancelled: Promise<void>,
  ): Promise<ArtifactRegistrationOutcome> {
    if (this.transferTokens.get(registrationId) !== token) return failed("conflict", false);
    const principal = await this.authenticate(credential);
    if (principal === undefined || !IDENTIFIER.test(registrationId)) return failed("unauthorized");
    let record = await this.readRecord(registrationId);
    if (record === undefined) return failed("unauthorized");
    const authority = await this.registrationAuthority(principal, record);
    if (authority !== undefined) {
      if (authority === "authority_revoked" && record.state !== "registered") return this.abort(record, authority);
      return failed(authority, authority !== "authority_unavailable");
    }
    if (record.state !== "receiving") return outcome(record);
    if (Date.parse(record.request.deadline) <= this.now().getTime()) {
      record = { ...record, state: "aborted", failureReason: "deadline_expired" };
      await this.writeRecord(record);
      return outcome(record);
    }

    this.transferByteCounts.set(token, 0);
    const generation = record.transferGeneration + 1;
    record = { ...record, transferGeneration: generation };
    await this.writeRecord(record);
    await this.removeTemporaryFiles(registrationId);
    const temporaryFile = `${temporaryPrefix(registrationId)}${generation}-${randomUUID()}.part`;
    const temporaryPath = join(this.registrationDirectory, temporaryFile);
    const handle = await open(temporaryPath, "wx", 0o600);
    let count = 0;
    const hash = createHash("sha256");
    let complete = false;
    try {
      const source: AsyncIterable<Uint8Array> = Symbol.asyncIterator in Object(bytes)
        ? bytes as AsyncIterable<Uint8Array>
        : (async function* () { yield bytes as Uint8Array; })();
      const iterator = source[Symbol.asyncIterator]();
      while (true) {
        const remainingMs = Math.max(0, Date.parse(record.request.deadline) - this.now().getTime());
        const next = await new Promise<IteratorResult<Uint8Array> | "cancelled" | "expired">((resolveNext, rejectNext) => {
          const timer = setTimeout(() => resolveNext("expired"), remainingMs);
          timer.unref();
          let settled = false;
          const settle = (value: IteratorResult<Uint8Array> | "cancelled" | "expired") => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveNext(value);
          };
          cancelled.then(() => settle("cancelled"));
          iterator.next().then((value) => settle(value), rejectNext);
        });
        if (next === "cancelled") {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
          return failed("conflict", false);
        }
        if (next === "expired") {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
          return this.abort(record, "deadline_expired");
        }
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) return this.abort(record, "input_integrity_mismatch");
        count += chunk.byteLength;
        if (count > record.request.expectedByteCount || count > record.effectivePolicy.maxArtifactBytes ||
          this.temporaryBytes + chunk.byteLength > record.effectivePolicy.maxTemporaryBytes) {
          return this.abort(record, "limit_exceeded");
        }
        this.temporaryBytes += chunk.byteLength;
        this.transferByteCounts.set(token, (this.transferByteCounts.get(token) ?? 0) + chunk.byteLength);
        await handle.writeFile(chunk);
        hash.update(chunk);
      }
      await this.fault("temporary_bytes_persisted");
      if (count !== record.request.expectedByteCount) return outcome(record);
      if (`sha256:${hash.digest("hex")}` !== record.request.expectedDigest) return this.abort(record, "input_integrity_mismatch");
      await handle.sync();
      await this.fault("data_synced");
      await handle.close();
      await syncDirectory(this.registrationDirectory);
      await this.fault("directory_synced");
      if (this.transferTokens.get(registrationId) !== token) return failed("conflict", false);
      if (Date.parse(record.request.deadline) <= this.now().getTime()) {
        record = { ...record, state: "aborted", failureReason: "deadline_expired" };
        await this.writeRecord(record);
        return outcome(record);
      }
      const transferred = await readFile(temporaryPath);
      const format = this.formats.get(`${record.request.formatId}\0${record.request.normalizationId}`);
      if (format === undefined || !(await format.validate(Uint8Array.from(transferred)))) {
        record = { ...record, state: "aborted", failureReason: "invalid_format" };
        await this.writeRecord(record);
        return outcome(record);
      }
      const currentAuthority = await this.registrationAuthority(principal, record);
      if (currentAuthority !== undefined) {
        if (currentAuthority === "authority_unavailable") return failed(currentAuthority, false);
        return this.abort(record, currentAuthority);
      }
      const closure = await this.dependencyClosure(
        record.request.dependencies,
        record.effectivePolicy,
        (artifactId) => principal.canReference(artifactId),
      );
      if (closure.reason !== undefined) {
        if (closure.reason === "authority_unavailable") return failed(closure.reason, false);
        return this.abort(record, closure.reason);
      }
      record = { ...record, state: "prepared", temporaryFile };
      await this.writeRecord(record);
      await this.fault("prepared_record_persisted");
      const committed = await this.commitAuthorized(record, principal);
      complete = committed.kind === "registered";
      if (complete) await this.fault("success_response");
      return committed;
    } finally {
      await handle.close().catch(() => undefined);
      const latest = await this.readRecord(registrationId).catch(() => undefined);
      const published = await this.readArtifactRecord(record.artifactId).catch(() => undefined);
      if (complete || latest?.state !== "prepared" || published !== undefined) {
        await unlink(temporaryPath).catch(() => undefined);
        this.temporaryBytes = Math.max(0, this.temporaryBytes - (this.transferByteCounts.get(token) ?? 0));
      }
      this.transferByteCounts.delete(token);
    }
  }

  private commitAuthorized(
    record: RegistrationRecord,
    principal: Readonly<ArtifactPrincipal>,
  ): Promise<ArtifactRegistrationOutcome> {
    return this.serializeIo(async () => {
      const closure = await this.dependencyClosure(
        record.request.dependencies,
        record.effectivePolicy,
        (artifactId) => principal.canReference(artifactId),
      );
      if (closure.reason !== undefined) {
        if (closure.reason === "authority_unavailable") return failed(closure.reason, false);
        const aborted = { ...record, state: "aborted", failureReason: closure.reason } as const;
        await this.writeRecordUnserialized(aborted);
        return outcome(aborted);
      }
      const authority = await this.registrationAuthority(principal, record);
      if (authority !== undefined) {
        if (authority === "authority_unavailable") return failed(authority, false);
        const aborted = { ...record, state: "aborted", failureReason: authority } as const;
        await this.writeRecordUnserialized(aborted);
        return outcome(aborted);
      }
      return outcome(await this.commitUnserialized(record));
    });
  }

  private commit(record: RegistrationRecord): Promise<RegistrationRecord> {
    return this.serializeIo(() => this.commitUnserialized(record));
  }

  private async commitUnserialized(record: RegistrationRecord): Promise<RegistrationRecord> {
    if (record.state !== "prepared" || record.temporaryFile === undefined) return record;
    const dataFile = `${record.artifactId}.bin`;
    const dataPath = join(this.artifactDirectory, dataFile);
    const temporaryPath = join(this.registrationDirectory, record.temporaryFile);
    if (!(await exists(dataPath))) {
      await rename(temporaryPath, dataPath);
      await syncDirectory(this.registrationDirectory);
      await syncDirectory(this.artifactDirectory);
    }
    const bytes = await readFile(dataPath);
    if (bytes.byteLength !== record.request.expectedByteCount || sha256(bytes) !== record.request.expectedDigest) {
      throw new Error("Prepared Artifact bytes do not match their fixed integrity metadata");
    }
    const registeredAt = this.now();
    let artifact: ArtifactRecord = {
      schema: ARTIFACT_SCHEMA,
      artifactId: record.artifactId,
      byteCount: record.request.expectedByteCount,
      digest: record.request.expectedDigest,
      formatId: record.request.formatId,
      normalizationId: record.request.normalizationId,
      dependencies: [...record.request.dependencies],
      dataFile,
      lifecycle: "available",
      storageStatus: "verified",
      registeredAt: registeredAt.toISOString(),
      unusedRetentionUntil: new Date(registeredAt.getTime() + record.effectivePolicy.unusedArtifactRetentionMs).toISOString(),
      deletionRecoveryAttempts: 0,
    };
    const artifactPath = this.artifactPath(record.artifactId);
    if (await exists(artifactPath)) {
      const existing = await this.readArtifactRecord(record.artifactId);
      if (existing === undefined || existing.artifactId !== artifact.artifactId || existing.digest !== artifact.digest ||
        existing.byteCount !== artifact.byteCount || existing.formatId !== artifact.formatId ||
        existing.normalizationId !== artifact.normalizationId ||
        JSON.stringify(existing.dependencies) !== JSON.stringify(artifact.dependencies)) {
        throw new Error("Artifact identifier conflict");
      }
      artifact = existing;
    } else {
      await writeJson(artifactPath, artifact);
    }
    await this.fault("artifact_published");
    const registered: RegistrationRecord = { ...record, state: "registered", artifact };
    await this.writeRecordUnserialized(registered);
    await this.fault("registration_committed");
    return registered;
  }

  async registrationStatus(credential: string, registrationId: string): Promise<ArtifactRegistrationOutcome> {
    try {
      const principal = await this.authenticate(credential);
      if (principal === undefined || !IDENTIFIER.test(registrationId)) return failed("unauthorized");
      const record = await this.readRecord(registrationId);
      if (record === undefined) return failed("unauthorized");
      const authority = await this.registrationAuthority(principal, record);
      return authority === undefined ? outcome(record) : failed(authority, authority !== "authority_unavailable");
    } catch {
      return failed("storage_inspection_unavailable");
    }
  }

  private async recordStorageStatus(
    record: ArtifactRecord,
    storageStatus: ArtifactRecord["storageStatus"],
  ): Promise<void> {
    if (record.storageStatus === storageStatus) return;
    await this.serializeIo(async () => {
      const current = await this.readArtifactRecord(record.artifactId);
      if (current === undefined || current.storageStatus === "corrupt" || current.storageStatus === storageStatus) return;
      await writeJson(this.artifactPath(record.artifactId), { ...current, storageStatus });
    });
  }

  private async verifiedBytes(record: ArtifactRecord): Promise<Buffer | ArtifactFailureReason> {
    if (record.storageStatus === "corrupt") return "stored_artifact_corrupt";
    let bytes: Buffer;
    try {
      const path = join(this.artifactDirectory, record.dataFile);
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink()) {
        await this.recordStorageStatus(record, "corrupt");
        return "stored_artifact_corrupt";
      }
      bytes = await readFile(path);
    } catch (error) {
      const reason = hasCode(error, "ENOENT") ? "stored_artifact_corrupt" : "storage_inspection_unavailable";
      await this.recordStorageStatus(record, reason === "stored_artifact_corrupt" ? "corrupt" : "uninspectable").catch(() => undefined);
      return reason;
    }
    if (bytes.byteLength !== record.byteCount || sha256(bytes) !== record.digest) {
      await this.recordStorageStatus(record, "corrupt");
      return "stored_artifact_corrupt";
    }
    await this.recordStorageStatus(record, "verified");
    return bytes;
  }

  async retrieve(credential: string, artifactId: string): Promise<ArtifactRetrievalOutcome> {
    if (this.closed) return retrievalFailed("storage_inspection_unavailable");
    const principal = await this.authenticate(credential);
    if (principal === undefined) return retrievalFailed("unauthorized");
    let decision: ArtifactAuthorityDecision;
    try { decision = await principal.canRetrieve(artifactId); } catch { return retrievalFailed("unauthorized"); }
    if (decision !== "allowed") return retrievalFailed("unauthorized");
    let record: ArtifactRecord | undefined;
    try { record = await this.readArtifactRecord(artifactId); } catch { return retrievalFailed("storage_inspection_unavailable"); }
    if (record === undefined) return retrievalFailed("unauthorized");
    if (record.lifecycle === "deletion_pending") return retrievalFailed("artifact_deletion_pending");
    if (record.lifecycle === "deleted") return retrievalFailed("artifact_deleted");
    const closure = await this.dependencyClosure(
      record.dependencies,
      this.options.policy,
      (dependencyId) => principal.canRetrieve(dependencyId),
    );
    if (closure.reason === "unauthorized" || closure.reason === "authority_revoked" || closure.reason === "authority_unavailable") {
      return retrievalFailed("unauthorized");
    }
    if (closure.reason !== undefined) {
      return retrievalFailed(closure.reason === "dependency_not_found" ? "stored_artifact_corrupt" : closure.reason);
    }
    for (const dependency of closure.records) {
      const verified = await this.verifiedBytes(dependency);
      if (typeof verified === "string") return retrievalFailed(verified);
    }
    const bytes = await this.verifiedBytes(record);
    if (typeof bytes === "string") return retrievalFailed(bytes);
    return { kind: "retrieved", artifact: record, bytes, integrity: "verified" };
  }

  async prepareUseBinding(
    credential: string,
    request: Readonly<ArtifactUseBindingRequest>,
  ): Promise<ArtifactUseBindingOutcome> {
    try {
      return await this.serialize(() => this.prepareUseBindingUnserialized(credential, request));
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      return useBindingFailed("storage_inspection_unavailable", false);
    }
  }

  private validUseRequest(request: Readonly<ArtifactUseBindingRequest>): boolean {
    return IDENTIFIER.test(request.bindingId) && IDENTIFIER.test(request.operationId) &&
      IDENTIFIER.test(request.artifactId) && request.purpose === "review_subject" &&
      IDENTIFIER.test(request.decisionId) && typeof request.authorityBasis === "string" && request.authorityBasis.length > 0;
  }

  private async useBindingAuthority(
    principal: Readonly<ArtifactPrincipal>,
    request: Readonly<ArtifactUseBindingRequest>,
    artifactIds: ReadonlyArray<string>,
  ): Promise<ArtifactFailureReason | undefined> {
    for (const artifactId of artifactIds) {
      try {
        const reason = authorityFailure(await principal.canBindArtifactUse(request, artifactId));
        if (reason !== undefined) return reason;
      } catch {
        return "authority_unavailable";
      }
    }
    return undefined;
  }

  private async prepareUseBindingUnserialized(
    credential: string,
    request: Readonly<ArtifactUseBindingRequest>,
  ): Promise<ArtifactUseBindingOutcome> {
    if (this.closed || !this.validUseRequest(request)) return useBindingFailed("limit_exceeded");
    const principal = await this.authenticate(credential);
    if (principal === undefined) return useBindingFailed("unauthorized");
    const existing = await this.readUseBinding(request.bindingId);
    if (existing !== undefined) {
      if (existing.subjectId !== principal.subjectId) return useBindingFailed("unauthorized");
      if (existing.requestDigest !== useBindingRequestDigest(request)) return useBindingFailed("request_mismatch");
      if (existing.state === "preparing") return this.finishPreparingUseBinding(existing, principal);
      return useBindingOutcome(existing);
    }
    const parentAuthority = await this.useBindingAuthority(principal, request, [request.artifactId]);
    if (parentAuthority !== undefined) return useBindingFailed(parentAuthority, parentAuthority !== "authority_unavailable");
    const parent = await this.readArtifactRecord(request.artifactId);
    if (parent === undefined) return useBindingFailed("unauthorized");
    if (parent.lifecycle === "deletion_pending") return useBindingFailed("artifact_deletion_pending");
    if (parent.lifecycle === "deleted") return useBindingFailed("artifact_deleted");
    const closure = await this.dependencyClosure(
      parent.dependencies,
      this.options.policy,
      (artifactId) => principal.canBindArtifactUse(request, artifactId),
    );
    if (closure.reason !== undefined) return useBindingFailed(closure.reason, closure.reason !== "authority_unavailable");
    const artifactIds = [parent.artifactId, ...closure.records.map(({ artifactId }) => artifactId)];
    const retentionUntil = new Date(this.now().getTime() + this.options.policy.reviewInputRetentionMs).toISOString();
    const record: UseBindingRecord = {
      schema: USE_SCHEMA,
      ...request,
      requestDigest: useBindingRequestDigest(request),
      subjectId: principal.subjectId,
      dependencyClosure: closure.records.map(({ artifactId }) => artifactId),
      retentionUntil,
      effectiveReviewRetentionMs: this.options.policy.reviewInputRetentionMs,
      state: "preparing",
    };
    await this.writeUseBinding(record);
    await this.fault("use_binding_record_persisted");
    for (const artifactId of artifactIds) {
      const retention: RetentionRecord = {
        schema: RETENTION_SCHEMA,
        retentionId: protectionId("use-retention", request.bindingId, artifactId),
        ownerType: "artifact_use_binding",
        ownerId: request.bindingId,
        artifactId,
        retainUntil: retentionUntil,
      };
      await this.serializeIo(() => writeJson(this.retentionPath(retention.retentionId), retention));
    }
    await this.fault("use_binding_retention_persisted");
    for (let index = 0; index < artifactIds.length; index += 1) {
      const artifactId = artifactIds[index]!;
      const pin: PinRecord = {
        schema: PIN_SCHEMA,
        pinId: protectionId("use-pin", request.bindingId, artifactId),
        ownerType: "artifact_use_binding",
        ownerId: request.bindingId,
        purpose: request.purpose,
        artifactId,
        state: "held",
      };
      await this.serializeIo(() => writeJson(this.pinPath(pin.pinId), pin));
      await this.fault(index === 0 ? "use_binding_parent_pin_persisted" : "use_binding_dependency_pin_persisted");
    }
    return this.finishPreparingUseBinding(record, principal);
  }

  private async finishPreparingUseBinding(
    record: UseBindingRecord,
    principal: Readonly<ArtifactPrincipal>,
  ): Promise<ArtifactUseBindingOutcome> {
    const request: ArtifactUseBindingRequest = {
      bindingId: record.bindingId,
      operationId: record.operationId,
      artifactId: record.artifactId,
      purpose: record.purpose,
      decisionId: record.decisionId,
      authorityBasis: record.authorityBasis,
    };
    const artifactIds = [record.artifactId, ...record.dependencyClosure];
    for (const artifactId of artifactIds) {
      const artifact = await this.readArtifactRecord(artifactId);
      if (artifact === undefined || artifact.lifecycle !== "available") {
        return this.rejectUseBinding(record, artifact?.lifecycle === "deletion_pending" ? "artifact_deletion_pending" : "artifact_deleted");
      }
      const bytes = await this.verifiedBytes(artifact);
      if (typeof bytes === "string") {
        if (bytes === "storage_inspection_unavailable") return useBindingFailed(bytes, false);
        return this.rejectUseBinding(record, bytes);
      }
    }
    const authority = await this.useBindingAuthority(principal, request, artifactIds);
    if (authority !== undefined) {
      if (authority === "authority_unavailable") return useBindingFailed(authority, false);
      return this.rejectUseBinding(record, authority);
    }
    const retentionUntil = new Date(this.now().getTime() + record.effectiveReviewRetentionMs).toISOString();
    for (const artifactId of artifactIds) {
      const retention: RetentionRecord = {
        schema: RETENTION_SCHEMA,
        retentionId: protectionId("use-retention", record.bindingId, artifactId),
        ownerType: "artifact_use_binding",
        ownerId: record.bindingId,
        artifactId,
        retainUntil: retentionUntil,
      };
      await this.serializeIo(() => writeJson(this.retentionPath(retention.retentionId), retention));
    }
    const available: UseBindingRecord = { ...record, retentionUntil, state: "available" };
    await this.writeUseBinding(available);
    await this.fault("use_binding_available_persisted");
    return useBindingOutcome(available);
  }

  private async rejectUseBinding(record: UseBindingRecord, reason: ArtifactFailureReason): Promise<ArtifactUseBindingOutcome> {
    const rejected: UseBindingRecord = { ...record, state: "rejected", failureReason: reason };
    await this.writeUseBinding(rejected);
    await this.fault("use_binding_rejection_persisted");
    await this.releaseUseBindingPins(record.bindingId);
    return useBindingOutcome(rejected);
  }

  private async releaseUseBindingPins(bindingId: string): Promise<void> {
    await this.fault("before_use_binding_pins_released");
    for (const entry of await readdir(this.pinDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.pinDirectory, entry);
      const pin = await readJson(path) as Partial<PinRecord>;
      if (pin.schema !== PIN_SCHEMA || pin.ownerId !== bindingId || pin.state !== "held") continue;
      await this.serializeIo(() => writeJson(path, { ...pin, state: "released" }));
    }
  }

  async useBindingStatus(credential: string, bindingId: string): Promise<ArtifactUseBindingOutcome> {
    try {
      const principal = await this.authenticate(credential);
      if (principal === undefined) return useBindingFailed("unauthorized");
      const record = await this.readUseBinding(bindingId);
      if (record === undefined || record.subjectId !== principal.subjectId) return useBindingFailed("unauthorized");
      return useBindingOutcome(record);
    } catch {
      return useBindingFailed("storage_inspection_unavailable", false);
    }
  }

  async retrieveForUseBinding(credential: string, bindingId: string): Promise<ArtifactRetrievalOutcome> {
    const status = await this.useBindingStatus(credential, bindingId);
    if (status.kind !== "available") {
      return retrievalFailed(status.kind === "failed" ? status.reason : "conflict", status.kind === "failed" && status.terminal);
    }
    return this.retrieve(credential, status.binding.artifactId);
  }

  async releaseUseBinding(credential: string, bindingId: string): Promise<ArtifactUseBindingOutcome> {
    try {
      return await this.serialize(async () => {
        const principal = await this.authenticate(credential);
        if (principal === undefined) return useBindingFailed("unauthorized");
        const record = await this.readUseBinding(bindingId);
        if (record === undefined || record.subjectId !== principal.subjectId) return useBindingFailed("unauthorized");
        if (record.state === "released") return useBindingOutcome(record);
        if (record.state !== "available") return useBindingOutcome(record);
        const released: UseBindingRecord = { ...record, state: "released" };
        await this.writeUseBinding(released);
        await this.releaseUseBindingPins(bindingId);
        return useBindingOutcome(released);
      });
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      return useBindingFailed("storage_inspection_unavailable", false);
    }
  }

  async createRetentionPin(
    credential: string,
    request: Readonly<ArtifactRetentionPinRequest>,
  ): Promise<ArtifactRetentionPinOutcome> {
    try {
      return await this.serialize(async () => {
        if (!IDENTIFIER.test(request.pinId) || !IDENTIFIER.test(request.artifactId) ||
          !IDENTIFIER.test(request.ownerId) || typeof request.purpose !== "string" ||
          request.purpose.length === 0 || request.retention !== "indefinite") return pinFailed("limit_exceeded");
        const principal = await this.authenticate(credential);
        if (principal === undefined) return pinFailed("unauthorized");
        const existing = await this.readExplicitPin(request.pinId);
        if (existing !== undefined) {
          if (existing.subjectId !== principal.subjectId) return pinFailed("unauthorized");
          if (existing.requestDigest !== pinRequestDigest(request)) return pinFailed("request_mismatch");
          return pinOutcome(existing);
        }
        let parentAuthority: ArtifactFailureReason | undefined;
        try { parentAuthority = authorityFailure(await principal.canPinArtifact(request, request.artifactId)); } catch { parentAuthority = "authority_unavailable"; }
        if (parentAuthority !== undefined) return pinFailed(parentAuthority, parentAuthority !== "authority_unavailable");
        const parent = await this.readArtifactRecord(request.artifactId);
        if (parent === undefined) return pinFailed("unauthorized");
        if (parent.lifecycle === "deletion_pending") return pinFailed("artifact_deletion_pending");
        if (parent.lifecycle === "deleted") return pinFailed("artifact_deleted");
        const closure = await this.dependencyClosure(
          parent.dependencies,
          this.options.policy,
          (artifactId) => principal.canPinArtifact(request, artifactId),
        );
        if (closure.reason !== undefined) return pinFailed(closure.reason, closure.reason !== "authority_unavailable");
        const artifactIds = [parent.artifactId, ...closure.records.map(({ artifactId }) => artifactId)];
        const record: ExplicitPinRecord = {
          schema: EXPLICIT_PIN_SCHEMA,
          ...request,
          requestDigest: pinRequestDigest(request),
          subjectId: principal.subjectId,
          dependencyClosure: closure.records.map(({ artifactId }) => artifactId),
          state: "held",
        };
        await this.serializeIo(() => writeJson(this.explicitPinPath(request.pinId), record));
        for (const artifactId of artifactIds) {
          const pin: PinRecord = {
            schema: PIN_SCHEMA,
            pinId: protectionId("explicit-pin", request.pinId, artifactId),
            ownerType: "principal",
            ownerId: request.pinId,
            purpose: request.purpose,
            artifactId,
            state: "held",
          };
          await this.serializeIo(() => writeJson(this.pinPath(pin.pinId), pin));
        }
        return pinOutcome(record);
      });
    } catch {
      return pinFailed("storage_inspection_unavailable", false);
    }
  }

  async releaseRetentionPin(credential: string, pinId: string): Promise<ArtifactRetentionPinOutcome> {
    try {
      return await this.serialize(async () => {
        const principal = await this.authenticate(credential);
        if (principal === undefined) return pinFailed("unauthorized");
        const record = await this.readExplicitPin(pinId);
        if (record === undefined || record.subjectId !== principal.subjectId) return pinFailed("unauthorized");
        if (record.state === "released") return pinOutcome(record);
        const released: ExplicitPinRecord = { ...record, state: "released" };
        await this.serializeIo(() => writeJson(this.explicitPinPath(pinId), released));
        await this.fault("before_explicit_pin_records_released");
        await this.releaseExplicitPinRecords(pinId);
        return pinOutcome(released);
      });
    } catch {
      return pinFailed("storage_inspection_unavailable", false);
    }
  }

  private async releaseExplicitPinRecords(pinId: string): Promise<void> {
    for (const entry of await readdir(this.pinDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.pinDirectory, entry);
      const pin = await readJson(path) as Partial<PinRecord>;
      if (pin.schema === PIN_SCHEMA && pin.ownerType === "principal" && pin.ownerId === pinId && pin.state === "held") {
        await this.serializeIo(() => writeJson(path, { ...pin, state: "released" }));
      }
    }
  }

  async prepareResultAcceptance(
    credential: string,
    request: Readonly<ResultAcceptancePreparationRequest>,
  ): Promise<ResultAcceptancePreparationOutcome> {
    try {
      return await this.serialize(() => this.prepareResultAcceptanceUnserialized(credential, request));
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      if (error instanceof ResultAcceptanceManifestError) return resultAcceptanceFailed(error.reason);
      return resultAcceptanceFailed("storage_inspection_unavailable", false);
    }
  }

  private validResultAcceptanceRequest(request: Readonly<ResultAcceptancePreparationRequest>): boolean {
    return IDENTIFIER.test(request.preparationId) && IDENTIFIER.test(request.operationId) &&
      IDENTIFIER.test(request.acceptanceRequestId) && /^sha256:[a-f0-9]{64}$/u.test(request.manifestDigest) &&
      /^sha256:[a-f0-9]{64}$/u.test(request.requirementsDigest) &&
      /^sha256:[a-f0-9]{64}$/u.test(request.retentionPolicyDigest);
  }

  private async resultAcceptanceAuthority(
    principal: Readonly<ArtifactPrincipal>,
    request: Readonly<ResultAcceptancePreparationRequest>,
    artifactIds: ReadonlyArray<string>,
  ): Promise<ArtifactFailureReason | undefined> {
    for (const artifactId of artifactIds) {
      try {
        const reason = authorityFailure(await principal.canPrepareResultAcceptance(request, artifactId));
        if (reason !== undefined) return reason;
      } catch {
        return "authority_unavailable";
      }
    }
    return undefined;
  }

  private async resultAcceptanceArtifacts(
    request: Readonly<ResultAcceptancePreparationRequest>,
    principal: Readonly<ArtifactPrincipal>,
  ): Promise<ReadonlyArray<ArtifactRecord> | ResultAcceptancePreparationOutcome> {
    const roots = [request.manifest.bodyArtifactId, ...request.manifest.workProducts.flatMap(({ artifactIds }) => artifactIds)];
    const records = new Map<string, ArtifactRecord>();
    const closure = await this.dependencyClosure(
      roots,
      this.options.policy,
      (artifactId) => principal.canPrepareResultAcceptance(request, artifactId),
    );
    if (closure.reason !== undefined) {
      const mapped = closure.reason === "dependency_not_found" ? "artifact_not_found" : closure.reason;
      return resultAcceptanceFailed(mapped as ArtifactFailureReason | ResultAcceptanceManifestError["reason"], mapped !== "authority_unavailable");
    }
    for (const record of closure.records) records.set(record.artifactId, record);
    for (const artifactId of roots) {
      const record = await this.readArtifactRecord(artifactId);
      if (record === undefined) return resultAcceptanceFailed("artifact_not_found");
      if (record.lifecycle === "deletion_pending") return resultAcceptanceFailed("artifact_deletion_pending");
      if (record.lifecycle === "deleted") return resultAcceptanceFailed("artifact_deleted");
      records.set(record.artifactId, record);
    }
    const ordered = [...records.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    for (const record of ordered) {
      const bytes = await this.verifiedBytes(record);
      if (typeof bytes === "string") return resultAcceptanceFailed(bytes, bytes !== "storage_inspection_unavailable");
      const format = this.formats.get(`${record.formatId}\0${record.normalizationId}`);
      if (format === undefined || !(await format.validate(bytes))) return resultAcceptanceFailed("invalid_format");
    }
    return ordered;
  }

  private async prepareResultAcceptanceUnserialized(
    credential: string,
    request: Readonly<ResultAcceptancePreparationRequest>,
  ): Promise<ResultAcceptancePreparationOutcome> {
    if (this.closed || !this.validResultAcceptanceRequest(request)) return resultAcceptanceFailed("limit_exceeded");
    const principal = await this.authenticate(credential);
    if (principal === undefined) return resultAcceptanceFailed("unauthorized");
    const existing = await this.readResultAcceptancePreparation(request.preparationId);
    if (existing !== undefined) {
      if (existing.subjectId !== principal.subjectId) return resultAcceptanceFailed("unauthorized");
      if (existing.requestDigest !== resultAcceptanceRequestDigest(request)) return resultAcceptanceFailed("conflict");
      if (existing.state === "preparing") {
        if (!(await this.preparationSourcesRemainTrusted(existing))) {
          return resultAcceptanceFailed("authority_unavailable", false);
        }
        return this.finishPreparingResultAcceptance(existing, principal);
      }
      const currentAuthority = await this.resultAcceptanceAuthority(principal, existing.request, existing.evidence.artifactIds);
      if (currentAuthority !== undefined) {
        return resultAcceptanceFailed(currentAuthority, currentAuthority !== "authority_unavailable");
      }
      if (existing.state === "prepared") {
        await this.ensureResultAcceptanceProtections(existing);
        await this.validateResultAcceptanceProtections(existing);
        const artifacts = await this.resultAcceptanceArtifacts(existing.request, principal);
        if ("kind" in artifacts) return artifacts;
        const authority = await this.resultAcceptanceAuthority(principal, existing.request, existing.evidence.artifactIds);
        if (authority !== undefined) return resultAcceptanceFailed(authority, authority !== "authority_unavailable");
      }
      return resultAcceptanceOutcome(existing);
    }
    const document = resultAcceptanceManifestDocument(request.manifest);
    if (document.digest !== request.manifestDigest) return resultAcceptanceFailed("request_mismatch");
    let requirements: Readonly<ResolvedWorkProductRequirements> | "unknown";
    try {
      requirements = await this.options.resultAcceptanceRequirementsSource?.read(request.operationId) ?? "unknown";
    } catch {
      requirements = "unknown";
    }
    if (requirements === "unknown") return resultAcceptanceFailed("authority_unavailable", false);
    if (requirements.digest !== request.requirementsDigest) return resultAcceptanceFailed("conflict");
    for (const entry of await readdir(this.resultAcceptancePreparationDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const other = await this.readResultAcceptancePreparation(entry.slice(0, -5));
      if (other?.request.operationId === request.operationId) return resultAcceptanceFailed("conflict");
    }
    for (const entry of await readdir(this.resultAcceptanceRetentionDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const other = await this.readResultAcceptanceRetention(entry.slice(0, -5));
      if (other?.operationId === request.operationId) return resultAcceptanceFailed("conflict");
    }
    let retentionPolicy: Readonly<ResultAcceptanceRetentionPolicyEvidence> | "unknown";
    try {
      retentionPolicy = await this.options.resultAcceptanceRetentionPolicySource?.read(request.operationId) ?? "unknown";
    } catch {
      retentionPolicy = "unknown";
    }
    if (retentionPolicy === "unknown") return resultAcceptanceFailed("authority_unavailable", false);
    if (retentionPolicy.formatId !== "pions.result-acceptance-retention-policy.v1" ||
      retentionPolicy.operationId !== request.operationId || retentionPolicy.digest !== request.retentionPolicyDigest ||
      !Number.isSafeInteger(retentionPolicy.acceptedArtifactRetentionMs) || retentionPolicy.acceptedArtifactRetentionMs <= 0 ||
      retentionPolicy.digest !== retentionPolicyDigest({
        formatId: retentionPolicy.formatId,
        operationId: retentionPolicy.operationId,
        acceptedArtifactRetentionMs: retentionPolicy.acceptedArtifactRetentionMs,
      })) return resultAcceptanceFailed("conflict");
    const artifacts = await this.resultAcceptanceArtifacts(request, principal);
    if ("kind" in artifacts) return artifacts;
    const validated = validateResultAcceptanceManifest(request.manifest, requirements, artifacts);
    const authority = await this.resultAcceptanceAuthority(principal, request, validated.artifactIds);
    if (authority !== undefined) return resultAcceptanceFailed(authority, authority !== "authority_unavailable");
    const unsignedEvidence = {
      formatId: "pions.result-acceptance-preparation.v1",
      preparationId: request.preparationId,
      operationId: request.operationId,
      acceptanceRequestId: request.acceptanceRequestId,
      manifestDigest: request.manifestDigest,
      requirementsDigest: request.requirementsDigest,
      bodyArtifactId: validated.value.bodyArtifactId,
      workProducts: validated.value.workProducts,
      artifactIds: validated.artifactIds,
      totalByteCount: validated.totalByteCount,
      acceptedArtifactRetentionMs: retentionPolicy.acceptedArtifactRetentionMs,
      retentionPolicyDigest: retentionPolicy.digest,
    } as const;
    const evidence: ResultAcceptancePreparationEvidence = {
      ...unsignedEvidence,
      digest: resultAcceptanceEvidenceDigest(unsignedEvidence),
    };
    const record: ResultAcceptancePreparationRecord = {
      schema: RESULT_ACCEPTANCE_PREPARATION_SCHEMA,
      request: {
        ...request,
        manifest: validated.value,
      },
      requirements,
      requestDigest: resultAcceptanceRequestDigest(request),
      subjectId: principal.subjectId,
      evidence,
      state: "preparing",
      effectiveAcceptedRetentionMs: retentionPolicy.acceptedArtifactRetentionMs,
      retentionPolicy,
    };
    await this.serializeIo(() => writeJson(this.resultAcceptancePreparationPath(request.preparationId), record));
    await this.fault("result_acceptance_record_persisted");
    return this.finishPreparingResultAcceptance(record, principal);
  }

  private async ensureResultAcceptanceProtections(record: ResultAcceptancePreparationRecord): Promise<void> {
    await this.fault("before_result_acceptance_first_pin_persisted");
    for (const artifactId of record.evidence.artifactIds) {
      const pin: PinRecord = {
        schema: PIN_SCHEMA,
        pinId: protectionId("result-acceptance-pin", record.request.preparationId, artifactId),
        ownerType: "result_acceptance_preparation",
        ownerId: record.request.preparationId,
        purpose: "result_acceptance_preparation",
        artifactId,
        state: "held",
      };
      await this.serializeIo(() => writeJson(this.pinPath(pin.pinId), pin));
      await this.fault("result_acceptance_pin_persisted");
    }
    await this.fault("before_result_acceptance_retention_persisted");
    const retention: ResultAcceptanceRetentionRecord = {
      schema: RESULT_ACCEPTANCE_RETENTION_SCHEMA,
      preparationId: record.request.preparationId,
      operationId: record.request.operationId,
      acceptanceRequestId: record.request.acceptanceRequestId,
      artifactIds: record.evidence.artifactIds,
      retentionMs: record.effectiveAcceptedRetentionMs,
      state: "pending",
    };
    const existing = await this.readResultAcceptanceRetention(record.request.preparationId);
    if (existing === undefined) {
      await this.serializeIo(() => writeJson(this.resultAcceptanceRetentionPath(record.request.preparationId), retention));
    } else if (existing.state !== "pending" || existing.retentionMs !== retention.retentionMs ||
      JSON.stringify(existing.artifactIds) !== JSON.stringify(retention.artifactIds)) {
      throw new Error("Result acceptance retention conflicts with its preparation");
    }
    await this.fault("result_acceptance_retention_persisted");
  }

  private async validateResultAcceptanceProtections(record: ResultAcceptancePreparationRecord): Promise<void> {
    const retention = await this.readResultAcceptanceRetention(record.request.preparationId);
    if (retention === undefined || retention.state !== "pending" ||
      retention.operationId !== record.request.operationId ||
      retention.acceptanceRequestId !== record.request.acceptanceRequestId ||
      retention.retentionMs !== record.effectiveAcceptedRetentionMs ||
      JSON.stringify(retention.artifactIds) !== JSON.stringify(record.evidence.artifactIds)) {
      throw new Error("Result acceptance pending retention is unavailable");
    }
    for (const artifactId of record.evidence.artifactIds) {
      const pinId = protectionId("result-acceptance-pin", record.request.preparationId, artifactId);
      const pin = await readJson(this.pinPath(pinId)) as Partial<PinRecord>;
      if (pin.schema !== PIN_SCHEMA || pin.pinId !== pinId || pin.ownerType !== "result_acceptance_preparation" ||
        pin.ownerId !== record.request.preparationId || pin.artifactId !== artifactId || pin.state !== "held") {
        throw new Error("Result acceptance preparation pin is unavailable");
      }
    }
  }

  private async finishPreparingResultAcceptance(
    record: ResultAcceptancePreparationRecord,
    principal: Readonly<ArtifactPrincipal>,
  ): Promise<ResultAcceptancePreparationOutcome> {
    await this.ensureResultAcceptanceProtections(record);
    await this.validateResultAcceptanceProtections(record);
    const artifacts = await this.resultAcceptanceArtifacts(record.request, principal);
    if ("kind" in artifacts) return artifacts;
    const validated = validateResultAcceptanceManifest(record.request.manifest, record.requirements, artifacts);
    if (validated.digest !== record.evidence.manifestDigest ||
      JSON.stringify(validated.artifactIds) !== JSON.stringify(record.evidence.artifactIds) ||
      validated.totalByteCount !== record.evidence.totalByteCount) {
      return resultAcceptanceFailed("conflict");
    }
    const authority = await this.resultAcceptanceAuthority(principal, record.request, record.evidence.artifactIds);
    if (authority !== undefined) return resultAcceptanceFailed(authority, authority !== "authority_unavailable");
    const prepared: ResultAcceptancePreparationRecord = { ...record, state: "prepared" };
    await this.serializeIo(() => writeJson(this.resultAcceptancePreparationPath(record.request.preparationId), prepared));
    await this.fault("result_acceptance_prepared_persisted");
    return resultAcceptanceOutcome(prepared);
  }

  async resultAcceptancePreparationStatus(
    credential: string,
    preparationId: string,
  ): Promise<ResultAcceptancePreparationOutcome> {
    try {
      return await this.serialize(async () => {
        const principal = await this.authenticate(credential);
        if (principal === undefined) return resultAcceptanceFailed("unauthorized");
        const record = await this.readResultAcceptancePreparation(preparationId);
        if (record === undefined || record.subjectId !== principal.subjectId) return resultAcceptanceFailed("unauthorized");
        const currentAuthority = await this.resultAcceptanceAuthority(principal, record.request, record.evidence.artifactIds);
        if (currentAuthority !== undefined) {
          return resultAcceptanceFailed(currentAuthority, currentAuthority !== "authority_unavailable");
        }
        if (record.state === "prepared") {
          await this.validateResultAcceptanceProtections(record);
          const artifacts = await this.resultAcceptanceArtifacts(record.request, principal);
          if ("kind" in artifacts) return artifacts;
          const authority = await this.resultAcceptanceAuthority(principal, record.request, record.evidence.artifactIds);
          if (authority !== undefined) return resultAcceptanceFailed(authority, authority !== "authority_unavailable");
        }
        return resultAcceptanceOutcome(record);
      });
    } catch {
      return resultAcceptanceFailed("storage_inspection_unavailable", false);
    }
  }

  private validEventEvidence(evidence: Readonly<ResultAcceptanceEventEvidence>, state: ResultAcceptanceEventEvidence["state"]): boolean {
    return IDENTIFIER.test(evidence.preparationId) && IDENTIFIER.test(evidence.operationId) &&
      IDENTIFIER.test(evidence.acceptanceRequestId) && evidence.state === state &&
      /^sha256:[a-f0-9]{64}$/u.test(evidence.manifestDigest) && /^sha256:[a-f0-9]{64}$/u.test(evidence.evidenceDigest) &&
      Number.isFinite(Date.parse(evidence.observedAt)) &&
      (state === "not_accepted" ? evidence.acceptedAt === undefined : Number.isFinite(Date.parse(evidence.acceptedAt ?? "")));
  }

  private eventEvidenceMatches(
    left: Readonly<ResultAcceptanceEventEvidence> | undefined,
    right: Readonly<ResultAcceptanceEventEvidence>,
  ): boolean {
    return left?.preparationId === right.preparationId && left.operationId === right.operationId &&
      left.acceptanceRequestId === right.acceptanceRequestId && left.manifestDigest === right.manifestDigest &&
      left.evidenceDigest === right.evidenceDigest && left.state === right.state &&
      left.observedAt === right.observedAt && left.acceptedAt === right.acceptedAt;
  }

  private eventEvidenceMatchesPreparation(
    record: ResultAcceptancePreparationRecord,
    evidence: Readonly<ResultAcceptanceEventEvidence>,
  ): boolean {
    return record.request.operationId === evidence.operationId &&
      record.request.acceptanceRequestId === evidence.acceptanceRequestId &&
      record.request.manifestDigest === evidence.manifestDigest &&
      record.evidence.digest === evidence.evidenceDigest;
  }

  private async reconciliationAuthority(
    principal: Readonly<ArtifactPrincipal>,
    evidence: Readonly<ResultAcceptanceEventEvidence>,
  ): Promise<ArtifactFailureReason | undefined> {
    try {
      const trust = await this.options.resultAcceptanceEventEvidenceVerifier?.verify(evidence) ?? "unknown";
      if (trust === "unknown") return "authority_unavailable";
      if (trust === "untrusted") return "conflict";
      return authorityFailure(await principal.canReconcileResultAcceptance(evidence.preparationId, evidence));
    } catch {
      return "authority_unavailable";
    }
  }

  async finalizeResultAcceptance(
    credential: string,
    evidence: Readonly<ResultAcceptanceEventEvidence>,
  ): Promise<ResultAcceptancePreparationOutcome> {
    try {
      return await this.serialize(async () => {
        if (!this.validEventEvidence(evidence, "accepted")) return resultAcceptanceFailed("conflict");
        const principal = await this.authenticate(credential);
        if (principal === undefined) return resultAcceptanceFailed("unauthorized");
        const record = await this.readResultAcceptancePreparation(evidence.preparationId);
        if (record === undefined || record.subjectId !== principal.subjectId) return resultAcceptanceFailed("unauthorized");
        if (!this.eventEvidenceMatchesPreparation(record, evidence) || record.state === "aborted") {
          return resultAcceptanceFailed("conflict");
        }
        const authority = await this.reconciliationAuthority(principal, evidence);
        if (authority !== undefined) return resultAcceptanceFailed(authority, authority !== "authority_unavailable");
        const retention = await this.readResultAcceptanceRetention(evidence.preparationId);
        if (record.state === "accepted") {
          if (!this.eventEvidenceMatches(record.eventEvidence, evidence) || retention?.state !== "active" ||
            retention.retainUntil !== record.retentionUntil ||
            JSON.stringify(retention.artifactIds) !== JSON.stringify(record.evidence.artifactIds)) {
            return resultAcceptanceFailed("conflict");
          }
          await this.releaseResultAcceptancePins(evidence.preparationId);
          return resultAcceptanceOutcome(record);
        }
        if (record.state !== "prepared") return resultAcceptanceFailed("conflict");
        if (retention === undefined || retention.operationId !== record.request.operationId ||
          retention.acceptanceRequestId !== record.request.acceptanceRequestId ||
          retention.retentionMs !== record.effectiveAcceptedRetentionMs ||
          JSON.stringify(retention.artifactIds) !== JSON.stringify(record.evidence.artifactIds)) {
          return resultAcceptanceFailed("storage_inspection_unavailable", false);
        }
        const retentionUntil = new Date(Date.parse(evidence.acceptedAt!) + record.effectiveAcceptedRetentionMs).toISOString();
        if (retention.state === "active" && (!this.eventEvidenceMatches(retention.eventEvidence, evidence) ||
          retention.retainUntil !== retentionUntil)) return resultAcceptanceFailed("conflict");
        if (retention.state === "cancelled") return resultAcceptanceFailed("conflict");
        const active: ResultAcceptanceRetentionRecord = {
          ...retention,
          state: "active",
          retainUntil: retentionUntil,
          eventEvidence: evidence,
        };
        if (retention.state === "pending") {
          await this.fault("before_result_acceptance_active_retention_persisted");
          await this.serializeIo(() => writeJson(this.resultAcceptanceRetentionPath(evidence.preparationId), active));
          await this.fault("result_acceptance_active_retention_persisted");
        }
        const accepted: ResultAcceptancePreparationRecord = {
          ...record,
          state: "accepted",
          retentionUntil,
          eventEvidence: evidence,
        };
        await this.serializeIo(() => writeJson(this.resultAcceptancePreparationPath(evidence.preparationId), accepted));
        await this.fault("result_acceptance_accepted_persisted");
        await this.releaseResultAcceptancePins(evidence.preparationId);
        return resultAcceptanceOutcome(accepted);
      });
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      return resultAcceptanceFailed("storage_inspection_unavailable", false);
    }
  }

  async abortResultAcceptance(
    credential: string,
    evidence: Readonly<ResultAcceptanceEventEvidence>,
  ): Promise<ResultAcceptancePreparationOutcome> {
    try {
      return await this.serialize(async () => {
        if (!this.validEventEvidence(evidence, "not_accepted")) return resultAcceptanceFailed("conflict");
        const principal = await this.authenticate(credential);
        if (principal === undefined) return resultAcceptanceFailed("unauthorized");
        const record = await this.readResultAcceptancePreparation(evidence.preparationId);
        if (record === undefined || record.subjectId !== principal.subjectId) return resultAcceptanceFailed("unauthorized");
        if (!this.eventEvidenceMatchesPreparation(record, evidence) || record.state === "accepted") {
          return resultAcceptanceFailed("conflict");
        }
        const authority = await this.reconciliationAuthority(principal, evidence);
        if (authority !== undefined) return resultAcceptanceFailed(authority, authority !== "authority_unavailable");
        const currentRetention = await this.readResultAcceptanceRetention(evidence.preparationId);
        if (currentRetention?.state === "active") return resultAcceptanceFailed("conflict");
        if (record.state === "aborted") {
          if (!this.eventEvidenceMatches(record.eventEvidence, evidence)) return resultAcceptanceFailed("conflict");
          const retention = currentRetention;
          if (retention !== undefined && retention.state !== "cancelled") {
            await this.serializeIo(() => writeJson(this.resultAcceptanceRetentionPath(evidence.preparationId), {
              ...retention,
              state: "cancelled",
            }));
          }
          await this.releaseResultAcceptancePins(evidence.preparationId);
          return resultAcceptanceOutcome(record);
        }
        const aborted: ResultAcceptancePreparationRecord = { ...record, state: "aborted", eventEvidence: evidence };
        await this.serializeIo(() => writeJson(this.resultAcceptancePreparationPath(evidence.preparationId), aborted));
        const retention = currentRetention;
        if (retention !== undefined) {
          await this.serializeIo(() => writeJson(this.resultAcceptanceRetentionPath(evidence.preparationId), {
            ...retention,
            state: "cancelled",
          }));
        }
        await this.releaseResultAcceptancePins(evidence.preparationId);
        return resultAcceptanceOutcome(aborted);
      });
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      return resultAcceptanceFailed("storage_inspection_unavailable", false);
    }
  }

  private async releaseResultAcceptancePins(preparationId: string): Promise<void> {
    await this.fault("before_result_acceptance_pins_released");
    for (const entry of await readdir(this.pinDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.pinDirectory, entry);
      const pin = await readJson(path) as Partial<PinRecord>;
      if (pin.schema === PIN_SCHEMA && pin.ownerType === "result_acceptance_preparation" &&
        pin.ownerId === preparationId && pin.state === "held") {
        await this.serializeIo(() => writeJson(path, { ...pin, state: "released" }));
      }
    }
  }

  async collectGarbage(
    credential: string,
    request: Readonly<ArtifactGarbageCollectionRequest>,
  ): Promise<ArtifactGarbageCollectionOutcome> {
    try {
      return await this.serialize(() => this.collectGarbageUnserialized(credential, request));
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      await this.persistGarbageCollectionDiagnostic(request, "gc_processing_unavailable").catch(() => undefined);
      return gcFailed("gc_processing_unavailable", false);
    }
  }

  private async persistGarbageCollectionDiagnostic(
    request: Readonly<ArtifactGarbageCollectionRequest>,
    reason: ArtifactFailureReason,
  ): Promise<void> {
    if (!IDENTIFIER.test(request.collectionId)) return;
    await this.fault("before_gc_diagnostic_persisted");
    await this.serializeIo(() => writeJson(
      join(this.garbageCollectionDiagnosticDirectory, `${request.collectionId}.json`),
      { schema: GC_DIAGNOSTIC_SCHEMA, collectionId: request.collectionId, reason, observedAt: this.now().toISOString() },
    ));
  }

  private async collectGarbageUnserialized(
    credential: string,
    request: Readonly<ArtifactGarbageCollectionRequest>,
  ): Promise<ArtifactGarbageCollectionOutcome> {
    if (this.closed || !IDENTIFIER.test(request.collectionId) || !Number.isSafeInteger(request.scanBudget) ||
      request.scanBudget <= 0 || request.scanBudget > this.options.policy.maxGarbageCollectionScan ||
      !Number.isSafeInteger(request.deletionBudget) || request.deletionBudget <= 0 ||
      request.deletionBudget > this.options.policy.maxGarbageCollectionDeletes ||
      !Number.isSafeInteger(request.recoveryBudget) || request.recoveryBudget <= 0 ||
      request.recoveryBudget > this.options.policy.maxGarbageCollectionRecoveryAttempts ||
      (request.afterArtifactId !== undefined && !IDENTIFIER.test(request.afterArtifactId))) {
      return gcFailed("limit_exceeded");
    }
    const principal = await this.authenticate(credential);
    if (principal === undefined) return gcFailed("unauthorized");
    let authority: ArtifactFailureReason | undefined;
    try { authority = authorityFailure(await principal.canGarbageCollect(request)); } catch { authority = "authority_unavailable"; }
    if (authority !== undefined) return gcFailed(authority, authority !== "authority_unavailable");
    const artifactIds = (await readdir(this.artifactDirectory))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -5))
      .filter((artifactId) => request.afterArtifactId === undefined || artifactId > request.afterArtifactId)
      .sort();
    const scanned = artifactIds.slice(0, request.scanBudget);
    let remainingArtifactIds = artifactIds.slice(request.scanBudget);
    const deletedArtifactIds: string[] = [];
    let lastProcessedArtifactId = request.afterArtifactId;
    for (let index = 0; index < scanned.length; index += 1) {
      const artifactId = scanned[index]!;
      if (deletedArtifactIds.length >= request.deletionBudget) {
        remainingArtifactIds = [...scanned.slice(index), ...remainingArtifactIds];
        break;
      }
      lastProcessedArtifactId = artifactId;
      const record = await this.readArtifactRecord(artifactId);
      if (record === undefined || record.lifecycle === "deleted") continue;
      if (record.lifecycle === "deletion_pending") {
        const budget = record.deletionRecoveryBudget ?? request.recoveryBudget;
        if (record.deletionRecoveryAttempts >= budget) return gcFailed("gc_processing_unavailable");
        const attempting = { ...record, deletionRecoveryAttempts: record.deletionRecoveryAttempts + 1 };
        await this.serializeIo(() => writeJson(this.artifactPath(record.artifactId), attempting));
        try {
          await this.finishDeletion(attempting);
        } catch (error) {
          if (error instanceof ArtifactStoreInjectedFault) throw error;
          return gcFailed("storage_inspection_unavailable", false);
        }
        deletedArtifactIds.push(record.artifactId);
        lastProcessedArtifactId = artifactId;
        continue;
      }
      if (!(await this.isDeletionEligible(record.artifactId, record.unusedRetentionUntil))) {
        lastProcessedArtifactId = artifactId;
        continue;
      }
      await this.fault("gc_eligibility_checked");
      const pending: ArtifactRecord = {
        ...record,
        lifecycle: "deletion_pending",
        deletionRecoveryBudget: request.recoveryBudget,
      };
      await this.serializeIo(() => writeJson(this.artifactPath(record.artifactId), pending));
      await this.fault("deletion_pending_persisted");
      try {
        await this.finishDeletion(pending);
      } catch (error) {
        if (error instanceof ArtifactStoreInjectedFault) throw error;
        return gcFailed("storage_inspection_unavailable", false);
      }
      deletedArtifactIds.push(record.artifactId);
      lastProcessedArtifactId = artifactId;
    }
    if (remainingArtifactIds.length > 0) {
      return {
        kind: "continuable",
        reason: "gc_unprocessed",
        deletedArtifactIds,
        remainingArtifactIds,
        nextCursor: lastProcessedArtifactId ?? request.afterArtifactId ?? "",
      };
    }
    return { kind: "completed", deletedArtifactIds };
  }

  private async isDeletionEligible(artifactId: string, unusedRetentionUntil: string): Promise<boolean> {
    if (Date.parse(unusedRetentionUntil) > this.now().getTime()) return false;
    for (const entry of await readdir(this.registrationDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const registration = await this.readRecord(entry.slice(0, -5));
      if (registration === undefined || (registration.state !== "receiving" && registration.state !== "prepared")) continue;
      if (registration.artifactId === artifactId || registration.request.dependencies.includes(artifactId)) return false;
      const closure = await this.dependencyClosure(registration.request.dependencies, registration.effectivePolicy);
      if (closure.reason !== undefined || closure.records.some((record) => record.artifactId === artifactId)) return false;
    }
    for (const entry of await readdir(this.useBindingDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const binding = await this.readUseBinding(entry.slice(0, -5));
      if (binding !== undefined && (binding.state === "preparing" || binding.state === "available") &&
        (binding.artifactId === artifactId || binding.dependencyClosure.includes(artifactId))) return false;
    }
    for (const entry of await readdir(this.explicitPinDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const pin = await this.readExplicitPin(entry.slice(0, -5));
      if (pin !== undefined && pin.state === "held" &&
        (pin.artifactId === artifactId || pin.dependencyClosure.includes(artifactId))) return false;
    }
    for (const entry of await readdir(this.resultAcceptancePreparationDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const preparation = await this.readResultAcceptancePreparation(entry.slice(0, -5));
      if (preparation === undefined || !preparation.evidence.artifactIds.includes(artifactId) || preparation.state === "aborted") continue;
      if (preparation.state !== "accepted") return false;
      const retention = await this.readResultAcceptanceRetention(preparation.request.preparationId);
      if (retention === undefined || retention.state !== "active" ||
        retention.retentionMs !== preparation.effectiveAcceptedRetentionMs ||
        retention.retainUntil !== preparation.retentionUntil ||
        JSON.stringify(retention.artifactIds) !== JSON.stringify(preparation.evidence.artifactIds)) {
        throw new Error("Published Result acceptance retention is unavailable");
      }
      if (Date.parse(retention.retainUntil!) > this.now().getTime()) return false;
    }
    for (const entry of await readdir(this.resultAcceptanceRetentionDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const retention = await this.readResultAcceptanceRetention(entry.slice(0, -5));
      if (retention === undefined || !retention.artifactIds.includes(artifactId) || retention.state === "cancelled") continue;
      if (retention.state === "active") {
        const preparation = await this.readResultAcceptancePreparation(retention.preparationId);
        if (preparation?.state !== "accepted" || preparation.request.operationId !== retention.operationId ||
          preparation.request.acceptanceRequestId !== retention.acceptanceRequestId ||
          preparation.retentionUntil !== retention.retainUntil ||
          !this.eventEvidenceMatches(preparation.eventEvidence, retention.eventEvidence!) ||
          JSON.stringify(preparation.evidence.artifactIds) !== JSON.stringify(retention.artifactIds)) {
          throw new Error("Published Result acceptance preparation is unavailable");
        }
      }
      if (retention.state === "pending" || Date.parse(retention.retainUntil!) > this.now().getTime()) return false;
    }
    for (const entry of await readdir(this.pinDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const pin = await readJson(join(this.pinDirectory, entry)) as Partial<PinRecord>;
      if (pin.schema === PIN_SCHEMA && pin.artifactId === artifactId && pin.state === "held") return false;
    }
    for (const entry of await readdir(this.retentionDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const retention = await readJson(join(this.retentionDirectory, entry)) as Partial<RetentionRecord>;
      if (retention.schema === RETENTION_SCHEMA && retention.artifactId === artifactId &&
        Date.parse(retention.retainUntil ?? "") > this.now().getTime()) return false;
    }
    return true;
  }

  private async finishDeletion(record: ArtifactRecord): Promise<void> {
    const dataPath = join(this.artifactDirectory, record.dataFile);
    try {
      await unlink(dataPath);
      await syncDirectory(this.artifactDirectory);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        await this.serializeIo(() => writeJson(this.artifactPath(record.artifactId), { ...record, storageStatus: "uninspectable" }));
        throw error;
      }
    }
    await this.fault("artifact_bytes_deleted");
    const deleted: ArtifactRecord = { ...record, lifecycle: "deleted" };
    await this.serializeIo(() => writeJson(this.artifactPath(record.artifactId), deleted));
    await this.fault("deletion_committed");
  }

  private async preparationSourcesRemainTrusted(record: ResultAcceptancePreparationRecord): Promise<boolean> {
    try {
      const requirements = await this.options.resultAcceptanceRequirementsSource?.read(record.request.operationId) ?? "unknown";
      const retentionPolicy = await this.options.resultAcceptanceRetentionPolicySource?.read(record.request.operationId) ?? "unknown";
      return requirements !== "unknown" && retentionPolicy !== "unknown" &&
        requirements.digest === record.requirements.digest &&
        requirements.canonicalJson === record.requirements.canonicalJson &&
        retentionPolicy.digest === record.retentionPolicy.digest &&
        retentionPolicy.operationId === record.request.operationId &&
        retentionPolicy.acceptedArtifactRetentionMs === record.effectiveAcceptedRetentionMs;
    } catch {
      return false;
    }
  }

  private async recoverUseBindingsPinsAndDeletions(): Promise<void> {
    for (const entry of await readdir(this.resultAcceptancePreparationDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.readResultAcceptancePreparation(entry.slice(0, -5));
      if (record === undefined) continue;
      if (record.state === "preparing") {
        try {
          if (!(await this.preparationSourcesRemainTrusted(record))) continue;
          await this.ensureResultAcceptanceProtections(record);
          const principal = await this.options.authenticator.restore(record.subjectId);
          await this.finishPreparingResultAcceptance(record, principal);
        } catch (error) {
          if (error instanceof ArtifactStoreInjectedFault) throw error;
        }
      } else if (record.state === "prepared") {
        try {
          const retention = await this.readResultAcceptanceRetention(record.request.preparationId);
          const sourcedEvidence = retention?.eventEvidence ??
            await this.options.resultAcceptanceEventEvidenceSource?.read(
              record.request.operationId,
              record.request.preparationId,
            );
          const evidence = sourcedEvidence === "unknown" ? undefined : sourcedEvidence;
          if (evidence === undefined || evidence.acceptedAt === undefined) continue;
          const evidenceTrust = await this.options.resultAcceptanceEventEvidenceVerifier?.verify(evidence) ?? "unknown";
          const retentionUntil = new Date(
            Date.parse(evidence.acceptedAt) + record.effectiveAcceptedRetentionMs,
          ).toISOString();
          const principal = await this.options.authenticator.restore(record.subjectId);
          const authority = await this.reconciliationAuthority(principal, evidence);
          if (evidenceTrust === "trusted" && authority === undefined && retention !== undefined &&
            (retention.state === "pending" || retention.state === "active") &&
            this.validEventEvidence(evidence, "accepted") &&
            this.eventEvidenceMatchesPreparation(record, evidence) &&
            retention.retentionMs === record.effectiveAcceptedRetentionMs &&
            JSON.stringify(retention.artifactIds) === JSON.stringify(record.evidence.artifactIds) &&
            (retention.state !== "active" || retention.retainUntil === retentionUntil)) {
            const active: ResultAcceptanceRetentionRecord = {
              ...retention,
              state: "active",
              retainUntil: retentionUntil,
              eventEvidence: evidence,
            };
            if (retention.state === "pending") {
              await writeJson(this.resultAcceptanceRetentionPath(record.request.preparationId), active);
            }
            const accepted: ResultAcceptancePreparationRecord = {
              ...record,
              state: "accepted",
              retentionUntil,
              eventEvidence: evidence,
            };
            await writeJson(this.resultAcceptancePreparationPath(record.request.preparationId), accepted);
            await this.releaseResultAcceptancePins(record.request.preparationId);
          }
        } catch (error) {
          if (error instanceof ArtifactStoreInjectedFault) throw error;
        }
      } else if (record.state === "accepted") {
        try {
          const retention = await this.readResultAcceptanceRetention(record.request.preparationId);
          const evidenceTrust = record.eventEvidence === undefined
            ? "unknown"
            : await this.options.resultAcceptanceEventEvidenceVerifier?.verify(record.eventEvidence) ?? "unknown";
          if (evidenceTrust === "trusted" && retention !== undefined && retention.state === "active" &&
            retention.eventEvidence !== undefined && record.eventEvidence !== undefined &&
            this.validEventEvidence(record.eventEvidence, "accepted") &&
            this.eventEvidenceMatchesPreparation(record, record.eventEvidence) &&
            this.eventEvidenceMatches(record.eventEvidence, retention.eventEvidence) &&
            retention.retainUntil === record.retentionUntil &&
            JSON.stringify(retention.artifactIds) === JSON.stringify(record.evidence.artifactIds)) {
            await this.releaseResultAcceptancePins(record.request.preparationId);
          }
        } catch (error) {
          if (error instanceof ArtifactStoreInjectedFault) throw error;
        }
      } else if (record.state === "aborted" && record.eventEvidence !== undefined) {
        let evidenceTrust: "trusted" | "untrusted" | "unknown" = "unknown";
        try {
          evidenceTrust = await this.options.resultAcceptanceEventEvidenceVerifier?.verify(record.eventEvidence) ?? "unknown";
        } catch {
          evidenceTrust = "unknown";
        }
        if (evidenceTrust !== "trusted" || !this.validEventEvidence(record.eventEvidence, "not_accepted") ||
          !this.eventEvidenceMatchesPreparation(record, record.eventEvidence)) continue;
        const retention = await this.readResultAcceptanceRetention(record.request.preparationId);
        if (retention !== undefined && retention.state !== "cancelled") {
          await writeJson(this.resultAcceptanceRetentionPath(record.request.preparationId), { ...retention, state: "cancelled" });
        }
        await this.releaseResultAcceptancePins(record.request.preparationId);
      }
    }
    for (const entry of await readdir(this.explicitPinDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const pin = await this.readExplicitPin(entry.slice(0, -5));
      if (pin?.state === "released") await this.releaseExplicitPinRecords(pin.pinId);
    }
    for (const entry of await readdir(this.useBindingDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.readUseBinding(entry.slice(0, -5));
      if (record === undefined) continue;
      if (record.state === "rejected" || record.state === "released") {
        await this.releaseUseBindingPins(record.bindingId);
        continue;
      }
      if (record.state !== "preparing") continue;
      const artifactIds = [record.artifactId, ...record.dependencyClosure];
      for (const artifactId of artifactIds) {
        const retention: RetentionRecord = {
          schema: RETENTION_SCHEMA,
          retentionId: protectionId("use-retention", record.bindingId, artifactId),
          ownerType: "artifact_use_binding",
          ownerId: record.bindingId,
          artifactId,
          retainUntil: record.retentionUntil,
        };
        if (!(await exists(this.retentionPath(retention.retentionId)))) await writeJson(this.retentionPath(retention.retentionId), retention);
        const pin: PinRecord = {
          schema: PIN_SCHEMA,
          pinId: protectionId("use-pin", record.bindingId, artifactId),
          ownerType: "artifact_use_binding",
          ownerId: record.bindingId,
          purpose: record.purpose,
          artifactId,
          state: "held",
        };
        if (!(await exists(this.pinPath(pin.pinId)))) await writeJson(this.pinPath(pin.pinId), pin);
      }
      try {
        const principal = await this.options.authenticator.restore(record.subjectId);
        await this.finishPreparingUseBinding(record, principal);
      } catch (error) {
        if (error instanceof ArtifactStoreInjectedFault) throw error;
      }
    }
    for (const entry of await readdir(this.artifactDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.readArtifactRecord(entry.slice(0, -5));
      if (record?.lifecycle !== "deletion_pending") continue;
      const budget = record.deletionRecoveryBudget ?? this.options.policy.maxGarbageCollectionRecoveryAttempts;
      if (record.deletionRecoveryAttempts >= budget) continue;
      const attempting = { ...record, deletionRecoveryAttempts: record.deletionRecoveryAttempts + 1 };
      await writeJson(this.artifactPath(record.artifactId), attempting);
      try {
        await this.finishDeletion(attempting);
      } catch (error) {
        if (error instanceof ArtifactStoreInjectedFault) throw error;
      }
    }
  }

  async recover(): Promise<void> {
    await this.recoverUseBindingsPinsAndDeletions();
    for (const entry of await readdir(this.registrationDirectory)) {
      if (!entry.endsWith(".json")) continue;
      let record = await this.readRecord(entry.slice(0, -5));
      if (record?.state === "receiving" && Date.parse(record.request.deadline) <= this.now().getTime()) {
        record = { ...record, state: "aborted", failureReason: "deadline_expired" };
        await this.writeRecord(record);
        await this.removeTemporaryFiles(record.request.registrationId);
        continue;
      }
      if (record?.state !== "prepared") continue;
      if (record.recoveryAttempts >= record.request.recoveryBudget) {
        const published = await this.readArtifactRecord(record.artifactId);
        if (published !== undefined && typeof await this.verifiedBytes(published) !== "string") {
          await this.writeRecord({ ...record, state: "registered", artifact: published });
        } else {
          await this.writeRecord({ ...record, state: "unresolved", failureReason: "recovery_budget_exceeded" });
        }
        continue;
      }
      record = { ...record, recoveryAttempts: record.recoveryAttempts + 1 };
      await this.fault("before_recovery_attempt_persisted");
      await this.writeRecord(record);
      await this.fault("recovery_attempt_persisted");
      try {
        if (await this.readArtifactRecord(record.artifactId) !== undefined) {
          await this.commit(record);
          continue;
        }
        const principal = await this.options.authenticator.restore(record.subjectId);
        const committed = await this.commitAuthorized(record, principal);
        if (committed.kind === "failed" && committed.reason === "authority_unavailable") {
          throw new Error(committed.reason);
        }
      } catch (error) {
        if (error instanceof ArtifactStoreInjectedFault) throw error;
        const latest = await this.readRecord(record.request.registrationId);
        if (latest?.state === "registered") continue;
        const published = await this.readArtifactRecord(record.artifactId);
        if (published !== undefined) {
          const verified = await this.verifiedBytes(published);
          if (typeof verified !== "string") {
            await this.writeRecord({ ...record, state: "registered", artifact: published });
            continue;
          }
        }
        if (record.recoveryAttempts >= record.request.recoveryBudget) {
          await this.writeRecord({ ...record, state: "unresolved", failureReason: "recovery_budget_exceeded" });
        }
      }
    }
  }

  async initializeTemporaryByteCount(): Promise<void> {
    let total = 0;
    for (const entry of await readdir(this.registrationDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
      total += (await lstat(join(this.registrationDirectory, entry.name))).size;
    }
    this.temporaryBytes = total;
  }

  close(): Promise<void> {
    this.closing ??= this.finishClose();
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.activeTransfers]);
    await this.updateTail;
    await this.ioTail;
    await rm(this.lockDirectory, { recursive: true, force: true });
    await syncDirectory(dirname(this.lockDirectory)).catch(() => undefined);
  }
}

async function processStartToken(pid: number): Promise<string | undefined> {
  try {
    const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ");
    return fields[21];
  } catch {
    return undefined;
  }
}

async function acquireLock(rootDirectory: string): Promise<string> {
  const lockDirectory = `${rootDirectory}.writer-lock`;
  const parent = dirname(lockDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const claim = `${lockDirectory}.claim-${process.pid}-${randomUUID()}`;
  const startToken = await processStartToken(process.pid);
  if (startToken === undefined) {
    throw new ArtifactStoreOpenError("writer_locked", "Artifact writer ownership is not inspectable");
  }
  await mkdir(claim, { mode: 0o700 });
  await writeFile(join(claim, "owner.json"), `${JSON.stringify({
    pid: process.pid,
    startToken,
  })}\n`, { mode: 0o600 });
  await syncDirectory(claim);
  try {
    await rename(claim, lockDirectory);
    await syncDirectory(parent);
    return lockDirectory;
  } catch (error) {
    await rm(claim, { recursive: true, force: true });
    if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) throw error;
  }

  let owner: { readonly pid?: unknown; readonly startToken?: unknown } = {};
  try {
    owner = await readJson(join(lockDirectory, "owner.json")) as typeof owner;
  } catch {
    throw new ArtifactStoreOpenError("writer_locked", "Artifact writer ownership is not inspectable");
  }
  if (typeof owner.pid !== "number") {
    throw new ArtifactStoreOpenError("writer_locked", "Artifact writer ownership is not inspectable");
  }
  let alive = false;
  try {
    process.kill(owner.pid, 0);
    alive = true;
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw new ArtifactStoreOpenError("writer_locked", "Artifact writer ownership is not inspectable");
  }
  const currentStartToken = alive ? await processStartToken(owner.pid) : undefined;
  if (alive && (typeof owner.startToken !== "string" || currentStartToken === undefined || currentStartToken === owner.startToken)) {
    throw new ArtifactStoreOpenError("writer_locked", "Artifact storage root already has a writer");
  }
  const stale = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    await rename(lockDirectory, stale);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return acquireLock(rootDirectory);
    throw error;
  }
  await rm(stale, { recursive: true, force: true });
  await syncDirectory(parent);
  return acquireLock(rootDirectory);
}

async function initializeRoot(rootDirectory: string, formats: ReadonlyArray<StoredFormat>): Promise<void> {
  if (!(await exists(rootDirectory))) {
    await mkdir(rootDirectory, { mode: 0o700 });
    await syncDirectory(dirname(rootDirectory));
    await writeJson(join(rootDirectory, ROOT_FILE), { schema: ROOT_SCHEMA, formats });
    await mkdir(join(rootDirectory, "registrations"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "artifacts"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "use-bindings"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "pins"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "retentions"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "explicit-pins"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "result-acceptance-preparations"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "result-acceptance-retentions"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "gc-diagnostics"), { mode: 0o700 });
    await syncDirectory(rootDirectory);
    return;
  }
  const rootFile = join(rootDirectory, ROOT_FILE);
  if (!(await exists(rootFile))) {
    if ((await readdir(rootDirectory)).length !== 0) throw new ArtifactStoreOpenError("unsupported_root", "Artifact storage root has no supported format marker");
    await writeJson(rootFile, { schema: ROOT_SCHEMA, formats });
    await mkdir(join(rootDirectory, "registrations"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "artifacts"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "use-bindings"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "pins"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "retentions"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "explicit-pins"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "result-acceptance-preparations"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "result-acceptance-retentions"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "gc-diagnostics"), { mode: 0o700 });
    await syncDirectory(rootDirectory);
    return;
  }
  const marker = await readJson(rootFile) as { readonly schema?: unknown; readonly formats?: unknown };
  if (marker.schema !== ROOT_SCHEMA || JSON.stringify(marker.formats) !== JSON.stringify(formats)) {
    throw new ArtifactStoreOpenError("unsupported_root", "Unsupported Artifact storage root format or format registry");
  }
  for (const directory of [
    join(rootDirectory, "registrations"),
    join(rootDirectory, "artifacts"),
    join(rootDirectory, "use-bindings"),
    join(rootDirectory, "pins"),
    join(rootDirectory, "retentions"),
    join(rootDirectory, "explicit-pins"),
    join(rootDirectory, "result-acceptance-preparations"),
    join(rootDirectory, "result-acceptance-retentions"),
    join(rootDirectory, "gc-diagnostics"),
  ]) {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new ArtifactStoreOpenError("storage_inspection_unavailable", "Artifact storage directory is invalid");
  }
}

async function canonicalRoot(rootDirectory: string): Promise<string> {
  const absolute = resolve(rootDirectory);
  if (await exists(absolute)) return realpath(absolute);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  return join(await realpath(dirname(absolute)), basename(absolute));
}

async function openArtifactStoreInternal(options: InternalOpenArtifactStoreOptions): Promise<ArtifactStore> {
  validatePolicy(options.policy);
  const formats = configuredFormats();
  const normalizedOptions = { ...options, rootDirectory: await canonicalRoot(options.rootDirectory) };
  let lockDirectory: string;
  try {
    lockDirectory = await acquireLock(normalizedOptions.rootDirectory);
  } catch (error) {
    if (error instanceof ArtifactStoreOpenError) throw error;
    throw new ArtifactStoreOpenError("storage_inspection_unavailable", String(error));
  }
  try {
    await initializeRoot(normalizedOptions.rootDirectory, storedFormats(formats));
    const store = new FileArtifactStore(normalizedOptions, lockDirectory);
    await store.recover();
    await store.initializeTemporaryByteCount();
    return store;
  } catch (error) {
    await rm(lockDirectory, { recursive: true, force: true });
    if (error instanceof ArtifactStoreOpenError) throw error;
    throw new ArtifactStoreOpenError("storage_inspection_unavailable", String(error));
  }
}

export function openArtifactStore(options: OpenArtifactStoreOptions): Promise<ArtifactStore> {
  return openArtifactStoreInternal(options);
}

export function openArtifactStoreWithFaultInjection(
  options: OpenArtifactStoreOptions,
  faultInjector: (point: ArtifactStoreFaultPoint) => void | Promise<void>,
): Promise<ArtifactStore> {
  return openArtifactStoreInternal({ ...options, faultInjector });
}
