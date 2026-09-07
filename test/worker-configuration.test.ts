import assert from "node:assert/strict";
import { test } from "node:test";

import { configurationMismatch } from "../src/internal/worker-configuration.js";
import { effectiveConfig, observedConfig } from "./worker-protocol-fixtures.js";

test("observed thinking different from effective thinking is rejected", () => {
  const observed = {
    ...observedConfig,
    thinkingLevel: { state: "observed", value: "low" },
  } as const;

  assert.equal(configurationMismatch(effectiveConfig, observed), "thinking_level_mismatch");
});

test("unavailable observed thinking is rejected", () => {
  const observed = {
    ...observedConfig,
    thinkingLevel: { state: "unavailable" },
  } as const;

  assert.equal(configurationMismatch(effectiveConfig, observed), "thinking_level_mismatch");
});
