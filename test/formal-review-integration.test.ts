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

import { createFormalReviewIntegration } from "../src/formal-review.js";
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

async function fixture(context: test.TestContext) {
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
  return createFormalReviewIntegration({ repositoryRoot: root });
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
  const digest =
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;

  const artifact = await integration.registerReviewSubject({
    registrationId: "review-subject-1",
    bytes,
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
  });

  assert.deepEqual(artifact, {
    artifactId: artifact.artifactId,
    byteCount: bytes.byteLength,
    digest,
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
    dependencies: [],
  });
});

test("repeating a review subject registration returns the same Artifact", async (context) => {
  const integration = await fixture(context);
  const request = {
    registrationId: "review-subject-1",
    bytes: Buffer.from("fixed review subject", "utf8"),
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
  } as const;

  const first = await integration.registerReviewSubject(request);
  const replay = await integration.registerReviewSubject(request);

  assert.equal(replay.artifactId, first.artifactId);
});

test("a registration identifier cannot replace its fixed root Artifact", async (context) => {
  const integration = await fixture(context);
  await integration.registerReviewSubject({
    registrationId: "review-subject-1",
    bytes: Buffer.from("first review subject", "utf8"),
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
  });

  await assert.rejects(
    integration.registerReviewSubject({
      registrationId: "review-subject-1",
      bytes: Buffer.from("replacement review subject", "utf8"),
      formatId: "pions.opaque.v1",
      normalizationId: "identity.v1",
    }),
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

test("a registered root Artifact is available to the configured extension Runtime", async (context) => {
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
  const bytes = Buffer.from("fixed review subject", "utf8");
  const artifact = await integration.registerReviewSubject({
    registrationId: "review-subject-1",
    bytes,
    formatId: "pions.opaque.v1",
    normalizationId: "identity.v1",
  });
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
    { artifactId: artifact.artifactId, task: "Review this Artifact" },
    undefined,
    undefined,
    extensionContext
  );
  const operationId = (result.details as { readonly operationId: string })
    .operationId;
  const receipt = await (
    await runtime!.operation(operationId)
  ).waitForStartupReceipt();

  assert.equal(receipt?.reviewSubject?.artifactId, artifact.artifactId);
});
