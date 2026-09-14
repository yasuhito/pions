# Feature: Live Delegation (PRIMARY USER PATH)

**This is the primary user path for Pions.** Live delegation uses `pions_delegate` to spawn a real Pi worker in a Herdr pane, execute a task, and return a verified Result. Without proving this feature works, you have not verified Pions end-to-end.

## Sub-features

1. **Worker launch in Herdr pane** (sibling pane created without stealing focus)
2. **Task execution with Pi TUI** (visible, observable Pi "regular" TUI)
3. **Result acceptance and verification** (immutable UTF-8 artifact with SHA-256 digest)
4. **Pane auto-close on success** (Pions-owned success panes only, per AGENTS.md)
5. **Operation persistence and retrieval** (persisted Operation records in `~/.local/state/pions/`)

## Prerequisites (HARD REQUIREMENTS)

1. **Herdr is running and accessible**:

   ```bash
   herdr --version
   ```

   If this fails, **live delegation cannot be verified**. Stop here and document the block.

2. **Pi is installed and configured**:

   ```bash
   pi --version
   ```

   Expected: Pi 0.85.1+

3. **Pions is built** (CRITICAL — protocol version mismatch if skipped):

   ```bash
   npm run build
   ```

   Verify:

   ```bash
   ls -la dist/src/worker-extension.js
   ```

4. **Pi session is running inside Herdr** in the Pions project:

   - Start Herdr
   - Launch a Pi session in a Herdr pane (or use an existing one)
   - Confirm the working directory is the Pions repository root
   - Confirm Pions project is trusted (has `AGENTS.md`)

5. **No active conflicting sessions**: Check for other Pi panes in the same workspace:
   ```bash
   herdr pane list
   ```
   If a user is actively working in a Pi session in this workspace, **defer or use a separate test workspace** to avoid corrupting their session.

## How to get to it (user perspective)

A user working in a Pi session (inside Herdr) uses the `pions_delegate` tool to delegate a self-contained task.

Example user message:

```
Use pions_delegate to read CONTEXT.md and list three domain terms.
```

The model sees `pions_delegate` as a registered tool and calls it with the task text.

## Driving it with harness

### CRITICAL: Must run inside a Herdr pane

**The harness must execute inside a Herdr pane**, not from a bare shell. Pions workers require Herdr environment variables (`HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`) to create sibling panes.

**This will NOT work** (even if `herdr status` shows server running):

```bash
# From a normal shell outside Herdr:
pi --mode json -p 'Use pions_delegate to read package.json'
# Fails with: "Herdr environment is unavailable: HERDR_ENV, HERDR_WORKSPACE_ID..."
```

**These WILL work**:

1. **Interactive Pi session already running in a Herdr pane** (manual, for human verification)
2. **`herdr agent prompt <pane-id>`** (programmatic, for automated proof):

   ```bash
   herdr agent prompt wS9:p3 'Use pions_delegate to read package.json and return only the name field. Do nothing else.' --wait
   ```

### Prerequisites

1. **Herdr server is running**:

   ```bash
   herdr status
   ```

   Expected: "Herdr server running..."

2. **Herdr and Pi are on PATH**:

   ```bash
   herdr --version
   pi --version
   ```

3. **Pions is built** (CRITICAL — protocol version mismatch if skipped):

   ```bash
   cd ~/Work/pions  # or your Pions repo path
   npm run build
   ```

4. **A Pi session exists in a Herdr pane** (for `herdr agent prompt`), OR you will launch one interactively:
   ```bash
   herdr pane list
   # Look for a pane with Pi running, e.g., wS9:p3
   ```

### Exact steps (programmatic via `herdr agent prompt`)

1. **Identify the target pane**:

   ```bash
   herdr pane list
   ```

   Find a pane running Pi in the Pions workspace (e.g., `wS9:p3`).

2. **Send delegation command**:

   ```bash
   herdr agent prompt wS9:p3 'Use pions_delegate exactly once to read package.json and return only the name field value. Do nothing else.' --wait
   ```

   Replace `wS9:p3` with your actual pane ID.

3. **Observe the result**:

   The command waits for Pi to respond. You should see:

   - The package name (`pions`) in the output
   - Operation ID in the response

4. **Capture evidence**:

   ```bash
   mkdir -p /tmp/verify-pions-pane-$(date +%Y%m%d-%H%M%S)
   herdr pane read wS9:p3 > /tmp/verify-pions-pane-$(date +%Y%m%d-%H%M%S)/pane-after-delegation.txt
   herdr pane list > /tmp/verify-pions-pane-$(date +%Y%m%d-%H%M%S)/pane-list.txt
   ```

### Exact steps (interactive via Pi TUI in Herdr)

1. **Launch or attach to a Pi session in Herdr**:

   ```bash
   # If no Pi session exists:
   herdr run pi
   # Or attach to existing pane:
   herdr pane focus wS9:p3
   ```

