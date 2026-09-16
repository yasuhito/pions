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

1. **Check working directory**: Ensure you're in the Pions repository root (`yasuhito/pions`). **Daily live smoke runs on the Grok Bot box** (pions eng's machine): `/home/box/Work/pions` or `$HOME/Work/pions` there. Cloud Agent may use `/workspace` for automated checks only — not for daily Herdr smoke.

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

   Expected: **v26+** (matches CI `.github/workflows/check.yml` `node-version: 26`). Node 22 is insufficient for the full `npm run check` test suite — many tests fail with `Promise resolution is still pending but the event loop has already resolved` (especially visible-worker). Use Node 26+ for automated checks.

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

3. **Check Pi LLM auth on the machine running the `verify-pions` Herdr session** (CRITICAL for live delegation):

   Live delegation requires a working Pi LLM login or provider credentials on the **same machine** that runs the `verify-pions` Herdr session. Without auth, the parent Pi in the pane cannot call tools (including `pions_delegate`).

   ```bash
   # Empty or missing auth means live delegation is blocked
   test -s ~/.pi/agent/auth.json && echo "auth.json present" || echo "auth.json empty or missing"
   ```

   If not logged in, run `pi` and use `/login`, or configure provider API keys for the models Pi will use. In the Pi TUI you may see: `Not logged in · Please run /login`.

**If Herdr or Pi is missing** (typical on Cloud Agent VMs):

- **USER-PATH VERIFICATION IS BLOCKED**. You cannot prove visible delegation works.
- **Do NOT fall back** to Yasuhito's default Herdr session, gmktec, firstmate workspaces, or any personal pane on another host.
- Automated tests (`npm run check`, build verification) may still run as partial regression gates, but they do NOT substitute for proving the real user experience.
- Document clearly in your proof output: "Live delegation proof BLOCKED: Herdr unavailable. Automated checks only."
- Do NOT claim end-to-end verification succeeded.

**If Herdr and Pi are present but Pi LLM auth is missing** on the box running `verify-pions`:

- Mark live delegation **BLOCKED / verified-unreachable** with prerequisite: Pi LLM login or provider credentials required.
- Document: "Live delegation proof BLOCKED: Pi not logged in (run `/login` or configure provider keys). Automated checks only."
- **Do NOT** fall back to gmktec, Yasuhito's default Herdr session, or any other host to work around missing auth.

**If Herdr and Pi are present with working Pi auth:**

- Proving ONE live-delegation feature (see `features/live-delegation.md`) is **REQUIRED** before claiming end-to-end success.
- Use the **dedicated named Herdr session** `verify-pions` on the **Grok Bot box** only (see Isolation below). Never smoke or maintain on gmktec, Yasuhito's default session, or captain personal panes.

### Isolation: dedicated `verify-pions` Herdr session on the Grok Bot box

