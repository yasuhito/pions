import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { InMemoryEventStore } from "../src/internal/event-store/memory-storage.js";
import { runtimeArtifactStore } from "../src/internal/runtime-artifacts.js";

test("closing an unopened Runtime Artifact Store prevents a later open", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-runtime-artifacts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const services = runtimeArtifactStore(root, new InMemoryEventStore());

  await services.artifacts.close();

  await assert.rejects(
    services.artifacts.registrationStatus(
      services.credential,
      "registration-1"
    ),
    /closed/u
  );
});
