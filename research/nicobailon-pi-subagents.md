# Static review: `nicobailon/pi-subagents` at `7fe9dee1bc186592e3f2b95c07d86c02f2edd57a`

**Review revision:** [`7fe9dee1bc186592e3f2b95c07d86c02f2edd57a`](https://github.com/nicobailon/pi-subagents/tree/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a)  
**Commit timestamp/message:** 2026-09-06 00:09:30 UTC, `fix(runtime): keep unconfigured prompt-runtime loads inert (#1984)`  
**Manifest version at that revision:** `pi-subagents` 0.65.1  
**Release caveat:** annotated tag object `v0.65.1` is `dbe28f181fc5c17c6c62de28c396e6cbf6fefa3b` and peels to commit `83be9c3de2cde1553c0269f383efc1eb1194dc8b`, not the reviewed commit. The reviewed snapshot is current `HEAD` with the same manifest version and must not be described as the tagged release artifact.  
**Method:** static inspection of the commit-pinned README, manifest, documentation, relevant TypeScript runtime modules, and relevant unit/integration tests. The package was **not installed or executed**. No live Herdr pane/workspace and no Qoral artifact was inspected or operated.

## Follow-up architecture decision

After this review, the user selected TypeScript/Node for Pions to reduce cross-language dependencies and align with Pi. This removes the report's original language-shape objection, but does not change the lifecycle and Herdr incompatibilities documented below. `nicobailon/pi-subagents` is therefore a primary reference implementation, not a selected dependency or a drop-in Pions runtime.

## Executive conclusion

### Package identity

**Source fact.** This is a **TypeScript/Node Pi extension**, not a Python backend. The manifest declares `type: "module"`, exports `index.ts` and TypeScript API subpaths, registers `./index.ts` under `pi.extensions`, and depends on Pi's JavaScript packages. Its foreground path creates Pi `AgentSession` objects in the parent process; its background path starts a detached Node/Jiti runner that creates Pi sessions in that runner process. [manifest](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/package.json) · [child session factory](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-session.ts) · [background launch](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/async-execution.ts)

**Interpretation.** It cannot close Phase 0/1 Decision P-001 as the intended Python agent package. It is a feature-rich orchestration extension and a useful source of design patterns, but using it as the Pions backend would require a Node/Pi sidecar or a redesign of Pions around Pi's extension runtime.

### Overall fit

| Question | Verdict |
|---|---|
| Candidate Python `AgentBackend` | **Conflict** — wrong runtime/package shape; no Python API. |
| Independent-process async backend | **Partial fit** — background runs have a detached Node runner, but foreground runs are in-process and the public structured delegation API is foreground-only. |
| Phase 1 visible Herdr worker | **Conflict** — ordinary runs are intentionally headless; Herdr is metadata/inspection/peer-pane integration, not the child presentation substrate. |
| Semantic result/event source | **Good design input** — native child sessions are observed directly, with typed results and Pi events rather than terminal scraping. |
| Required Pions state/event protocol | **Adapter-solvable only with substantial wrapper state** — package status files are useful but are not Pions' append-only authenticated operation protocol. |
| Required nested settlement/cancellation | **Conflict** — nesting and limits exist, but a parent may finish while descendants continue; stop marks the parent stopped before descendant acknowledgement and dispatch traversal is not post-order. |
| Persistence/recovery | **Mixed** — strong operational artifacts, session identity, stale-run repair, and reload restoration; not an authoritative permanent event store and not equivalent to Pions' exact replayable reducer. |
| Security boundary | **Mixed** — tool ceilings, path checks, private selected files, shell-free process launch, and fail-closed proofs are valuable; ordinary native children inherit process credentials, worktrees are not sandboxes, and several artifact/control files are not an authenticated child channel. |

**Recommendation.** Do **not** select this package as Pions' Python backend or use its ordinary Herdr integration for the Phase 1 visible-worker slice. Reuse selected ideas—direct Pi event subscription, explicit `agent_settled` handling, process-instance proof, model verification, capability ceilings, bounded fan-out claims, session leases, and fail-closed worktree cleanup—behind Pions' own Python contracts.

## Evidence and classification rules

- **Fit:** the fixed source already satisfies the relevant requirement or supplies the required evidence without weakening it.
- **Adapter-solvable gap:** Pions can add the missing projection, persistence, or wrapper behavior while retaining the package's underlying semantics.
- **Conflict:** package shape or lifecycle semantics contradict a Phase 0/1 invariant; resolving it requires bypassing or materially changing the package.
- “Source fact” reports what the fixed commit implements. “Interpretation” compares that implementation with the Pions requirements. “Recommendation” is prescriptive and is not a claim about upstream behavior.

## 1. Process and execution model

### 1.1 Process isolation

**Source facts.**

- Foreground (`async: false`) children are Pi sessions created **inside the parent Pi process**. The factory shares one `ModelRuntime`, creates a separate session manager/resource loader per child, serializes the temporary `process.env` application window, and resets Pi's extension cache when possible. [README](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/README.md) · [child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-session.ts)
- Background children run in a detached Node process. The launcher writes a private runner config, starts Node + Jiti + `subagent-runner.ts` with argv-array `spawn`, redirects stdout/stderr to files, records PID plus a random `runnerProcessInstanceId`, and unrefs the process. POSIX uses `detached: true`; Windows does not. [async-execution.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/async-execution.ts) · [background-process-options.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/background-process-options.ts)
- A background runner can host multiple child Pi sessions. Therefore a logical operation/step is not necessarily one OS process, even though a top-level async run has a runner process boundary. [subagent-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/subagent-runner.ts)
- Optional `external-cli` profiles launch an argv-array process with prompt delivery over stdin or an adapter-owned mode; their process groups can be terminated and verified on POSIX. They deliberately lack many native-Pi capabilities. [external-cli-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/external-cli-runner.ts) · [tool reference](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/tool-reference.md#external-cli-agent-profiles)

**Interpretation.** Backend acceptance gate 1 is met only by the background runner interpretation (“inside an independent wrapper process”). Foreground execution is not process-isolated. The shared runner/process environment is weaker than Pions' desired one-operation/worker boundary.

**Classification:** **adapter-solvable gap** for a background-only Node adapter; **conflict** if foreground mode or one-process-per-operation is required.

### 1.2 Foreground, background, parallel, and chain execution

**Source facts.**

- `async:false` blocks and streams a foreground in-process child. Default workflow execution is background; detached foreground execution is also supported. [README](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/README.md) · [observability](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/observability.md)
- Current composition is `workflowScript`: `runs.run` for keyed/sequential work, `runs.all` for parallel work, `runs.lanes` for parallel sequential lanes, and ordinary Promise combinators for rolling fan-out. Legacy top-level `chain`, `tasks`, and `parallel` inputs are rejected. [workflows](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/workflows.md) · [tool reference](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/tool-reference.md)
- Parallel tasks are bounded by task and concurrency configuration; the default ordinary concurrency is 4, with a workflow-wide default `globalConcurrencyLimit` of 20. [configuration](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/configuration.md#parallel)

**Interpretation.** This is substantially beyond Phase 1, where public background/parallel APIs are deferred. Its internal execution primitives are useful evidence, but adopting the extension would enlarge the MVP surface and introduce another workflow/state model.

**Classification:** execution capability **fit**; Phase 0/1 scope alignment **conflict**.

### 1.3 Async, deadlines, steering, interruption, and cancellation

**Source facts.**

- Background runs return immediately and are controlled by a file inbox. `interrupt` pauses/resumably aborts a live child turn; `stop` is terminal/non-resumable; `steer` and `follow_up` have acknowledgement receipts. Run and per-tool deadlines abort sessions. [control-channel.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/control-channel.ts) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts) · [tool reference](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/tool-reference.md#status-and-control-actions)
- Foreground execution listens to an `AbortSignal`, calls `session.abort()`, and has bounded hard-finish fallbacks when the session does not settle. [foreground execution](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/foreground/execution.ts)
- On POSIX, owned external process groups receive `SIGTERM`, then `SIGKILL`, followed by `ps`-based verification. Unsupported or unverifiable cases return `unknown`. [owned-process-tree.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/owned-process-tree.ts) · [test](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/owned-process-tree.test.ts)

**Interpretation.** Gate 2 (async and cancellation) is broadly met for native background runs. However, package `stop` is not Pions' proven subtree-cancellation protocol, and native child session abortion is logically distinct from OS process-tree proof.

**Classification:** basic async/deadline propagation **fit**; Pions cancellation semantics **conflict** (details in §5).

## 2. Result and completion semantics

### 2.1 Native Pi semantic result

**Source facts.** Both native launch paths subscribe directly to the child `AgentSession`; they collect final assistant messages, usage, tool events, model, errors, session identity, structured-output captures, and acceptance evidence. They do not derive native Pi success by scraping terminal text. [foreground execution](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/foreground/execution.ts) · [background child driver](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)

Native text, file-only output, and schema-validated structured output are distinct result modes. Empty terminal output, model mismatch, missing required output, extension/tool setup errors, timeout, stop, and provider failures can turn the result into a typed failure. [structured-output.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/structured-output.ts) · [single-output.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/single-output.ts)

**Interpretation.** This satisfies acceptance gate 3 for native Pi sessions. It does not provide Pions' authenticated result message/ACK transaction; background result authority is implemented through package-owned local files and the runner/watcher relationship.

**Classification:** semantic typed result **fit**; Pions result-channel contract **adapter-solvable gap**.

### 2.2 `agent_end` versus `agent_settled`

**Source facts.** `projectChildLifecycle` explicitly cancels the final-drain timer when `agent_end.willRetry === true`; `agent_settled` starts the terminal drain unless a compaction retry remains active. A terminal assistant `stop` can also start a short drain. If the prompt/session remains stuck, the host aborts after a one-second grace and hard-finishes after a further three seconds. [child-lifecycle.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-lifecycle.ts) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)

Integration tests specifically cover retrying `agent_end`, compaction retry, and `agent_settled` as a clean terminal watermark in foreground and background paths. [foreground tests](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/integration/single-execution.part-2.test.ts) · [background tests](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/integration/async-execution.part-1.test.ts)

**Interpretation.** The package correctly avoids treating retrying `agent_end` as final and recognizes `agent_settled` as the stronger Pi watermark. Its additional “terminal assistant stop + bounded forced cleanup” path means `agent_settled` is not an absolute prerequisite for a package terminal result. That is acceptable as a defensive package policy only if Pions records the missing watermark and resulting evidence explicitly.

**Classification:** distinction between events **fit**; exact Pions evidence policy **adapter-solvable gap**.

### 2.3 Publication and at-most-once behavior

**Source facts.** Async results are first written under a session-qualified pending path and atomically promoted. A watcher writes a bounded replay/archive before deleting the one-shot result after delivery. In-memory/TTL completion dedupe keys include session, run, and state. Replays expire and are described as best-effort temporary state, not a permanent ledger. [result-files.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/result-files.ts) · [completion-replay.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/completion-replay.ts) · [completion-dedupe.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/completion-dedupe.ts)

**Interpretation.** This is a good delivery implementation, but it is not Phase 0's permanent append-only result-before-settlement event history. A duplicate conflicting child result is not governed by Pions' single-writer authenticated protocol.

**Classification:** delivery ordering/dedupe **partial fit**; permanent replayable settlement **adapter-solvable gap**.

## 3. Events, callbacks, configuration, and observability

### 3.1 Events and callbacks

**Source facts.** Native sessions expose direct callbacks for `agent_start`, `message_end`, `message_update`, `tool_execution_start/end`, `tool_result_end`, compaction/retry events, `agent_end`, and `agent_settled`. Background runs mirror bounded child events to `events.jsonl`; `message_update` omits the unbounded partial body. Public/in-process APIs expose started/completed, control, process-terminal, structured delegation update/terminal response, Fleet status, and extension acknowledgement events. `pi.events` is explicitly process-local. [child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-session.ts) · [observability](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/observability.md#events) · [extension API](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#structured-delegation-api)

**Interpretation.** Acceptance gate 4 is well supported. The package event vocabulary and artifacts must still be translated to Pions' monotonic per-operation event schema; upstream records do not uniformly carry Pions' `event_id`, actor, schema version, authenticated capability, and operation-local `seq`.

**Classification:** event availability **fit**; Pions vocabulary/authentication **adapter-solvable gap**.

### 3.2 Model and thinking

**Source facts.** Model precedence is per-run → provider-scoped role override → ordinary role override → agent frontmatter → global subagent default → parent model. Models may have fallback candidates. The runtime resolves model/thinking through Pi, records attempted/final model information, and compares terminal response model IDs against the requested provider-qualified candidate, with explicit configured aliases. Thinking supports explicit levels and inherited ceilings; source records the resolved/effective thinking value. [models documentation](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/models.md) · [model-fallback.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/model-fallback.ts) · [foreground verification](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/foreground/execution.ts)

**Interpretation.** Requested/effective/final model and fallback attempts are strongly observable. Thinking is chiefly resolved policy; there is no independent provider-reported “observed reasoning level” equivalent to observed model identity. Fuzzy model resolution and configured fallbacks are deliberate, not silent, but Pions would need to preserve requested/effective/observed fields separately rather than collapse them.

**Classification:** model selection/verification **fit**; observed thinking **adapter-solvable gap** if represented as unavailable rather than fabricated.

### 3.3 Tools, extensions, and cwd

**Source facts.** Agent profiles control builtin tools, exclusions, MCP-direct tools, extensions, ambient-extension discovery, skills, permissions, and nested-subagent authorization. Capability ceilings intersect allowed agents/tools, can deny extensions, propagate to nested/background children, and reject missing required tools before spawn. Each run records cwd and launch-contract digests/projections. [child-tool-plan.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-tool-plan.ts) · [child-launch.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-launch.ts) · [capability API](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#capability-ceilings)

Foreground sessions intentionally do not load parent ambient extensions; background sessions may do so unless an explicit extension list or capability ceiling disables them. [extension API](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#background-work-provider-api)

**Interpretation.** Acceptance gate 6 is met for native children. The requested/effective configuration can be derived from launch planning and result metadata, but not in the exact Pions `TaskSpec`/`Operation` shape.

**Classification:** **fit**, with a small projection adapter.

### 3.4 Usage and live observability

**Source facts.** Progress records current tool/path, bounded recent output/tool summaries, input/output/cache token counts, cost, turns, duration, attention state, model, and thinking. Status, FleetView, transcript inspection, JSONL, output logs, metadata, and result details expose these fields with bounds. [observability](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/observability.md) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)

**Interpretation.** This exceeds the backend acceptance gate's observability minimum and offers useful mapping input. Usage is reported, not reserved, so hard usage budgets can reject later launches but do not stop already-running children.

**Classification:** **fit** for observation; **gap** for strict tree-wide budget reservation.

## 4. Nested spawn, lineage, limits, and budgets

### 4.1 Nested spawn and lineage

**Source facts.** Children do not receive `subagent` by default. A child whose resolved tools explicitly include it, or whose profile allows nested subagents, receives a child-safe fan-out extension. Runtime config carries depth/max depth, root route, parent run/index, path, inherited capability/thinking ceilings, and a root fan-out budget. Nested started/updated/completed records are written to a capability-bearing file route and rendered as a tree. [workflows recursion guard](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/workflows.md#recursion-guard) · [child-runtime-config.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-runtime-config.ts) · [fanout-child.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/extension/fanout-child.ts) · [nested-events.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/nested-events.ts)

**Interpretation.** Gate 7 is conceptually met: a child calls an explicit runtime `subagent` tool, not an invisible package recursion primitive. The lineage uses run IDs and step indexes rather than Pions operation IDs and does not implement Pions' idempotency key.

**Classification:** explicit nested tool and lineage **fit**; Pions identity/idempotency **adapter-solvable gap**.

### 4.2 Depth, fan-out, concurrency, and usage limits

**Source facts.** Default maximum depth is 2. Per-agent values can only tighten the inherited maximum. A session-wide cumulative spawn budget is optional; a root run has a default cumulative fan-out limit of 64, represented by atomically claimed `0600` files under a `0700` budget directory. Parallel/task/global active limits are separate. Reported token/cost budgets reject later children after reconciliation but do not reserve usage or cancel existing children. [recursion tests](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/recursion-guard.test.ts) · [run-fanout-budget.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/run-fanout-budget.ts) · [configuration](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/configuration.md#maxsubagentspawnsperrun)

**Interpretation.** Depth and cumulative run limits align well. Phase 0 specifically requires max children per operation and max live descendants per root with typed rejection and zero created resources; upstream instead offers several differently scoped limits, and its default concurrency queues rather than always rejects. The cumulative claim directory is a useful implementation reference.

**Classification:** depth/cumulative budget **fit**; exact fan-out/live-descendant policy **adapter-solvable gap**.

## 5. Descendant settlement, drain, and cancellation

### 5.1 Parent settlement with live descendants

**Source facts.** The package retains a nested route after a foreground parent finishes so the UI/status layer can continue tracking live descendants; the retained tracker removes the route only after no live descendants remain. The documentation also says detached children can continue after host-session shutdown and that nested runs are separately visible. [retained-nested-route-tracker.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/retained-nested-route-tracker.ts) · [extension API, host lifetime](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#host-session-lifetime-and-completion-wakes)

**Interpretation.** This is direct evidence that parent semantic completion is not necessarily delayed until descendant terminal states and pending handoffs drain. It conflicts with Phase 0's `self_settled -> draining_descendants -> terminal` invariant and `parent_exit_policy: cancel_descendants`.

**Classification:** **conflict**.

### 5.2 Subtree stop/cancel ordering and acknowledgement

**Source facts.** On stop, the runner immediately marks its own status/steps stopped and writes `subagent.run.stopped`, then aborts its stop controller, dispatches stop requests to nested descendants, and stops active direct children. Descendant traversal yields each child before recursively yielding its descendants (pre-order), and dispatch does not await terminal acknowledgements before parent stop state publication. Failures are diagnostic `subagent.nested.stop_failed` events. [subagent-runner stop path](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/subagent-runner.ts)

**Interpretation.** This violates Phase 0 cancellation requirements to atomically freeze spawning, snapshot live descendants, cancel post-order, await acknowledgement/death proof, and choose `cancelled` versus `unknown(cancel_unproven)`. There is no cancellation epoch/idempotency protocol matching the requirement.

**Classification:** **conflict**.

**Recommendation.** Do not adapt upstream `stop` into `Runtime.cancel(scope="subtree")` as though it had Pions semantics. A Pions supervisor must own freeze, post-order dispatch, acknowledgements, and `unknown` classification independently.

## 6. Prompt, secret, and result transport

### 6.1 Prompt transport

**Source facts.**

- Foreground prompt text is passed as an in-memory argument to `session.prompt()`.
- Background prompt/system instructions are serialized in a private `0600` async config JSON file; the spawned runner argv contains only the config path, not the prompt. The runner later calls the in-process child session with the prompt. [async-execution.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/async-execution.ts) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)
- External CLI profiles receive the combined prompt over stdin; adapters that require a file create it with mode `0600`. [external-cli-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/external-cli-runner.ts)
- Artifact metadata/input placeholders redact the raw task in several paths, and Herdr metadata uses bounded explicit labels rather than raw task/goal prompts. Child Pi session transcripts still necessarily contain prompts. [foreground execution](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/foreground/execution.ts) · [Herdr status](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/integrations/herdr-status.ts)

**Interpretation.** Acceptance gate 8 is met: prompt text need not appear in process argv. It does not use Pions' `prompt_ref` or authenticated Unix socket protocol.

**Classification:** no-prompt-in-argv **fit**; Pions transport shape **adapter-solvable gap**.

### 6.2 Secrets and channel authentication

**Source facts.** Native background runners inherit the parent environment except a package extension-binding variable; native Pi child extensions run in that process. External CLI adapters can use an environment allowlist, but the ordinary native runner does not implement a least-privilege environment allowlist. [async-execution.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/async-execution.ts) · [external-cli-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/external-cli-runner.ts)

Nested event/control routes use a random UUID capability token, validate route containment and matching metadata, cap event size, and suppress capability fields from result-intercom projection. The token is nevertheless persisted in route/index JSON and carried in child runtime configuration; this is a private local filesystem capability, not a 256-bit Pions socket token with monotonic sender sequence. [nested-events.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/nested-events.ts) · [result-intercom test](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/result-intercom.test.ts)

The async control inbox validates shapes and bounds, but ordinary stop/interrupt files are protected primarily by filesystem path ownership, not per-message capability authentication or sequence numbers. [control-channel.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/control-channel.ts)

**Interpretation.** Pions' capability secrecy, authenticated closed message set, monotonic child sequence, and “authenticate before parsing unbounded payload” contract are not present. Selected files are `0600` and selected directories `0700`, but not every general artifact writer forces those modes.

**Classification:** **adapter-solvable gap** only if Pions owns a separate channel; **conflict** if upstream file inbox is treated as equivalent authentication.

## 7. Session and process identity

**Source facts.** The package records top-level run ID, step index/key, parent/root nested IDs, Pi `sessionId`, session file, parent session ownership, runner PID, random runner process-instance ID, and external writer process-instance records. Completion delivery is scoped to the originating session and a process-stable completion-owner UUID. Retained revival uses canonical session files and an exclusive cross-process session lease. [child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-session.ts) · [session-identity.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/shared/session-identity.ts) · [completion-owner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/shared/completion-owner.ts) · [process-terminal.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/process-terminal.ts) · [session-lease.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/session-lease.ts)

**Interpretation.** Acceptance gate 9 is strongly met. Pions still needs its own stable `operation_id/root_operation_id/parent_operation_id`, idempotency key, and exact mapping to these backend identities.

**Classification:** **fit**, with an identity-mapping adapter.

## 8. Persistence, reload, restart, and crash recovery

### 8.1 What persists

**Source facts.** Background runs write `status.json`, bounded `events.jsonl`, output logs, result files, session JSONL, process-terminal sidecars, recovery descriptors, active indexes, optional workflow/mission/handoff records, and nested registries. Session start/reload restores active jobs, result watching, wait subscriptions, foreground history, schedules, and Herdr projections. [observability](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/observability.md#async-run-artifacts) · [extension lifecycle](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/extension/index.ts)

A detached child continues if the owning Pi session shuts down; what is lost is immediate notification. A later matching session/runtime can rediscover results. [extension API](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#host-session-lifetime-and-completion-wakes)

### 8.2 Reconciliation and proof

**Source facts.** Stale-run reconciliation can repair running status from an existing result file; if exact PID death is observed and no result exists, it writes a failed result/status. `EPERM` and other uncertain liveness become unknown rather than dead. Process-terminal proof is `observed` only after the live launcher sees the exact runner close and writer process-tree/session-lease evidence is consistent; otherwise proof is `unknown`. [stale-run-reconciler.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/stale-run-reconciler.ts) · [process-terminal.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/process-terminal.ts) · [process-terminal tests](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/process-terminal.test.ts)

**Interpretation.** This is substantially stronger than simple PID polling and is valuable design input. Nevertheless:

1. `events.jsonl` is diagnostic and bounded (default 50 MiB), not the canonical append-only state log.
2. `status.json` and multiple mutable sidecars are co-authoritative operational records rather than a pure reducer snapshot reconstructible from one authenticated event stream.
3. delivered result files are removed; replay/archive records expire.
4. restart reconciliation cannot retroactively obtain the launcher's exact `close` observation, so process proof may correctly remain unknown.
5. completion-owner identity is process-stable across reload, not durable across a new parent process.

**Classification:** same-process reload and operational recovery **fit**; Phase 0 event-store/reducer and durable crash-recovery authority **adapter-solvable gap**.

## 9. Failure semantics

**Source facts.** The package distinguishes complete, failed, partial, paused, stopped, rejected, timed-out, and process-proof unknown states. Model mismatch, missing required output, malformed structured output, denied tools/extensions, unavailable child runtime, startup-handshake failure, dead runner without result, worktree uncertainty, and process-tree verification failure are surfaced rather than silently converted to success. Unsupported external-runner capabilities are rejected before launch. [tool reference](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/tool-reference.md) · [stale-run-reconciler.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/stale-run-reconciler.ts) · [process-terminal.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/process-terminal.ts)

There is, however, no single Pions-style state machine. In particular, package “stopped” can be published before descendant/process terminal proof, while process proof remains a separate sidecar. Forced drain after a clean terminal assistant message may produce logical success even without normal session settlement. [subagent-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/subagent-runner.ts) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)

**Interpretation.** Acceptance gate 10 is met in many capability and process-proof paths, but package logical state names cannot be mapped one-to-one to Pions terminal states. Pions must not translate `stopped` to `cancelled` without separate stop proof.

**Classification:** fail-closed capability reporting **fit**; Pions terminal-state mapping **adapter-solvable gap**, with subtree stop semantics a **conflict**.

## 10. Worktrees and security boundaries

**Source facts.** Managed worktrees require Git, normally require a clean source checkout, validate base refs, reject unsafe allocation roots, create separate branches/worktrees, capture binary patches and handoff evidence, and preserve uncertain/dirty work rather than deleting it. Cleanup authority is separate from lane display metadata and requires fresh checks. [workflows worktree section](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/workflows.md#worktree-isolation) · [worktree.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/worktree.ts)

Tool and extension allowlists are explicit policy controls, but upstream documentation correctly says they are same-process policy rather than an OS sandbox. Child Bash/custom tools run with the process user's filesystem and inherited credentials. Host workflow commands use trusted resource grants but still inherit workflow cwd/environment and PATH trust. [capability ceilings](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#capability-ceilings) · [trusted workflow resources](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#trusted-workflow-resources)

**Interpretation.** The worktree implementation is an excellent consistency/cleanup reference, but it does not satisfy an OS security boundary. Phase 1 explicitly forbids creating worktrees, so these facilities must remain unused in the MVP.

**Classification:** worktree safety practices **fit as later design input**; sandboxing **not provided**; Phase 1 use **conflict with scope**.

## 11. Herdr integration

### 11.1 What ordinary runs do

**Source facts.** Ordinary native subagents remain headless. When the owning interactive Pi runs inside Herdr (`HERDR_ENV=1` and `HERDR_PANE_ID`), the extension reports aggregate async counts/labels on the **existing parent pane** using `herdr pane report-metadata`, emits `herdr:busy` and `herdr:blocked`, restores the projection after reload/resume, and clears it at completion/shutdown. It does not split a pane for each worker. [Herdr status source](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/integrations/herdr-status.ts) · [Herdr tests](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/herdr-status-bridge.test.ts)

Optional Herdr inspector panes are dashboards over existing async artifacts/control inboxes, explicitly not child sessions or literal attaches. Optional project panes create independent peer Pi sessions, but the parent does not own/control subagents within them. [extension API, Herdr](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#herdr-integration)

### 11.2 Comparison with Phase 1

**Interpretation.** This fails the central visible-worker requirement:

- no split of the current Pions pane for each operation;
- no `--no-focus` child worker launch transaction;
- no exact newly-created worker pane identity stored against the operation;
- no worker wrapper running in that pane;
- ordinary execution remains valid outside Herdr, rather than failing a Phase 1 precondition;
- Herdr metadata is parent aggregate presentation, not operation-level liveness for a visible worker.

The bridge does embody two good requirements: it uses argv arrays through `pi.exec`, and Herdr projection is best-effort rather than semantic result authority. It also avoids putting raw prompts in metadata.

**Classification:** optional parent metadata **fit as an ancillary projection**; Phase 1 `HerdrPresentation` **conflict**.

**Recommendation.** Do not attempt to reinterpret its inspector or project-pane actions as a Phase 1 worker pane. If Pions ever integrates the extension, Pions must create and own the exact pane itself, launch a dedicated wrapper there, and treat upstream status only as backend observation.

## 12. Requirement-by-requirement matrix

### 12.1 Backend acceptance gate (§1)

| # | Requirement | Fixed-commit evidence | Classification |
|---:|---|---|---|
| 1 | Independent OS process or backend inside independent wrapper | Detached Node runner for async; foreground in parent process | **Adapter-solvable gap** (background-only); foreground **conflict** |
| 2 | Async and cancellation/deadline propagation | Async runner, control inbox, aborts and deadlines | **Fit** for basic operation; subtree proof differs |
| 3 | Typed semantic result/failure, no terminal scraping | Direct `AgentSession` events/messages and structured result | **Fit** |
| 4 | Lifecycle/tool/message/usage stream or callback | Rich direct subscriptions and bounded JSONL/progress callbacks | **Fit** |
| 5 | Requested/observed model and reasoning; no silent fallback | Model candidates/attempts and terminal model verification; effective thinking, no independent observed thinking | **Adapter-solvable gap** |
| 6 | Per-operation tool restriction | Profile tool plan, capability ceilings, required-tool preflight | **Fit** |
| 7 | Child can call Pions Runtime spawn | Child can call package's child-safe `subagent`, not Python Pions Runtime | **Conflict** for Pions; useful design analogue |
| 8 | Prompt/token/result absent from argv | Native background prompt in `0600` config; external CLI stdin/file | **Fit** for prompt; Pions token channel absent |
| 9 | Backend session/process identity | Run/session/PID/process-instance/writer identity | **Fit** |
| 10 | Unsupported capability not disguised as success | Extensive preflight rejection and unknown process proof | **Fit**, except package states need careful mapping |

### 12.2 Shared domain and state machine (§§2–4)

| Requirement | Classification | Reason |
|---|---|---|
| `Runtime` is the only caller-facing seam; backend/presentation/store/channel separated | **Conflict** | Package exposes a Pi tool, workflow DSL, RPC, files, TUI, and Herdr APIs; it is an orchestration product, not a replaceable Python backend seam. |
| `TaskSpec.prompt_ref`, profile, idempotency key | **Gap/conflict** | Profiles exist; raw prompt is in memory/private config; no Pions prompt reference or parent-scope idempotency key. |
| Full Pions `Operation` fields | **Adapter-solvable gap** | Most backend/session/model/cwd/timing fields exist, but Pions lineage, state sequence, cancellation epoch, result digest, and pane ownership do not. |
| Exact Pions nonterminal/terminal states | **Conflict** | Upstream has running/attention/paused/stopped/partial etc.; no `self_settled`/`draining_descendants`, and stopped does not imply proven cancellation. |
| Legal reducer transitions and terminal immutability | **Conflict** | No pure reducer or authoritative append-only transition model. Mutable status repair is intentional. |
| Process/Herdr state cannot alone manufacture success | **Fit** | Native result comes from session semantics; process proof remains separate. |
| Monotonic authenticated event envelope | **Adapter-solvable gap** | Some event timestamps/versions/capabilities exist, but not uniformly the required envelope or sequence validation. |
| Deterministic Phase 0 fake backend/store/clock/IDs | **Conflict as deliverable** | Upstream tests have injectable factories/fakes, but no Pions reducer package or deterministic domain harness. |
| Depth 2, fan-out 3, live descendants 4, reject without resources | **Partial/gap** | Depth 2 exists; other upstream limits have different scopes/defaults and may queue. |
| Result persisted before self-settlement and at-most-once parent publication | **Partial fit** | Async pending/promoted result precedes watcher delivery, with dedupe/replay; no Pions self-settlement transition or permanent single-writer event. |
| Parent waits for descendants before terminal | **Conflict** | Retained descendant tracking explicitly permits parent completion first. |
| Atomic spawn freeze + post-order cancel + ack/death proof + unknown | **Conflict** | No cancellation epoch/freeze; nested dispatch is pre-order and parent stopped state is written first. |
| Required Phase 0 property/table tests | **Conflict as deliverable** | Extensive upstream tests cover its own contracts, not Pions' transition invariants. |

### 12.3 Phase 1 visible-worker MVP (§5)

| Requirement | Classification | Reason |
|---|---|---|
| One operation, no nesting, blocking vertical slice | **Adapter-solvable** | Foreground single run exists, but is in-process and not a visible separate worker. |
| Strict Herdr env preflight; no headless fallback | **Conflict** | Herdr is optional and ordinary launches remain headless. |
| Split current Pions pane, no focus, explicit cwd, returned opaque pane ID | **Conflict** | Ordinary child launch performs no pane split. |
| Persist exact Pions-owned pane and never target pre-existing/Qoral panes | **Conflict/not implemented** | No per-operation worker pane ownership exists. Project/inspector panes are different features. |
| Private `0700` run dir and `0600` prompt/config/result/error | **Partial gap** | Selected config/budget/recovery files are `0600` and some dirs `0700`; generic async/artifact/result writers do not uniformly impose the Pions modes. |
| Worker authenticated `hello/started/activity/.../result/cancel_ack` channel | **Conflict** | Native sessions use direct callbacks; detached coordination uses package file artifacts/inboxes, not this protocol. |
| 256-bit capability, hidden from argv/log/metadata, monotonic sequence | **Conflict** | Nested UUID capability is persisted and narrower; ordinary result/control path has no equivalent token/sequence. |
| Persist/hash result, ACK, then settle | **Adapter-solvable gap** | Atomic result publication exists, but no Pions ACK/hash/state transaction. |
| Herdr is projection/liveness only | **Fit** | Upstream Herdr bridge is best effort and not result authority. |
| Exact per-operation Herdr model/state/usage projection | **Gap** | Aggregate parent-pane metadata only. |
| Process exit without result => failed if proven; unproven => unknown | **Partial fit** | Stale reconciler marks proven dead runner without result failed; process-terminal sidecar preserves unknown proof. Mapping must remain explicit. |
| Cancel backend first; proven stop cancelled, otherwise unknown | **Conflict** | Upstream publishes stopped before full descendant/process proof. |
| Retain blocked/failed/unknown/success panes | **Conflict/not applicable** | Ordinary runs have no worker panes. |
| Fake-Herdr argv/ownership/security tests | **Conflict as deliverable** | Herdr bridge/project/inspector tests cover upstream interfaces, not Pions' pane transaction fixtures. |
| Reconstruct final result without terminal output | **Fit** | Native session/result/status artifacts suffice. |

## 13. Relevant test evidence inspected

No tests were run. Static inspection included tests for:

- foreground/background `agent_end.willRetry` and `agent_settled` behavior: [single execution](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/integration/single-execution.part-2.test.ts), [async execution](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/integration/async-execution.part-1.test.ts);
- nested control routing, route scoping, reload listener replacement, and trusted session-root checks: [nested-control.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/nested-control.test.ts);
- depth and inherited-limit behavior: [recursion-guard.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/recursion-guard.test.ts);
- exact runner/writer process-terminal proof and unknown outcomes: [process-terminal.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/process-terminal.test.ts);
- POSIX descendant termination/verification: [owned-process-tree.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/owned-process-tree.test.ts);
- Herdr enablement, parent-pane metadata, prompt-label redaction, reload projection, and inert behavior outside Herdr: [herdr-status-bridge.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/herdr-status-bridge.test.ts);
- external CLI stdin prompt delivery and process-group stop behavior: [external-cli-runner.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/external-cli-runner.test.ts);
- result capability redaction: [result-intercom.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/result-intercom.test.ts).

These tests support upstream's own behavior. They are not evidence that the Phase 0 reducer tests or Phase 1 fake-Herdr safety suite already exist.

## 14. Drift from the prior report

The prior report, [`herdr-pi-extensions.md`](./herdr-pi-extensions.md), did **not** review `nicobailon/pi-subagents` at this revision. Its similarly named entry was **`@minhduydev/pi-subagents` 0.13.0** at a different repository and commit (`MinhDuyDEV/pi-subagents@6df615…`). Those findings must not be attributed to this package.

Material differences from the prior report's general picture are:

1. **Package shape:** this fixed revision is explicitly a TypeScript Pi extension with a large in-process/public TypeScript API, not the still-undecided Python backend assumed by Pions.
2. **Herdr role:** unlike visible-pane subagent packages emphasized in the prior report, ordinary children here remain headless. Herdr integration projects aggregate state onto the parent pane and opens optional inspectors/project peers.
3. **Completion handling:** this revision has strong direct handling of `agent_end.willRetry` versus `agent_settled`, matching the prior report's recommendation not to treat `agent_end` as final.
4. **Process proof:** this revision adds unusually explicit runner-instance, writer-process-tree, and session-lease terminal evidence, including durable `unknown` proof when observation is unavailable.
5. **Nested lifecycle:** despite first-class lineage, depth, visibility, and cumulative fan-out claims, it does **not** implement the qcts-style descendant-drained parent settlement/cancellation recommended in the prior report. Parent completion can precede descendant completion, and stop is not descendant-first acknowledged cancellation.
6. **Persistence:** the package has much richer status/result/recovery/mission/worktree artifacts than the small ephemeral designs in the prior report, but its diagnostic JSONL and expiring completion replay are not a permanent Pions event store.
7. **Security:** model/tool/extension ceilings and worktree cleanup evidence are more developed than many reviewed packages, while ordinary native child processes still share user authority and inherited environment; neither a worktree nor a Pi extension policy is an OS sandbox.

## 15. Final recommendation

### Source-derived decision

Reject `nicobailon/pi-subagents@7fe9dee1bc186592e3f2b95c07d86c02f2edd57a` as the package that resolves Pions Decision P-001. It is not Python, does not expose the required Python backend contract, does not create Phase 1 visible Herdr workers, and conflicts with required descendant settlement/cancellation semantics.

### Concepts worth adapting

1. Subscribe directly to backend/Pi events and retain `agent_settled` as the strongest normal terminal watermark.
2. Record requested model candidates, attempted models, final observed model, and explicit alias/fallback policy.
3. Keep logical completion separate from exact process-terminal proof; represent unavailable proof as `unknown`.
4. Use random process-instance identity in addition to PID and require canonical-session lease release for revival/terminal proof.
5. Use capability/tool/thinking ceilings that only tighten through descendants.
6. Use atomic, no-refund root fan-out claims and fail an admission group before starting any child.
7. Preserve uncertain worktrees and require fresh identity/Git evidence before destructive cleanup.
8. Bound event, transcript, output, steering, and metadata projections and keep raw prompts out of Herdr metadata.

### Concepts not to copy into Phase 0/1

1. A second workflow DSL/state model around the Pions reducer.
2. Parent terminal publication while descendants remain live.
3. Pre-order fire-and-forget descendant stop with parent `stopped` published first.
4. Treating a local unauthenticated file inbox as the Pions child capability channel.
5. Optional/headless Herdr behavior in the Phase 1 visible-worker adapter.
6. Treating worktrees, tool allowlists, or same-process extension ceilings as OS isolation.
