import { Schema } from "effect";

import type {
  EffectiveWorkerConfig,
  ModelReference,
  ObservedWorkerConfig,
  RequestedWorkerConfig,
  ThinkingLevel,
  WorkerConfigurationFailureReason,
  WorkerProfilePolicy,
} from "../public.js";
import { ResourceProofRejectedError, WorkerConfigurationError } from "../public.js";
import { normalizePermissionManifest } from "./resource-proof.js";
import { resolveWorkProductRequirements } from "./result-acceptance-manifest.js";

export const ModelReferenceSchema = Schema.Struct({
  provider: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
});
export const ThinkingLevelSchema = Schema.Literal(
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
);
export const RequestedWorkerConfigSchema = Schema.Struct({
  model: Schema.optional(ModelReferenceSchema),
  thinkingLevel: Schema.optional(ThinkingLevelSchema),
  tools: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  cwd: Schema.optional(Schema.NonEmptyString),
});
export const EffectiveWorkerConfigSchema = Schema.Struct({
  model: ModelReferenceSchema,
  thinkingLevel: ThinkingLevelSchema,
  tools: Schema.Array(Schema.NonEmptyString),
  cwd: Schema.NonEmptyString,
  modelPolicy: Schema.Struct({
    candidates: Schema.Array(ModelReferenceSchema),
    attempted: Schema.Array(ModelReferenceSchema),
    maxAttempts: Schema.Literal(1),
    fallback: Schema.Literal("forbidden"),
    aliases: Schema.Array(Schema.String),
  }),
});
export const ObservedWorkerConfigSchema = Schema.Struct({
  model: Schema.Union(
    Schema.Struct({ state: Schema.Literal("observed"), value: ModelReferenceSchema }),
    Schema.Struct({ state: Schema.Literal("unavailable") }),
  ),
  thinkingLevel: Schema.Union(
    Schema.Struct({ state: Schema.Literal("observed"), value: ThinkingLevelSchema }),
    Schema.Struct({ state: Schema.Literal("unavailable") }),
  ),
  tools: Schema.Union(
    Schema.Struct({ state: Schema.Literal("observed"), value: Schema.Array(Schema.NonEmptyString) }),
    Schema.Struct({ state: Schema.Literal("unavailable") }),
  ),
  cwd: Schema.Union(
    Schema.Struct({ state: Schema.Literal("observed"), value: Schema.NonEmptyString }),
    Schema.Struct({ state: Schema.Literal("unavailable") }),
  ),
});

const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];
const MAX_CONFIG_STRING_BYTES = 512;
const MAX_TOOLS = 16;
const PI_BUILTIN_TOOLS = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

export const BODY_ONLY_WORK_PRODUCT_REQUIREMENTS = Object.freeze({
  body: Object.freeze({
    formatId: "pions.result-body.v1",
    normalizationId: "identity.v1",
    maxByteCount: 1_048_576,
  }),
  workProducts: Object.freeze([]),
  maxTotalByteCount: 1_048_576,
});

export const DEFAULT_WORKER_PROFILE_POLICY: WorkerProfilePolicy = Object.freeze({
  modelCandidates: Object.freeze([{ provider: "test", id: "test-model" }]),
  thinkingLevel: "medium",
  tools: Object.freeze(["read", "bash", "edit", "write"]),
  resources: Object.freeze({ resourceProofPolicy: "disabled" }),
  workProductRequirements: BODY_ONLY_WORK_PRODUCT_REQUIREMENTS,
  acceptedArtifactRetentionMs: 86_400_000,
});

export function validateWorkerResourcePolicy(profile: Readonly<WorkerProfilePolicy>): void {
  const resources = profile.resources;
  if (resources === undefined || resources.resourceProofPolicy !== "disabled" && resources.resourceProofPolicy !== "required") {
    throw new ResourceProofRejectedError("invalid_profile", "Resource proof policy must be explicit");
  }
  if (resources.resourceProofPolicy === "disabled") return;
  if (
    resources.authorityId.length === 0 ||
    resources.authorityRegistrationId.length === 0 ||
    resources.authorityGeneration.length === 0 ||
    resources.normalizationVersion.length === 0 ||
    resources.workspace.workspaceId.length === 0 ||
    resources.workspace.normalizedPath.length === 0 ||
    resources.workspace.baseRevision.length === 0 ||
    resources.workspace.pionsMayDelete !== false ||
    !Number.isSafeInteger(resources.cleanupTimeoutMs) || resources.cleanupTimeoutMs <= 0 ||
    !Number.isSafeInteger(resources.maxCleanupAttempts) || resources.maxCleanupAttempts <= 0 ||
    resources.safetyCleanupOperations.length !== 3 ||
    !["inspect", "revoke", "release"].every((operation) => resources.safetyCleanupOperations.includes(operation as "inspect" | "revoke" | "release"))
  ) {
    throw new ResourceProofRejectedError("invalid_profile", "Required resource proof configuration is incomplete");
  }
  const manifest = normalizePermissionManifest(resources.permissionManifest);
  const profileTools = [...new Set(profile.tools)].sort();
  if (manifest.tools.length !== profileTools.length || manifest.tools.some((tool, index) => tool !== profileTools[index])) {
    throw new ResourceProofRejectedError("permission_contradiction", "Profile tools and permission manifest tools differ");
  }
}

function sameModel(left: Readonly<ModelReference>, right: Readonly<ModelReference>): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function fail(reason: WorkerConfigurationFailureReason, message: string): never {
  throw new WorkerConfigurationError(reason, message);
}

