import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeFormalReviewIntegration } from "./internal/formal-review-integration.js";
import type { ResultFormatValidationFailureReason } from "./public.js";

export type DeploymentMode = "non-production" | "production";

export type FormalReviewResultFormatValidation =
  | { readonly kind: "valid" }
  | {
      readonly kind: "invalid";
      readonly reason: ResultFormatValidationFailureReason;
    };

export interface FormalReviewResultFormatValidator {
  readonly validatorId: string;
  readonly validatorVersion: string;
  /** Exact bytes of the validation rules and implementation used by validate. */
  readonly implementation: Uint8Array;
  validate(input: {
    readonly bytes: Uint8Array;
    readonly formatId: string;
    readonly version: string;
    readonly normalizationId: string;
    readonly expectations: Readonly<Record<string, string>>;
  }): Promise<FormalReviewResultFormatValidation>;
}

export interface FormalReviewResultFormatRegistration {
  readonly formatId: string;
  readonly version: string;
  readonly normalizationId: string;
  readonly validator: Readonly<FormalReviewResultFormatValidator>;
}

export interface FormalReviewResultFormatConfiguration {
  readonly formatId: string;
  readonly version: string;
  readonly expectations: Readonly<Record<string, string>>;
  readonly registrations: ReadonlyArray<
    Readonly<FormalReviewResultFormatRegistration>
  >;
}

export interface FormalReviewConfiguration {
  readonly resultFormat: Readonly<FormalReviewResultFormatConfiguration>;
}

export const formalReviewIntegrationModule = Object.freeze({
  moduleId: "pions.formal-review-integration",
  version: "1",
} as const);

export interface FormalReviewTrustedBootstrap {
  readonly expectedModuleVersion: string;
  readonly repository: Readonly<{
    readonly repositoryId: string;
    readonly canonicalRoot: string;
    verifyIdentity(normalizedRoot: string): boolean;
  }>;
  readonly deployment: DeploymentMode;
}

export interface FormalReviewIntegrationConfiguration {
  readonly repositoryRoot: string;
  readonly trustedBootstrap: Readonly<FormalReviewTrustedBootstrap>;
  readonly formalReview?: Readonly<FormalReviewConfiguration>;
}

export type FormalReviewBootstrapFailureReason =
  | "invalid_bootstrap_configuration"
  | "module_version_mismatch"
  | "repository_identity_mismatch"
  | "test_adapter_rejected";

export class FormalReviewBootstrapError extends Error {
  override readonly name = "FormalReviewBootstrapError";

  constructor(
    readonly reason: FormalReviewBootstrapFailureReason,
    message: string
  ) {
    super(message);
  }
}

export interface FormalReviewIntegration {
  installPiExtension(pi: ExtensionAPI): void;
}

export function createFormalReviewIntegration(
  configuration: Readonly<FormalReviewIntegrationConfiguration>
): FormalReviewIntegration {
  return makeFormalReviewIntegration(configuration);
}
