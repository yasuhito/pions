# Feature: Live Delegation

Live delegation uses `pions_delegate` to spawn a real Pi worker in a Herdr pane, execute a task, and return a verified Result.

## Sub-features

1. **Worker launch in Herdr pane**
2. **Task execution with Pi TUI**
3. **Result acceptance and verification**
4. **Pane auto-close on success**
5. **Operation persistence and retrieval**

## How to get to it (user perspective)

A user working in a Pi session (inside Herdr) uses the `pions_delegate` tool to delegate a self-contained task.

Example:

```
Use pions_delegate to read CONTEXT.md and summarize the top three domain terms.
```

The model sees `pions_delegate` as a registered tool and calls it with the task text.

## Driving it with harness

### Prerequisites

1. **Herdr is running**:

   ```bash
   herdr --version
   ```

   If this fails, Herdr is unavailable. Live delegation will fail with `HerdrPreconditionError`.

2. **Pi is installed and configured**:

   ```bash
   pi --version
   ```

3. **Pions is built**:

   ```bash
   npm run build
   ```

4. **Pi session is running inside Herdr**:
   - Start Herdr
   - Launch a Pi session in a Herdr pane
   - Confirm Pions project is trusted (has `AGENTS.md`)

### Exact steps

1. Open a Pi session in Herdr (or use an existing one).

2. Send a message that will trigger `pions_delegate`:

   ```
   Use pions_delegate to read CONTEXT.md and list three domain terms.
   ```

3. Observe:
   - Pi calls `pions_delegate` tool
   - A sibling Herdr pane opens (right or bottom, depending on available space)
   - The new pane shows Pi TUI with "regular" view
   - Worker receives the task and executes it
   - Result streams back to the parent Pi session
   - On success, the worker pane auto-closes

4. Check the parent Pi response:
   - Contains the result text (possibly truncated if > 2000 lines or 50 KB)
   - Includes operation ID (UUID)
   - Includes SHA-256 digest of accepted bytes

### Expected outcome

- Operation succeeds
- Result returned to parent
- Worker pane closes automatically
- Operation ID and digest logged

Example:

```
Operation: a1b2c3d4-e5f6-7890-abcd-ef1234567890
Digest: sha256:abc123...
Result:
1. Operation — A persistent request...
2. Worker — An execution entity...
3. Result — Accepted immutable output...
```

### Evidence capture

From the parent Pi session:

- Note the operation ID
- Check `~/.local/state/pions/` for operation records

From Herdr:

```bash
herdr pane list > /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/herdr-panes.txt
```

If the worker pane is still open (it closes quickly on success), you can inspect it:

```bash
herdr pane read <pane-id> > /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/worker-tui.txt
```

## Gotchas

### Herdr required

Without Herdr, `pions_delegate` fails immediately with `HerdrPreconditionError`.

**Cloud VM limitation**: Most cloud VMs do not have Herdr installed or running. This is expected. Document the limitation and rely on automated tests instead.

### Must build first

If you skip `npm run build` or build with an old protocol version, workers fail with:

```
Worker configuration version does not match
```

**Fix**: Run `npm run build` before delegating.

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

### Pane auto-close

Success workers auto-close their panes. Failed, cancelled, or unknown workers leave panes open for debugging.

**To test pane retention**: Force a failure (e.g., delete the prompt file after worker launch but before `begin`).

### Result truncation

If the result exceeds 2000 lines or 50 KB, the parent sees a truncated version with a notice.

The full result is still persisted and retrievable via `pions_result`.

### Multiple delegations compose

You can delegate multiple independent tasks in parallel. Pi calls `pions_delegate` multiple times, and Pions launches multiple workers.

Example:

```
Use pions_delegate to review docs/adr/0001. Also use pions_delegate to review docs/adr/0002.
```

Two workers launch in parallel.

### Model selection

Workers inherit the parent's model and thinking level unless overridden in `.pions.json`.

Check observed model in operation events:

```bash
# (Requires operation inspection tooling or log review)
```

### No background execution

Workers are foreground operations. They block until complete or cancelled. Pions does not support background execution.

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

### No steering, chains, or workflows

Pions supports one-shot delegations only. No mid-run steering, chains, or workflows.

For those features, see `pi-subagents`.
