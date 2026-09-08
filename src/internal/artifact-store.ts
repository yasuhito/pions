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
  type ArtifactMetadata,
  type ArtifactPrincipal,
  type ArtifactRegistrationOutcome,
  type ArtifactRegistrationRequest,
  type ArtifactRegistrationSnapshot,
  type ArtifactRetrievalOutcome,
  type ArtifactStore,
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
  | "success_response";

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

const ROOT_SCHEMA = "pions-artifacts.v1";
const RECORD_SCHEMA = "pions-artifact-registration.v1";
const ARTIFACT_SCHEMA = "pions-artifact.v1";
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
        !value.dependencies.every((dependency) => typeof dependency === "string" && IDENTIFIER.test(dependency))) {
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
      if (record.lifecycle !== "available") return "artifact_deleted";
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
    const artifact: ArtifactRecord = {
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
    };
    const artifactPath = this.artifactPath(record.artifactId);
    if (await exists(artifactPath)) {
      const existing = await this.readArtifactRecord(record.artifactId);
      if (JSON.stringify(existing) !== JSON.stringify(artifact)) throw new Error("Artifact identifier conflict");
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
    if (record.lifecycle !== "available") return retrievalFailed("artifact_deleted");
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

  async recover(): Promise<void> {
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
    await syncDirectory(rootDirectory);
    return;
  }
  const rootFile = join(rootDirectory, ROOT_FILE);
  if (!(await exists(rootFile))) {
    if ((await readdir(rootDirectory)).length !== 0) throw new ArtifactStoreOpenError("unsupported_root", "Artifact storage root has no supported format marker");
    await writeJson(rootFile, { schema: ROOT_SCHEMA, formats });
    await mkdir(join(rootDirectory, "registrations"), { mode: 0o700 });
    await mkdir(join(rootDirectory, "artifacts"), { mode: 0o700 });
    await syncDirectory(rootDirectory);
    return;
  }
  const marker = await readJson(rootFile) as { readonly schema?: unknown; readonly formats?: unknown };
  if (marker.schema !== ROOT_SCHEMA || JSON.stringify(marker.formats) !== JSON.stringify(formats)) {
    throw new ArtifactStoreOpenError("unsupported_root", "Unsupported Artifact storage root format or format registry");
  }
  for (const directory of [join(rootDirectory, "registrations"), join(rootDirectory, "artifacts")]) {
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
