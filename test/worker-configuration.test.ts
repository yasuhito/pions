import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_RESULT_BYTE_COUNT,
  configurationMismatch,
  resolveWorkerConfig,
} from "../src/internal/worker-configuration.js";
import type { WorkerProfilePolicy } from "../src/internal/types.js";
import { effectiveConfig, observedConfig } from "./worker-protocol-fixtures.js";

const profile: WorkerProfilePolicy = {
  modelCandidates: [{ provider: "test", id: "test-model" }],
  thinkingLevel: "medium",
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  extensions: [],
  maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
};

const webExtension = {
  source: "npm:pi-web-access",
  path: "/home/user/.pi/agent/npm/node_modules/pi-web-access/index.ts",
};

function observedTools(tools: ReadonlyArray<string>) {
  return {
    ...observedConfig,
    tools: { state: "observed", value: tools },
  } as const;
}

test("observed thinking different from effective thinking is rejected", () => {
  const observed = {
    ...observedConfig,
    thinkingLevel: { state: "observed", value: "low" },
  } as const;

  assert.equal(
    configurationMismatch(effectiveConfig, observed),
    "thinking_level_mismatch"
  );
});

test("the Worker profile provides editing tools", () => {
  assert.deepEqual(
    resolveWorkerConfig({ requested: {}, profile, runtimeCwd: "/workspace" })
      .tools,
    ["read", "write", "edit", "bash", "grep", "find", "ls"]
  );
});

test("a profile cannot provide a tool outside the Pi built-in set", () => {
  assert.throws(
    () =>
      resolveWorkerConfig({
        requested: {},
        profile: { ...profile, tools: ["read", "pions_delegate"] },
        runtimeCwd: "/workspace",
      }),
    { name: "WorkerConfigurationError", reason: "tool_policy_violation" }
  );
});

test("the Worker profile runs in the Runtime working directory", () => {
  assert.equal(
    resolveWorkerConfig({ requested: {}, profile, runtimeCwd: "/workspace" })
      .cwd,
    "/workspace"
  );
});

test("unavailable observed thinking is rejected", () => {
  const observed = {
    ...observedConfig,
    thinkingLevel: { state: "unavailable" },
  } as const;

  assert.equal(
    configurationMismatch(effectiveConfig, observed),
    "thinking_level_mismatch"
  );
});

test("the Worker profile carries its extensions into the effective configuration", () => {
  assert.deepEqual(
    resolveWorkerConfig({
      requested: {},
      profile: { ...profile, extensions: [webExtension] },
      runtimeCwd: "/workspace",
    }).extensions,
    [webExtension]
  );
});

test("tools added by Worker extensions are accepted beside the effective tools", () => {
  assert.equal(
    configurationMismatch(
      effectiveConfig,
      observedTools(["read", "bash", "web_search"])
    ),
    undefined
  );
});

test("an observed Pi built-in tool outside the effective tools is rejected", () => {
  assert.equal(
    configurationMismatch(
      effectiveConfig,
      observedTools(["read", "bash", "write"])
    ),
    "tool_policy_violation"
  );
});

test("an observed delegation tool is rejected", () => {
  assert.equal(
    configurationMismatch(
      effectiveConfig,
      observedTools(["read", "bash", "pions_delegate"])
    ),
    "tool_policy_violation"
  );
});

test("a missing effective tool is rejected", () => {
  assert.equal(
    configurationMismatch(effectiveConfig, observedTools(["read"])),
    "tool_policy_violation"
  );
});
