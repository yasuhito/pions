# Pions

**Pions is a durable, verifiable runtime for visible Pi workers.**

Most subagent extensions focus on starting a child session and returning its answer. Pions treats delegation as a persistent `Operation` with lifecycle evidence and an integrity-verified `Result`.

Each worker runs as a real Pi TUI in a Herdr pane. The pane is for humans to observe—not a source of truth. Pions determines completion from persisted protocol records rather than terminal text, process appearance, or pane state.

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
- start authorization and delivery evidence;
- result acceptance evidence;
- worker stop confirmation;
- bounded execution evidence; and
- presentation cleanup diagnostics.

Losing the original handle does not lose the operation. A reopened runtime can reconstruct it from its identifier.

### Results are immutable, verified byte sequences

A worker answer is not merely a string returned by a tool call. Pions stores it as an immutable UTF-8 artifact and records its byte length and SHA-256 digest.

Retrieval verifies the complete stored artifact before returning any content. It distinguishes:

- a result that has not been accepted;
- corrupted storage;
- policy-driven deletion;
- revoked retrieval authority; and
- storage that cannot currently be inspected.

Large results can be retrieved in UTF-8-safe chunks using an opaque cursor. The same accepted bytes remain retrievable after the Pi session or runtime restarts.

By contrast, `pi-subagents` documents its async completion replay records as best-effort temporary state rather than a permanent run ledger. Pions makes retrieval of the accepted byte sequence part of the public runtime contract.

### Worker settlement is not tree completion

A worker producing its own answer is **self-settlement**. It is not necessarily **terminal completion**.

An operation reaches terminal completion only after its own result and all required descendant settlement and result-delivery obligations are resolved. This prevents a parent answer from silently standing in for completion of the whole operation tree.

### Uncertainty remains explicit

A missing process or pane is not proof that a worker stopped safely.

Pions identifies worker process instances with start tokens and records stop evidence. If cancellation or liveness cannot be proven, the operation remains `unknown` instead of being guessed into success or cancellation.

### Acceptance, adoption, and retention are separate

Pions separates several facts that are easy to conflate:

- **Result acceptance**: the exact bytes were verified and durably accepted.
- **Artifact acceptance**: a coordinator chose to adopt the artifact.
- **Retention**: the bytes must remain protected from deletion.
- **Revision**: a new operation was requested against an accepted result.

Persisting a result does not claim that the result is correct. Revising it does not rewrite the original operation or result.

### Workers are visible, but the UI is not authoritative

Pions starts each worker as an actual `pi` CLI in a sibling Herdr pane. Humans can inspect the normal Pi TUI directly; Pions does not simulate it.

Semantic completion still comes exclusively from the authenticated worker protocol and persistent runtime state. Terminal rendering is evidence for an observer, not a lifecycle database.

### Task content stays out of process arguments

The Pi subagent example passes delegated task text as a child-process argument. Pions writes task content and worker configuration to owner-only private files and passes references instead.

Worker lifecycle and result frames travel over a local Unix-domain socket authenticated with an operation-specific capability. A result acknowledgement is sent only after durable acceptance.

This is careful process plumbing, not an OS sandbox. Permission manifests describe intended access; they do not by themselves provide container or kernel isolation.

## Pi tools

Pions installs delegation, result retrieval, operation inspection, and formal-review tools in trusted projects. Formal-review tools remain visible but fail closed unless trusted host configuration enables them.

### `pions_delegate`

Delegates one self-contained task to a read-oriented worker with an independent context.

```text
Use pions_delegate to investigate the lifecycle boundary in this change.
```

The model cannot choose the worker model, thinking level, tools, working directory, persistence policy, presentation policy, or cancellation policy through the tool input. Every successful response includes the `Operation` identifier, whether or not the displayed result was truncated.

Independent delegations compose through Pi's normal parallel tool execution.

### `pions_result`

Retrieves an accepted result by `Operation` identifier.

```text
operationId: <operation-id>
```

If another chunk is available, pass the returned cursor to the next call. The tool does not expose storage paths or allow callers to select chunk sizes. It only reads operations belonging to the current trusted repository.

## Trusted formal-review integration

Trusted host code can use the supported `pions/formal-review` entry point instead of importing runtime or storage internals:

```ts
import { createHash } from "node:crypto";
import { createFormalReviewIntegration } from "pions/formal-review";

const sha256Digest = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const integration = createFormalReviewIntegration({
  repositoryRoot,
  formalReview: trustedFormalReviewConfiguration,
});

const subject = await integration.registerReviewSubject({
  registrationId,
  bytes: manifestBytes,
  expectedByteCount: manifestBytes.byteLength,
  expectedDigest: sha256Digest(manifestBytes),
  formatId: "pions.opaque.v1",
  normalizationId: "identity.v1",
  dependencies: [
    {
      path: "spec.md",
      expectedByteCount: specBytes.byteLength,
      expectedDigest: sha256Digest(specBytes),
      formatId: "pions.opaque.v1",
      normalizationId: "identity.v1",
    },
  ],
  dependencyFiles: [{ path: "spec.md", bytes: specBytes }],
});

integration.installPiExtension(pi);
```

The integration exposes only review-subject registration and configured Pi extension installation. It owns Runtime construction, Artifact Store access, repository state paths, credentials, and recovery wiring. Registration verifies that dependency requirements and supplied files form the same closed set, registers dependencies first, and then registers the unchanged root bytes with those dependencies. Paths must be normalized relative paths, and every supplied byte count and digest must match. A configured candidate profile does not enable production formal review by itself.

## Pions and pi-subagents

Pions is not a drop-in replacement for `pi-subagents`. They prioritize different jobs.

|                        | Pions                                                      | `pi-subagents`                                                   |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Primary goal           | Durable, verifiable delegation                             | Flexible, feature-rich orchestration                             |
| Worker UI              | Real Pi TUI in a Herdr pane                                | Foreground views, FleetView, and inspectors                      |
| Result model           | Integrity-verified immutable artifact                      | Run results, notifications, replay records, and output archives  |
| Completion model       | Separates worker settlement from operation-tree completion | Supports foreground, detached, background, and nested async runs |
| Agent definitions      | Currently one read-oriented profile                        | Built-in and custom agents                                       |
| Parallelism and chains | Composed through Pi tool calls                             | Built into the extension                                         |
| Background execution   | Not supported                                              | Supported                                                        |
| Steering               | Not supported                                              | Supported                                                        |
| Herdr                  | Required                                                   | Optional                                                         |

Choose `pi-subagents` when you want broad orchestration, configurable roles, background work, chains, steering, or packaged workflows.

Choose Pions when the important boundary is a persistent operation whose accepted output, lifecycle, stop evidence, and descendant completion can be inspected after the original call is gone.

## Current limitations

Pions is under active development.

- Herdr is required; Pions does not fall back to headless execution.
- The Pi extension currently exposes one read-oriented worker profile.
- Delegated implementation and other write-oriented roles are not enabled.
- Custom agent definitions are not supported.
- Background execution, chains, and mid-run steering are not supported.
- Permission manifests are not an OS-level sandbox.
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
- [Separate result integrity, adoption, and retention](docs/adr/0007-separate-result-integrity-adoption-and-retention.md)
- [Use the runtime as the result retrieval boundary](docs/adr/0013-use-runtime-as-the-result-retrieval-boundary.md)

The source comparison behind this README is documented in [`docs/research/pions-vs-pi-subagents.md`](docs/research/pions-vs-pi-subagents.md).
