import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  installPionsExtension,
  type PionsExtensionOptions,
} from "./pi-extension.js";
import { configuredResultFormat } from "./result-format-registry.js";
import type { VisibleRuntimeOptions } from "./visible-runtime.js";
import type {
  FormalReviewIntegration,
  FormalReviewIntegrationConfiguration,
} from "../formal-review.js";
import {
  formalReviewIntegrationModule,
  FormalReviewBootstrapError,
} from "../formal-review.js";
import type { Runtime } from "../public.js";

export interface FormalReviewIntegrationDependencies {
  readonly stateBaseDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
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

function validateTrustedBootstrap(
  configuration: Readonly<FormalReviewIntegrationConfiguration>,
  hasTestOverride: boolean
): void {
  const bootstrap = configuration.trustedBootstrap;
  if (
    bootstrap.deployment !== "non-production" &&
    bootstrap.deployment !== "production"
  ) {
    throw new FormalReviewBootstrapError(
      "invalid_bootstrap_configuration",
      "The trusted bootstrap deployment mode is invalid"
    );
  }
  let configuredRoot: string | undefined;
  let canonicalRoot: string | undefined;
  try {
    configuredRoot = realpathSync(configuration.repositoryRoot);
    canonicalRoot = realpathSync(bootstrap.repository.canonicalRoot);
  } catch {
    // A missing or unreadable root cannot establish the trusted identity.
  }
  let repositoryIdentityVerified = false;
  if (configuredRoot !== undefined) {
    try {
      repositoryIdentityVerified =
        bootstrap.repository.verifyIdentity(configuredRoot);
    } catch {
      // An unavailable identity verifier cannot authorize the repository.
    }
  }
  if (
    bootstrap.repository.repositoryId.length === 0 ||
    configuredRoot === undefined ||
    configuredRoot !== canonicalRoot ||
    !repositoryIdentityVerified
  ) {
    throw new FormalReviewBootstrapError(
      "repository_identity_mismatch",
      `Repository ${bootstrap.repository.repositoryId} does not match its canonical root`
    );
  }
  if (
    bootstrap.expectedModuleVersion !== formalReviewIntegrationModule.version
  ) {
    throw new FormalReviewBootstrapError(
      "module_version_mismatch",
      "The trusted bootstrap expected a different Pions formal review module version"
    );
  }
  if (bootstrap.deployment === "production" && hasTestOverride) {
    throw new FormalReviewBootstrapError(
      "test_adapter_rejected",
      "Test-only integration overrides are forbidden in production"
    );
  }
}

export function makeFormalReviewIntegration(
  configuration: Readonly<FormalReviewIntegrationConfiguration>
): FormalReviewIntegration {
  const configuredDependencies = dependenciesByConfiguration.get(configuration);
  validateTrustedBootstrap(configuration, configuredDependencies !== undefined);
  const dependencies = configuredDependencies ?? {};
  const environment = dependencies.environment ?? process.env;
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const resultFormats =
    configuration.formalReview === undefined
      ? undefined
      : configuredResultFormat(configuration.formalReview.resultFormat);

  return {
    installPiExtension(pi: ExtensionAPI): void {
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
        ...(resultFormats === undefined
          ? {}
          : {
              formalReview: { resultFormats },
            }),
      });
    },
  };
}
