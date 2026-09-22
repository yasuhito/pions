import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  FormalReviewResultFormatConfiguration,
  FormalReviewResultFormatRegistration,
  FormalReviewResultFormatValidation,
} from "../formal-review.js";
import type {
  PinnedResultFormat,
  ResultFormatValidatorIdentity,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const REGISTRY_FORMAT = "pions.result-format-validator-registry.v1";
const REGISTRY_FILE = "result-format-validators.v1.json";
const REGISTRY_LOCK = `${REGISTRY_FILE}.lock`;
const LOCK_ATTEMPTS = 100;

interface RegisteredResultFormat {
  readonly pinned: Omit<PinnedResultFormat, "expectations">;
  readonly validate: FormalReviewResultFormatRegistration["validator"]["validate"];
}

type PersistedResultFormat = Omit<PinnedResultFormat, "expectations">;

interface PersistedRegistry {
  readonly formatId: typeof REGISTRY_FORMAT;
  readonly validators: ReadonlyArray<Readonly<ResultFormatValidatorIdentity>>;
  readonly formats: ReadonlyArray<Readonly<PersistedResultFormat>>;
}

export class ResultFormatRegistrationError extends Error {
  override readonly name = "ResultFormatRegistrationError";
}

export type ResultFormatValidationOutcome =
  | FormalReviewResultFormatValidation
  | {
      readonly kind: "invalid";
      readonly reason: "validator_identity_mismatch" | "validator_unavailable";
    };

export interface ResultFormatRegistry {
  pin(configuration: {
    readonly formatId: string;
    readonly version: string;
    readonly expectations: Readonly<Record<string, string>>;
  }): Readonly<PinnedResultFormat>;
  register(stateDirectory: string): Promise<void>;
  validate(
    pinned: Readonly<PinnedResultFormat>,
    bytes: Uint8Array
  ): Promise<ResultFormatValidationOutcome>;
  readonly digest: `sha256:${string}`;
}

export interface ConfiguredResultFormats {
  readonly registry: ResultFormatRegistry;
  readonly resultFormat: Readonly<PinnedResultFormat>;
}

function formatKey(formatId: string, version: string): string {
  return `${formatId}\0${version}`;
}

function validatorKey(validatorId: string, version: string): string {
  return `${validatorId}\0${version}`;
}

function validExpectations(
  expectations: Readonly<Record<string, string>>
): boolean {
  return Object.keys(expectations).every((key) => IDENTIFIER.test(key));
}

function validPersistedIdentity(
  value: unknown
): value is ResultFormatValidatorIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.validatorId === "string" &&
    IDENTIFIER.test(candidate.validatorId) &&
    typeof candidate.version === "string" &&
    IDENTIFIER.test(candidate.version) &&
    typeof candidate.digest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(candidate.digest)
  );
}

function validPersistedResultFormat(
  value: unknown
): value is PersistedResultFormat {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 4 &&
    typeof candidate.formatId === "string" &&
    IDENTIFIER.test(candidate.formatId) &&
    typeof candidate.version === "string" &&
    IDENTIFIER.test(candidate.version) &&
    typeof candidate.normalizationId === "string" &&
    IDENTIFIER.test(candidate.normalizationId) &&
    validPersistedIdentity(candidate.validator)
  );
}

function decodePersistedRegistry(source: string): PersistedRegistry {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new ResultFormatRegistrationError(
      "The persisted Result format validator registry is corrupt"
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    (value as { readonly formatId?: unknown }).formatId !== REGISTRY_FORMAT ||
    !Array.isArray((value as { readonly validators?: unknown }).validators) ||
    !(
      value as { readonly validators: ReadonlyArray<unknown> }
    ).validators.every(validPersistedIdentity) ||
    !Array.isArray((value as { readonly formats?: unknown }).formats) ||
    !(value as { readonly formats: ReadonlyArray<unknown> }).formats.every(
      validPersistedResultFormat
    )
  ) {
    throw new ResultFormatRegistrationError(
      "The persisted Result format validator registry is corrupt"
    );
  }
  return value as PersistedRegistry;
}

async function readPersistedRegistry(path: string): Promise<PersistedRegistry> {
  try {
    return decodePersistedRegistry(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { formatId: REGISTRY_FORMAT, validators: [], formats: [] };
    }
    throw error;
  }
}

async function acquireRegistryLock(path: string) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await open(path, "wx", 0o600);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new ResultFormatRegistrationError(
    "The Result format validator registry is locked"
  );
}

function mergedRegistry(
  persisted: Readonly<PersistedRegistry>,
  registrations: ReadonlyMap<string, Readonly<ResultFormatValidatorIdentity>>,
  configuredFormats: ReadonlyMap<string, Readonly<PersistedResultFormat>>
): PersistedRegistry {
  const validators = new Map(
    persisted.validators.map((identity) => [
      validatorKey(identity.validatorId, identity.version),
      identity,
    ])
  );
  if (validators.size !== persisted.validators.length) {
    throw new ResultFormatRegistrationError(
      "The persisted Result format validator registry is corrupt"
    );
  }
  for (const [key, identity] of registrations) {
    const existing = validators.get(key);
    if (existing !== undefined && existing.digest !== identity.digest) {
      throw new ResultFormatRegistrationError(
        "A Result format validator identity cannot be replaced"
      );
    }
    validators.set(key, identity);
  }

  const persistedFormats = new Map(
    persisted.formats.map((format) => [
      formatKey(format.formatId, format.version),
      format,
    ])
  );
  if (persistedFormats.size !== persisted.formats.length) {
    throw new ResultFormatRegistrationError(
      "The persisted Result format validator registry is corrupt"
    );
  }
  for (const [key, format] of configuredFormats) {
    const existing = persistedFormats.get(key);
    if (existing !== undefined && !isDeepStrictEqual(existing, format)) {
      throw new ResultFormatRegistrationError(
        "A Result format version cannot be replaced"
      );
    }
    persistedFormats.set(key, format);
  }
  for (const format of persistedFormats.values()) {
    const validator = validators.get(
      validatorKey(format.validator.validatorId, format.validator.version)
    );
    if (
      validator === undefined ||
      !isDeepStrictEqual(validator, format.validator)
    ) {
      throw new ResultFormatRegistrationError(
        "The persisted Result format validator registry is corrupt"
      );
    }
  }
  return {
    formatId: REGISTRY_FORMAT,
    validators: [...validators.values()].sort((left, right) =>
      validatorKey(left.validatorId, left.version).localeCompare(
        validatorKey(right.validatorId, right.version)
      )
    ),
    formats: [...persistedFormats.values()].sort((left, right) =>
      formatKey(left.formatId, left.version).localeCompare(
        formatKey(right.formatId, right.version)
      )
    ),
  };
}

