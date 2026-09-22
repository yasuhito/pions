import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ExternalReviewAllocationError,
  type ExternalReviewAllocation,
  type ExternalReviewAllocationAuthentication,
  type ExternalReviewAllocationAuthenticator,
  type ExternalReviewAllocationBinding,
  type ExternalReviewAllocationRequest,
} from "../public.js";
import { canonicalJson } from "./canonical-json.js";
import { sha256Digest } from "./result-digest.js";
import {
  currentProcessStartToken,
  processStartToken,
} from "./worker-process-control.js";

const LEDGER_FORMAT = "pions.external-review-allocation-ledger.v1";
const LEDGER_FILE = "external-review-allocations.v1.json";
const LEDGER_LOCK = `${LEDGER_FILE}.lock`;
const LOCK_ATTEMPTS = 100;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ABSOLUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

interface PersistedLedger {
  readonly formatId: typeof LEDGER_FORMAT;
  readonly bindings: ReadonlyArray<Readonly<ExternalReviewAllocationBinding>>;
  readonly digest: `sha256:${string}`;
}

export interface ExternalReviewAllocationReservationInput {
  readonly request: Readonly<ExternalReviewAllocationRequest>;
  readonly operationId: string;
  readonly profileId: string;
  readonly reviewSubjectId: string;
}

export interface ExternalReviewAllocationReservation {
  readonly binding: Readonly<ExternalReviewAllocationBinding>;
  release(): Promise<void>;
}

export interface ExternalReviewAllocationRegistry {
  reserve(
    input: Readonly<ExternalReviewAllocationReservationInput>
  ): Promise<ExternalReviewAllocationReservation>;
}

function allocationDocument(allocation: Readonly<ExternalReviewAllocation>) {
  return {
    allocationId: allocation.allocationId,
    issuerId: allocation.issuerId,
    reviewSubjectId: allocation.reviewSubjectId,
    profileId: allocation.profileId,
    expiresAt: allocation.expiresAt,
    useLimit: allocation.useLimit,
    bundle: allocation.bundle,
    handoff: allocation.handoff,
    subjectVersion: allocation.subjectVersion,
    axis: allocation.axis,
    externalExecutionId: allocation.externalExecutionId,
  };
}

function bindingDocument(
  binding: Omit<ExternalReviewAllocationBinding, "digest">
) {
  return {
    ...allocationDocument(binding),
    requestId: binding.requestId,
    operationId: binding.operationId,
    boundAt: binding.boundAt,
  };
}

function bindingDigest(
  binding: Omit<ExternalReviewAllocationBinding, "digest">
): `sha256:${string}` {
  return sha256Digest(canonicalJson(bindingDocument(binding)));
}

function validOpaqueValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validAbsoluteTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ABSOLUTE_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

type UnknownAllocation = {
  readonly [Key in keyof ExternalReviewAllocation]: unknown;
};

function validAllocation(allocation: Readonly<UnknownAllocation>): boolean {
  return (
    validOpaqueValue(allocation.allocationId) &&
    validOpaqueValue(allocation.issuerId) &&
    validOpaqueValue(allocation.reviewSubjectId) &&
    validOpaqueValue(allocation.profileId) &&
    validAbsoluteTimestamp(allocation.expiresAt) &&
    typeof allocation.useLimit === "number" &&
    Number.isSafeInteger(allocation.useLimit) &&
    allocation.useLimit >= 0 &&
    allocation.useLimit <= 1 &&
    validOpaqueValue(allocation.bundle) &&
    validOpaqueValue(allocation.handoff) &&
    validOpaqueValue(allocation.subjectVersion) &&
    validOpaqueValue(allocation.axis) &&
    validOpaqueValue(allocation.externalExecutionId)
  );
}

