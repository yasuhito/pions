import assert from "node:assert/strict";
import { test } from "node:test";

import { configurationMismatch } from "../src/internal/worker-configuration.js";
import { resolveWorkerConfig } from "../src/internal/worker-configuration.js";
import { effectiveConfig, observedConfig } from "./worker-protocol-fixtures.js";

test("observed thinking different from effective thinking is rejected", () => {
  const observed = {
    ...observedConfig,
    thinkingLevel: { state: "observed", value: "low" },
  } as const;

  assert.equal(configurationMismatch(effectiveConfig, observed), "thinking_level_mismatch");
});

test("a profile without an explicit resource proof policy is rejected", () => {
  assert.throws(() => resolveWorkerConfig({
    requested: {},
    profile: {
      modelCandidates: [{ provider: "test", id: "test-model" }],
      thinkingLevel: "medium",
      tools: ["read"],
    } as never,
    runtimeCwd: "/workspace",
  }), { name: "ResourceProofRejectedError", reason: "invalid_profile" });
});

test("unavailable observed thinking is rejected", () => {
  const observed = {
    ...observedConfig,
    thinkingLevel: { state: "unavailable" },
  } as const;

  assert.equal(configurationMismatch(effectiveConfig, observed), "thinking_level_mismatch");
});
