# Feature: Live Delegation (PRIMARY USER PATH)

**This is the primary user path for Pions.** Live delegation uses `pions_delegate` to spawn a real Pi worker in a Herdr pane, execute a task, and return a verified Result. Without proving this feature works, you have not verified Pions end-to-end.

## Sub-features

1. **Worker launch in Herdr pane** (sibling pane created without stealing focus)
2. **Task execution with Pi TUI** (visible, observable Pi "regular" TUI)
3. **Result acceptance and verification** (immutable UTF-8 artifact with SHA-256 digest)
4. **Pane auto-close on success** (Pions-owned success panes only, per AGENTS.md)
5. **Operation persistence and retrieval** (persisted Operation records in `~/.local/state/pions/`)

## Dedicated Herdr session (REQUIRED — never captain default)

**Standing instruction:** daily smoke and maintain must **never** drive Yasuhito's personal/default Herdr session, firstmate workspaces, or captain personal panes.

| Item | Value |
| --- | --- |
| Repo | `yasuhito/pions` |
| Checkout | `~/Work/pions` on gmktec; repo root elsewhere (e.g. `/workspace` on Cloud Agent) |
| Herdr session | Named session `verify-pions` only |
| CLI | **Every** Herdr command uses `herdr --session verify-pions …` |

Set once per shell:

```bash
export PIONS_ROOT="${PIONS_ROOT:-$HOME/Work/pions}"   # adjust for host
export HERDR="herdr --session verify-pions"
```

### Start dedicated server (if not running)

```bash
# Headless server for verify-pions only — do NOT touch default session
if ! $HERDR status server &>/dev/null; then
  herdr server --session verify-pions &
  sleep 2   # allow socket to come up
fi
```

**Do NOT** stop, restart, or attach to captain's default Herdr server.

### Cloud Agent / Herdr absent

If `command -v herdr` fails (typical Cloud VM):

- Mark live delegation **BLOCKED**
- Document: "Live delegation proof BLOCKED: Herdr unavailable. Automated checks only."
- **Do NOT** fall back to captain Herdr on another machine or session
- Automated `npm run check` does NOT substitute for this proof

## Prerequisites (HARD REQUIREMENTS)

1. **Herdr is on PATH** (local machine with Herdr installed):

   ```bash
   command -v herdr && herdr --version
   ```

   If missing, **live delegation cannot be verified**. Stop here and document the block.

2. **Pi is installed**:

   ```bash
   pi --version
   ```

   Expected: Pi 0.85.1+

3. **Pions is built** (CRITICAL — protocol version mismatch if skipped):

   ```bash
   cd "$PIONS_ROOT"
   npm run build
   ls -la dist/src/worker-extension.js
   ```

4. **Dedicated `verify-pions` session server is running** (see above).

5. **Isolated workspace + Pi pane** in `verify-pions` with `cwd` = Pions checkout — created by you for this proof, not borrowed from captain/firstmate.

## How to get to it (user perspective)

A user working in a Pi session (inside Herdr) uses the `pions_delegate` tool to delegate a self-contained task.

Example user message:

```
Use pions_delegate to read CONTEXT.md and list three domain terms.
```

The model sees `pions_delegate` as a registered tool and calls it with the task text.

## Driving it with harness

### CRITICAL: Must run inside a Herdr pane (verify-pions session)

**The harness must execute inside a Herdr pane** in the `verify-pions` session, not from a bare shell. Pions workers require Herdr environment variables (`HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`) to create sibling panes.

**This will NOT work** (even if a default Herdr server is running):

```bash
# From a normal shell outside Herdr:
pi --mode json -p 'Use pions_delegate to read package.json'
# Fails with: "Herdr environment is unavailable: HERDR_ENV, HERDR_WORKSPACE_ID..."
```

**This WILL work** (programmatic proof in `verify-pions`):

1. Create workspace + root pane with Pions `cwd`
2. `herdr --session verify-pions agent start … --kind pi --pane <pane-id>`
3. `herdr --session verify-pions agent prompt <pane-id> '…' --wait`

### Exact steps (programmatic — verify-pions session)

1. **Ensure dedicated server is up**:

   ```bash
   $HERDR status server
   ```

   Expected: server running for session `verify-pions`.

2. **Create an isolated workspace** (cwd = Pions checkout):

   ```bash
   created=$($HERDR workspace create --cwd "$PIONS_ROOT" --label verify-pions-smoke --no-focus)
   pane_id=$(printf '%s\n' "$created" | jq -r '.result.root_pane.pane_id')
   workspace_id=$(printf '%s\n' "$created" | jq -r '.result.workspace.workspace_id')
   ```

   Record `pane_id` and `workspace_id` for cleanup. Do not reuse captain or firstmate workspace IDs.

3. **Start Pi in the pane**:

   ```bash
   $HERDR agent start verify-smoke --kind pi --pane "$pane_id"
   ```

   The pane must be at an interactive shell prompt before `agent start`. Agent names must match `[a-z][a-z0-9_-]{0,31}`.

4. **Send delegation command**:

   ```bash
   $HERDR agent prompt "$pane_id" \
     'Use pions_delegate exactly once to read package.json and return only the name field value. Do nothing else.' \
     --wait
   ```

5. **Observe the result**:

   - Package name (`pions`) in the output
   - Operation ID (UUID) in the response

