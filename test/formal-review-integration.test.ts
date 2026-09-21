import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Effect } from "effect";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  createFormalReviewIntegration,
  formalReviewIntegrationModule,
  type ReviewSubjectRegistrationEvidenceConfiguration,
  type ReviewSubjectRegistrationRequest,
  type ReviewSubjectRegistrationResult,
} from "../src/formal-review.js";
import {
  PrivateFileEventStore,
  type Operation,
  type OperationEvent,
} from "../src/internal/event-store/index.js";
import {
  makeExternalReviewAllocationRegistry,
  validExternalReviewAllocationBinding,
} from "../src/internal/external-review-allocation.js";
import { configureFormalReviewIntegrationForTest } from "../src/internal/formal-review-integration.js";
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  makeTestRuntime,
} from "../src/internal/testing.js";
import type {
  WorkerAdapter,
  WorkerRunHooks,
} from "../src/internal/services.js";
import type {
  ExternalReviewAllocationRequest,
  Runtime,
  WorkerProfilePolicy,
} from "../src/public.js";

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function trustedBootstrap(
  root: string,
  approvedAdapters: ReadonlyArray<
    Readonly<{
      readonly adapterId: string;
      readonly version: string;
      readonly digest: `sha256:${string}`;
      readonly intendedUse: "non-production" | "production";
    }>
  > = []
) {
  return {
    expectedModuleVersion: formalReviewIntegrationModule.version,
    repository: {
      repositoryId: "trusted-test-repository",
      canonicalRoot: root,
      verifyIdentity: (normalizedRoot: string) => normalizedRoot === root,
    },
    deployment: "non-production" as const,
    approvedAdapters,
  };
}

function collectionDigest(
  root: Readonly<{ readonly digest: `sha256:${string}` }>,
  dependencies: ReadonlyArray<
    Readonly<{ readonly path: string; readonly digest: `sha256:${string}` }>
  >
): `sha256:${string}` {
  return digest(
    Buffer.from(
      JSON.stringify({
        root: root.digest,
        files: [...dependencies]
          .sort((left, right) =>
            left.path < right.path ? -1 : left.path > right.path ? 1 : 0
          )
          .map(({ path, digest: fileDigest }) => ({
            path,
            digest: fileDigest,
          })),
      }),
      "utf8"
    )
  );
}

function rootRegistration(
  bytes: Uint8Array,
  overrides: Partial<ReviewSubjectRegistrationRequest> = {}
): ReviewSubjectRegistrationRequest {
  const dependencies = overrides.dependencies ?? [];
  const root = {
    byteCount: overrides.expectedByteCount ?? bytes.byteLength,
    digest: overrides.expectedDigest ?? digest(bytes),
  };
  return {
    registrationId: "review-subject-1",
    bytes,
    expectedByteCount: root.byteCount,
    expectedDigest: root.digest,
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
    dependencies,
    dependencyFiles: [],
    evidence: {
      issuerId: "trusted-review-subject-issuer",
      authentication: "trusted-proof",
      validatorId: "test-review-subject-validator",
      validatorVersion: "1",
      root,
      dependencies: dependencies.map((dependency) => ({
        path: dependency.path,
        byteCount: dependency.expectedByteCount,
        digest: dependency.expectedDigest,
      })),
      collectionDigest: collectionDigest(
        root,
        dependencies.map((dependency) => ({
          path: dependency.path,
          digest: dependency.expectedDigest,
        }))
      ),
    },
    ...overrides,
  };
}

function testResourceAuthority(
  registrationArtifact: Uint8Array,
  intendedUse: "non-production" | "production" = "non-production"
) {
  const unavailable = async () => {
    throw new Error("test Resource Adapter is not active");
  };
  return {
    authorityId: "trusted-test-authority",
    registrationId: "trusted-test-registration",
    generation: "1",
    normalizationVersion: "1",
    identity: {
      adapterId: "trusted-test-adapter",
      version: "1",
      digest: digest(registrationArtifact),
      intendedUse,
    },
    registrationArtifact,
    issuer: { verify: unavailable, isCurrentlyTrusted: unavailable },
    adapter: {
      normalizeSelector: unavailable,
      acquire: unavailable,
      recover: unavailable,
      inspect: unavailable,
      revokeAccess: unavailable,
      release: unavailable,
    },
  } as const;
}

function formalReviewProfile(root: string): WorkerProfilePolicy {
  return {
    intendedUse: "formal_reviewer",
    modelCandidates: [{ provider: "test", id: "review-model" }],
    thinkingLevel: "medium",
    tools: ["read"],
    resources: { resourceProofPolicy: "disabled" },
    startAuthorization: {
      policy: "required",
      windowMs: 60_000,
      authorizedSubjectIds: ["coordinator-1"],
      receipt: {
        workspace: {
          workspaceId: "workspace-1",
          normalizedPath: root,
          baseRevision: "revision-1",
          owner: { state: "unknown" },
          pionsMayDelete: false,
        },
        permissionManifest: {
          manifestId: "manifest-1",
          digest: `sha256:${"ab".repeat(32)}`,
        },
        reviewSubjectVerification: "required",
      },
    },
    workProductRequirements: {
      body: {
        formatId: "pions.result-body.v1",
        normalizationId: "identity.v1",
        maxByteCount: 50_000,
      },
      workProducts: [],
      maxTotalByteCount: 50_000,
    },
    acceptedArtifactRetentionMs: 86_400_000,
  };
}

const reviewSubjectRegistration = {
  authenticator: {
    authenticate: async (declaration: { readonly authentication: string }) =>
      declaration.authentication === "trusted-proof"
        ? ("authenticated" as const)
        : ("denied" as const),
  },
  validator: {
    validatorId: "test-review-subject-validator",
    validatorVersion: "1",
    validate: async (input: {
      readonly root: Uint8Array;
      readonly dependencies: ReadonlyArray<
        Readonly<{ readonly path: string; readonly bytes: Uint8Array }>
      >;
    }) => ({
      kind: "valid" as const,
      collectionDigest: collectionDigest(
        { digest: digest(input.root) },
        input.dependencies.map(({ path, bytes: fileBytes }) => ({
          path,
          digest: digest(fileBytes),
        }))
      ),
    }),
  },
} as const;

function dependencyRegistration(path: string, bytes: Uint8Array) {
  return {
    manifest: {
      path,
      expectedByteCount: bytes.byteLength,
      expectedDigest: digest(bytes),
      formatId: "pions.opaque.v1",
      normalizationId: "identity.v1",
    },
    file: { path, bytes },
  } as const;
}

interface RegisteredTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext
  ): Promise<{
    readonly details?: unknown;
  }>;
}

async function fixture(
  context: test.TestContext,
  registrationConfiguration: Readonly<ReviewSubjectRegistrationEvidenceConfiguration> = reviewSubjectRegistration
) {
  const root = await mkdtemp(
    join(tmpdir(), "pions-formal-review-integration-")
  );
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  context.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });
  return createFormalReviewIntegration({
    repositoryRoot: root,
    trustedBootstrap: trustedBootstrap(root),
    reviewSubjectRegistration: registrationConfiguration,
  });
}

function persistedResultFormatIntegration(
  root: string,
  stateBaseDirectory: string,
  options: Readonly<{
    readonly registrationArtifact: Uint8Array;
    readonly normalizationId: string;
  }>
) {
  const resourceAuthority = testResourceAuthority(
    Buffer.from("persisted-format adapter v1", "utf8")
  );
  const configuration = {
    repositoryRoot: root,
    trustedBootstrap: trustedBootstrap(root, [resourceAuthority.identity]),
    reviewSubjectRegistration,
    formalReview: {
      profile: formalReviewProfile(root),
      resourceAuthority,
      reviewSubjectAuthority: {
        currentUse: async () => "allowed" as const,
      },
      resultFormat: {
        formatId: "test.review-result",
        version: "1",
        expectations: { axis: "standards" },
        registrations: [
          {
            formatId: "test.review-result",
            version: "1",
            normalizationId: options.normalizationId,
            validator: {
              validatorId: "test-result-validator",
              validatorVersion: "1",
              registrationArtifact: options.registrationArtifact,
              validate: async () => ({ kind: "valid" as const }),
            },
          },
        ],
      },
    },
  };
  configureFormalReviewIntegrationForTest(configuration, {
    stateBaseDirectory,
  });
  return createFormalReviewIntegration(configuration);
}

