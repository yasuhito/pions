import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { resolveWorkerExtensionEntryPath } from "../src/internal/worker-extension-entry.js";

test("source-loaded resolver selects the built Pions Worker extension", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-source-entry-"));
  const sourceModule = join(root, "src", "internal", "worker-extension-entry.ts");
  const builtEntry = join(root, "dist", "src", "worker-extension.js");
  await mkdir(join(root, "src", "internal"), { recursive: true });
  await mkdir(join(root, "dist", "src"), { recursive: true });
  await writeFile(builtEntry, "");
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(resolveWorkerExtensionEntryPath({ moduleUrl: pathToFileURL(sourceModule).href }), builtEntry);
});
