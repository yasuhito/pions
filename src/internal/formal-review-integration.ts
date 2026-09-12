import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { PrivateFileEventStore } from "./event-store/index.js";
import {
  installPionsExtension,
  type PionsExtensionOptions,
} from "./pi-extension.js";
import { resolveRepositoryState } from "./repository-state.js";
import { runtimeArtifactStore } from "./runtime-artifacts.js";
import type { RuntimeClock } from "./services.js";
import { sha256Digest } from "./result-digest.js";
import {
  reviewSubjectRegistrationEvidenceDigest,
  reviewSubjectRegistrationEvidenceId,
} from "./review-subject-registration-evidence.js";
import type { VisibleRuntimeOptions } from "./visible-runtime.js";
import type {
  FormalReviewIntegration,
  FormalReviewIntegrationConfiguration,
  ReviewSubjectRegistrationRequest,
} from "../formal-review.js";
import { ReviewSubjectRegistrationError } from "../formal-review.js";
import type {
  ArtifactDigest,
  ArtifactMetadata,
  ArtifactRegistrationOutcome,
  ReviewSubjectRegistrationEvidence,
  Runtime,
  StartAuthorizationAuthenticator,
  StartAuthorizationAuthority,
} from "../public.js";
import type { ReviewSubjectRegistrationResult } from "../formal-review.js";

const REGISTRATION_WINDOW_MS = 60_000;
const REGISTRATION_RECOVERY_BUDGET = 3;
const REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const MAX_REVIEW_SUBJECT_PATH_LENGTH = 1_024;

interface ArtifactRegistrationInput {
  readonly registrationId: string;
  readonly bytes: Uint8Array;
  readonly expectedByteCount: number;
  readonly expectedDigest: ArtifactDigest;
  readonly formatId: string;
  readonly normalizationId: string;
  readonly dependencies: ReadonlyArray<string>;
}

export interface FormalReviewIntegrationDependencies {
  readonly stateBaseDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly now?: () => Date;
  readonly runtimeFactory?: (options: VisibleRuntimeOptions) => Runtime;
  readonly resultRuntimeFactory?: PionsExtensionOptions["resultRuntimeFactory"];
}

const dependenciesByConfiguration = new WeakMap<
  Readonly<FormalReviewIntegrationConfiguration>,
  Readonly<FormalReviewIntegrationDependencies>
>();

export function configureFormalReviewIntegrationForTest(
  configuration: Readonly<FormalReviewIntegrationConfiguration>,
  dependencies: Readonly<FormalReviewIntegrationDependencies>
): void {
  dependenciesByConfiguration.set(configuration, dependencies);
}

function makeRegistrationClock(now: () => Date): RuntimeClock {
  return {
    now: () => Effect.sync(() => now().toISOString()),
    sleep: (milliseconds) =>
      Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, milliseconds))
      ),
    monotonicMilliseconds: () => performance.now(),
    recoveredElapsedTimeIsReliable: () => false,
  };
}

function registrationError(
  outcome: Extract<ArtifactRegistrationOutcome, { readonly kind: "failed" }>
): ReviewSubjectRegistrationError {
  return new ReviewSubjectRegistrationError(
    outcome.reason === "request_mismatch"
      ? "request_mismatch"
      : "registration_failed",
    `Review subject Artifact registration failed: ${outcome.reason}`
  );
}

function toPublicArtifactMetadata(
  artifact: Readonly<ArtifactMetadata>
): Readonly<ArtifactMetadata> {
  return {
    artifactId: artifact.artifactId,
    byteCount: artifact.byteCount,
    digest: artifact.digest,
    formatId: artifact.formatId,
    normalizationId: artifact.normalizationId,
    dependencies: [...artifact.dependencies],
  };
}

function metadataMatches(
  artifact: Readonly<ArtifactMetadata>,
  input: Readonly<ArtifactRegistrationInput>
): boolean {
  return (
    artifact.byteCount === input.expectedByteCount &&
    artifact.digest === input.expectedDigest &&
    artifact.formatId === input.formatId &&
    artifact.normalizationId === input.normalizationId &&
    artifact.dependencies.length === input.dependencies.length &&
    artifact.dependencies.every(
      (dependency, index) => dependency === input.dependencies[index]
    )
  );
}

function validReviewSubjectPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > MAX_REVIEW_SUBJECT_PATH_LENGTH ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  return path
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".."
    );
}