function boundedString(value: string, name: string): void {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_CONFIG_STRING_BYTES) {
    fail("unsupported_capability", `${name} is empty or exceeds its size limit`);
  }
}

function uniqueTools(tools: ReadonlyArray<string>): ReadonlyArray<string> {
  if (tools.length > MAX_TOOLS || new Set(tools).size !== tools.length) {
    fail("tool_policy_violation", "Tool selection is duplicated or exceeds its count limit");
  }
  for (const tool of tools) boundedString(tool, "tool name");
  return Object.freeze([...tools]);
}

export function requestedWorkerConfig(task: Readonly<RequestedWorkerConfig>): RequestedWorkerConfig {
  return Object.freeze({
    ...(task.model === undefined ? {} : { model: Object.freeze({ ...task.model }) }),
    ...(task.thinkingLevel === undefined ? {} : { thinkingLevel: task.thinkingLevel }),
    ...(task.tools === undefined ? {} : { tools: uniqueTools(task.tools) }),
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
  });
}

export function resolveWorkerConfig(options: {
  readonly requested: Readonly<RequestedWorkerConfig>;
  readonly profile: Readonly<WorkerProfilePolicy> | undefined;
  readonly runtimeCwd: string;
  readonly parent?: Readonly<EffectiveWorkerConfig>;
}): EffectiveWorkerConfig {
  const { profile } = options;
  if (profile === undefined) fail("unsupported_capability", "Unknown Worker profile");
  validateWorkerResourcePolicy(profile);
  resolveWorkProductRequirements(profile);
  boundedString(options.runtimeCwd, "working directory");
  if (profile.modelCandidates.length !== 1) {
    fail("model_mismatch", "Exactly one model candidate is required because fallback is forbidden");
  }
  const candidate = profile.modelCandidates[0];
  if (candidate === undefined) fail("model_mismatch", "A model candidate is required");
  boundedString(candidate.provider, "model provider");
  boundedString(candidate.id, "model identifier");

  const model = options.requested.model ?? candidate;
  if (!sameModel(model, candidate)) {
    fail("model_mismatch", "Requested model is not the exact configured candidate");
  }
  const thinkingLevel = options.requested.thinkingLevel ?? profile.thinkingLevel;
  if (!THINKING_LEVELS.includes(thinkingLevel)) {
    fail("unsupported_capability", "Unsupported thinking level");
  }
  if (THINKING_LEVELS.indexOf(thinkingLevel) > THINKING_LEVELS.indexOf(profile.thinkingLevel)) {
    fail("unsupported_capability", "Requested thinking level exceeds the profile ceiling");
  }
  const profileTools = uniqueTools(profile.tools);
  if (profileTools.some((tool) => !PI_BUILTIN_TOOLS.has(tool))) {
    fail("tool_policy_violation", "Profile requires a tool unavailable to the Pi Worker");
  }
  const tools = uniqueTools(options.requested.tools ?? profileTools);
  if (tools.some((tool) => !profileTools.includes(tool))) {
    fail("tool_policy_violation", "Requested tools exceed the profile ceiling");
  }
  if (options.requested.cwd !== undefined && options.requested.cwd !== options.runtimeCwd) {
    fail("unsupported_capability", "Requested working directory is unavailable");
  }
  if (profile.resources.resourceProofPolicy === "required") {
    if (profile.resources.workspace.normalizedPath !== options.runtimeCwd) {
      throw new ResourceProofRejectedError("invalid_profile", "Resource workspace differs from the Runtime workspace");
    }
    const manifestTools = normalizePermissionManifest(profile.resources.permissionManifest).tools;
    if (manifestTools.length !== tools.length || manifestTools.some((tool, index) => tool !== [...tools].sort()[index])) {
      throw new ResourceProofRejectedError("permission_mismatch", "Effective tools differ from the required permission manifest");
    }
  }

  const parent = options.parent;
  if (parent !== undefined) {
    if (tools.some((tool) => !parent.tools.includes(tool))) {
      fail("tool_policy_violation", "Child tools exceed the inherited ceiling");
    }
    if (THINKING_LEVELS.indexOf(thinkingLevel) > THINKING_LEVELS.indexOf(parent.thinkingLevel)) {
      fail("unsupported_capability", "Child thinking level exceeds the inherited ceiling");
    }
  }

  return Object.freeze({
    model: Object.freeze({ ...model }),
    thinkingLevel,
    tools,
    cwd: options.runtimeCwd,
    modelPolicy: Object.freeze({
      candidates: Object.freeze([Object.freeze({ ...candidate })]),
      attempted: Object.freeze([Object.freeze({ ...model })]),
      maxAttempts: 1,
      fallback: "forbidden",
      aliases: Object.freeze([]),
    }),
  });
}

export function configurationMismatch(
  effective: Readonly<EffectiveWorkerConfig>,
  observed: Readonly<ObservedWorkerConfig>,
): WorkerConfigurationFailureReason | undefined {
  if (observed.model.state !== "observed" || !sameModel(effective.model, observed.model.value)) {
    return "model_mismatch";
  }
  if (observed.thinkingLevel.state !== "observed" ||
      observed.thinkingLevel.value !== effective.thinkingLevel) {
    return "thinking_level_mismatch";
  }
  if (observed.tools.state !== "observed" ||
      observed.tools.value.length !== effective.tools.length ||
      observed.tools.value.some((tool) => !effective.tools.includes(tool))) {
    return "tool_policy_violation";
  }
  if (observed.cwd.state !== "observed" || observed.cwd.value !== effective.cwd) {
    return "unsupported_capability";
  }
  return undefined;
}
