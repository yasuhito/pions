---
name: verify-pions
description: Verify Pions (durable Pi worker runtime and extension) by launching, doctoring, driving features, capturing evidence, and cleaning up
---

# Pions Verification Skill

This skill helps a cold agent verify Pions, a durable Pi worker runtime and extension for delegating tasks to visible, persistent operations.

**What Pions is:** TypeScript ESM library + Pi coding-agent extension that installs delegation tools (`pions_delegate`, `pions_result`, `pions_operation`) in trusted projects. Workers run as real Pi CLI sessions in Herdr panes. Lifecycle truth comes from persisted Operation/Result protocol, not UI state.

**When to use this skill:** When you need to verify changes to Pions, run smoke tests, or prove that the project builds and passes automated checks.

## Launch

Get Pions ready to verify:

1. **Check working directory**: Ensure you're in the Pions repository root (e.g., `/workspace` on a cloud agent, or `~/Work/pions` on a local machine).

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Build the project** (REQUIRED before using the extension):

   ```bash
   npm run build
   ```

   This generates `dist/` with the internal worker extension. If you skip this after protocol version changes, workers fail with "Worker configuration version does not match".

4. **Verify build artifacts exist**:

   ```bash
   ls -la dist/src/
   ```

   You should see `.js` files including `index.js`, `formal-review.js`, and `worker-extension.js`.

## Doctor

Check that Pions prerequisites and runtime dependencies are healthy:

### Required dependencies

1. **Node.js version**:

   ```bash
   node --version
   ```

   Expected: v26+ (check `package.json` `devDependencies.@types/node`)

2. **npm packages installed**:

   ```bash
   npm list --depth=0
   ```

   Key packages: `effect`, `@earendil-works/pi-coding-agent`, `pi-claude-bridge`, `typebox`

3. **TypeScript available**:
   ```bash
   npx tsc --version
   ```

### Herdr and Pi (REQUIRED for user-path verification)

**CRITICAL**: Pions workers require Herdr to create visible Pi TUI panes. The primary user path — live delegation via `pions_delegate` — cannot be verified without Herdr and Pi.

1. **Check if Herdr is available**:

   ```bash
   command -v herdr && herdr --version
   ```

   Expected: `herdr` binary on PATH, version 0.8.2+

2. **Check if Pi is available**:

   ```bash
   command -v pi && pi --version
   ```

   Expected: `pi` binary on PATH, version 0.85.1+

**If Herdr or Pi is missing:**

- **USER-PATH VERIFICATION IS BLOCKED**. You cannot prove visible delegation works.
- Automated tests (`npm run check`, build verification) may still run as partial regression gates, but they do NOT substitute for proving the real user experience.
- Document clearly in your proof output: "Live delegation proof BLOCKED: Herdr unavailable. Automated checks only."
- Do NOT claim end-to-end verification succeeded.

**If Herdr and Pi are present:**

- Proving ONE live-delegation feature (see `features/live-delegation.md`) is **REQUIRED** before claiming end-to-end success.
- Check for active user sessions to avoid conflicts (see Isolation below).

### Isolation: avoid double-driving shared sessions

If Herdr is present, check whether a user is actively working in a Pi session:

```bash
herdr pane list
```

If you see active Pi panes that the user owns, DO NOT drive delegation in the same workspace. Either:

1. Use a separate test workspace (if available), OR
2. Wait for user permission, OR
3. Document: "Live delegation proof deferred: user has active Pi session in this workspace."

Pions delegates to **sibling panes**. Launching delegation in a shared Herdr session while a user is working can corrupt their session state.

## Drive

Execute Pions features to prove they work.

**Primary user path**: Live delegation via `pions_delegate` in Herdr (see Feature 1 below). This is the real user experience.

**Regression gates**: Automated test suite, build verification, type checking. These prove code quality but do NOT prove visible delegation works.

### Feature 1: Live delegation (PRIMARY USER PATH — Herdr required)

**CRITICAL**: Must run **inside a Herdr pane**. Bare `pi --mode json` from a normal shell fails with "Herdr environment is unavailable" even if `herdr status` shows server running.

**Harness options**:

1. **Interactive Pi in Herdr** (manual): Launch Pi in a Herdr pane, send delegation message
2. **`herdr agent prompt <pane>`** (programmatic): Send delegation command to existing Pi pane

Example (programmatic):

```bash
herdr agent prompt wS9:p3 'Use pions_delegate exactly once to read package.json and return only the name field value. Do nothing else.' --wait
```

**See `features/live-delegation.md` for detailed steps, exact commands, success observables, and evidence capture.**

**If Herdr is unavailable**, you CANNOT prove this feature. Document the block and proceed to Feature 2 (automated checks) as a partial gate only.

### Feature 2: Automated test suite (regression gate, not user-path proof)

**Harness**: `npm run build` (prerequisite), then `npm run check`

**How to drive**:

```bash
npm run build
npm run check
```

**What it proves**: Code quality, type safety, lint rules, formatting compliance, test assertion rules, and full test coverage. Does NOT prove visible delegation works.

The `check` script runs:

- `typecheck` — TypeScript type validation
- `lint` — ESLint validation
- `format:check` — Prettier formatting check
- `check:test-assertions` — One-behavior-one-assertion rule validation
- `test` — Full node:test suite

**Expected outcome**: Exit code 0, all checks pass, all tests pass.

**See `features/automated-test-suite.md` for detailed steps and gotchas.**

### Feature 3: Build and extension readiness (regression gate)

**Harness**: `npm run build` + verify outputs

