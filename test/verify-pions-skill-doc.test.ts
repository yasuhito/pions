import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const skillPath = join(
  process.cwd(),
  ".cursor",
  "skills",
  "verify-pions",
  "SKILL.md"
);

function cleanupEvidenceSnippet(): string {
  const skill = readFileSync(skillPath, "utf8");
  const start = skill.indexOf("4. **Verify evidence remains**:");
  assert.notEqual(start, -1, "cleanup step 4 heading is missing");
  const fenceOpen = skill.indexOf("```bash\n", start);
  const fenceClose = skill.indexOf("```", fenceOpen + "```bash\n".length);
  assert.ok(fenceOpen > start && fenceClose > fenceOpen);
  return skill
    .slice(fenceOpen + "```bash\n".length, fenceClose)
    .split("\n")
    .map((line) => line.replace(/^ {3}/, ""))
    .join("\n");
}

function runSnippet(snippet: string, env: Record<string, string>) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", snippet], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("cleanup evidence check does not use the unexpandable quoted glob", () => {
  const snippet = cleanupEvidenceSnippet();

  assert.doesNotMatch(
    snippet,
    /"\$\{VERIFY_PIONS_EVIDENCE_DIR:-\/tmp\/verify-pions-\*\}"/
  );
});

test("cleanup evidence check lists an explicitly configured directory with spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "pions-skill-doc-test-"));
  const evidenceDir = join(root, "evidence dir");
  mkdirSync(evidenceDir);
  try {
    const result = runSnippet(cleanupEvidenceSnippet(), {
      VERIFY_PIONS_EVIDENCE_DIR: evidenceDir,
    });

    assert.deepEqual(
      { status: result.status, stderr: result.stderr },
      { status: 0, stderr: "" }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup evidence check succeeds without a configured directory", () => {
  const snippet = cleanupEvidenceSnippet();
  const env = { ...process.env };
  delete env["VERIFY_PIONS_EVIDENCE_DIR"];

  const result = spawnSync("bash", ["-euo", "pipefail", "-c", snippet], {
    encoding: "utf8",
    env,
  });

  assert.deepEqual(
    {
      status: result.status,
      literalGlobInOutput: /verify-pions-\*/.test(result.stdout),
    },
    { status: 0, literalGlobInOutput: false }
  );
});
