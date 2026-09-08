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
  type ArtifactUseOutcome,
  type ArtifactUseRequest,
  type ArtifactUseSnapshot,
  type OpenArtifactStoreOptions,
} from "../public.js";

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
  | "use_record_persisted"
  | "use_retention_persisted"
  | "use_parent_pin_persisted"
  | "use_dependency_pin_persisted"
  | "use_available_persisted"
  | "use_rejection_persisted"
  | "before_use_pins_released"
  | "gc_eligibility_checked"
  | "deletion_pending_persisted"
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

const ROOT_SCHEMA = "pions-artifacts.v2";
const RECORD_SCHEMA = "pions-artifact-registration.v2";
const ARTIFACT_SCHEMA = "pions-artifact.v2";
const USE_SCHEMA = "pions-artifact-use.v1";
const PIN_SCHEMA = "pions-artifact-pin.v1";
const RETENTION_SCHEMA = "pions-artifact-retention.v1";
const EXPLICIT_PIN_SCHEMA = "pions-artifact-explicit-pin.v1";
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
  readonly storageStatus: "verified" | "corrupt" | "unknown";
  readonly registeredAt: string;
  readonly unusedRetentionUntil: string;
  readonly deletionRecoveryAttempts: number;
  readonly deletionRecoveryBudget?: number;
}

interface UseRecord extends ArtifactUseSnapshot {
  readonly schema: typeof USE_SCHEMA;
  readonly requestDigest: `sha256:${string}`;
  readonly effectiveReviewRetentionMs: number;
  readonly failureReason?: ArtifactFailureReason;
}