const fixedReviewSubjectRegistration = () =>
  rootRegistration(Buffer.from("fixed review subject", "utf8"));

test("the package does not publish the formal review integration entry", async () => {
  const entry = "pions/formal-review";
  await assert.rejects(import(entry), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
});

test("the retained formal review module exposes its versioned identity", () => {
  assert.deepEqual(formalReviewIntegrationModule, {
    moduleId: "pions.formal-review-integration",
    version: "1",
  });
});

test("the trusted bootstrap rejects a different Pions module version", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-module-version-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () =>
      createFormalReviewIntegration({
        repositoryRoot: root,
        trustedBootstrap: {
          ...trustedBootstrap(root),
          expectedModuleVersion: "different-version",
        },
        reviewSubjectRegistration,
      }),
    { name: "FormalReviewBootstrapError", reason: "module_version_mismatch" }
  );
});

test("the trusted bootstrap rejects a non-canonical repository root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-repository-root-"));
  const differentRoot = await mkdtemp(join(tmpdir(), "pions-canonical-root-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(differentRoot, { recursive: true, force: true }));
  assert.throws(
    () =>
      createFormalReviewIntegration({
        repositoryRoot: root,
        trustedBootstrap: trustedBootstrap(differentRoot),
        reviewSubjectRegistration,
      }),
    {
      name: "FormalReviewBootstrapError",
      reason: "repository_identity_mismatch",
    }
  );
});

test("the trusted bootstrap rejects a canonical repository identity mismatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-repository-identity-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () =>
      createFormalReviewIntegration({
        repositoryRoot: root,
        trustedBootstrap: {
          ...trustedBootstrap(root),
          repository: {
            repositoryId: "different-repository",
            canonicalRoot: root,
            verifyIdentity: () => false,
          },
        },
        reviewSubjectRegistration,
      }),
    {
      name: "FormalReviewBootstrapError",
      reason: "repository_identity_mismatch",
    }
  );
});

test("the trusted bootstrap rejects an Adapter registration Artifact digest mismatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-adapter-digest-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const authority = testResourceAuthority(Buffer.from("adapter v1", "utf8"));

  assert.throws(
    () =>
      createFormalReviewIntegration({
        repositoryRoot: root,
        trustedBootstrap: trustedBootstrap(root, [authority.identity]),
        reviewSubjectRegistration,
        formalReview: {
          profile: formalReviewProfile(root),
          reviewSubjectAuthority: { currentUse: async () => "allowed" },
          resultFormat: {
            formatId: "test.review-result",
            version: "1",
            expectations: {},
            registrations: [],
          },
          resourceAuthority: {
            ...authority,
            registrationArtifact: Buffer.from("substituted adapter", "utf8"),
          },
        },
      }),
    { name: "FormalReviewBootstrapError", reason: "adapter_identity_mismatch" }
  );
});

test("the trusted bootstrap rejects an Adapter identity outside its approval list", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-unapproved-adapter-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const authority = testResourceAuthority(Buffer.from("adapter v1", "utf8"));

  assert.throws(
    () =>
      createFormalReviewIntegration({
        repositoryRoot: root,
        trustedBootstrap: trustedBootstrap(root),
        reviewSubjectRegistration,
        formalReview: {
          profile: formalReviewProfile(root),
          reviewSubjectAuthority: { currentUse: async () => "allowed" },
          resultFormat: {
            formatId: "test.review-result",
            version: "1",
            expectations: {},
            registrations: [],
          },
          resourceAuthority: authority,
        },
      }),
    { name: "FormalReviewBootstrapError", reason: "adapter_identity_mismatch" }
  );
});

test("production rejects a non-production Adapter identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-production-adapter-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const authority = testResourceAuthority(Buffer.from("adapter v1", "utf8"));

  assert.throws(
    () =>
      createFormalReviewIntegration({
        repositoryRoot: root,
        trustedBootstrap: {
          ...trustedBootstrap(root, [authority.identity]),
          deployment: "production",
        },
        reviewSubjectRegistration,
        formalReview: {
          profile: formalReviewProfile(root),
          reviewSubjectAuthority: { currentUse: async () => "allowed" },
          resultFormat: {
            formatId: "test.review-result",
            version: "1",
            expectations: {},
            registrations: [],
          },
          resourceAuthority: authority,
        },
      }),
    {
      name: "FormalReviewBootstrapError",
      reason: "non_production_adapter_rejected",
    }
  );
});

test("production rejects a test-only integration override", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-production-override-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configuration = {
    repositoryRoot: root,
    trustedBootstrap: {
      ...trustedBootstrap(root),
      deployment: "production" as const,
    },
    reviewSubjectRegistration,
  };
  configureFormalReviewIntegrationForTest(configuration, {});

  assert.throws(() => createFormalReviewIntegration(configuration), {
    name: "FormalReviewBootstrapError",
    reason: "test_adapter_rejected",
  });
});

test("production keeps formal review disabled pending rollout approval", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-production-disabled-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const resourceAuthority = testResourceAuthority(
    Buffer.from("production adapter v1", "utf8"),
    "production"
  );

  assert.throws(
    () =>
      createFormalReviewIntegration({
        repositoryRoot: root,
        trustedBootstrap: {
          ...trustedBootstrap(root, [resourceAuthority.identity]),
          deployment: "production",
        },
        reviewSubjectRegistration,
        formalReview: {
          profile: formalReviewProfile(root),
          resourceAuthority,
          reviewSubjectAuthority: { currentUse: async () => "allowed" },
          resultFormat: {
            formatId: "test.review-result",
            version: "1",
            expectations: {},
            registrations: [],
          },
        },
      }),
    {
      name: "FormalReviewBootstrapError",
      reason: "production_formal_review_disabled",
    }
  );
});

test("the formal review integration exposes only its two supported operations", async (context) => {
  const integration = await fixture(context);

  assert.deepEqual(Object.keys(integration).sort(), [
    "installPiExtension",
    "registerReviewSubject",
  ]);
});

test("a fixed root review subject is registered in the integration Artifact Store", async (context) => {
  const integration = await fixture(context);
  const bytes = Buffer.from("fixed review subject", "utf8");
  const expectedDigest = digest(bytes);

  const registration = await integration.registerReviewSubject(
    rootRegistration(bytes)
  );

  assert.deepEqual(registration.artifact, {
    artifactId: registration.artifact.artifactId,
    byteCount: bytes.byteLength,
    digest: expectedDigest,
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
    dependencies: [],
  });
});

test("a root review subject references its registered dependency", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependencyBytes = Buffer.from("fixed specification", "utf8");

  const registration = await integration.registerReviewSubject(
    rootRegistration(rootBytes, {
      dependencies: [
        {
          path: "docs/spec.md",
          expectedByteCount: dependencyBytes.byteLength,
          expectedDigest: digest(dependencyBytes),
          formatId: "pions.opaque.v1",
          normalizationId: "identity.v1",
        },
      ],
      dependencyFiles: [{ path: "docs/spec.md", bytes: dependencyBytes }],
    })
  );

  assert.equal(registration.artifact.dependencies.length, 1);
});

test("registration evidence binds the verified root and dependency mapping", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  const registration = await integration.registerReviewSubject(
    rootRegistration(rootBytes, {
      dependencies: [dependency.manifest],
      dependencyFiles: [dependency.file],
    })
  );

  assert.deepEqual(registration.evidence, {
    formatId: "pions.review-subject-registration-evidence.v1",
    evidenceId: registration.evidence.evidenceId,
    issuerId: "trusted-review-subject-issuer",
    root: registration.artifact,
    files: [
      {
        path: "docs/spec.md",
        artifactId: registration.artifact.dependencies[0],
        byteCount: dependency.manifest.expectedByteCount,
        digest: dependency.manifest.expectedDigest,
        formatId: dependency.manifest.formatId,
        normalizationId: dependency.manifest.normalizationId,
      },
    ],
    collectionDigest: collectionDigest({ digest: digest(rootBytes) }, [
      {
        path: dependency.manifest.path,
        digest: dependency.manifest.expectedDigest,
      },
    ]),
    validator: {
      validatorId: "test-review-subject-validator",
      version: "1",
    },
    digest: registration.evidence.digest,
  });
});