export function validExternalReviewAllocationBinding(
  value: unknown
): value is ExternalReviewAllocationBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 15) return false;
  const allocation = {
    allocationId: candidate.allocationId,
    issuerId: candidate.issuerId,
    reviewSubjectId: candidate.reviewSubjectId,
    profileId: candidate.profileId,
    expiresAt: candidate.expiresAt,
    useLimit: candidate.useLimit,
    bundle: candidate.bundle,
    handoff: candidate.handoff,
    subjectVersion: candidate.subjectVersion,
    axis: candidate.axis,
    externalExecutionId: candidate.externalExecutionId,
  };
  if (
    Object.values(allocation).some((entry) => entry === undefined) ||
    !validAllocation(allocation) ||
    typeof candidate.requestId !== "string" ||
    !validOpaqueValue(candidate.requestId) ||
    typeof candidate.operationId !== "string" ||
    !validOpaqueValue(candidate.operationId) ||
    !validAbsoluteTimestamp(candidate.boundAt) ||
    typeof candidate.digest !== "string" ||
    !DIGEST.test(candidate.digest)
  ) {
    return false;
  }
  return (
    candidate.digest ===
    bindingDigest(
      candidate as unknown as Omit<ExternalReviewAllocationBinding, "digest">
    )
  );
}

function ledgerDigest(
  bindings: ReadonlyArray<Readonly<ExternalReviewAllocationBinding>>
): `sha256:${string}` {
  return sha256Digest(canonicalJson(bindings));
}

function decodeLedger(source: string): PersistedLedger {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new ExternalReviewAllocationError(
      "persistence_failed",
      "The external review allocation ledger is corrupt"
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    (value as { readonly formatId?: unknown }).formatId !== LEDGER_FORMAT ||
    !Array.isArray((value as { readonly bindings?: unknown }).bindings) ||
    !(value as { readonly bindings: ReadonlyArray<unknown> }).bindings.every(
      validExternalReviewAllocationBinding
    ) ||
    typeof (value as { readonly digest?: unknown }).digest !== "string"
  ) {
    throw new ExternalReviewAllocationError(
      "persistence_failed",
      "The external review allocation ledger is corrupt"
    );
  }
  const ledger = value as PersistedLedger;
  if (
    !DIGEST.test(ledger.digest) ||
    ledger.digest !== ledgerDigest(ledger.bindings) ||
    new Set(ledger.bindings.map(({ requestId }) => requestId)).size !==
      ledger.bindings.length ||
    new Set(ledger.bindings.map(({ allocationId }) => allocationId)).size !==
      ledger.bindings.length
  ) {
    throw new ExternalReviewAllocationError(
      "persistence_failed",
      "The external review allocation ledger is corrupt"
    );
  }
  return ledger;
}

async function readLedger(path: string): Promise<PersistedLedger> {
  try {
    return decodeLedger(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        formatId: LEDGER_FORMAT,
        bindings: [],
        digest: ledgerDigest([]),
      };
    }
    throw error;
  }
}

async function removeStaleLock(path: string): Promise<void> {
  const source = await readFile(path, "utf8").catch(() => undefined);
  if (source === undefined) return;
  let processId: number;
  let expected: string;
  try {
    const owner = JSON.parse(source) as unknown;
    if (
      typeof owner !== "object" ||
      owner === null ||
      Array.isArray(owner) ||
      typeof (owner as { readonly processId?: unknown }).processId !==
        "number" ||
      typeof (owner as { readonly processStartToken?: unknown })
        .processStartToken !== "string"
    ) {
      return;
    }
    processId = (owner as { readonly processId: number }).processId;
    expected = (owner as { readonly processStartToken: string })
      .processStartToken;
  } catch {
    return;
  }
  try {
    const observed = processStartToken(
      await readFile(`/proc/${processId}/stat`, "utf8")
    );
    if (observed === undefined || observed === expected) return;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      return;
    }
  }
  if ((await readFile(path, "utf8").catch(() => undefined)) === source) {
    await rm(path, { force: true });
  }
}