6. **Capture evidence** (portable paths):

   ```bash
   EVIDENCE_DIR="${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-live-delegation-$(date +%Y%m%d-%H%M%S)}"
   mkdir -p "$EVIDENCE_DIR"
   $HERDR pane read "$pane_id" > "$EVIDENCE_DIR/pane-after-delegation.txt"
   $HERDR pane list > "$EVIDENCE_DIR/pane-list.txt"
   ```

7. **Cleanup** (resources you created in `verify-pions` only):

   ```bash
   $HERDR workspace close "$workspace_id"
   # Or close individual panes if you split layout
   ```

   **Do NOT** run `herdr server stop` (default) or stop captain's Herdr server.

### Exact steps (interactive via Pi TUI — verify-pions session)

Use only when debugging; prefer programmatic steps above for smoke/maintain.

1. **Attach to verify-pions session** (interactive terminal on gmktec):

   ```bash
   herdr --session verify-pions
   ```

2. **Create workspace at Pions root** (or use one you created for verify):

   ```bash
   herdr --session verify-pions workspace create --cwd "$PIONS_ROOT" --label verify-pions-smoke
   ```

3. **Start Pi in the root pane**, then send a delegation message in the Pi TUI:

   ```
   Use pions_delegate to read CONTEXT.md and list three domain terms.
   ```

4. **Observe**:

   - Pi calls `pions_delegate` tool
   - A sibling Herdr pane opens (right or bottom)
   - Worker executes; result streams back
   - On success, the worker pane auto-closes

5. **Close the verify workspace when done** — do not leave smoke panes in captain's default session.

### Expected outcome

- Operation succeeds
- Result returned to parent
- Worker pane closes automatically (success only)
- Operation ID and digest logged

Example output:

```
Operation: 1ccfa7a5-f41b-42d1-a9fc-f84e31da02bc
Digest: sha256:abc123...
Result: pions
```

### Evidence capture

```bash
EVIDENCE_DIR="${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-live-delegation-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$EVIDENCE_DIR"

$HERDR pane read <pane-id> > "$EVIDENCE_DIR/pane-after-delegation.txt"
$HERDR pane list > "$EVIDENCE_DIR/pane-list.txt"
ls -la ~/.local/state/pions/ > "$EVIDENCE_DIR/operation-state.txt" 2>/dev/null || true
```

## Gotchas

### Herdr is REQUIRED

Without Herdr, `pions_delegate` fails immediately with `HerdrPreconditionError`. **No Herdr = no live delegation proof.** Do not substitute captain's session from another context.

### Never use default / captain / firstmate session

- **NEVER** `herdr pane list` (no `--session`) and pick an existing captain pane
- **NEVER** smoke in firstmate workspaces or personal panes (`wS9:p*` or any pre-existing ID)
- **ALWAYS** `--session verify-pions` and create your own workspace

### Must build first

If you skip `npm run build` or build with an old protocol version, workers fail with:

```
Worker configuration version does not match
```

**Fix**: Run `npm run build` in `$PIONS_ROOT` before delegating.

### Task content stays private

The task text is NOT in:

- Process arguments (visible via `ps` or `herdr pane process-info`)
- Herdr metadata (agent name, title)

It's passed via an owner-only private file referenced by the worker config.

**Verify** (in `verify-pions` session):

```bash
$HERDR pane process-info <worker-pane-id>
```

The `argv` is the Herdr/Pi worker launch line, not the task string. A real launch looks like:

```
herdr agent start pions-<id> --kind pi --pane <pane> --timeout <ms> -- \
  --provider <provider> --model <model> --thinking <level> --tools <tools> \
  --no-session --tui-mode regular --no-extensions --extension <path> \
  --no-skills --no-prompt-templates --no-themes --approve \
  --pions-worker-config <config-path>
```

(See `src/internal/visible-worker.ts`.) Do **not** expect `["pi"]` alone, and do **not** expect the task text on argv.

### Worker session is temporary

Workers use `--no-session`, so they don't save standard Pi sessions. This is intentional.

### Pane auto-close applies to success only

**Success workers auto-close their panes.** Failed, cancelled, or unknown workers **leave panes open for debugging** (per AGENTS.md).

### Result truncation

If the result exceeds 2000 lines or 50 KB, the parent sees a truncated version with a notice. Full result is still persisted and retrievable via `pions_result`.

### No background execution

Workers are foreground operations. They block until complete or cancelled.

### Cancellation

If you interrupt the parent Pi, Pions cancels the worker. Cancelled operations leave their panes open for debugging.

### State storage

Operation state lives in `~/.local/state/pions/` (or `$XDG_STATE_HOME/pions/`). Each repository is isolated by a digest of its canonical root.

### Cloud Agent limitation

**Most cloud VMs lack Herdr.** If Herdr is unavailable:

- **You cannot prove live delegation.**
- Document: "Live delegation proof BLOCKED: Herdr unavailable."
- **Do NOT** fall back to captain Herdr.
- Automated test coverage (`npm run check`) does NOT substitute for this proof.

## For machines with Herdr (gmktec)

When executing on gmktec (Node v26+, Herdr 0.8.2+, Pi 0.85.1+):

1. Use **only** the `verify-pions` session workflow above.
2. Set `PIONS_ROOT=~/Work/pions`.
3. Capture all success observables (Operation ID, digest, pane evidence).
4. Save evidence to a portable writable directory (`$VERIFY_PIONS_EVIDENCE_DIR` or `/tmp/verify-pions-…`).
5. Close verify workspaces/panes you created; leave captain's default server running.
6. Report: "Live delegation proof COMPLETED in verify-pions session on gmktec."