test("registration evidence keeps root and collection digests distinct", async (context) => {
  const integration = await fixture(context);
  const registration = await integration.registerReviewSubject(
    rootRegistration(Buffer.from("fixed manifest", "utf8"))
  );

  assert.notEqual(
    registration.evidence.root.digest,
    registration.evidence.collectionDigest
  );
});

test("registration evidence rejects an unauthenticated issuer", async (context) => {
  const integration = await fixture(context);
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"));

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: { ...request.evidence, authentication: "untrusted-proof" },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "issuer_authentication_failed",
    }
  );
});

test("registration evidence rejects an unknown issuer", async (context) => {
  const integration = await fixture(context, {
    ...reviewSubjectRegistration,
    authenticator: {
      authenticate: async () => {
        throw new Error("issuer state unavailable");
      },
    },
  });

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(Buffer.from("fixed manifest", "utf8"))
    ),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "issuer_authentication_failed",
    }
  );
});

test("registration evidence rejects a collection digest mismatch", async (context) => {
  const integration = await fixture(context);
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"));

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: {
        ...request.evidence,
        collectionDigest: `sha256:${"0".repeat(64)}`,
      },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence rejects extra dependency metadata", async (context) => {
  const integration = await fixture(context);
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"));

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: {
        ...request.evidence,
        dependencies: [
          {
            path: "extra.md",
            byteCount: 1,
            digest: `sha256:${"0".repeat(64)}`,
          },
        ],
      },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence rejects an invalid dependency path", async (context) => {
  const integration = await fixture(context);
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"), {
    dependencies: [dependency.manifest],
    dependencyFiles: [dependency.file],
  });

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: {
        ...request.evidence,
        dependencies: [
          { ...request.evidence.dependencies[0]!, path: "../spec.md" },
        ],
      },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence rejects a missing dependency", async (context) => {
  const integration = await fixture(context);
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"), {
    dependencies: [dependency.manifest],
    dependencyFiles: [dependency.file],
  });

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: { ...request.evidence, dependencies: [] },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence rejects duplicate dependency paths", async (context) => {
  const integration = await fixture(context);
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"), {
    dependencies: [dependency.manifest],
    dependencyFiles: [dependency.file],
  });

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: {
        ...request.evidence,
        dependencies: [
          request.evidence.dependencies[0]!,
          request.evidence.dependencies[0]!,
        ],
      },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence rejects a dependency digest mismatch", async (context) => {
  const integration = await fixture(context);
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"), {
    dependencies: [dependency.manifest],
    dependencyFiles: [dependency.file],
  });

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: {
        ...request.evidence,
        dependencies: [
          {
            ...request.evidence.dependencies[0]!,
            digest: `sha256:${"0".repeat(64)}`,
          },
        ],
      },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence rejects a dependency byte-count mismatch", async (context) => {
  const integration = await fixture(context);
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"), {
    dependencies: [dependency.manifest],
    dependencyFiles: [dependency.file],
  });

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: {
        ...request.evidence,
        dependencies: [
          {
            ...request.evidence.dependencies[0]!,
            byteCount: dependency.manifest.expectedByteCount + 1,
          },
        ],
      },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence rejects a root digest mismatch", async (context) => {
  const integration = await fixture(context);
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"));

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: {
        ...request.evidence,
        root: { ...request.evidence.root, digest: `sha256:${"0".repeat(64)}` },
      },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence rejects a validator mismatch", async (context) => {
  const integration = await fixture(context);
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"));

  await assert.rejects(
    integration.registerReviewSubject({
      ...request,
      evidence: { ...request.evidence, validatorVersion: "2" },
    }),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("registration evidence is not a root Artifact dependency", async (context) => {
  const integration = await fixture(context);
  const registration = await integration.registerReviewSubject(
    rootRegistration(Buffer.from("fixed manifest", "utf8"))
  );

  assert.equal(
    registration.artifact.dependencies.includes(
      registration.evidence.evidenceId
    ),
    false
  );
});

test("a dependency manifest rejects a missing file", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, { dependencies: [dependency.manifest] })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("a dependency manifest rejects an extra file", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, { dependencyFiles: [dependency.file] })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("a dependency manifest rejects duplicate paths", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, {
        dependencies: [dependency.manifest, dependency.manifest],
        dependencyFiles: [dependency.file],
      })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("a dependency manifest rejects invalid paths", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "../spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, {
        dependencies: [dependency.manifest],
        dependencyFiles: [dependency.file],
      })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("a dependency manifest rejects a byte-count mismatch", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, {
        dependencies: [
          {
            ...dependency.manifest,
            expectedByteCount: dependency.manifest.expectedByteCount + 1,
          },
        ],
        dependencyFiles: [dependency.file],
      })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("a dependency manifest rejects a digest mismatch", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, {
        dependencies: [
          {
            ...dependency.manifest,
            expectedDigest: `sha256:${"0".repeat(64)}`,
          },
        ],
        dependencyFiles: [dependency.file],
      })
    ),
    {
      name: "ReviewSubjectRegistrationError",
      reason: "evidence_validation_failed",
    }
  );
});

test("Pions rejects dependency bytes independently of the configured validator", async (context) => {
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const request = rootRegistration(rootBytes, {
    dependencies: [
      {
        ...dependency.manifest,
        expectedDigest: `sha256:${"0".repeat(64)}`,
      },
    ],
    dependencyFiles: [dependency.file],
  });
  const integration = await fixture(context, {
    ...reviewSubjectRegistration,
    validator: {
      ...reviewSubjectRegistration.validator,
      validate: async () => ({
        kind: "valid" as const,
        collectionDigest: request.evidence.collectionDigest,
      }),
    },
  });

  await assert.rejects(integration.registerReviewSubject(request), {
    name: "ReviewSubjectRegistrationError",
    reason: "registration_failed",
  });
});

test("dependency files reject duplicate paths", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, {
        dependencies: [dependency.manifest],
        dependencyFiles: [dependency.file, dependency.file],
      })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("a root manifest rejects a byte-count mismatch", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, {
        expectedByteCount: rootBytes.byteLength + 1,
      })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("a root manifest rejects a digest mismatch", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, {
        expectedDigest: `sha256:${"0".repeat(64)}`,
      })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("an unsupported dependency format prevents root registration", async (context) => {
  const integration = await fixture(context);
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(rootBytes, {
        dependencies: [
          { ...dependency.manifest, formatId: "unregistered.format.v1" },
        ],
        dependencyFiles: [dependency.file],
      })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "registration_failed" }
  );
});

test("repeating a review subject registration returns the same Artifact", async (context) => {
  const integration = await fixture(context);
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"), {
    dependencies: [dependency.manifest],
    dependencyFiles: [dependency.file],
  });

  const first = await integration.registerReviewSubject(request);
  const replay = await integration.registerReviewSubject(request);

  assert.equal(replay.artifact.artifactId, first.artifact.artifactId);
});

test("registration evidence digest is stable after reopening the integration", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-formal-review-reopen-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configuration = {
    repositoryRoot: root,
    trustedBootstrap: trustedBootstrap(root),
    reviewSubjectRegistration,
  } as const;
  const request = rootRegistration(Buffer.from("fixed manifest", "utf8"));
  const first =
    await createFormalReviewIntegration(configuration).registerReviewSubject(
      request
    );

  const reopened =
    await createFormalReviewIntegration(configuration).registerReviewSubject(
      request
    );

  assert.equal(reopened.evidence.digest, first.evidence.digest);
});

test("dependency input order does not change registration identity", async (context) => {
  const integration = await fixture(context);
  const specification = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const standards = dependencyRegistration(
    "docs/standards.md",
    Buffer.from("fixed standards", "utf8")
  );
  const rootBytes = Buffer.from("fixed manifest", "utf8");
  const first = await integration.registerReviewSubject(
    rootRegistration(rootBytes, {
      dependencies: [specification.manifest, standards.manifest],
      dependencyFiles: [specification.file, standards.file],
    })
  );

  const replay = await integration.registerReviewSubject(
    rootRegistration(rootBytes, {
      dependencies: [standards.manifest, specification.manifest],
      dependencyFiles: [standards.file, specification.file],
    })
  );

  assert.equal(replay.artifact.artifactId, first.artifact.artifactId);
});

