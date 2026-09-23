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
  maxResultByteCount: DEFAULT_MAX_RESULT_BYTE_COUNT,
};

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
