import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { resolveWorkerExtensionEntryPath } from "../src/internal/worker-extension-entry.js";

async function packageRoot(
  context: { after(fn: () => Promise<void>): void },
  entries: ReadonlyArray<string>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pions-worker-entry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const entry of entries) {
    await mkdir(join(root, entry, ".."), { recursive: true });
    await writeFile(join(root, entry), "");
  }
  return root;
}

function resolveFrom(root: string, resolverModule: string): string {
  return resolveWorkerExtensionEntryPath({
    moduleUrl: pathToFileURL(join(root, resolverModule)).href,
  });
}

test("source-loaded resolver selects the source Pions Worker extension", async (context) => {
  const root = await packageRoot(context, [
    "src/worker-extension.ts",
    "dist/src/worker-extension.js",
  ]);

  assert.equal(
    resolveFrom(root, "src/internal/worker-extension-entry.ts"),
    join(root, "src", "worker-extension.ts")
  );
});

test("source-loaded resolver never falls back to a built Pions Worker extension", async (context) => {
  const root = await packageRoot(context, ["dist/src/worker-extension.js"]);

  assert.throws(
    () => resolveFrom(root, "src/internal/worker-extension-entry.ts"),
    /Pions Worker extension entry is unavailable/u
  );
});

test("built resolver selects the built Pions Worker extension", async (context) => {
  const root = await packageRoot(context, ["dist/src/worker-extension.js"]);

  assert.equal(
    resolveFrom(root, "dist/src/internal/worker-extension-entry.js"),
    join(root, "dist", "src", "worker-extension.js")
  );
});
