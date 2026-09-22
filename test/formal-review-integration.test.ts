import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFormalReviewIntegration,
  FormalReviewBootstrapError,
  formalReviewIntegrationModule,
  type FormalReviewIntegrationConfiguration,
} from "../src/formal-review.js";

async function configuration(
  expectedModuleVersion: string = formalReviewIntegrationModule.version
): Promise<FormalReviewIntegrationConfiguration> {
  const repositoryRoot = await realpath(
    await mkdtemp(join(tmpdir(), "pions-formal-review-"))
  );
  return {
    repositoryRoot,
    trustedBootstrap: {
      expectedModuleVersion: expectedModuleVersion as "1",
      repository: {
        repositoryId: "test-repository",
        canonicalRoot: repositoryRoot,
        verifyIdentity: (root) => root === repositoryRoot,
      },
      deployment: "non-production",
      approvedAdapters: [],
    },
  };
}

test("formal review integration preserves the trusted installation boundary", async (context) => {
  const input = await configuration();
  context.after(() =>
    rm(input.repositoryRoot, { recursive: true, force: true })
  );

  const integration = createFormalReviewIntegration(input);

  assert.equal(typeof integration.installPiExtension, "function");
});

test("formal review integration rejects a different module contract version", async (context) => {
  const input = await configuration("different-version");
  context.after(() =>
    rm(input.repositoryRoot, { recursive: true, force: true })
  );

  assert.throws(
    () => createFormalReviewIntegration(input),
    (error) =>
      error instanceof FormalReviewBootstrapError &&
      error.reason === "module_version_mismatch"
  );
});
