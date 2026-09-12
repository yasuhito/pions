import { isDeepStrictEqual } from "node:util";

import type {
  FormalReviewResultFormatConfiguration,
  FormalReviewResultFormatRegistration,
  FormalReviewResultFormatValidation,
} from "../formal-review.js";
import type {
  PinnedResultFormat,
  ResultFormatRejectionReason,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

interface RegisteredResultFormat {
  readonly pinned: Omit<PinnedResultFormat, "expectations">;
  readonly validate: FormalReviewResultFormatRegistration["validator"]["validate"];
}

export class ResultFormatRegistrationError extends Error {
  override readonly name = "ResultFormatRegistrationError";
}

export type ResultFormatValidationOutcome =
  | FormalReviewResultFormatValidation
  | {
      readonly kind: "invalid";
      readonly reason: Extract<
        ResultFormatRejectionReason,
        "validator_identity_mismatch" | "validator_unavailable"
      >;
    };

export interface ResultFormatRegistry {
  pin(configuration: {
    readonly formatId: string;
    readonly version: string;
    readonly expectations: Readonly<Record<string, string>>;
  }): Readonly<PinnedResultFormat>;
  validate(
    pinned: Readonly<PinnedResultFormat>,
    bytes: Uint8Array
  ): Promise<ResultFormatValidationOutcome>;
  readonly digest: `sha256:${string}`;
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
  return Object.entries(expectations).every(
    ([key, value]) => IDENTIFIER.test(key) && typeof value === "string"
  );
}

export function makeResultFormatRegistry(
  registrations: ReadonlyArray<Readonly<FormalReviewResultFormatRegistration>>
): ResultFormatRegistry {
  const formats = new Map<string, RegisteredResultFormat>();
  const validatorDigests = new Map<string, `sha256:${string}`>();

  for (const registration of registrations) {
    const validator = registration.validator;
    if (
      !IDENTIFIER.test(registration.formatId) ||
      !IDENTIFIER.test(registration.version) ||
      !IDENTIFIER.test(registration.normalizationId) ||
      !IDENTIFIER.test(validator.validatorId) ||
      !IDENTIFIER.test(validator.validatorVersion) ||
      validator.registrationArtifact.byteLength === 0
    ) {
      throw new ResultFormatRegistrationError(
        "Formal review Result format registration is invalid"
      );
    }
    const digest = sha256Digest(validator.registrationArtifact);
    const identityKey = validatorKey(
      validator.validatorId,
      validator.validatorVersion
    );
    const existingDigest = validatorDigests.get(identityKey);
    if (existingDigest !== undefined && existingDigest !== digest) {
      throw new ResultFormatRegistrationError(
        "A Result format validator identity cannot be replaced"
      );
    }
    validatorDigests.set(identityKey, digest);

    const pinned = {
      formatId: registration.formatId,
      version: registration.version,
      normalizationId: registration.normalizationId,
      validator: {
        validatorId: validator.validatorId,
        version: validator.validatorVersion,
        digest,
      },
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
): {
  readonly registry: ResultFormatRegistry;
  readonly pinned: Readonly<PinnedResultFormat>;
} {
  const registry = makeResultFormatRegistry(configuration.registrations);
  return { registry, pinned: registry.pin(configuration) };
}