interface PinRecord {
  readonly schema: typeof PIN_SCHEMA;
  readonly pinId: string;
  readonly ownerType: "artifact_use" | "principal";
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
  readonly ownerType: "registration_grace" | "artifact_use";
  readonly ownerId: string;
  readonly artifactId: string;
  readonly retainUntil: string;
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
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

function useFailed(reason: ArtifactFailureReason, terminal = true): ArtifactUseOutcome {
  return { kind: "failed", terminal, reason };
}

function gcFailed(reason: ArtifactFailureReason, terminal = true): ArtifactGarbageCollectionOutcome {
  return { kind: "failed", terminal, reason };
}

function useRequestDigest(request: Readonly<ArtifactUseRequest>): `sha256:${string}` {
  return sha256(JSON.stringify(request));
}

function pinRequestDigest(request: Readonly<ArtifactRetentionPinRequest>): `sha256:${string}` {
  return sha256(JSON.stringify(request));
}

function pinOutcome(record: ExplicitPinRecord): ArtifactRetentionPinOutcome {
  return { kind: record.state, pin: record };
}

function pinFailed(reason: ArtifactFailureReason, terminal = true): ArtifactRetentionPinOutcome {
  return { kind: "failed", terminal, reason };
}

function useOutcome(record: UseRecord): ArtifactUseOutcome {
  if (record.state === "available") return { kind: "available", use: record };
  if (record.state === "released") return { kind: "released", use: record };
  if (record.state === "preparing") return { kind: "continuable", use: record };
  return useFailed(record.failureReason ?? "storage_inspection_unavailable", record.state === "rejected");
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
    policy.acceptedArtifactRetentionMs,
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
  private readonly useDirectory: string;
  private readonly pinDirectory: string;
  private readonly retentionDirectory: string;
  private readonly explicitPinDirectory: string;
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
    this.useDirectory = join(options.rootDirectory, "uses");
    this.pinDirectory = join(options.rootDirectory, "pins");
    this.retentionDirectory = join(options.rootDirectory, "retentions");
    this.explicitPinDirectory = join(options.rootDirectory, "explicit-pins");
    for (const format of configuredFormats()) {
      this.formats.set(`${format.formatId}\0${format.normalizationId}`, format);
    }
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

  private usePath(useId: string): string {
    return join(this.useDirectory, `${useId}.json`);
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

  private async readUse(useId: string): Promise<UseRecord | undefined> {
    if (!IDENTIFIER.test(useId)) return undefined;
    try {
      const value = await readJson(this.usePath(useId)) as Partial<UseRecord>;
      const states = ["preparing", "available", "rejected", "released", "unresolved"];
      const request: ArtifactUseRequest = {
        useId: value.useId ?? "",
        operationId: value.operationId ?? "",
        artifactId: value.artifactId ?? "",
        purpose: value.purpose as "review_subject",
        decisionId: value.decisionId ?? "",
        authorityBasis: value.authorityBasis ?? "",
      };
      if (value.schema !== USE_SCHEMA || !IDENTIFIER.test(useId) || value.useId !== useId ||
        !IDENTIFIER.test(request.operationId) || !IDENTIFIER.test(request.artifactId) ||
        request.purpose !== "review_subject" || !IDENTIFIER.test(request.decisionId) ||
        typeof request.authorityBasis !== "string" || request.authorityBasis.length === 0 ||
        value.requestDigest !== useRequestDigest(request) || typeof value.subjectId !== "string" ||
        !Array.isArray(value.dependencyClosure) || !value.dependencyClosure.every((id) => typeof id === "string" && IDENTIFIER.test(id)) ||
        !Number.isFinite(Date.parse(value.retentionUntil ?? "")) || !states.includes(value.state ?? "") ||
        !Number.isSafeInteger(value.effectiveReviewRetentionMs) || (value.effectiveReviewRetentionMs ?? 0) <= 0) {
        throw new Error("Invalid Artifact use record");
      }
      return value as UseRecord;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private writeUse(record: UseRecord): Promise<void> {
    return this.serializeIo(() => writeJson(this.usePath(record.useId), record));
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
        (value.storageStatus !== "verified" && value.storageStatus !== "corrupt" && value.storageStatus !== "unknown") ||
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
      registeredAt: this.now().toISOString(),
      unusedRetentionUntil: new Date(this.now().getTime() + record.effectivePolicy.unusedArtifactRetentionMs).toISOString(),
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
      await this.recordStorageStatus(record, reason === "stored_artifact_corrupt" ? "corrupt" : "unknown").catch(() => undefined);
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

  async prepareUse(
    credential: string,
    request: Readonly<ArtifactUseRequest>,
  ): Promise<ArtifactUseOutcome> {
    try {
      return await this.serialize(() => this.prepareUseUnserialized(credential, request));
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      return useFailed("storage_inspection_unavailable", false);
    }
  }

  private validUseRequest(request: Readonly<ArtifactUseRequest>): boolean {
    return IDENTIFIER.test(request.useId) && IDENTIFIER.test(request.operationId) &&
      IDENTIFIER.test(request.artifactId) && request.purpose === "review_subject" &&
      IDENTIFIER.test(request.decisionId) && typeof request.authorityBasis === "string" && request.authorityBasis.length > 0;
  }

  private async useAuthority(
    principal: Readonly<ArtifactPrincipal>,
    request: Readonly<ArtifactUseRequest>,
    artifactIds: ReadonlyArray<string>,
  ): Promise<ArtifactFailureReason | undefined> {
    for (const artifactId of artifactIds) {
      try {
        const reason = authorityFailure(await principal.canBindUse(request, artifactId));
        if (reason !== undefined) return reason;
      } catch {
        return "authority_unavailable";
      }
    }
    return undefined;
  }

  private async prepareUseUnserialized(
    credential: string,
    request: Readonly<ArtifactUseRequest>,
  ): Promise<ArtifactUseOutcome> {
    if (this.closed || !this.validUseRequest(request)) return useFailed("limit_exceeded");
    const principal = await this.authenticate(credential);
    if (principal === undefined) return useFailed("unauthorized");
    const existing = await this.readUse(request.useId);
    if (existing !== undefined) {
      if (existing.subjectId !== principal.subjectId) return useFailed("unauthorized");
      if (existing.requestDigest !== useRequestDigest(request)) return useFailed("request_mismatch");
      if (existing.state === "preparing") return this.finishPreparingUse(existing, principal);
      return useOutcome(existing);
    }
    const parentAuthority = await this.useAuthority(principal, request, [request.artifactId]);
    if (parentAuthority !== undefined) return useFailed(parentAuthority, parentAuthority !== "authority_unavailable");
    const parent = await this.readArtifactRecord(request.artifactId);
    if (parent === undefined) return useFailed("unauthorized");
    if (parent.lifecycle === "deletion_pending") return useFailed("artifact_deletion_pending");
    if (parent.lifecycle === "deleted") return useFailed("artifact_deleted");
    const closure = await this.dependencyClosure(
      parent.dependencies,
      this.options.policy,
      (artifactId) => principal.canBindUse(request, artifactId),
    );
    if (closure.reason !== undefined) return useFailed(closure.reason, closure.reason !== "authority_unavailable");
    const artifactIds = [parent.artifactId, ...closure.records.map(({ artifactId }) => artifactId)];
    const retentionUntil = new Date(this.now().getTime() + this.options.policy.reviewInputRetentionMs).toISOString();
    const record: UseRecord = {
      schema: USE_SCHEMA,
      ...request,
      requestDigest: useRequestDigest(request),
      subjectId: principal.subjectId,
      dependencyClosure: closure.records.map(({ artifactId }) => artifactId),
      retentionUntil,
      effectiveReviewRetentionMs: this.options.policy.reviewInputRetentionMs,
      state: "preparing",
    };
    await this.writeUse(record);
    await this.fault("use_record_persisted");
    for (const artifactId of artifactIds) {
      const retention: RetentionRecord = {
        schema: RETENTION_SCHEMA,
        retentionId: protectionId("use-retention", request.useId, artifactId),
        ownerType: "artifact_use",
        ownerId: request.useId,
        artifactId,
        retainUntil: retentionUntil,
      };
      await this.serializeIo(() => writeJson(this.retentionPath(retention.retentionId), retention));
    }
    await this.fault("use_retention_persisted");
    for (let index = 0; index < artifactIds.length; index += 1) {
      const artifactId = artifactIds[index]!;
      const pin: PinRecord = {
        schema: PIN_SCHEMA,
        pinId: protectionId("use-pin", request.useId, artifactId),
        ownerType: "artifact_use",
        ownerId: request.useId,
        purpose: request.purpose,
        artifactId,
        state: "held",
      };
      await this.serializeIo(() => writeJson(this.pinPath(pin.pinId), pin));
      await this.fault(index === 0 ? "use_parent_pin_persisted" : "use_dependency_pin_persisted");
    }
    return this.finishPreparingUse(record, principal);
  }

  private async finishPreparingUse(
    record: UseRecord,
    principal: Readonly<ArtifactPrincipal>,
  ): Promise<ArtifactUseOutcome> {
    const request: ArtifactUseRequest = {
      useId: record.useId,
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
        return this.rejectUse(record, artifact?.lifecycle === "deletion_pending" ? "artifact_deletion_pending" : "artifact_deleted");
      }
      const bytes = await this.verifiedBytes(artifact);
      if (typeof bytes === "string") {
        if (bytes === "storage_inspection_unavailable") return useFailed(bytes, false);
        return this.rejectUse(record, bytes);
      }
    }
    const authority = await this.useAuthority(principal, request, artifactIds);
    if (authority !== undefined) {
      if (authority === "authority_unavailable") return useFailed(authority, false);
      return this.rejectUse(record, authority);
    }
    const available: UseRecord = { ...record, state: "available" };
    await this.writeUse(available);
    await this.fault("use_available_persisted");
    return useOutcome(available);
  }

  private async rejectUse(record: UseRecord, reason: ArtifactFailureReason): Promise<ArtifactUseOutcome> {
    const rejected: UseRecord = { ...record, state: "rejected", failureReason: reason };
    await this.writeUse(rejected);
    await this.fault("use_rejection_persisted");
    await this.releasePins(record.useId);
    return useOutcome(rejected);
  }

  private async releasePins(useId: string): Promise<void> {
    await this.fault("before_use_pins_released");
    for (const entry of await readdir(this.pinDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.pinDirectory, entry);
      const pin = await readJson(path) as Partial<PinRecord>;
      if (pin.schema !== PIN_SCHEMA || pin.ownerId !== useId || pin.state !== "held") continue;
      await this.serializeIo(() => writeJson(path, { ...pin, state: "released" }));
    }
  }

  async useStatus(credential: string, useId: string): Promise<ArtifactUseOutcome> {
    try {
      const principal = await this.authenticate(credential);
      if (principal === undefined) return useFailed("unauthorized");
      const record = await this.readUse(useId);
      if (record === undefined || record.subjectId !== principal.subjectId) return useFailed("unauthorized");
      return useOutcome(record);
    } catch {
      return useFailed("storage_inspection_unavailable", false);
    }
  }

  async retrieveForUse(credential: string, useId: string): Promise<ArtifactRetrievalOutcome> {
    const status = await this.useStatus(credential, useId);
    if (status.kind !== "available") {
      return retrievalFailed(status.kind === "failed" ? status.reason : "conflict", status.kind === "failed" && status.terminal);
    }
    return this.retrieve(credential, status.use.artifactId);
  }

  async releaseUse(credential: string, useId: string): Promise<ArtifactUseOutcome> {
    try {
      return await this.serialize(async () => {
        const principal = await this.authenticate(credential);
        if (principal === undefined) return useFailed("unauthorized");
        const record = await this.readUse(useId);
        if (record === undefined || record.subjectId !== principal.subjectId) return useFailed("unauthorized");
        if (record.state === "released") return useOutcome(record);
        if (record.state !== "available") return useOutcome(record);
        const released: UseRecord = { ...record, state: "released" };
        await this.writeUse(released);
        await this.releasePins(useId);
        return useOutcome(released);
      });
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedFault) throw error;
      return useFailed("storage_inspection_unavailable", false);
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
        for (const entry of await readdir(this.pinDirectory)) {
          if (!entry.endsWith(".json")) continue;
          const path = join(this.pinDirectory, entry);
          const pin = await readJson(path) as Partial<PinRecord>;
          if (pin.schema === PIN_SCHEMA && pin.ownerType === "principal" && pin.ownerId === pinId && pin.state === "held") {
            await this.serializeIo(() => writeJson(path, { ...pin, state: "released" }));
          }
        }
        return pinOutcome(released);
      });
    } catch {
      return pinFailed("storage_inspection_unavailable", false);
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
      return gcFailed("gc_processing_unavailable", false);
    }
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
      request.recoveryBudget > this.options.policy.maxGarbageCollectionRecoveryAttempts) {
      return gcFailed("limit_exceeded");
    }
    const principal = await this.authenticate(credential);
    if (principal === undefined) return gcFailed("unauthorized");
    let authority: ArtifactFailureReason | undefined;
    try { authority = authorityFailure(await principal.canGarbageCollect(request)); } catch { authority = "authority_unavailable"; }
    if (authority !== undefined) return gcFailed(authority, authority !== "authority_unavailable");
    const entries = (await readdir(this.artifactDirectory)).filter((entry) => entry.endsWith(".json")).sort();
    const scanned = entries.slice(0, request.scanBudget);
    const remainingArtifactIds = entries.slice(request.scanBudget).map((entry) => entry.slice(0, -5));
    const deletedArtifactIds: string[] = [];
    for (const entry of scanned) {
      if (deletedArtifactIds.length >= request.deletionBudget) {
        remainingArtifactIds.push(entry.slice(0, -5));
        continue;
      }
      const record = await this.readArtifactRecord(entry.slice(0, -5));
      if (record === undefined || record.lifecycle !== "available") continue;
      if (!(await this.isDeletionEligible(record.artifactId, record.unusedRetentionUntil))) continue;
      await this.fault("gc_eligibility_checked");
      const pending: ArtifactRecord = {
        ...record,
        lifecycle: "deletion_pending",
        deletionRecoveryBudget: request.recoveryBudget,
      };
      await this.serializeIo(() => writeJson(this.artifactPath(record.artifactId), pending));
      await this.fault("deletion_pending_persisted");
      await this.finishDeletion(pending);
      deletedArtifactIds.push(record.artifactId);
    }
    if (remainingArtifactIds.length > 0) {
      return { kind: "continuable", reason: "gc_unprocessed", deletedArtifactIds, remainingArtifactIds };
    }
    return { kind: "completed", deletedArtifactIds };
  }

