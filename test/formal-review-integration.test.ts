import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  createFormalReviewIntegration,
  type ReviewSubjectRegistrationEvidenceConfiguration,
  type ReviewSubjectRegistrationRequest,
} from "../src/formal-review.js";
import { PrivateFileEventStore } from "../src/internal/event-store/index.js";
import { configureFormalReviewIntegrationForTest } from "../src/internal/formal-review-integration.js";
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";
import {
  FakeClock,
  FakeIdGenerator,
  FakePresentation,
  FakeWorkerAdapter,
  makeTestRuntime,
} from "../src/internal/testing.js";
import type { Runtime, WorkerProfilePolicy } from "../src/public.js";

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
    await rm(root, { recursive: true, force: true });
  });
  return createFormalReviewIntegration({
    repositoryRoot: root,
    reviewSubjectRegistration: registrationConfiguration,
  });
}

test("the package publishes the stable formal review integration entry", async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8")
  ) as {
    readonly files?: ReadonlyArray<string>;
    readonly exports?: Readonly<Record<string, string>>;
  };

  assert.deepEqual(
    {
      files: manifest.files,
      entry: manifest.exports?.["./formal-review"],
    },
    {
      files: ["dist"],
      entry: "./dist/src/formal-review.js",
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

test("an unconfigured integration keeps the formal review tool registered and rejects its use", async (context) => {
  const integration = await fixture(context);
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
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "session-1" },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;

  await assert.rejects(
    review.execute(
      "review-call-1",
      { artifactId: "artifact-1", task: "Review this Artifact" },
      undefined,
      undefined,
      extensionContext
    ),
    { name: "WorkerConfigurationError", reason: "unsupported_capability" }
  );
});

test("a registered dependent root is available to the configured extension Runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-formal-review-runtime-"));
  const stateBaseDirectory = join(root, "state");
  const profile: WorkerProfilePolicy = {
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
        formatId: "pions.result-body.utf8.v1",
        normalizationId: "identity",
        maxByteCount: 50_000,
      },
      workProducts: [],
      maxTotalByteCount: 50_000,
    },
    acceptedArtifactRetentionMs: 86_400_000,
  };
  let runtime: Runtime | undefined;
  const configuration = {
    repositoryRoot: root,
    reviewSubjectRegistration,
    formalReview: {
      profile,
      reviewSubjectAuthority: { currentUse: async () => "allowed" as const },
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
    await rm(root, { recursive: true, force: true });
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
