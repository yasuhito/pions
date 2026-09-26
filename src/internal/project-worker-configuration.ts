import type {
  ModelReference,
  ThinkingLevel,
  WorkerExtension,
  WorkerProfilePolicy,
} from "./types.js";
import {
  ProjectConfigurationError,
  WorkerConfigurationError,
} from "./types.js";
import { DEFAULT_MAX_RESULT_BYTE_COUNT } from "./worker-configuration.js";

const PROJECT_CONFIG_FILE = ".pions.json";
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const WORKER_TOOLS = Object.freeze([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);
const MAX_EXTENSION_SOURCES = 16;
const MAX_EXTENSION_SOURCE_BYTES = 512;

export interface ProjectWorkerConfig {
  readonly model?: Readonly<ModelReference>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly extensions?: ReadonlyArray<string>;
}

export interface DelegatingWorkerSettings {
  readonly model: Readonly<ModelReference>;
  readonly thinkingLevel: ThinkingLevel;
}

export interface WorkerSelection extends DelegatingWorkerSettings {
  readonly extensionSources: ReadonlyArray<string>;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKnownKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
  location: string
): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) {
    throw new ProjectConfigurationError(
      "unknown_key",
      `Unknown key ${JSON.stringify(unknown)} in ${location}`
    );
  }
}

/** Decode the trusted repository's Worker configuration without accessing Pi or disk. */
export function decodeProjectWorkerConfig(source: string): ProjectWorkerConfig {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    throw new ProjectConfigurationError(
      "invalid_json",
      `${PROJECT_CONFIG_FILE} is not valid JSON`
    );
  }
  if (!isRecord(decoded)) {
    throw new ProjectConfigurationError(
      "invalid_shape",
      `${PROJECT_CONFIG_FILE} must contain an object`
    );
  }
  requireKnownKeys(
    decoded,
    ["model", "thinkingLevel", "extensions"],
    PROJECT_CONFIG_FILE
  );

  let model: ModelReference | undefined;
  if (decoded.model !== undefined) {
    if (!isRecord(decoded.model)) {
      throw new ProjectConfigurationError(
        "invalid_shape",
        "model must contain an object"
      );
    }
    requireKnownKeys(decoded.model, ["provider", "id"], "model");
    if (
      typeof decoded.model.provider !== "string" ||
      !PROVIDER_PATTERN.test(decoded.model.provider)
    ) {
      throw new ProjectConfigurationError(
        "invalid_provider",
        "model.provider is invalid"
      );
    }
    if (
      typeof decoded.model.id !== "string" ||
      !MODEL_ID_PATTERN.test(decoded.model.id)
    ) {
      throw new ProjectConfigurationError(
        "invalid_model_id",
        "model.id is invalid"
      );
    }
    model = { provider: decoded.model.provider, id: decoded.model.id };
  }

  if (
    decoded.thinkingLevel !== undefined &&
    !isThinkingLevel(decoded.thinkingLevel)
  ) {
    throw new ProjectConfigurationError(
      "invalid_thinking_level",
      "thinkingLevel is invalid"
    );
  }
  const extensions = decoded.extensions;
  if (
    extensions !== undefined &&
    (!Array.isArray(extensions) ||
      extensions.length > MAX_EXTENSION_SOURCES ||
      new Set(extensions).size !== extensions.length ||
      extensions.some(
        (entry) =>
          typeof entry !== "string" ||
          entry.length === 0 ||
          Buffer.byteLength(entry, "utf8") > MAX_EXTENSION_SOURCE_BYTES
      ))
  ) {
    throw new ProjectConfigurationError(
      "invalid_extensions",
      "extensions must be a list of distinct Pi package sources"
    );
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(decoded.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: decoded.thinkingLevel }),
    ...(extensions === undefined
      ? {}
      : { extensions: extensions as ReadonlyArray<string> }),
  };
}

/** Reject invalid delegating Pi settings before reading repository configuration. */
export function delegatingWorkerSettings(
  model: Readonly<ModelReference> | undefined,
  thinkingLevel: unknown
): DelegatingWorkerSettings {
  if (model === undefined) {
    throw new WorkerConfigurationError(
      "model_mismatch",
      "The delegating Pi session has no selected model"
    );
  }
  if (!isThinkingLevel(thinkingLevel)) {
    throw new WorkerConfigurationError(
      "unsupported_capability",
      "The delegating Pi session has no supported thinking level"
    );
  }
  return { model: { provider: model.provider, id: model.id }, thinkingLevel };
}

/** Make the launch decision from facts observed by the delegating Pi extension. */
export function selectProjectWorker(options: {
  readonly configured: Readonly<ProjectWorkerConfig> | undefined;
  readonly inherited: Readonly<DelegatingWorkerSettings>;
  readonly registeredModel: Readonly<ModelReference> | undefined;
  readonly registeredModelAuthenticated: boolean | undefined;
  readonly registeredProviderIds: ReadonlyArray<string>;
}): WorkerSelection {
  const { configured } = options;
  let model = options.inherited.model;
  if (configured?.model !== undefined) {
    if (options.registeredModel === undefined) {
      throw new WorkerConfigurationError(
        "model_not_found",
        `Configured Worker model ${configured.model.provider}/${configured.model.id} was not found`
      );
    }
    if (!options.registeredModelAuthenticated) {
      throw new WorkerConfigurationError(
        "model_auth_unavailable",
        `Configured Worker model provider ${configured.model.provider} is not authenticated`
      );
    }
    model = {
      provider: options.registeredModel.provider,
      id: options.registeredModel.id,
    };
  }
  const extensionSources = configured?.extensions ?? [];
  // Pi does not expose which extension registered a provider. Only the
  // unambiguous omission of all Worker extension packages can be checked.
  if (
    extensionSources.length === 0 &&
    options.registeredProviderIds.includes(model.provider)
  ) {
    throw new WorkerConfigurationError(
      "unsupported_capability",
      `Model provider ${model.provider} is registered by a Pi extension; add the Pi package that provides it to ${PROJECT_CONFIG_FILE} "extensions"`
    );
  }
  return {
    model,
    thinkingLevel: configured?.thinkingLevel ?? options.inherited.thinkingLevel,
    extensionSources,
  };
}

/** Keep the Runtime's persisted effective configuration derived from one profile. */
export function projectWorkerProfile(
  selection: Readonly<WorkerSelection>,
  extensions: ReadonlyArray<Readonly<WorkerExtension>>
): WorkerProfilePolicy {
  return {
    modelCandidates: [selection.model],
    thinkingLevel: selection.thinkingLevel,
    tools: WORKER_TOOLS,
    extensions,
    maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
  };
}