export function makeResultFormatRegistry(
  registrations: ReadonlyArray<Readonly<FormalReviewResultFormatRegistration>>
): ResultFormatRegistry {
  const formats = new Map<string, RegisteredResultFormat>();
  const validators = new Map<string, Readonly<ResultFormatValidatorIdentity>>();

  for (const registration of registrations) {
    const validator = registration.validator;
    if (
      !IDENTIFIER.test(registration.formatId) ||
      !IDENTIFIER.test(registration.version) ||
      !IDENTIFIER.test(registration.normalizationId) ||
      !IDENTIFIER.test(validator.validatorId) ||
      !IDENTIFIER.test(validator.validatorVersion) ||
      validator.implementation.byteLength === 0
    ) {
      throw new ResultFormatRegistrationError(
        "Formal review Result format registration is invalid"
      );
    }
    const implementation = Uint8Array.from(validator.implementation);
    const identity = {
      validatorId: validator.validatorId,
      version: validator.validatorVersion,
      digest: sha256Digest(implementation),
    } as const;
    const identityKey = validatorKey(identity.validatorId, identity.version);
    const existingIdentity = validators.get(identityKey);
    if (
      existingIdentity !== undefined &&
      existingIdentity.digest !== identity.digest
    ) {
      throw new ResultFormatRegistrationError(
        "A Result format validator identity cannot be replaced"
      );
    }
    validators.set(identityKey, identity);

    const pinned = {
      formatId: registration.formatId,
      version: registration.version,
      normalizationId: registration.normalizationId,
      validator: identity,
    };
    const key = formatKey(registration.formatId, registration.version);
    const existing = formats.get(key);
    if (existing !== undefined && !isDeepStrictEqual(existing.pinned, pinned)) {
      throw new ResultFormatRegistrationError(
        "A Result format version cannot be replaced"
      );
    }
    formats.set(key, { pinned, validate: validator.validate });
  }

  const registryDigest = sha256Digest(
    JSON.stringify(
      [...formats.values()]
        .map(({ pinned }) => pinned)
        .sort((left, right) =>
          formatKey(left.formatId, left.version).localeCompare(
            formatKey(right.formatId, right.version)
          )
        )
    )
  );

  return {
    digest: registryDigest,
    pin(configuration): Readonly<PinnedResultFormat> {
      if (!validExpectations(configuration.expectations)) {
        throw new ResultFormatRegistrationError(
          "Formal review Result format expectations are invalid"
        );
      }
      const registered = formats.get(
        formatKey(configuration.formatId, configuration.version)
      );
      if (registered === undefined) {
        throw new ResultFormatRegistrationError(
          "The selected formal review Result format is not registered"
        );
      }
      return Object.freeze({
        ...structuredClone(registered.pinned),
        expectations: Object.freeze({ ...configuration.expectations }),
      });
    },
    async register(stateDirectory): Promise<void> {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const registryPath = join(stateDirectory, REGISTRY_FILE);
      const lockPath = join(stateDirectory, REGISTRY_LOCK);
      const lock = await acquireRegistryLock(lockPath);
      const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;
      try {
        const persisted = await readPersistedRegistry(registryPath);
        const merged = mergedRegistry(
          persisted,
          validators,
          new Map(
            [...formats].map(([key, registration]) => [
              key,
              registration.pinned,
            ])
          )
        );
        if (!isDeepStrictEqual(merged, persisted)) {
          await writeFile(temporaryPath, `${JSON.stringify(merged)}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          await rename(temporaryPath, registryPath);
        }
      } finally {
        await lock.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    },
    async validate(pinned, bytes): Promise<ResultFormatValidationOutcome> {
      const registered = formats.get(
        formatKey(pinned.formatId, pinned.version)
      );
      if (registered === undefined) {
        return { kind: "invalid", reason: "validator_unavailable" };
      }
      if (
        !isDeepStrictEqual(registered.pinned, {
          formatId: pinned.formatId,
          version: pinned.version,
          normalizationId: pinned.normalizationId,
          validator: pinned.validator,
        })
      ) {
        return { kind: "invalid", reason: "validator_identity_mismatch" };
      }
      try {
        return await registered.validate({
          bytes,
          formatId: pinned.formatId,
          version: pinned.version,
          normalizationId: pinned.normalizationId,
          expectations: pinned.expectations,
        });
      } catch {
        return { kind: "invalid", reason: "validator_unavailable" };
      }
    },
  };
}

export function configuredResultFormat(
  configuration: Readonly<FormalReviewResultFormatConfiguration>
): ConfiguredResultFormats {
  const registry = makeResultFormatRegistry(configuration.registrations);
  return { registry, resultFormat: registry.pin(configuration) };
}