**How to drive**:

```bash
npm run build
ls -la dist/src/worker-extension.js
```

**What it proves**: The project compiles successfully, and the internal worker extension (loaded by visible workers) exists.

**Expected outcome**:

- `dist/src/worker-extension.js` exists
- `dist/src/index.js` and `dist/src/formal-review.js` exist

### Feature 4: Type checking (regression gate)

**Harness**: `npm run typecheck`

**How to drive**:

```bash
npm run typecheck
```

**What it proves**: Both main source (`tsconfig.json`) and extension source (`tsconfig.extension.json`) type-check cleanly.

**Expected outcome**: Exit code 0, no TypeScript errors.

### Feature 5: Formal review fail-closed (behavior proof)

**Harness**: Check that formal-review tools reject calls when unconfigured

**How to verify**:
Formal-review tools (`pions_review`, `pions_review_decision`) are registered but fail closed when no trusted configuration exists. The default project extension does not enable production formal review.

This is verified by:

1. Reviewing the extension code to confirm tools are registered
2. Confirming that execution without trusted configuration rejects requests
3. Checking automated tests that cover fail-closed behavior

**What it proves**: Formal-review tools do not accidentally enable production review without explicit trusted bootstrap configuration.

**Expected outcome**: Tools registered but reject execution without configuration.

## Evidence

Capture proof that verification succeeded. Evidence persists after cleanup so you can reference it in PRs or reports.

**Portable evidence directory convention:**

- Use `$VERIFY_PIONS_EVIDENCE_DIR` if set
- Else use `/tmp/verify-pions-$(date +%Y%m%d-%H%M%S)`
- Cloud agents may use `/opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)` when that directory exists

Example setup:

```bash
EVIDENCE_DIR="${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$EVIDENCE_DIR"
```

1. **Create an artifacts directory**:

   ```bash
   EVIDENCE_DIR="${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-$(date +%Y%m%d-%H%M%S)}"
   mkdir -p "$EVIDENCE_DIR"
   ```

2. **Save npm run check output**:

   ```bash
   npm run check > "$EVIDENCE_DIR/npm-check-output.txt" 2>&1
   ```

3. **Save build artifacts listing**:

   ```bash
   ls -laR dist/ > "$EVIDENCE_DIR/dist-listing.txt"
   ```

4. **If you ran live delegation** (Herdr available):
   - Note operation IDs returned by `pions_delegate`
   - Capture Herdr pane list: `herdr pane list > "$EVIDENCE_DIR/herdr-panes.txt"`

5. **Save environment info**:
   ```bash
   node --version > "$EVIDENCE_DIR/env-info.txt"
   npm list --depth=0 >> "$EVIDENCE_DIR/env-info.txt"
   ```

## Cleanup

Remove transient artifacts and processes created during verification. Do NOT delete evidence artifacts.

1. **Kill any stray processes** (only if you manually interrupted tests):

   ```bash
   # Check for stray Node processes if tests were interrupted
   ps aux | grep node
   # Kill specific PIDs if needed (be careful not to kill your own agent process)
   ```

2. **Remove test build artifacts** (optional, these are in `.test-dist/` and gitignored):

   ```bash
   rm -rf .test-dist/
   ```

3. **Check for leftover state** (only relevant if live delegation ran):
   - Pions state lives in `~/.local/state/pions/` (or `$XDG_STATE_HOME/pions/`)
   - Leave it alone unless you know operations are corrupted

4. **Verify evidence remains**:

   ```bash
   ls "${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-*}"
   ```

   Evidence should still exist after cleanup.

5. **Verify no ports are stuck open**:
   ```bash
   # Pions uses Unix domain sockets, not TCP ports, so this is usually a non-issue
   # If you started any external services manually, stop them now
   ```

## Helpers

### Quick health check script

Run this to quickly verify prerequisites before driving features:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Pions Quick Health Check ==="
echo "Node: $(node --version)"
echo "npm: $(npm --version)"
echo "TypeScript: $(npx tsc --version)"

if command -v herdr &> /dev/null; then
  echo "Herdr: $(herdr --version)"
else
  echo "Herdr: NOT AVAILABLE (live delegation will fail)"
fi

if command -v pi &> /dev/null; then
  echo "Pi: $(pi --version)"
else
  echo "Pi: NOT AVAILABLE (live delegation will fail)"
fi

echo ""
echo "Checking build artifacts..."
if [ -f dist/src/index.js ]; then
  echo "✓ dist/src/index.js exists"
else
  echo "✗ dist/src/index.js MISSING — run 'npm run build'"
fi

if [ -f dist/src/worker-extension.js ]; then
  echo "✓ dist/src/worker-extension.js exists"
else
  echo "✗ dist/src/worker-extension.js MISSING — run 'npm run build'"
fi

echo ""
echo "=== Health check complete ==="
```

Save as `.cursor/skills/verify-pions/helpers/health-check.sh` and run with `bash .cursor/skills/verify-pions/helpers/health-check.sh`.

### Interpreting test failures

- **Effect errors**: Pions uses Effect for functional control flow. Errors include `Effect.runSync`, `Effect.gen`, and internal fiber traces. Look for the top-level error message first.
- **Worker protocol errors**: If tests fail with "Worker configuration version does not match", rebuild with `npm run build`.
- **Herdr errors**: If `pions_delegate` fails with `HerdrPreconditionError`, Herdr is not available. This is expected in most cloud environments.

### Feature map reference

See `features/README.md` and individual feature files in `features/` for detailed sub-feature breakdowns, gotchas, and harness commands.