test("a registration identifier cannot replace a fixed dependency", async (context) => {
  const integration = await fixture(context);
  const firstDependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("first specification", "utf8")
  );
  await integration.registerReviewSubject(
    rootRegistration(Buffer.from("fixed manifest", "utf8"), {
      dependencies: [firstDependency.manifest],
      dependencyFiles: [firstDependency.file],
    })
  );
  const replacementDependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("replacement specification", "utf8")
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(Buffer.from("fixed manifest", "utf8"), {
        dependencies: [replacementDependency.manifest],
        dependencyFiles: [replacementDependency.file],
      })
    ),
    { name: "ReviewSubjectRegistrationError", reason: "request_mismatch" }
  );
});

test("a registration identifier cannot replace its fixed root Artifact", async (context) => {
  const integration = await fixture(context);
  await integration.registerReviewSubject(
    rootRegistration(Buffer.from("first review subject", "utf8"))
  );

  await assert.rejects(
    integration.registerReviewSubject(
      rootRegistration(Buffer.from("replacement review subject", "utf8"))
    ),
    { name: "ReviewSubjectRegistrationError", reason: "request_mismatch" }
  );
});

test("the integration rejects a validator version backed by different registration Artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-result-format-conflict-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const validator = {
    validatorId: "test-result-validator",
    validatorVersion: "1",
    registrationArtifact: Buffer.from("validator one", "utf8"),
    validate: async () => ({ kind: "valid" as const }),
  };
  const resourceAuthority = testResourceAuthority(
    Buffer.from("format-conflict adapter v1", "utf8")
  );

  assert.throws(
    () =>
      createFormalReviewIntegration({
        repositoryRoot: root,
        trustedBootstrap: trustedBootstrap(root, [resourceAuthority.identity]),
        reviewSubjectRegistration,
        formalReview: {
          profile: formalReviewProfile(root),
          resourceAuthority,
          reviewSubjectAuthority: {
            currentUse: async () => "allowed" as const,
          },
          resultFormat: {
            formatId: "test.review-result",
            version: "1",
            expectations: { axis: "standards" },
            registrations: [
              {
                formatId: "test.review-result",
                version: "1",
                normalizationId: "identity.v1",
                validator,
              },
              {
                formatId: "test.other-review-result",
                version: "1",
                normalizationId: "identity.v1",
                validator: {
                  ...validator,
                  registrationArtifact: Buffer.from(
                    "validator replacement",
                    "utf8"
                  ),
                },
              },
            ],
          },
        },
      }),
    { name: "ResultFormatRegistrationError" }
  );
});

test("a persisted validator version cannot be replaced after integration restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-result-format-restart-"));
  const stateBaseDirectory = join(root, "state");
  context.after(() => rm(root, { recursive: true, force: true }));
  await persistedResultFormatIntegration(root, stateBaseDirectory, {
    registrationArtifact: Buffer.from("validator one", "utf8"),
    normalizationId: "identity.v1",
  }).registerReviewSubject(fixedReviewSubjectRegistration());

  await assert.rejects(
    persistedResultFormatIntegration(root, stateBaseDirectory, {
      registrationArtifact: Buffer.from("validator replacement", "utf8"),
      normalizationId: "identity.v1",
    }).registerReviewSubject(fixedReviewSubjectRegistration()),
    { name: "ResultFormatRegistrationError" }
  );
});

test("a persisted Result format version cannot change normalization after restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-result-format-version-"));
  const stateBaseDirectory = join(root, "state");
  context.after(() => rm(root, { recursive: true, force: true }));
  await persistedResultFormatIntegration(root, stateBaseDirectory, {
    registrationArtifact: Buffer.from("validator one", "utf8"),
    normalizationId: "identity.v1",
  }).registerReviewSubject(fixedReviewSubjectRegistration());

  await assert.rejects(
    persistedResultFormatIntegration(root, stateBaseDirectory, {
      registrationArtifact: Buffer.from("validator one", "utf8"),
      normalizationId: "replacement.v1",
    }).registerReviewSubject(fixedReviewSubjectRegistration()),
    { name: "ResultFormatRegistrationError" }
  );
});

test("an unconfigured integration does not register the formal review tool", async (context) => {
  const integration = await fixture(context);
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool as unknown as RegisteredTool);
    },
    on() {},
  } as unknown as ExtensionAPI;
  integration.installPiExtension(pi);

  assert.equal(tools.has("pions_review"), false);
});

test("a registered dependent root is available to the configured extension Runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-formal-review-runtime-"));
  const stateBaseDirectory = join(root, "state");
  const profile = formalReviewProfile(root);
  const resourceAuthority = testResourceAuthority(
    Buffer.from("configured-runtime adapter v1", "utf8")
  );
  let runtime: Runtime | undefined;
  const configuration = {
    repositoryRoot: root,
    trustedBootstrap: trustedBootstrap(root, [resourceAuthority.identity]),
    reviewSubjectRegistration,
    formalReview: {
      profile,
      resourceAuthority,
      reviewSubjectAuthority: { currentUse: async () => "allowed" as const },
      resultFormat: {
        formatId: "test.formal-review-result",
        version: "1",
        expectations: { axis: "standards" },
        registrations: [
          {
            formatId: "test.formal-review-result",
            version: "1",
            normalizationId: "identity.v1",
            validator: {
              validatorId: "test.formal-review-result-validator",
              validatorVersion: "1",
              registrationArtifact: Buffer.from("test validator v1", "utf8"),
              validate: async () => ({ kind: "valid" as const }),
            },
          },
        ],
      },
      coordinator: {
        subjectId: "coordinator-1",
        currentAuthorization: async () => "authorized" as const,
      },
    },
  } as const;
  configureFormalReviewIntegrationForTest(configuration, {
    stateBaseDirectory,
    runtimeFactory: (options) => {
      const clock = new FakeClock(
        Array.from({ length: 100 }, (_, index) =>
          new Date(Date.UTC(2026, 8, 12, 10, 0, index)).toISOString()
        )
      );
      const store = new PrivateFileEventStore(options.stateDirectory, clock);
      const artifactServices = runtimeArtifactStore(
        options.stateDirectory,
        store,
        () => new Date("2026-09-12T10:00:00.000Z"),
        undefined,
        options.reviewSubjectAuthority
      );
      runtime = makeTestRuntime({
        worker: new FakeWorkerAdapter(),
        clock,
        ids: new FakeIdGenerator(["operation-1"]),
        presentation: new FakePresentation(),
        store,
        artifacts: artifactServices.artifacts,
        artifactCredential: artifactServices.credential,
        synchronizeArtifactClock: artifactServices.synchronizeClock,
        ...(options.formalReviewResultFormats === undefined
          ? {}
          : {
              formalReviewResultFormats: options.formalReviewResultFormats,
            }),
        ...(options.startAuthorizationAuthenticator === undefined
          ? {}
          : {
              startAuthorizationAuthenticator:
                options.startAuthorizationAuthenticator,
            }),
        ...(options.startAuthorizationAuthority === undefined
          ? {}
          : {
              startAuthorizationAuthority: options.startAuthorizationAuthority,
            }),
        configuration: { cwd: options.cwd, profiles: options.profiles },
      });
      return runtime;
    },
  });
  const integration = createFormalReviewIntegration(configuration);
  context.after(async () => {
    await runtime?.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });
  const bytes = Buffer.from("fixed manifest", "utf8");
  const dependency = dependencyRegistration(
    "docs/spec.md",
    Buffer.from("fixed specification", "utf8")
  );
  const registration = await integration.registerReviewSubject(
    rootRegistration(bytes, {
      dependencies: [dependency.manifest],
      dependencyFiles: [dependency.file],
    })
  );
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool as unknown as RegisteredTool);
    },
    on() {},
  } as unknown as ExtensionAPI;
  integration.installPiExtension(pi);
  const review = tools.get("pions_review");
  if (review === undefined) throw new Error("pions_review was not registered");
  const extensionContext = {
    cwd: root,
    model: { provider: "test", id: "review-model" },
    thinkingLevel: "medium",
    modelRegistry: {
      find: () => ({ provider: "test", id: "review-model" }),
      hasConfiguredAuth: () => true,
      getRegisteredProviderIds: () => [],
    },
    sessionManager: { getSessionId: () => "session-1" },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  const result = await review.execute(
    "review-call-1",
    {
      artifactId: registration.artifact.artifactId,
      task: "Review this Artifact",
    },
    undefined,
    undefined,
    extensionContext
  );
  const operationId = (result.details as { readonly operationId: string })
    .operationId;
  const operation = await runtime!.operation(operationId);
  await operation.waitForStartupReceipt();
  const snapshot = await operation.read();

  assert.deepEqual(snapshot.startAuthorization.receipt?.reviewSubject, {
    artifactId: registration.artifact.artifactId,
    byteCount: registration.artifact.byteCount,
    digest: registration.artifact.digest,
    format: registration.artifact.formatId,
    normalization: registration.artifact.normalizationId,
    registrationEvidenceId: registration.evidence.evidenceId,
    registrationEvidenceDigest: registration.evidence.digest,
  });
});