function invalidRegistrationRequest(message: string): never {
  throw new ReviewSubjectRegistrationError("registration_failed", message);
}

function validateArtifactInput(
  input: Readonly<ArtifactRegistrationInput>
): void {
  if (
    !REGISTRATION_ID.test(input.registrationId) ||
    !Number.isSafeInteger(input.expectedByteCount) ||
    input.expectedByteCount < 0
  ) {
    invalidRegistrationRequest("Review subject Artifact metadata is invalid");
  }
  if (
    input.bytes.byteLength !== input.expectedByteCount ||
    sha256Digest(input.bytes) !== input.expectedDigest
  ) {
    invalidRegistrationRequest(
      "Review subject Artifact bytes do not match the manifest"
    );
  }
}

function dependencyRegistrationId(
  registrationId: string,
  path: string
): string {
  return `review-subject-dependency-${createHash("sha256")
    .update(registrationId, "utf8")
    .update("\0", "utf8")
    .update(path, "utf8")
    .digest("hex")}`;
}

function coordinatorConfiguration(
  configuration: Readonly<FormalReviewIntegrationConfiguration>
):
  | Readonly<{
      credential: string;
      authenticator: StartAuthorizationAuthenticator;
      authority: StartAuthorizationAuthority;
    }>
  | undefined {
  const coordinator = configuration.formalReview?.coordinator;
  if (coordinator === undefined) return undefined;
  const credential = randomBytes(32).toString("hex");
  const credentialBytes = Buffer.from(credential, "utf8");
  const authority: StartAuthorizationAuthority = {
    currentAuthorization: (subjectId, operationId) =>
      subjectId === coordinator.subjectId
        ? coordinator.currentAuthorization(operationId)
        : Promise.resolve("denied"),
  };
  const authenticator: StartAuthorizationAuthenticator = {
    authenticate: async (candidate) => {
      const candidateBytes = Buffer.from(candidate, "utf8");
      if (
        candidateBytes.byteLength !== credentialBytes.byteLength ||
        !timingSafeEqual(candidateBytes, credentialBytes)
      ) {
        throw new Error("Invalid formal review Coordinator credential");
      }
      return {
        subjectId: coordinator.subjectId,
        currentAuthorization: (operationId) =>
          coordinator.currentAuthorization(operationId),
      };
    },
  };
  return { credential, authenticator, authority };
}

