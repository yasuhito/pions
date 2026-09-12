import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeFormalReviewIntegration } from "./internal/formal-review-integration.js";
import type {
  ArtifactMetadata,
  CurrentStartAuthorization,
  ReviewSubjectRegistrationEvidence,
  RuntimeReviewSubjectAuthority,
  WorkerProfilePolicy,
} from "./public.js";

export interface FormalReviewCoordinatorConfiguration {
  readonly subjectId: string;
  currentAuthorization(operationId: string): Promise<CurrentStartAuthorization>;
}

export interface FormalReviewConfiguration {
  readonly profile: Readonly<WorkerProfilePolicy>;
  readonly reviewSubjectAuthority: RuntimeReviewSubjectAuthority;
  readonly coordinator?: Readonly<FormalReviewCoordinatorConfiguration>;
}

export interface FormalReviewIntegrationConfiguration {
  readonly repositoryRoot: string;
  readonly reviewSubjectRegistration: Readonly<ReviewSubjectRegistrationEvidenceConfiguration>;
  readonly formalReview?: Readonly<FormalReviewConfiguration>;
}

export interface ReviewSubjectDependencyRequirement {
  readonly path: string;
  readonly expectedByteCount: number;
  readonly expectedDigest: ArtifactMetadata["digest"];
  readonly formatId: string;
  readonly normalizationId: string;
}

export interface ReviewSubjectDependencyFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ReviewSubjectRegistrationEvidenceDeclaration {
  readonly issuerId: string;
  readonly authentication: string;
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly root: Readonly<{
    readonly byteCount: number;
    readonly digest: ArtifactMetadata["digest"];
  }>;
  readonly dependencies: ReadonlyArray<
    Readonly<{
      readonly path: string;
      readonly byteCount: number;
      readonly digest: ArtifactMetadata["digest"];
    }>
  >;
  readonly collectionDigest: ArtifactMetadata["digest"];
}

export interface ReviewSubjectRegistrationRequest {
  readonly registrationId: string;
  readonly bytes: Uint8Array;
  readonly expectedByteCount: number;
  readonly expectedDigest: ArtifactMetadata["digest"];
  readonly formatId: string;
  readonly normalizationId: string;
  readonly dependencies: ReadonlyArray<
    Readonly<ReviewSubjectDependencyRequirement>
  >;
  readonly dependencyFiles: ReadonlyArray<
    Readonly<ReviewSubjectDependencyFile>
  >;
  readonly evidence: Readonly<ReviewSubjectRegistrationEvidenceDeclaration>;
}

export type ReviewSubjectEvidenceAuthentication =
  "authenticated" | "denied" | "unknown";

export interface ReviewSubjectRegistrationEvidenceAuthenticator {
  authenticate(
    declaration: Readonly<ReviewSubjectRegistrationEvidenceDeclaration>
  ): Promise<ReviewSubjectEvidenceAuthentication>;
}

export type ReviewSubjectRegistrationValidation =
  | {
      readonly kind: "valid";
      readonly collectionDigest: ArtifactMetadata["digest"];
    }
  | { readonly kind: "invalid" };

export interface ReviewSubjectRegistrationEvidenceValidator {
  readonly validatorId: string;
  readonly validatorVersion: string;
  validate(input: {
    readonly root: Uint8Array;
    readonly dependencies: ReadonlyArray<
      Readonly<{ readonly path: string; readonly bytes: Uint8Array }>
    >;
  }): Promise<ReviewSubjectRegistrationValidation>;
}

export interface ReviewSubjectRegistrationEvidenceConfiguration {
  readonly authenticator: ReviewSubjectRegistrationEvidenceAuthenticator;
  readonly validator: ReviewSubjectRegistrationEvidenceValidator;
}

export interface ReviewSubjectRegistrationResult {
  readonly artifact: Readonly<ArtifactMetadata>;
  readonly evidence: Readonly<ReviewSubjectRegistrationEvidence>;
}

export type ReviewSubjectRegistrationFailureReason =
  | "request_mismatch"
  | "issuer_authentication_failed"
  | "evidence_validation_failed"
  | "registration_failed";

export class ReviewSubjectRegistrationError extends Error {
  override readonly name = "ReviewSubjectRegistrationError";

  constructor(
    readonly reason: ReviewSubjectRegistrationFailureReason,
    message: string
  ) {
    super(message);
  }
}

export interface FormalReviewIntegration {
  registerReviewSubject(
    request: Readonly<ReviewSubjectRegistrationRequest>
  ): Promise<Readonly<ReviewSubjectRegistrationResult>>;
  installPiExtension(pi: ExtensionAPI): void;
}

export function createFormalReviewIntegration(
  configuration: Readonly<FormalReviewIntegrationConfiguration>
): FormalReviewIntegration {
  return makeFormalReviewIntegration(configuration);
}