2. **Verify you're in the Pions workspace**:

   ```bash
   # Inside Pi, check working directory
   pwd
   # Should be ~/Work/pions or similar
   ```

3. **Send a delegation message**:

   In the Pi session:

   ```
   Use pions_delegate to read CONTEXT.md and list three domain terms.
   ```

4. **Observe**:

   - Pi calls `pions_delegate` tool
   - A sibling Herdr pane opens (right or bottom)
   - The new pane shows Pi TUI with "regular" view
   - Worker executes the task
   - Result streams back to the parent Pi session
   - On success, the worker pane auto-closes

5. **Check the parent Pi response**:
   - Contains the result text (possibly truncated if > 2000 lines or 50 KB)
   - Includes operation ID (UUID)
   - Includes SHA-256 digest of accepted bytes

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
# Create evidence directory
EVIDENCE_DIR="/tmp/verify-pions-pane-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EVIDENCE_DIR"

# Capture pane state
herdr pane read <pane-id> > "$EVIDENCE_DIR/pane-after-delegation.txt"

# Capture pane list
herdr pane list > "$EVIDENCE_DIR/pane-list.txt"

# Check operation state (if accessible)
ls -la ~/.local/state/pions/ > "$EVIDENCE_DIR/operation-state.txt"
```

## Gotchas

### Herdr is REQUIRED

Without Herdr, `pions_delegate` fails immediately with `HerdrPreconditionError`. This is not a workaround-able limitation. **No Herdr = no live delegation proof.**

### Must build first

If you skip `npm run build` or build with an old protocol version, workers fail with:

```
Worker configuration version does not match
```

**Fix**: Run `npm run build` before delegating. This is especially critical after protocol version changes.

### Task content stays private

The task text is NOT in:

- Process arguments (visible via `ps` or `herdr pane process-info`)
- Herdr metadata (agent name, title)

It's passed via an owner-only private file referenced by the worker config.

**Verify**:

```bash
herdr pane process-info <worker-pane-id>
```

The `argv` should be `["pi"]`, not `["pi", "Read CONTEXT.md..."]`.

### Worker session is temporary

Workers use `--no-session`, so they don't save standard Pi sessions. This is intentional.

**Verify**:

```bash
ls ~/.pi/agent/sessions/
```

You won't see a session file matching the worker's Pi session ID.

### Pane auto-close applies to success only

**Success workers auto-close their panes.** Failed, cancelled, or unknown workers **leave panes open for debugging** (per AGENTS.md).

To test pane retention: Force a failure (e.g., delete the prompt file after worker launch but before `begin`).

### Result truncation

If the result exceeds 2000 lines or 50 KB, the parent sees a truncated version with a notice.

The full result is still persisted and retrievable via `pions_result`.

### Double-driving shared sessions

Pions delegates to **sibling panes**. If a user is actively working in a Pi session in the same workspace, launching delegation can corrupt their session state.

**Before delegating**:

1. Check `herdr pane list` for active Pi panes
2. If a user owns active Pi panes, **defer** or use a **separate test workspace**
3. Document the deferral if you cannot isolate

### No background execution

Workers are foreground operations. They block until complete or cancelled. Pions does not support background execution, chains, steering, or workflows.

### Cancellation

If you interrupt the parent Pi (e.g., press Escape during delegation), Pions cancels the worker.

Cancelled operations leave their panes open for debugging.

### State storage

Operation state lives in:

- `~/.local/state/pions/` (or `$XDG_STATE_HOME/pions/`)

Each repository is isolated by a digest of its canonical root.

### Unix domain sockets

Pions uses Unix domain sockets for worker protocol communication. These live in a short runtime directory (to avoid path length limits).

No TCP ports are opened.

### Cloud Agent limitation

**Most cloud VMs lack Herdr.** If you are running in a cloud environment and Herdr is unavailable:

- **You cannot prove live delegation.**
- Document: "Live delegation proof BLOCKED: Herdr unavailable."
- Automated test coverage (`npm run check`) does NOT substitute for this proof.
- The skill is only partially verified.

## For machines with Herdr (gmktec: Node v26.8.1, /home/yasuhito/.local/bin/herdr)

If you are executing this skill on a machine with Herdr and Pi (e.g., user's gmktec with Node v26.8.1, Herdr at `/home/yasuhito/.local/bin/herdr`, Pi 0.85.1):

1. Follow the exact steps above.
2. Capture all success observables (Operation ID, digest, pane evidence).
3. Save evidence to the skill's evidence directory:
   ```bash
   EVIDENCE_DIR="${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-live-delegation-$(date +%Y%m%d-%H%M%S)}"
   mkdir -p "$EVIDENCE_DIR"
   ```
4. Include evidence paths in your proof summary.
5. Update PR or proof document with: "Live delegation proof COMPLETED on gmktec with Herdr."