async function acquireLock(path: string) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const lock = await open(path, "wx", 0o600);
      try {
        await lock.writeFile(
          JSON.stringify({
            processId: process.pid,
            processStartToken: await currentProcessStartToken(),
          }),
          "utf8"
        );
        await lock.sync();
        return lock;
      } catch (error) {
        await lock.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      await removeStaleLock(path);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new ExternalReviewAllocationError(
    "persistence_failed",
    "The external review allocation ledger is locked"
  );
}

export function makeExternalReviewAllocationRegistry(
  options: Readonly<{
    readonly stateDirectory: string;
    readonly authenticator: ExternalReviewAllocationAuthenticator;
    readonly now: () => Date;
  }>
): ExternalReviewAllocationRegistry {
  return {
    async reserve(input) {
      const allocation = allocationDocument(input.request.allocation);
      if (
        !validOpaqueValue(input.request.requestId) ||
        !validOpaqueValue(input.operationId) ||
        !validAllocation(allocation)
      ) {
        throw new ExternalReviewAllocationError(
          "invalid_allocation",
          "The external review allocation is invalid"
        );
      }
      let authenticationResult: ExternalReviewAllocationAuthentication;
      try {
        authenticationResult = await options.authenticator.authenticate(
          allocation,
          input.request.credential
        );
      } catch {
        authenticationResult = "unknown";
      }
      if (authenticationResult !== "authenticated") {
        throw new ExternalReviewAllocationError(
          "issuer_authentication_failed",
          "The external review allocation issuer is not authenticated"
        );
      }
      if (
        allocation.reviewSubjectId !== input.reviewSubjectId ||
        allocation.profileId !== input.profileId
      ) {
        throw new ExternalReviewAllocationError(
          "allocation_mismatch",
          "The external review allocation does not match the Operation"
        );
      }
      const boundAt = options.now().toISOString();

      await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
      const ledgerPath = join(options.stateDirectory, LEDGER_FILE);
      const lockPath = join(options.stateDirectory, LEDGER_LOCK);
      const lock = await acquireLock(lockPath);
      const temporaryPath = `${ledgerPath}.${randomUUID()}.tmp`;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await lock.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
      try {
        const ledger = await readLedger(ledgerPath);
        const sameRequest = ledger.bindings.find(
          (binding) => binding.requestId === input.request.requestId
        );
        if (sameRequest !== undefined) {
          if (!isDeepStrictEqual(allocationDocument(sameRequest), allocation)) {
            throw new ExternalReviewAllocationError(
              "request_mismatch",
              "The allocation binding request cannot be replaced"
            );
          }
          return { binding: sameRequest, release };
        }
        if (Date.parse(allocation.expiresAt) <= Date.parse(boundAt)) {
          throw new ExternalReviewAllocationError(
            "expired",
            "The external review allocation has expired"
          );
        }
        if (allocation.useLimit < 1) {
          throw new ExternalReviewAllocationError(
            "use_limit_exceeded",
            "The external review allocation use limit is exhausted"
          );
        }
        if (
          ledger.bindings.some(
            (binding) => binding.allocationId === allocation.allocationId
          )
        ) {
          throw new ExternalReviewAllocationError(
            "allocation_already_bound",
            "The external review allocation cannot be bound again"
          );
        }
        const withoutDigest = {
          ...allocation,
          requestId: input.request.requestId,
          operationId: input.operationId,
          boundAt,
        };
        const binding: ExternalReviewAllocationBinding = {
          ...withoutDigest,
          digest: bindingDigest(withoutDigest),
        };
        const bindings = [...ledger.bindings, binding];
        const updated: PersistedLedger = {
          formatId: LEDGER_FORMAT,
          bindings,
          digest: ledgerDigest(bindings),
        };
        const temporary = await open(temporaryPath, "wx", 0o600);
        try {
          await temporary.writeFile(`${JSON.stringify(updated)}\n`, "utf8");
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        await rename(temporaryPath, ledgerPath);
        const directory = await open(options.stateDirectory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return { binding, release };
      } catch (error) {
        await release();
        throw error;
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    },
  };
}