export function makeFormalReviewIntegration(
  configuration: Readonly<FormalReviewIntegrationConfiguration>
): FormalReviewIntegration {
  const dependencies = dependenciesByConfiguration.get(configuration) ?? {};
  const environment = dependencies.environment ?? process.env;
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const now = dependencies.now ?? (() => new Date());
  const artifactCredential = randomBytes(32).toString("hex");
  const coordinator = coordinatorConfiguration(configuration);

  async function repositoryContext() {
    return resolveRepositoryState({
      cwd: configuration.repositoryRoot,
      repositoryRoot: configuration.repositoryRoot,
      ...(dependencies.stateBaseDirectory === undefined
        ? {}
        : { stateBaseDirectory: dependencies.stateBaseDirectory }),
      environment,
      homeDirectory,
    });
  }

  async function registerReviewSubject(
    request: Readonly<ReviewSubjectRegistrationRequest>
  ): Promise<Readonly<ReviewSubjectRegistrationResult>> {
    const { normalizedRoot, repositoryState } = await repositoryContext();
    const stateDirectory = join(repositoryState, "runtime");
    const eventStore = new PrivateFileEventStore(
      stateDirectory,
      makeRegistrationClock(now)
    );
    const artifactServices = runtimeArtifactStore(
      stateDirectory,
      eventStore,
      now,
      undefined,
      configuration.formalReview?.reviewSubjectAuthority,
      {
        subjectId: `formal-review-integration.${createHash("sha256")
          .update(normalizedRoot, "utf8")
          .digest("hex")}`,
        credential: artifactCredential,
      }
    );
    try {
      const rootInputWithoutDependencies: ArtifactRegistrationInput = {
        registrationId: request.registrationId,
        bytes: request.bytes,
        expectedByteCount: request.expectedByteCount,
        expectedDigest: request.expectedDigest,
        formatId: request.formatId,
        normalizationId: request.normalizationId,
        dependencies: [],
      };
      validateArtifactInput(rootInputWithoutDependencies);

      const requirementsByPath = new Map(
        request.dependencies.map((dependency) => [dependency.path, dependency])
      );
      if (requirementsByPath.size !== request.dependencies.length) {
        invalidRegistrationRequest(
          "Review subject dependency requirements contain a duplicate path"
        );
      }
      const filesByPath = new Map(
        request.dependencyFiles.map((file) => [file.path, file.bytes])
      );
      if (filesByPath.size !== request.dependencyFiles.length) {
        invalidRegistrationRequest(
          "Review subject dependency files contain a duplicate path"
        );
      }
      for (const path of [
        ...requirementsByPath.keys(),
        ...filesByPath.keys(),
      ]) {
        if (!validReviewSubjectPath(path)) {
          invalidRegistrationRequest(
            "Review subject dependency path is invalid"
          );
        }
      }
      if (
        requirementsByPath.size !== filesByPath.size ||
        [...requirementsByPath.keys()].some((path) => !filesByPath.has(path))
      ) {
        invalidRegistrationRequest(
          "Review subject dependency files do not match the requirements"
        );
      }

      const declaration = request.evidence;
      const declarationDependencies = new Map(
        declaration.dependencies.map((dependency) => [
          dependency.path,
          dependency,
        ])
      );
      const registrationConfiguration = configuration.reviewSubjectRegistration;
      if (
        !REGISTRATION_ID.test(declaration.issuerId) ||
        declarationDependencies.size !== declaration.dependencies.length ||
        declaration.validatorId !==
          registrationConfiguration.validator.validatorId ||
        declaration.validatorVersion !==
          registrationConfiguration.validator.validatorVersion ||
        declaration.root.byteCount !== request.expectedByteCount ||
        declaration.root.digest !== request.expectedDigest ||
        declarationDependencies.size !== requirementsByPath.size ||
        [...requirementsByPath].some(([path, dependency]) => {
          const declared = declarationDependencies.get(path);
          return (
            declared === undefined ||
            declared.byteCount !== dependency.expectedByteCount ||
            declared.digest !== dependency.expectedDigest
          );
        })
      ) {
        throw new ReviewSubjectRegistrationError(
          "evidence_validation_failed",
          "Review subject registration evidence does not match the manifest"
        );
      }
      let authentication: "authenticated" | "denied" | "unknown";
      try {
        authentication =
          await registrationConfiguration.authenticator.authenticate(
            declaration
          );
      } catch {
        authentication = "unknown";
      }
      if (authentication !== "authenticated") {
        throw new ReviewSubjectRegistrationError(
          "issuer_authentication_failed",
          "Review subject registration evidence issuer is not authenticated"
        );
      }
      const sortedFiles = [...filesByPath]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, bytes]) => ({ path, bytes }));
      let validation:
        | Awaited<
            ReturnType<typeof registrationConfiguration.validator.validate>
          >
        | undefined;
      try {
        validation = await registrationConfiguration.validator.validate({
          root: request.bytes,
          dependencies: sortedFiles,
        });
      } catch {
        validation = undefined;
      }
      if (
        validation?.kind !== "valid" ||
        validation.collectionDigest !== declaration.collectionDigest
      ) {
        throw new ReviewSubjectRegistrationError(
          "evidence_validation_failed",
          "Review subject registration evidence collection digest is invalid"
        );
      }

      async function registerArtifact(
        input: Readonly<ArtifactRegistrationInput>
      ): Promise<Readonly<ArtifactMetadata>> {
        validateArtifactInput(input);
        const existing = await artifactServices.artifacts.registrationStatus(
          artifactServices.credential,
          input.registrationId
        );
        if (existing.kind === "registered") {
          if (!metadataMatches(existing.artifact, input)) {
            throw new ReviewSubjectRegistrationError(
              "request_mismatch",
              "Review subject registration request does not match the registered Artifact"
            );
          }
          return toPublicArtifactMetadata(existing.artifact);
        }
        let outcome: ArtifactRegistrationOutcome = existing;
        if (existing.kind === "failed" && existing.reason === "unauthorized") {
          outcome = await artifactServices.artifacts.startRegistration(
            artifactServices.credential,
            {
              registrationId: input.registrationId,
              expectedByteCount: input.expectedByteCount,
              expectedDigest: input.expectedDigest,
              formatId: input.formatId,
              normalizationId: input.normalizationId,
              dependencies: input.dependencies,
              deadline: new Date(
                now().getTime() + REGISTRATION_WINDOW_MS
              ).toISOString(),
              recoveryBudget: REGISTRATION_RECOVERY_BUDGET,
            }
          );
        }
        if (outcome.kind === "failed") throw registrationError(outcome);
        if (outcome.kind === "registered")
          return toPublicArtifactMetadata(outcome.artifact);
        const transferred = await artifactServices.artifacts.transfer(
          artifactServices.credential,
          input.registrationId,
          input.bytes
        );
        if (transferred.kind === "failed") throw registrationError(transferred);
        if (transferred.kind === "continuable") {
          throw new ReviewSubjectRegistrationError(
            "registration_failed",
            "Review subject transfer did not complete"
          );
        }
        return toPublicArtifactMetadata(transferred.artifact);
      }

      const dependencyArtifacts: Array<
        Readonly<{ readonly path: string; readonly artifact: ArtifactMetadata }>
      > = [];
      for (const [path, dependency] of [...requirementsByPath].sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)
      )) {
        const bytes = filesByPath.get(path);
        if (bytes === undefined) {
          invalidRegistrationRequest("Review subject dependency is missing");
        }
        const artifact = await registerArtifact({
          registrationId: dependencyRegistrationId(
            request.registrationId,
            path
          ),
          bytes,
          expectedByteCount: dependency.expectedByteCount,
          expectedDigest: dependency.expectedDigest,
          formatId: dependency.formatId,
          normalizationId: dependency.normalizationId,
          dependencies: [],
        });
        dependencyArtifacts.push({ path, artifact });
      }

      const artifact = await registerArtifact({
        ...rootInputWithoutDependencies,
        dependencies: dependencyArtifacts.map(
          ({ artifact: dependency }) => dependency.artifactId
        ),
      });
      const evidenceWithoutDigest: Omit<
        ReviewSubjectRegistrationEvidence,
        "digest"
      > = {
        formatId: "pions.review-subject-registration-evidence.v1",
        evidenceId: reviewSubjectRegistrationEvidenceId(artifact.artifactId),
        issuerId: declaration.issuerId,
        root: artifact,
        files: dependencyArtifacts.map(({ path, artifact: dependency }) => ({
          path,
          artifactId: dependency.artifactId,
          byteCount: dependency.byteCount,
          digest: dependency.digest,
          formatId: dependency.formatId,
          normalizationId: dependency.normalizationId,
        })),
        collectionDigest: declaration.collectionDigest,
        validator: {
          validatorId: registrationConfiguration.validator.validatorId,
          version: registrationConfiguration.validator.validatorVersion,
        },
      };
      const evidence: ReviewSubjectRegistrationEvidence = {
        ...evidenceWithoutDigest,
        digest: reviewSubjectRegistrationEvidenceDigest(evidenceWithoutDigest),
      };
      const recorded =
        await artifactServices.artifacts.recordReviewSubjectRegistrationEvidence(
          artifactServices.credential,
          evidence
        );
      if (recorded.kind !== "resolved") {
        throw new ReviewSubjectRegistrationError(
          recorded.reason === "request_mismatch"
            ? "request_mismatch"
            : "registration_failed",
          `Review subject registration evidence failed: ${recorded.reason}`
        );
      }
      return { artifact, evidence: recorded.evidence };
    } finally {
      await artifactServices.artifacts.close();
    }
  }

  function installPiExtension(pi: ExtensionAPI): void {
    installPionsExtension(pi, {
      repositoryRoot: configuration.repositoryRoot,
      environment,
      homeDirectory,
      ...(dependencies.stateBaseDirectory === undefined
        ? {}
        : { stateBaseDirectory: dependencies.stateBaseDirectory }),
      ...(dependencies.runtimeFactory === undefined
        ? {}
        : { runtimeFactory: dependencies.runtimeFactory }),
      ...(dependencies.resultRuntimeFactory === undefined
        ? {}
        : { resultRuntimeFactory: dependencies.resultRuntimeFactory }),
      ...(configuration.formalReview === undefined
        ? {}
        : {
            formalReview: {
              profile: configuration.formalReview.profile,
              reviewSubjectAuthority:
                configuration.formalReview.reviewSubjectAuthority,
              ...(coordinator === undefined
                ? {}
                : {
                    coordinator: {
                      credential: coordinator.credential,
                      authenticator: coordinator.authenticator,
                      authority: coordinator.authority,
                    },
                  }),
            },
          }),
    });
  }

  return { registerReviewSubject, installPiExtension };
}