Daily live smoke and maintain run on **the Grok Bot box** (pions eng's machine), **not** on gmktec or Yasuhito's personal/default Herdr.

**Forbidden as daily smoke hosts:**

- gmktec (do not use for daily smoke)
- Yasuhito's default Herdr session, firstmate workspaces, captain personal panes

**Stack:**

| Item          | Value                                                   |
| ------------- | ------------------------------------------------------- |
| Primary host  | Grok Bot box (pions eng's machine)                      |
| Repo          | `yasuhito/pions`                                        |
| Checkout      | `/home/box/Work/pions` or `$HOME/Work/pions` on the box |
| Herdr session | Named session `verify-pions` only                       |
| CLI prefix    | Every Herdr command: `herdr --session verify-pions …`   |

**Start the dedicated server** (headless) if the `verify-pions` session is not running:

```bash
herdr server --session verify-pions
```

Run in background or a supervisor if needed on the box. **Do NOT** stop or restart Yasuhito's default Herdr server (on gmktec or elsewhere).

**Workflow summary** (details in `features/live-delegation.md`):

1. Ensure `verify-pions` session server is up (`herdr --session verify-pions status server`).
2. Create a workspace + pane with `cwd` = Pions checkout (`herdr --session verify-pions workspace create --cwd "$PIONS_ROOT" …`).
3. Start Pi in that pane: `herdr --session verify-pions agent start <name> --kind pi --pane <pane-id>`.
4. Drive proof: `herdr --session verify-pions agent prompt <pane-id> '…' --wait`.
5. **Cleanup**: close workspaces/panes **you created** in `verify-pions`. Leave Yasuhito's default session untouched.

On the Grok Bot box:

```bash
export PIONS_ROOT="${PIONS_ROOT:-$HOME/Work/pions}"   # typically /home/box/Work/pions
```

## Drive

Execute Pions features to prove they work.

**Primary user path**: Live delegation via `pions_delegate` in Herdr (see Feature 1 below). This is the real user experience.

**Regression gates**: Automated test suite, build verification, type checking. These prove code quality but do NOT prove visible delegation works.

### Feature 1: Live delegation (PRIMARY USER PATH — Herdr required)

**CRITICAL**: Must run **inside a Herdr pane** in the dedicated `verify-pions` session. Bare `pi --mode json` from a normal shell fails with "Herdr environment is unavailable" even if a default Herdr server is running elsewhere.

**NEVER** run daily smoke on gmktec, Yasuhito's default Herdr session, firstmate workspaces, or pre-existing personal panes.

**Harness** (programmatic, in `verify-pions` session only):

1. Create workspace + pane with `cwd` = Pions checkout
2. `herdr --session verify-pions agent start <name> --kind pi --pane <pane-id>`
3. `herdr --session verify-pions agent prompt <pane-id> 'Use pions_delegate exactly once to read package.json and return only the name field value. Do nothing else.' --wait`

Replace `<pane-id>` with the pane ID from your `verify-pions` workspace on the box (from `workspace create` or `pane list`). Do not reuse pane IDs from gmktec or Yasuhito's sessions.

**See `features/live-delegation.md` for detailed steps, exact commands, success observables, and evidence capture.**

**If Herdr is unavailable** (e.g. Cloud VM), you CANNOT prove this feature. Mark live **BLOCKED**; do not fall back to gmktec or Yasuhito Herdr. Proceed to Feature 2 (automated checks) as a partial gate only.

**If Pi LLM auth is missing** on the `verify-pions` session host (empty `~/.pi/agent/auth.json`, no provider keys, parent Pi shows `Not logged in · Please run /login`), mark live **BLOCKED / verified-unreachable**. Do NOT fall back to gmktec or another host.

### Feature 2: Automated test suite (regression gate, not user-path proof)

**Harness**: `npm run check` only (no `npm run build` prerequisite)

**How to drive**:

```bash
npm run check
```

**What it proves**: Code quality, type safety, lint rules, formatting compliance, test assertion rules, and full test coverage. Does NOT prove visible delegation works.

The `check` script runs:

- `typecheck` — TypeScript type validation
- `lint` — ESLint validation
- `format:check` — Prettier formatting check
- `check:test-assertions` — One-behavior-one-assertion rule validation
- `test` — Full node:test suite (via `build:test` → `.test-dist/`)

**Expected outcome**: Exit code 0, all checks pass, all tests pass.

**Runtime requirement**: Node **26+** (matches CI). Node 22 produces widespread false failures in the full test suite.

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

**Gotchas**:

- The `dist/` directory is gitignored. Always rebuild after pulling changes.
- Worker protocol version mismatches happen if you forget to rebuild after protocol changes (`WORKER_PROTOCOL_VERSION` in source vs stale `dist/`).

**See `features/build-and-extension.md` for detailed steps and gotchas.**

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

1. **Create a portable evidence directory** (any writable path; `/tmp/verify-pions-…` is fine):

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

4. **If you ran live delegation** (Herdr available, `verify-pions` session):
   - Note operation IDs returned by `pions_delegate`
   - Capture Herdr pane list: `herdr --session verify-pions pane list > "$EVIDENCE_DIR/herdr-panes.txt"`

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

3. **Tear down verify-pions session resources** (only if live delegation ran):
   - Close workspaces/panes **you created** in `verify-pions`: `herdr --session verify-pions workspace close <id>` (or `pane close` as appropriate)
   - **Do NOT** run `herdr server stop` on Yasuhito's default session (e.g. on gmktec)
   - Pions state lives in `~/.local/state/pions/` (or `$XDG_STATE_HOME/pions/`); leave it alone unless operations are corrupted

4. **Verify evidence remains**:

   ```bash
   if [ -n "${VERIFY_PIONS_EVIDENCE_DIR:-}" ]; then
     ls -la -- "$VERIFY_PIONS_EVIDENCE_DIR"
   else
     shopt -s nullglob
     evidence_dirs=(/tmp/verify-pions-*)
     printf '%s\n' "${evidence_dirs[@]}"
   fi
   ```

   Evidence should still exist after cleanup. The fallback branch lists every
   `/tmp/verify-pions-*` entry (including names with spaces) and, thanks to
   `nullglob`, prints only an empty line without erroring when none exist. A
   quoted `"${VAR:-/tmp/verify-pions-*}"` fallback would not glob-expand, so do
   not use it.

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

if [ -s "${HOME}/.pi/agent/auth.json" ]; then
  echo "Pi auth: auth.json present"
else
  echo "Pi auth: NOT CONFIGURED (run pi /login or set provider keys — live delegation will fail)"
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