interface ExternalAllocationFixtureOptions {
  readonly now?: Date;
  readonly operationIds?: ReadonlyArray<string>;
  readonly failOperationCreationOnce?: boolean;
  readonly worker?: WorkerAdapter;
  authenticate?(authentication: string): "authenticated" | "denied" | "unknown";
  allocationFor?(
    bindingRequestId: string,
    registration: Readonly<ReviewSubjectRegistrationResult>
  ): Readonly<ExternalReviewAllocationRequest>;
  validateResult?(
    bytes: Uint8Array
  ):
    | { readonly kind: "valid" }
    | { readonly kind: "invalid"; readonly reason: "invalid_json" };
}

interface IndependentReviewWorkerBehavior {
  readonly body?: string;
  readonly failure?: "worker_protocol_failed";
  readonly processId: number;
}

class IndependentReviewWorkerAdapter extends FakeWorkerAdapter {
  readonly prompts = new Map<string, string>();

  constructor(
    private readonly behaviors: Readonly<
      Record<string, Readonly<IndependentReviewWorkerBehavior>>
    >
  ) {
    super();
  }

  protected override run(
    operation: Operation,
    hooks: Readonly<WorkerRunHooks>
  ) {
    const behavior = this.behaviors[operation.operationId];
    if (behavior === undefined) {
      return Effect.succeed({ state: "worker_protocol_failed" } as const);
    }
    return Effect.gen(this, function* () {
      this.startCount += 1;
      this.prompts.set(
        operation.operationId,
        yield* Effect.promise(() => readFile(operation.task.promptRef, "utf8"))
      );
      yield* hooks.workerLaunched();
      const startInstruction = yield* hooks.workerIdentified({
        processId: behavior.processId,
        processInstanceId: `process-${operation.operationId}`,
        processStartToken: `start-${operation.operationId}`,
        piSessionId: `pi-${operation.operationId}`,
        observedConfig: {
          model: {
            state: "observed",
            value: { ...operation.effectiveConfig.model },
          },
          thinkingLevel: {
            state: "observed",
            value: operation.effectiveConfig.thinkingLevel,
          },
          tools: {
            state: "observed",
            value: [...operation.effectiveConfig.tools],
          },
          cwd: { state: "observed", value: operation.effectiveConfig.cwd },
        },
      });
      yield* hooks.startDeliveryEntered(startInstruction);
      yield* hooks.startInstructionDispatched(startInstruction);
      yield* hooks.startInstructionAccepted(startInstruction);
      yield* hooks.startInstructionAcknowledged(startInstruction);
      if (behavior.failure === "worker_protocol_failed") {
        return { state: "worker_protocol_failed" } as const;
      }
      const bytes = Buffer.from(behavior.body ?? "", "utf8");
      const acceptance = yield* hooks.acceptResult({
        acceptanceRequestId: `result-${operation.operationId}`,
        body: {
          formatId: "pions.result-body.v1",
          normalizationId: "identity.v1",
          expectedByteCount: bytes.byteLength,
          expectedDigest: digest(bytes),
          bytes,
        },
        workProducts: [],
      });
      if (
        acceptance.state === "failed" &&
        acceptance.reason === "result_format_rejected" &&
        acceptance.resultFormatRejection !== undefined
      ) {
        return {
          state: "result_format_rejected",
          rejection: acceptance.resultFormatRejection,
        } as const;
      }
      if (acceptance.state !== "accepted") {
        return { state: "worker_protocol_failed" } as const;
      }
      return {
        state: "result_acknowledged",
        evidence: {
          usage: {
            input: behavior.processId,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: behavior.processId + 1,
            cost: behavior.processId / 100,
          },
          toolUses: [
            {
              toolCallId: `read-${operation.operationId}`,
              toolName: "read",
              isError: false,
            },
          ],
        },
      } as const;
    });
  }
}

function externalAllocationRequest(
  requestId: string,
  registration: Readonly<ReviewSubjectRegistrationResult>,
  overrides: Partial<ExternalReviewAllocationRequest["allocation"]> = {}
): ExternalReviewAllocationRequest {
  return {
    requestId,
    credential: "trusted-allocation-proof",
    allocation: {
      allocationId: "allocation-standards-1",
      issuerId: "trusted-bootstrap",
      reviewSubjectArtifactId: registration.artifact.artifactId,
      registrationEvidenceId: registration.evidence.evidenceId,
      registrationEvidenceDigest: registration.evidence.digest,
      profileId: "formal-review",
      expiresAt: "2026-09-12T11:00:00.000Z",
      useLimit: 1,
      bundle: "bundle opaque value",
      handoff: "handoff opaque value",
      subjectVersion: "subject version opaque value",
      axis: "standards opaque value",
      externalExecutionId: "external execution opaque value",
      ...overrides,
    },
  };
}

