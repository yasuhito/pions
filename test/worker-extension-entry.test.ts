import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_BRIDGE_VERSION,
  resolveClaudeBridgeExtension,
  resolveWorkerExtensionEntryPath,
  validateClaudeBridgePolicy,
} from "../src/internal/worker-extension-entry.js";

test("the approved Claude bridge resolves its pinned extension entry", () => {
  const extension = resolveClaudeBridgeExtension();

  assert.match(
    extension.entryPath,
    /node_modules\/pi-claude-bridge\/src\/index\.ts$/u
  );
});

test("the approved Claude bridge reports its pinned package version", () => {
  const extension = resolveClaudeBridgeExtension();

  assert.equal(extension.version, CLAUDE_BRIDGE_VERSION);
});

test("a different installed Claude bridge version is rejected", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-claude-bridge-entry-"));
  const packagePath = join(root, "package.json");
  const entryPath = join(root, "src", "index.ts");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    packagePath,
    JSON.stringify({ name: "pi-claude-bridge", version: "0.7.1" })
  );
  await writeFile(entryPath, "");
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () => resolveClaudeBridgeExtension({ packagePath }),
    /version 0\.7\.1.*expected 0\.7\.0/u
  );
});

test("non-boolean AskClaude settings are rejected", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-claude-policy-"));
  await mkdir(join(root, ".pi"));
  await writeFile(
    join(root, ".pi", "claude-bridge.json"),
    JSON.stringify({
      askClaude: { enabled: "false" },
    })
  );
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(() => validateClaudeBridgePolicy({ cwd: root }), /AskClaude/u);
});

test("source-loaded resolver selects the built Pions Worker extension", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pions-source-entry-"));
  const sourceModule = join(
    root,
    "src",
    "internal",
    "worker-extension-entry.ts"
  );
  const builtEntry = join(root, "dist", "src", "worker-extension.js");
  await mkdir(join(root, "src", "internal"), { recursive: true });
  await mkdir(join(root, "dist", "src"), { recursive: true });
  await writeFile(builtEntry, "");
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(
    resolveWorkerExtensionEntryPath({
      moduleUrl: pathToFileURL(sourceModule).href,
    }),
    builtEntry
  );
});
