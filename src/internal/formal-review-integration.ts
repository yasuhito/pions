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
  Runtime,
  StartAuthorizationAuthenticator,
  StartAuthorizationAuthority,
} from "../public.js";

const REGISTRATION_WINDOW_MS = 60_000;
const REGISTRATION_RECOVERY_BUDGET = 3;
const REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

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

function artifactDigest(bytes: Uint8Array): ArtifactDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function registrationError(
  outcome: Extract<ArtifactRegistrationOutcome, { readonly kind: "failed" }>
): ReviewSubjectRegistrationError {
  return new ReviewSubjectRegistrationError(
    outcome.reason === "request_mismatch"
      ? "request_mismatch"
      : "registration_failed",
    `Review subject registration failed: ${outcome.reason}`
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
  request: Readonly<ReviewSubjectRegistrationRequest>,
  expectedDigest: ArtifactDigest
): boolean {
  return (
    artifact.byteCount === request.bytes.byteLength &&
    artifact.digest === expectedDigest &&
    artifact.formatId === request.formatId &&
    artifact.normalizationId === request.normalizationId &&
    artifact.dependencies.length === 0
  );
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
  ): Promise<Readonly<ArtifactMetadata>> {
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
      if (!REGISTRATION_ID.test(request.registrationId)) {
        throw new ReviewSubjectRegistrationError(
          "registration_failed",
          "Review subject registration identifier is invalid"
        );
      }
      const expectedDigest = artifactDigest(request.bytes);
      const existing = await artifactServices.artifacts.registrationStatus(
        artifactServices.credential,
        request.registrationId
      );
      if (existing.kind === "registered") {
        if (!metadataMatches(existing.artifact, request, expectedDigest)) {
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
            registrationId: request.registrationId,
            expectedByteCount: request.bytes.byteLength,
            expectedDigest,
            formatId: request.formatId,
            normalizationId: request.normalizationId,
            dependencies: [],
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
        request.registrationId,
        request.bytes
      );
      if (transferred.kind === "failed") throw registrationError(transferred);
      if (transferred.kind === "continuable") {
        throw new ReviewSubjectRegistrationError(
          "registration_failed",
          "Review subject transfer did not complete"
        );
      }
      return toPublicArtifactMetadata(transferred.artifact);
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