async function externalAllocationFixture(
  context: test.TestContext,
  options: Readonly<ExternalAllocationFixtureOptions> = {}
) {
  const root = await mkdtemp(join(tmpdir(), "pions-formal-review-allocation-"));
  const stateBaseDirectory = join(root, "state");
  const now = options.now ?? new Date("2026-09-12T10:00:00.000Z");
  let runtime: Runtime | undefined;
  let registration: ReviewSubjectRegistrationResult | undefined;
  let allocationResolutionCount = 0;
  const allocationAuthenticator = {
    authenticate: async (_allocation: unknown, authentication: string) =>
      options.authenticate?.(authentication) ??
      (authentication === "trusted-allocation-proof"
        ? ("authenticated" as const)
        : ("denied" as const)),
  };
  const resourceAuthority = testResourceAuthority(
    Buffer.from("non-production adapter v1", "utf8")
  );
  const configuration = {
    repositoryRoot: root,
    trustedBootstrap: trustedBootstrap(root, [resourceAuthority.identity]),
    reviewSubjectRegistration,
    formalReview: {
      profile: formalReviewProfile(root),
      reviewSubjectAuthority: { currentUse: async () => "allowed" as const },
      resultFormat: {
        formatId: "test.formal-review-result",
        version: "1",
        expectations: { resultKind: "formal-review" },
        registrations: [
          {
            formatId: "test.formal-review-result",
            version: "1",
            normalizationId: "identity.v1",
            validator: {
              validatorId: "test.formal-review-result-validator",
              validatorVersion: "1",
              registrationArtifact: Buffer.from("test validator v1", "utf8"),
              validate: async ({ bytes }: { readonly bytes: Uint8Array }) =>
                options.validateResult?.(bytes) ?? { kind: "valid" as const },
            },
          },
        ],
      },
      resourceAuthority,
      externalAllocation: {
        authenticator: allocationAuthenticator,
        allocationFor: async () => {
          if (registration === undefined)
            throw new Error("subject not registered");
          allocationResolutionCount += 1;
          const bindingRequestId = `allocation-request-${allocationResolutionCount}`;
          return (
            options.allocationFor?.(bindingRequestId, registration) ??
            externalAllocationRequest(bindingRequestId, registration)
          );
        },
      },
      coordinator: {
        subjectId: "coordinator-1",
        currentAuthorization: async () => "authorized" as const,
      },
    },
  } as const;
  configureFormalReviewIntegrationForTest(configuration, {
    stateBaseDirectory,
    runtimeFactory: (runtimeOptions) => {
      // Concurrent Operations share one fake clock, so one stable instant avoids
      // inventing ordering between independently scheduled event appends.
      const clock = new FakeClock(
        Array.from({ length: 500 }, () => "2026-09-12T10:00:00.000Z")
      );
      class AllocationEventStore extends PrivateFileEventStore {
        private rejectCreation = options.failOperationCreationOnce === true;

        protected override willAppend(event: OperationEvent): void {
          if (this.rejectCreation && event.type === "operation_requested") {
            this.rejectCreation = false;
            throw new Error("injected allocation Operation creation failure");
          }
        }
      }
      const store = new AllocationEventStore(
        runtimeOptions.stateDirectory,
        clock
      );
      const artifactServices = runtimeArtifactStore(
        runtimeOptions.stateDirectory,
        store,
        () => now,
        undefined,
        runtimeOptions.reviewSubjectAuthority
      );
      runtime = makeTestRuntime({
        worker: options.worker ?? new FakeWorkerAdapter(),
        clock,
        ids: new FakeIdGenerator(
          options.operationIds ?? ["operation-allocation-1"]
        ),
        presentation: new FakePresentation(),
        store,
        artifacts: artifactServices.artifacts,
        artifactCredential: artifactServices.credential,
        synchronizeArtifactClock: artifactServices.synchronizeClock,
        externalReviewAllocations: makeExternalReviewAllocationRegistry({
          stateDirectory: runtimeOptions.stateDirectory,
          authenticator: allocationAuthenticator,
          now: () => now,
        }),
        ...(runtimeOptions.formalReviewResultFormats === undefined
          ? {}
          : {
              formalReviewResultFormats:
                runtimeOptions.formalReviewResultFormats,
            }),
        ...(runtimeOptions.startAuthorizationAuthenticator === undefined
          ? {}
          : {
              startAuthorizationAuthenticator:
                runtimeOptions.startAuthorizationAuthenticator,
            }),
        ...(runtimeOptions.startAuthorizationAuthority === undefined
          ? {}
          : {
              startAuthorizationAuthority:
                runtimeOptions.startAuthorizationAuthority,
            }),
        configuration: {
          cwd: runtimeOptions.cwd,
          profiles: runtimeOptions.profiles,
        },
      });
      return runtime;
    },
  });
  const integration = createFormalReviewIntegration(configuration);
  context.after(async () => {
    await runtime?.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });
  registration = await integration.registerReviewSubject(
    rootRegistration(Buffer.from("fixed allocation subject", "utf8"))
  );
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, () => Promise<unknown> | unknown>();
  integration.installPiExtension({
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool as unknown as RegisteredTool);
    },
    on(event: string, handler: () => Promise<unknown> | unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI);
  const review = tools.get("pions_review");
  if (review === undefined) throw new Error("pions_review was not registered");
  const decision = tools.get("pions_review_decision");
  if (decision === undefined)
    throw new Error("pions_review_decision was not registered");
  const operationTool = tools.get("pions_operation");
  if (operationTool === undefined)
    throw new Error("pions_operation was not registered");
  const resultTool = tools.get("pions_result");
  if (resultTool === undefined)
    throw new Error("pions_result was not registered");
  const registered = registration;
  const reviewTool = review;
  const decisionTool = decision;
  let sessionId = "session-1";
  const extensionContext = {
    cwd: root,
    model: { provider: "test", id: "review-model" },
    thinkingLevel: "medium",
    modelRegistry: {
      find: () => ({ provider: "test", id: "review-model" }),
      hasConfiguredAuth: () => true,
      getRegisteredProviderIds: () => [],
    },
    sessionManager: { getSessionId: () => sessionId },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  async function reviewOutcome(
    toolCallId: string,
    task = "Review this Artifact"
  ) {
    const result = await reviewTool.execute(
      toolCallId,
      {
        artifactId: registered.artifact.artifactId,
        task,
      },
      undefined,
      undefined,
      extensionContext
    );
    return result.details as {
      readonly operationId: string;
      readonly rejoined: boolean;
    };
  }
  async function operation(operationId: string) {
    return runtime!.operation(operationId);
  }
  return {
    registration: registered,
    reviewOutcome,
    async review(toolCallId: string, task?: string) {
      return (await reviewOutcome(toolCallId, task)).operationId;
    },
    async authorize(operationId: string, toolCallId: string) {
      const receipt = await (
        await operation(operationId)
      ).waitForStartupReceipt();
      if (receipt === undefined) throw new Error("Startup receipt is missing");
      return decisionTool.execute(
        toolCallId,
        {
          operationId,
          receiptDigest: receipt.digest,
          decision: "authorize",
        },
        undefined,
        undefined,
        extensionContext
      );
    },
    async snapshot(operationId: string) {
      return (await operation(operationId)).read();
    },
    async result(operationId: string) {
      return (await operation(operationId)).readResult();
    },
    async inspectFromCurrentSession(operationId: string) {
      return operationTool.execute(
        "later-session-operation-call",
        { operationId },
        undefined,
        undefined,
        extensionContext
      );
    },
    async retrieveFromCurrentSession(operationId: string) {
      return resultTool.execute(
        "later-session-result-call",
        { operationId },
        undefined,
        undefined,
        extensionContext
      );
    },
    setSessionId(value: string) {
      sessionId = value;
    },
    async shutdown() {
      const handler = handlers.get("session_shutdown");
      if (handler === undefined)
        throw new Error("session_shutdown was not registered");
      await handler();
    },
    operation,
  };
}

test("a trusted external review allocation is bound to the created Operation", async (context) => {
  const fixture = await externalAllocationFixture(context);
  const operationId = await fixture.review("allocation-request-1");
  const snapshot = await fixture.snapshot(operationId);
  const { digest: _digest, ...binding } = snapshot.externalReviewAllocation!;

  assert.deepEqual(binding, {
    ...externalAllocationRequest("allocation-request-1", fixture.registration)
      .allocation,
    requestId: "allocation-request-1",
    operationId: "operation-allocation-1",
    boundAt: "2026-09-12T10:00:00.000Z",
  });
});

test("an external review allocation binding has an integrity digest", async (context) => {
  const fixture = await externalAllocationFixture(context);
  const operationId = await fixture.review("allocation-request-1");
  const snapshot = await fixture.snapshot(operationId);

  assert.match(
    snapshot.externalReviewAllocation!.digest,
    /^sha256:[0-9a-f]{64}$/u
  );
});

test("an unauthenticated external review allocation is rejected", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    authenticate: () => "denied",
  });

  await assert.rejects(fixture.review("allocation-request-1"), {
    name: "ExternalReviewAllocationError",
    reason: "issuer_authentication_failed",
  });
});

test("an external review allocation for another registration evidence is rejected", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    allocationFor: (requestId, registration) =>
      externalAllocationRequest(requestId, registration, {
        registrationEvidenceId: "different-evidence",
      }),
  });

  await assert.rejects(fixture.review("allocation-request-1"), {
    name: "ExternalReviewAllocationError",
    reason: "allocation_mismatch",
  });
});

test("an expired external review allocation is rejected", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    now: new Date("2026-09-12T11:00:00.000Z"),
  });

  await assert.rejects(fixture.review("allocation-request-1"), {
    name: "ExternalReviewAllocationError",
    reason: "expired",
  });
});

test("an exhausted external review allocation is rejected", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    allocationFor: (requestId, registration) =>
      externalAllocationRequest(requestId, registration, { useLimit: 0 }),
  });

  await assert.rejects(fixture.review("allocation-request-1"), {
    name: "ExternalReviewAllocationError",
    reason: "use_limit_exceeded",
  });
});

test("one external review allocation cannot bind a second Operation", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    operationIds: ["operation-allocation-1", "operation-allocation-2"],
  });
  await fixture.review("allocation-request-1");

  await assert.rejects(fixture.review("allocation-request-2"), {
    name: "ExternalReviewAllocationError",
    reason: "allocation_already_bound",
  });
});

test("a binding request identifier cannot replace its external allocation", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    operationIds: ["operation-allocation-1", "operation-allocation-2"],
    allocationFor: (bindingRequestId, registration) =>
      externalAllocationRequest("fixed-binding-request", registration, {
        axis:
          bindingRequestId === "allocation-request-1"
            ? "standards opaque value"
            : "specification opaque value",
      }),
  });
  await fixture.review("allocation-request-1");

  await assert.rejects(fixture.review("allocation-request-2"), {
    name: "ExternalReviewAllocationError",
    reason: "request_mismatch",
  });
});

