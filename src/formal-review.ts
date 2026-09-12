import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeFormalReviewIntegration } from "./internal/formal-review-integration.js";
import type {
  ArtifactMetadata,
  CurrentStartAuthorization,
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
  readonly formalReview?: Readonly<FormalReviewConfiguration>;
}

export interface ReviewSubjectDependencyManifestEntry {
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

export interface ReviewSubjectRegistrationRequest {
  readonly registrationId: string;
  readonly bytes: Uint8Array;
  readonly expectedByteCount: number;
  readonly expectedDigest: ArtifactMetadata["digest"];
  readonly formatId: string;
  readonly normalizationId: string;
  readonly dependencies: ReadonlyArray<
    Readonly<ReviewSubjectDependencyManifestEntry>
  >;
  readonly dependencyFiles: ReadonlyArray<
    Readonly<ReviewSubjectDependencyFile>
  >;
}

export type ReviewSubjectRegistrationFailureReason =
  "request_mismatch" | "registration_failed";

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
  ): Promise<Readonly<ArtifactMetadata>>;
  installPiExtension(pi: ExtensionAPI): void;
}

export function createFormalReviewIntegration(
  configuration: Readonly<FormalReviewIntegrationConfiguration>
): FormalReviewIntegration {
  return makeFormalReviewIntegration(configuration);
}