  private async isDeletionEligible(artifactId: string, unusedRetentionUntil: string): Promise<boolean> {
    if (Date.parse(unusedRetentionUntil) > this.now().getTime()) return false;
    for (const entry of await readdir(this.useDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const use = await this.readUse(entry.slice(0, -5));
      if (use !== undefined && (use.state === "preparing" || use.state === "available") &&
        (use.artifactId === artifactId || use.dependencyClosure.includes(artifactId))) return false;
    }
    for (const entry of await readdir(this.explicitPinDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const pin = await this.readExplicitPin(entry.slice(0, -5));
      if (pin !== undefined && pin.state === "held" &&
        (pin.artifactId === artifactId || pin.dependencyClosure.includes(artifactId))) return false;
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
        await this.serializeIo(() => writeJson(this.artifactPath(record.artifactId), { ...record, storageStatus: "unknown" }));
        throw error;
      }
    }
    await this.fault("artifact_bytes_deleted");
    const deleted: ArtifactRecord = { ...record, lifecycle: "deleted" };
    await this.serializeIo(() => writeJson(this.artifactPath(record.artifactId), deleted));
    await this.fault("deletion_committed");
  }

  private async recoverUsesAndDeletions(): Promise<void> {
    for (const entry of await readdir(this.useDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.readUse(entry.slice(0, -5));
      if (record === undefined) continue;
      if (record.state === "rejected" || record.state === "released") {
        await this.releasePins(record.useId);
        continue;
      }
      if (record.state !== "preparing") continue;
      const artifactIds = [record.artifactId, ...record.dependencyClosure];
      for (const artifactId of artifactIds) {
        const retention: RetentionRecord = {
          schema: RETENTION_SCHEMA,
          retentionId: protectionId("use-retention", record.useId, artifactId),
          ownerType: "artifact_use",
          ownerId: record.useId,
          artifactId,
          retainUntil: record.retentionUntil,
        };
        if (!(await exists(this.retentionPath(retention.retentionId)))) await writeJson(this.retentionPath(retention.retentionId), retention);
        const pin: PinRecord = {
          schema: PIN_SCHEMA,
          pinId: protectionId("use-pin", record.useId, artifactId),
          ownerType: "artifact_use",
          ownerId: record.useId,
          purpose: record.purpose,
          artifactId,
          state: "held",
        };
        if (!(await exists(this.pinPath(pin.pinId)))) await writeJson(this.pinPath(pin.pinId), pin);
      }
      try {
        const principal = await this.options.authenticator.restore(record.subjectId);
        await this.finishPreparingUse(record, principal);
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
    await this.recoverUsesAndDeletions();
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
  await mkdir(claim, { mode: 0o700 });
  await writeFile(join(claim, "owner.json"), `${JSON.stringify({
    pid: process.pid,
    startToken: await processStartToken(process.pid),
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
    await mkdir(join(rootDirectory, "uses"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "pins"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "retentions"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "explicit-pins"), { mode: 0o700 });
    await syncDirectory(rootDirectory);
    return;
  }
  const rootFile = join(rootDirectory, ROOT_FILE);
  if (!(await exists(rootFile))) {
    if ((await readdir(rootDirectory)).length !== 0) throw new ArtifactStoreOpenError("unsupported_root", "Artifact storage root has no supported format marker");
    await writeJson(rootFile, { schema: ROOT_SCHEMA, formats });
    await mkdir(join(rootDirectory, "registrations"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "artifacts"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "uses"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "pins"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "retentions"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "explicit-pins"), { mode: 0o700 });
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
    join(rootDirectory, "uses"),
    join(rootDirectory, "pins"),
    join(rootDirectory, "retentions"),
    join(rootDirectory, "explicit-pins"),
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