test("an identical binding request rejoins its reserved Operation", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    operationIds: ["operation-allocation-1", "operation-allocation-2"],
    allocationFor: (_bindingRequestId, registration) =>
      externalAllocationRequest("fixed-binding-request", registration),
  });
  const firstOperationId = await fixture.review("allocation-request-1");

  assert.deepEqual(await fixture.reviewOutcome("allocation-request-2"), {
    operationId: firstOperationId,
    rejoined: true,
  });
});

async function requireInjectedOperationCreationFailure(
  operation: Promise<string>
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error && error.name === "OperationPersistenceError") {
      return;
    }
    throw error;
  }
  throw new Error("Expected the injected Operation creation failure");
}

test("an interrupted allocation binding resumes with its reserved Operation identifier", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    failOperationCreationOnce: true,
    operationIds: ["operation-allocation-1", "operation-allocation-2"],
    allocationFor: (_bindingRequestId, registration) =>
      externalAllocationRequest("fixed-binding-request", registration),
  });
  await requireInjectedOperationCreationFailure(
    fixture.review("allocation-request-1")
  );

  assert.equal(
    await fixture.review("allocation-request-2"),
    "operation-allocation-1"
  );
});

test("an unresolved external allocation reservation is not reusable", async (context) => {
  const fixture = await externalAllocationFixture(context, {
    failOperationCreationOnce: true,
    operationIds: ["operation-allocation-1", "operation-allocation-2"],
  });
  await requireInjectedOperationCreationFailure(
    fixture.review("allocation-request-1")
  );

  await assert.rejects(fixture.review("allocation-request-2"), {
    name: "ExternalReviewAllocationError",
    reason: "allocation_already_bound",
  });
});

test("an external review allocation binding rejects changed opaque content", async (context) => {
  const fixture = await externalAllocationFixture(context);
  const operationId = await fixture.review("allocation-request-1");
  const snapshot = await fixture.snapshot(operationId);

  assert.equal(
    validExternalReviewAllocationBinding({
      ...snapshot.externalReviewAllocation,
      axis: "changed axis",
    }),
    false
  );
});

test("external review allocation integrity is independent of object key order", async (context) => {
  const fixture = await externalAllocationFixture(context);
  const operationId = await fixture.review("allocation-request-1");
  const snapshot = await fixture.snapshot(operationId);
  const reordered = Object.fromEntries(
    Object.entries(snapshot.externalReviewAllocation!).reverse()
  );

  assert.equal(validExternalReviewAllocationBinding(reordered), true);
});

const STANDARDS_REVIEW_RESULT = '{"axis":"standards","verdict":"PASS"}';
const SPECIFICATION_REVIEW_RESULT = '{"axis":"specification","verdict":"PASS"}';

interface IndependentReviewsFixtureOptions {
  readonly standardsFailure?: "worker_protocol_failed";
  readonly rejectedStandardsBody?: string;
}

function selectIndependentReviewAllocation() {
  const axes = ["standards", "specification"] as const;
  let allocationIndex = 0;
  return (
    requestId: string,
    registration: Readonly<ReviewSubjectRegistrationResult>
  ) => {
    const axis = axes[allocationIndex];
    allocationIndex += 1;
    if (axis === undefined) throw new Error("No external allocation selected");
    return externalAllocationRequest(requestId, registration, {
      allocationId: `allocation-${axis}`,
      axis,
      externalExecutionId: `external-${axis}`,
    });
  };
}

function expectedFormalReviewPrompt(task: string): string {
  return [
    "You are a formal-review Worker with an independent context.",
    "Follow the trusted project's AGENTS.md instructions.",
    "Do not load skills, extensions, or prompt templates.",
    "Use only the configured tools: read.",
    "Return a self-contained textual Result.",
    "",
    "Review task:",
    task,
  ].join("\n");
}

