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

1. **Check working directory**: Ensure you're in `/workspace` (the Pions repository root).

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

### Herdr and Pi (optional, required for live delegation)

Pions workers require Herdr to create visible Pi TUI panes. If Herdr is unavailable, `pions_delegate` fails with `HerdrPreconditionError`.

1. **Check if Herdr is running**:

   ```bash
   command -v herdr && herdr --version
   ```

2. **Check if Pi is available**:
   ```bash
   command -v pi && pi --version
   ```

**Limitation in Cloud Agents**: Most cloud VMs do not have Herdr or user Pi sessions configured. Skip live delegation tests if Herdr is unavailable. Focus on automated test harnesses instead.

## Drive

Execute Pions features to prove they work. Start with automated harnesses (safe everywhere), then try live delegation only if Herdr is available.

### Feature 1: Automated test suite

**Harness**: `npm run check` (typecheck, lint, prettier, test-assertion validation, node:test suite)

**How to drive**:

```bash
npm run check
```

**What it proves**: All TypeScript types are valid, code passes linting and formatting checks, test assertions follow the one-behavior-one-assertion rule, and all automated tests pass.

**Expected outcome**: Exit code 0, no failures.

**Gotchas**:

- Must run `npm run build` first to generate test artifacts in `.test-dist/`.
- If tests fail, read error output carefully — Pions uses Effect for control flow, so stack traces may show Effect internals.

### Feature 2: Build and extension readiness

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

**Gotchas**:

- The `dist/` directory is gitignored. Always rebuild after pulling changes.
- Worker protocol version mismatches happen if you forget to rebuild after protocol changes.

### Feature 3: Type checking

**Harness**: `npm run typecheck`

**How to drive**:

```bash
npm run typecheck
```

**What it proves**: Both main source (`tsconfig.json`) and extension source (`tsconfig.extension.json`) type-check cleanly.

**Expected outcome**: Exit code 0, no TypeScript errors.

### Feature 4: Live delegation (Herdr required)

**Harness**: Manual `pions_delegate` call via Pi TUI

**Prerequisites**:

- Herdr running
- Pi installed and configured
- `npm run build` completed

**How to drive**:

```bash
# Inside a Pi session in Herdr:
# Use pions_delegate tool with a simple task
```

Example task: "Read CONTEXT.md and list three domain terms."

**What it proves**:

- Extension loads without errors
- Worker launches in a sibling Herdr pane
- Operation completes and returns a Result
- Pane closes automatically on success

**Expected outcome**:

- Operation succeeds
- Result includes operation ID and digest
- Success pane auto-closes

**Gotchas**:

- Requires Herdr — will fail with `HerdrPreconditionError` otherwise
- Fails if `npm run build` wasn't run first
- Task content stays out of process args (verify with `herdr pane process-info`)

**Cloud Agent limitation**: Most cloud VMs lack Herdr. If Herdr is unavailable, document that live delegation cannot be verified in this environment and rely on automated test coverage instead.

### Feature 5: Formal review fail-closed

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

1. **Create an artifacts directory**:

   ```bash
   mkdir -p /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)
   ```

2. **Save npm run check output**:

   ```bash
   npm run check > /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/npm-check-output.txt 2>&1
   ```

3. **Save build artifacts listing**:

   ```bash
   ls -laR dist/ > /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/dist-listing.txt
   ```

4. **If you ran live delegation** (Herdr available):
   - Note operation IDs returned by `pions_delegate`
   - Capture Herdr pane list: `herdr pane list > /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/herdr-panes.txt`

5. **Save environment info**:
   ```bash
   node --version > /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/env-info.txt
   npm list --depth=0 >> /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/env-info.txt
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
   ls /opt/cursor/artifacts/verify-pions-*
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
