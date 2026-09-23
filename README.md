# Pions

**Pions is a durable, verifiable runtime for visible Pi workers.**

Most subagent extensions focus on starting a child session and returning its answer. Pions treats delegation as a persistent `Operation` with lifecycle evidence and an integrity-verified `Result`.

Each worker runs as a real Pi TUI in its own Herdr workspace. The workspace is for humans to observe—not a source of truth. Pions determines completion from persisted protocol records rather than terminal text, process appearance, or workspace state.

## Why Pions?

Pi includes a useful [subagent extension example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent), and [`pi-subagents`](https://github.com/nicobailon/pi-subagents) provides a broad orchestration platform with built-in agents, foreground and background runs, parallelism, chains, steering, workflows, worktrees, and rich observability.

Pions optimizes for a different question:

> What facts must be persisted before delegation can be considered started, accepted, stopped, and complete?

That leads to a deliberately narrower system focused on trustworthy lifecycle boundaries rather than feature breadth.

## What makes it different

### Delegation is a persistent Operation

Every delegation creates a uniquely identified `Operation`. Its persisted record includes:

- lifecycle state and version;
- worker process and Pi session identity;
- requested, effective, and observed configuration;
- start instruction acceptance and delivery evidence;
- result acceptance evidence;
- worker stop confirmation;
- bounded execution evidence; and
- presentation cleanup diagnostics.

Losing the original handle does not lose an operation stored in the current event format. A reopened runtime can reconstruct it from its identifier.

### Results are immutable, verified byte sequences

A worker answer is not merely a string returned by a tool call. Its `Operation` directly owns the immutable UTF-8 bytes together with their byte length, SHA-256 digest, and result-acceptance identifier. Pions has no generic artifact store: it does not ingest attachments, binary outputs, work products, or dependency closures.

Files changed by a worker remain in the shared working directory. Pions does not copy those changes into its persistent state.

Retrieval verifies the complete stored result before returning any content. It distinguishes:

- a result that has not been accepted;
- corrupted storage;
- revoked retrieval authority; and
- storage that cannot currently be inspected.

Large results can be retrieved in UTF-8-safe chunks using an opaque cursor. The same accepted bytes remain retrievable after the Pi session or runtime restarts.

By contrast, `pi-subagents` documents its async completion replay records as best-effort temporary state rather than a permanent run ledger. Pions makes retrieval of the accepted byte sequence part of the public runtime contract.

### Completion requires result acceptance and worker stop

A worker producing its own answer is **self-settlement**. It is not necessarily **terminal completion**.

An operation reaches terminal completion when its result has been durably accepted and its worker has been confirmed stopped. Worker settlement alone does not establish either fact.

### Uncertainty remains explicit

A missing process or workspace is not proof that a worker stopped safely.

Pions identifies worker process instances with start tokens and records stop evidence. If cancellation or liveness cannot be proven, the operation remains `unknown` instead of being guessed into success or cancellation.

### Acceptance and correctness are separate

Result acceptance means that the exact worker answer has been verified and durably stored. It does not claim that the answer is correct or suitable for use.

An accepted result is never automatically deleted. It remains available until the user explicitly removes Pions' state storage.

### Workers are visible, but the UI is not authoritative

Pions starts each worker as an actual `pi` CLI in a dedicated Herdr workspace labelled `Pions <short operation id>`, created without moving focus or splitting the caller's pane. Humans can pick it from Herdr's workspace list and inspect the normal Pi TUI directly; Pions does not simulate it. A successful or stop-confirmed cancelled worker closes its own workspace; failed or unknown workers leave it open for investigation.

Semantic completion still comes exclusively from the authenticated worker protocol and persistent runtime state. Terminal rendering is evidence for an observer, not a lifecycle database.

### Task content stays out of process arguments

The Pi subagent example passes delegated task text as a child-process argument. Pions writes task content and worker configuration to owner-only private files and passes references instead.

Worker lifecycle and result frames travel over a local Unix-domain socket authenticated with an operation-specific capability. A result acknowledgement is sent only after durable acceptance.

The worker protocol and private files do not provide an OS sandbox.

## Pi tools

The Pi extension installs exactly three tools in trusted projects: `pions_delegate`, `pions_result`, and `pions_operation`.

Recovery reads only records in the current event format; older records are rejected.

### `pions_delegate`

Delegates one self-contained task to a general-purpose worker with an independent context and waits until its result is durably accepted.

```text
Use pions_delegate to investigate the lifecycle boundary in this change.
```

The tool input is only `task`. The model cannot choose the worker model, thinking level, tools, working directory, persistence policy, presentation policy, or cancellation policy through the tool input. Every successful response returns the accepted final answer together with the `Operation` identifier, whether or not the displayed result was truncated.

The worker has `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`; it does not have `pions_delegate`, so delegation is one level deep. It runs in the same working directory as the delegating session and edits it directly: Pions creates no worktree or branch and does not merge changes. Failed delegations are never retried automatically; the parent starts a new `Operation` explicitly if needed.

Independent delegations compose through Pi's normal parallel tool execution. Not running conflicting write delegations in parallel is the parent's responsibility.

### `pions_result`

Retrieves an accepted result by `Operation` identifier.

```text
operationId: <operation-id>
```

If another chunk is available, pass the returned cursor to the next call. Each chunk reports the immutable result-acceptance identifier and the SHA-256 digest of the exact accepted bytes, so callers can bind retrieved content to the acceptance reported by operation inspection. The tool does not expose storage paths or allow callers to select chunk sizes. It only reads operations belonging to the current trusted repository.

### `pions_operation`

Returns the persisted state and diagnostics of an `Operation` without reading result bytes.

```text
operationId: <operation-id>
```

### Worker model configuration

A trusted repository pins the worker model and thinking level in `.pions.json`. Only top-level `model` and `thinkingLevel` are accepted; the former `review` block is rejected.

```json
{
  "model": { "provider": "anthropic", "id": "claude-opus-5" },
  "thinkingLevel": "high"
}
```

Pions bundles no model provider and loads none automatically. Installing and authenticating the configured provider is the Pi environment's responsibility. Workers start without extension discovery, so a provider that exists only because a Pi extension registered it in the delegating session is rejected with a configuration error before any worker starts; Pions never falls back to another model.

## Pions and pi-subagents

Pions is not a drop-in replacement for `pi-subagents`. They prioritize different jobs.

|                        | Pions                                                    | `pi-subagents`                                                   |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| Primary goal           | Durable, verifiable delegation                           | Flexible, feature-rich orchestration                             |
| Worker UI              | Real Pi TUI in a dedicated Herdr workspace               | Foreground views, FleetView, and inspectors                      |
| Result model           | Operation-owned, integrity-verified immutable UTF-8 text | Run results, notifications, replay records, and output archives  |
| Completion model       | Requires result acceptance and confirmed worker stop     | Supports foreground, detached, background, and nested async runs |
| Agent definitions      | One general-purpose worker profile                       | Built-in and custom agents                                       |
| Parallelism and chains | Composed through Pi tool calls                           | Built into the extension                                         |
| Background execution   | Not supported                                            | Supported                                                        |
| Steering               | Not supported                                            | Supported                                                        |
| Herdr                  | Required                                                 | Optional                                                         |

Choose `pi-subagents` when you want broad orchestration, configurable roles, background work, chains, steering, or packaged workflows.

Choose Pions when the important boundary is a persistent operation whose accepted output, lifecycle, and stop evidence can be inspected after the original call is gone.

## Current limitations

Pions is under active development.

- Herdr is required; Pions does not fall back to headless execution.
- The Pi extension exposes one general-purpose worker profile; custom agent definitions are not supported.
- Workers run without extension discovery, so only providers available to a plain Pi worker can be configured.
- Background execution, chains, and mid-run steering are not supported.
- Pions is not yet published as an installable npm package.
- APIs, persistence formats, configuration, and installation may change without compatibility paths.

## Development

```bash
npm install
npm run build
npm run check
```

`npm run check` runs type checking, linting, formatting checks, test-assertion validation, and the full test suite.

## Design documentation

The domain vocabulary lives in [`CONTEXT.md`](CONTEXT.md). Hard-to-reverse decisions are recorded in [`docs/adr/`](docs/adr/).

Start with:

- [Use an authenticated local worker protocol](docs/adr/0002-use-an-authenticated-local-worker-protocol.md)
- [Delegate operations through a Pi extension](docs/adr/0004-use-a-pi-extension-for-operation-delegation.md)
- [Use the Pi CLI for visible workers](docs/adr/0005-use-pi-cli-for-visible-workers.md)
- [Store results as Operation-owned UTF-8 text](docs/adr/0027-store-results-as-operation-owned-utf8-text.md)
- [Remove generic artifact management](docs/adr/0028-remove-generic-artifact-management.md)
- [Use Pi tools as the result retrieval boundary](docs/adr/0013-use-pi-tools-as-the-result-retrieval-boundary.md)

The source comparison behind this README is documented in [`docs/research/pions-vs-pi-subagents.md`](docs/research/pions-vs-pi-subagents.md).