async function independentReviewsFixture(
  context: test.TestContext,
  options: Readonly<IndependentReviewsFixtureOptions> = {}
) {
  const standardsOperationId = "operation-standards";
  const specificationOperationId = "operation-specification";
  const worker = new IndependentReviewWorkerAdapter({
    [standardsOperationId]: {
      body: options.rejectedStandardsBody ?? STANDARDS_REVIEW_RESULT,
      ...(options.standardsFailure === undefined
        ? {}
        : { failure: options.standardsFailure }),
      processId: 101,
    },
    [specificationOperationId]: {
      body: SPECIFICATION_REVIEW_RESULT,
      processId: 202,
    },
  });
  const fixture = await externalAllocationFixture(context, {
    operationIds: [standardsOperationId, specificationOperationId],
    worker,
    allocationFor: selectIndependentReviewAllocation(),
    validateResult: (bytes) =>
      options.rejectedStandardsBody !== undefined &&
      Buffer.from(bytes).toString("utf8") === options.rejectedStandardsBody
        ? { kind: "invalid", reason: "invalid_json" }
        : { kind: "valid" },
  });
  const operationIds = [
    await fixture.review(
      "standards-review-call",
      "Review coding standards only. Return a complete standards decision."
    ),
    await fixture.review(
      "specification-review-call",
      "Review the issue specification only. Return a complete specification decision."
    ),
  ] as const;
  await Promise.all([
    fixture.authorize(operationIds[0], "standards-decision-call"),
    fixture.authorize(operationIds[1], "specification-decision-call"),
  ]);
  async function waitForSettlement(operationId: string) {
    // Wait for a real terminal state. A fixed attempt budget fails under CI
    // load when other test files share the event loop; wall-clock bound stays
    // honest about "done or not" without inventing event order.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const snapshot = await fixture.snapshot(operationId);
      if (
        snapshot.state === "completed" ||
        snapshot.state === "failed" ||
        snapshot.state === "cancelled" ||
        snapshot.state === "unknown"
      ) {
        return snapshot;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Operation ${operationId} did not settle (state=${snapshot.state})`
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const snapshots = await Promise.all(operationIds.map(waitForSettlement));
  return {
    fixture,
    operationIds,
    snapshots,
    worker,
    async reviewIsComplete() {
      const results = await Promise.all(operationIds.map(fixture.result));
      return results.every((result) => result.kind === "retrieved");
    },
  };
}

test("an external harness binds its two review allocations to distinct Operations", async (context) => {
  const value = await independentReviewsFixture(context);

  assert.deepEqual(
    value.snapshots.map((snapshot) => ({
      operationId: snapshot.operationId,
      allocationId: snapshot.externalReviewAllocation?.allocationId,
      axis: snapshot.externalReviewAllocation?.axis,
    })),
    [
      {
        operationId: "operation-standards",
        allocationId: "allocation-standards",
        axis: "standards",
      },
      {
        operationId: "operation-specification",
        allocationId: "allocation-specification",
        axis: "specification",
      },
    ]
  );
});

test("independent formal reviews use distinct Worker and Pi session identities", async (context) => {
  const value = await independentReviewsFixture(context);

  assert.deepEqual(
    value.snapshots.map((snapshot) => snapshot.workerIdentity),
    [
      {
        processId: 101,
        processInstanceId: "process-operation-standards",
        processStartToken: "start-operation-standards",
        piSessionId: "pi-operation-standards",
        paneId: "fake-pane:operation-standards",
      },
      {
        processId: 202,
        processInstanceId: "process-operation-specification",
        processStartToken: "start-operation-specification",
        piSessionId: "pi-operation-specification",
        paneId: "fake-pane:operation-specification",
      },
    ]
  );
});

test("independent formal reviews receive separate self-contained tasks", async (context) => {
  const value = await independentReviewsFixture(context);

  assert.deepEqual(
    value.operationIds.map((operationId) =>
      value.worker.prompts.get(operationId)
    ),
    [
      expectedFormalReviewPrompt(
        "Review coding standards only. Return a complete standards decision."
      ),
      expectedFormalReviewPrompt(
        "Review the issue specification only. Return a complete specification decision."
      ),
    ]
  );
});

test("independent formal reviews preserve separate Worker execution evidence", async (context) => {
  const value = await independentReviewsFixture(context);

  assert.notDeepEqual(
    value.snapshots[0]?.workerExecutionEvidence,
    value.snapshots[1]?.workerExecutionEvidence
  );
});

test("independent formal reviews accept Results under separate acceptance identifiers", async (context) => {
  const value = await independentReviewsFixture(context);

  assert.notEqual(
    value.snapshots[0]?.resultAcceptance?.acceptanceId,
    value.snapshots[1]?.resultAcceptance?.acceptanceId
  );
});

test("each accepted formal review Result is governed by its pinned format", async (context) => {
  const reviews = await independentReviewsFixture(context);
  const pinnedFormat = {
    formatId: "test.formal-review-result",
    version: "1",
    normalizationId: "identity.v1",
    expectations: { resultKind: "formal-review" },
    validator: {
      validatorId: "test.formal-review-result-validator",
      version: "1",
      digest: digest(Buffer.from("test validator v1", "utf8")),
    },
  };

  assert.deepEqual(
    reviews.snapshots.map((snapshot) => snapshot.resultFormat),
    [pinnedFormat, pinnedFormat]
  );
});

test("each independent formal review retrieves only its own Result", async (context) => {
  const value = await independentReviewsFixture(context);
  const results = await Promise.all(
    value.operationIds.map(value.fixture.result)
  );

  assert.deepEqual(
    results.map((result) =>
      result.kind === "retrieved" ? result.result.body : result.kind
    ),
    [
      '{"axis":"standards","verdict":"PASS"}',
      '{"axis":"specification","verdict":"PASS"}',
    ]
  );
});

test("each independent formal review exposes its own Startup receipt", async (context) => {
  const value = await independentReviewsFixture(context);

  assert.deepEqual(
    value.snapshots.map(
      (snapshot) => snapshot.startAuthorization.receipt?.operationId
    ),
    ["operation-standards", "operation-specification"]
  );
});

test("each independent formal review Startup receipt has an integrity digest", async (context) => {
  const value = await independentReviewsFixture(context);

  assert.equal(
    value.snapshots.every((snapshot) =>
      /^sha256:[0-9a-f]{64}$/u.test(
        snapshot.startAuthorization.receipt?.digest ?? ""
      )
    ),
    true
  );
});

test("each independent formal review receives its own Start authorization", async (context) => {
  const value = await independentReviewsFixture(context);

  assert.notEqual(
    value.snapshots[0]?.startAuthorization.decision?.decisionId,
    value.snapshots[1]?.startAuthorization.decision?.decisionId
  );
});

test("one formal review protocol failure does not prevent the other Result acceptance", async (context) => {
  const value = await independentReviewsFixture(context, {
    standardsFailure: "worker_protocol_failed",
  });

  assert.notEqual(value.snapshots[1]?.resultAcceptance, undefined);
});

test("a formal review protocol failure remains a typed fact of that Operation", async (context) => {
  const value = await independentReviewsFixture(context, {
    standardsFailure: "worker_protocol_failed",
  });

  assert.equal(value.snapshots[0]?.failureReason, "worker_protocol_failed");
});

test("an invalid formal review Result remains a typed format rejection of that Operation", async (context) => {
  const value = await independentReviewsFixture(context, {
    rejectedStandardsBody: "not valid review JSON",
  });

  assert.deepEqual(value.snapshots[0]?.resultFormatRejection, {
    formatId: "test.formal-review-result",
    version: "1",
    validator: {
      validatorId: "test.formal-review-result-validator",
      version: "1",
      digest: digest(Buffer.from("test validator v1", "utf8")),
    },
    reason: "invalid_json",
  });
});

test("an invalid formal review Result does not change the other Operation", async (context) => {
  const value = await independentReviewsFixture(context, {
    rejectedStandardsBody: "not valid review JSON",
  });

  assert.notEqual(value.snapshots[1]?.resultAcceptance, undefined);
});

test("an invalid formal review Result is not available for retrieval", async (context) => {
  const reviews = await independentReviewsFixture(context, {
    rejectedStandardsBody: "not valid review JSON",
  });

  assert.equal(
    (await reviews.fixture.result(reviews.operationIds[0])).kind,
    "not_accepted"
  );
});

test("each independent formal review Result can be retrieved repeatedly", async (context) => {
  const reviews = await independentReviewsFixture(context);
  const first = await Promise.all(
    reviews.operationIds.map(reviews.fixture.result)
  );
  const second = await Promise.all(
    reviews.operationIds.map(reviews.fixture.result)
  );

  assert.deepEqual(second, first);
});

test("a binding mismatch in one allocation is a typed error independent of the other allocation", async (context) => {
  const reviews = await externalAllocationFixture(context, {
    operationIds: ["operation-standards", "operation-specification"],
    allocationFor: (requestId, registration) =>
      requestId === "allocation-request-1"
        ? externalAllocationRequest(requestId, registration, {
            allocationId: "allocation-standards",
            axis: "standards",
          })
        : externalAllocationRequest(requestId, registration, {
            allocationId: "allocation-specification",
            axis: "specification",
            registrationEvidenceId: "different-evidence",
          }),
  });
  await reviews.review("standards-review-call", "Review standards only");

  await assert.rejects(
    reviews.review("specification-review-call", "Review specification only"),
    { name: "ExternalReviewAllocationError", reason: "allocation_mismatch" }
  );
});

test("session shutdown cancels both active independent formal reviews", async (context) => {
  const reviews = await externalAllocationFixture(context, {
    operationIds: ["operation-standards", "operation-specification"],
    allocationFor: selectIndependentReviewAllocation(),
  });
  const operationIds = [
    await reviews.review("standards-review-call", "Review standards only"),
    await reviews.review(
      "specification-review-call",
      "Review specification only"
    ),
  ];
  const readers = await Promise.all(operationIds.map(reviews.operation));
  await reviews.shutdown();

  assert.deepEqual(
    await Promise.all(
      readers.map(async (reader) => (await reader.read()).state)
    ),
    ["cancelled", "cancelled"]
  );
});

test("a later Pi session can inspect both independent formal reviews", async (context) => {
  const reviews = await independentReviewsFixture(context);
  reviews.fixture.setSessionId("session-2");
  const inspections = await Promise.all(
    reviews.operationIds.map(reviews.fixture.inspectFromCurrentSession)
  );

  assert.deepEqual(
    inspections.map(
      (inspection) =>
        (inspection.details as { readonly operationId: string }).operationId
    ),
    [...reviews.operationIds]
  );
});

test("a later Pi session can retrieve both independent formal review Results", async (context) => {
  const reviews = await independentReviewsFixture(context);
  reviews.fixture.setSessionId("session-2");
  const results = await Promise.all(
    reviews.operationIds.map(reviews.fixture.retrieveFromCurrentSession)
  );

  assert.deepEqual(
    results.map((result) => (result.details as { readonly body: string }).body),
    [
      '{"axis":"standards","verdict":"PASS"}',
      '{"axis":"specification","verdict":"PASS"}',
    ]
  );
});

test("a later Pi session cannot authorize an earlier formal review", async (context) => {
  const reviews = await independentReviewsFixture(context);
  reviews.fixture.setSessionId("session-2");

  await assert.rejects(
    reviews.fixture.authorize(
      reviews.operationIds[0],
      "later-session-decision-call"
    ),
    /Operation is not owned by the current Pi session/u
  );
});

test("short-lived allocation credentials are absent from formal review tasks, state, and Results", async (context) => {
  const reviews = await independentReviewsFixture(context);
  const results = await Promise.all(
    reviews.operationIds.map(reviews.fixture.result)
  );
  const modelVisibleAndPersistedOutput = JSON.stringify({
    tasks: [...reviews.worker.prompts.values()],
    snapshots: reviews.snapshots,
    results,
  });

  assert.equal(
    modelVisibleAndPersistedOutput.includes("trusted-allocation-proof"),
    false
  );
});

test("an external harness alone decides when both independent reviews are complete", async (context) => {
  const reviews = await independentReviewsFixture(context);

  assert.equal(await reviews.reviewIsComplete(), true);
});

test("an external harness does not complete when one independent review fails", async (context) => {
  const reviews = await independentReviewsFixture(context, {
    standardsFailure: "worker_protocol_failed",
  });

  assert.equal(await reviews.reviewIsComplete(), false);
});
