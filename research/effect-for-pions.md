# Effect for Pions: stable-generation fit, boundaries, and Phase 0 recommendation

**Status:** research recommendation; no dependencies changed  
**Research date:** 2026-09-06  
**Method:** static inspection only. No package was installed or executed. Sources were limited to Effect's official site/registry metadata, the canonical [`Effect-TS/effect`](https://github.com/Effect-TS/effect) repository at exact commits, official package manifests/releases, and upstream tests/examples. The unversioned website was treated as an orientation point, not as version-pinned API authority. No Herdr or Qoral resource was inspected or operated.

## Executive conclusion

**Recommendation.** Adopt **Effect v3, pinned exactly to `effect@3.22.1`**, for Pions' orchestration implementation, boundary schemas, typed operational errors, test clock, resource scopes, and structured in-process concurrency. Do **not** put `Effect`, `Layer`, `Context`, `Exit`, or `Cause` in the caller-facing `Runtime`/`Handle` interface, and do **not** write the pure operation reducer as an Effect program. Keep the public shape promised by the requirements:

```ts
const handle = await runtime.spawn(task, options)
const result = await handle.result()
await handle.cancel({ scope: "subtree" })
```

Internally, one bootstrapped Effect program can compose `AgentBackend`, `EventStore`, `ChildChannel`, `Presentation`, clock, and ID/token services. A thin adapter runs that program and translates its typed outcomes into the public Promise API.

For **Phase 0**, add only:

```json
{
  "dependencies": {
    "effect": "3.22.1"
  }
}
```

Use the project's ordinary test runner around `Effect.runPromiseExit`. If Vitest is selected and Effect-aware test ergonomics are worth another dependency, add the exact dev dependency `@effect/vitest@0.30.0`; it is useful, but not necessary to prove the tracer bullet. Do not add `@effect/schema`: Schema is part of `effect`, and the standalone package is officially deprecated as merged into the main package. Do not add `@effect/platform-node`, Stream infrastructure, STM-backed registries, or OpenTelemetry merely to begin Phase 0.

For **Phase 1**, separately evaluate and, if accepted, pin the coherent stable platform set `@effect/platform-node@0.108.1`, `@effect/platform@0.97.1`, and the package manager's required compatible peers. Its filesystem and Unix-socket services fit Pions well. Its command API is a useful subprocess primitive, but it does not by itself establish Pions' required process-instance identity, descendant process-group termination, or cancellation proof; a small Node-specific `AgentBackend` process supervisor may still need direct `node:child_process`/OS operations behind the same service seam.

The largest gain is not “functional style.” It is making interruption, cleanup, timeout, dependency substitution, error causes, and deterministic time first-class **inside the runtime**. The largest risk is mistaking those mechanisms for Pions' domain evidence: a fiber interruption is not proof that a worker process stopped, scope finalization is not `operation_cancelled`, a `PubSub` notification is not an authoritative event, and successful sequencing in memory is not durable persist-before-settle.

## 1. Stable generation and exact pins

### 1.1 Stable versus preview

**Source fact.** On the research date, the official npm `latest` dist-tag was `effect@3.22.1`. The same registry also exposed `effect@4.0.0-beta.107` under `beta` and `effect@4.0.0-rc.112` under `rc`; GitHub marked the v4 RC release as a prerelease. The canonical annotated tag `effect@3.22.1` peels to commit [`417e0faa80e471d77fc4a67452e68b09ae0ee861`](https://github.com/Effect-TS/effect/tree/417e0faa80e471d77fc4a67452e68b09ae0ee861). That commit's manifest says version `3.22.1` and exports Schema from the main package. [pinned manifest](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/package.json) · [immutable npm metadata](https://registry.npmjs.org/effect/3.22.1) · [v4 RC release](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.112)

**Interpretation.** The current stable generation is **Effect 3**. Effect 4 is a preview/release-candidate line, not the stable line, even though it is newer and may dominate the unversioned website or current-main examples.

**Recommendation.** Treat commit `417e0f…` as the API authority for core Phase 0 work. Do not copy v4 beta/RC examples, imports, service APIs, or package versioning into v3 code. Every implementation-time API lookup should be checked against this commit or the installed declaration files for the exact pinned artifact.

### 1.2 Coherent stable package matrix

| Package | Exact stable version | Canonical release commit | Compatibility and decision |
|---|---:|---|---|
| `effect` | `3.22.1` | [`417e0faa80e471d77fc4a67452e68b09ae0ee861`](https://github.com/Effect-TS/effect/tree/417e0faa80e471d77fc4a67452e68b09ae0ee861) | **Phase 0 dependency.** Includes Effect, Schema, Context/Layer, Scope, fibers, Exit/Cause, Stream, Queue/PubSub, Ref/STM, Clock/TestClock, Config/Redacted, Logger, and Tracer. |
| `@effect/platform` | `0.97.1` | [`417e0faa80e471d77fc4a67452e68b09ae0ee861`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/platform/package.json) | Peer requires `effect ^3.22.1`; defer to Phase 1. [npm](https://registry.npmjs.org/%40effect%2Fplatform/0.97.1) |
| `@effect/platform-node-shared` | `0.61.1` | [`417e0faa80e471d77fc4a67452e68b09ae0ee861`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/platform-node-shared/package.json) | Transitive from platform-node; peer requires the same core/platform line. [npm](https://registry.npmjs.org/%40effect%2Fplatform-node-shared/0.61.1) |
| `@effect/platform-node` | `0.108.1` | [`bd20125fb9b8ce42f814ba738513daaf83ce723d`](https://github.com/Effect-TS/effect/tree/bd20125fb9b8ce42f814ba738513daaf83ce723d) | Peer requires `effect ^3.22.1` and `@effect/platform ^0.97.1`; Node `>=18`. Defer to Phase 1. [manifest](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node/package.json) · [npm](https://registry.npmjs.org/%40effect%2Fplatform-node/0.108.1) |
| `@effect/vitest` | `0.30.0` | [`e670e0f6befb959b84208d5f77631276521020ae`](https://github.com/Effect-TS/effect/tree/e670e0f6befb959b84208d5f77631276521020ae) | Optional dev dependency; peers `effect ^3.22.0`, `vitest ^3.2.0`. [manifest](https://github.com/Effect-TS/effect/blob/e670e0f6befb959b84208d5f77631276521020ae/packages/vitest/package.json) · [npm](https://registry.npmjs.org/%40effect%2Fvitest/0.30.0) |
| `@effect/opentelemetry` | `0.64.0` | [`e670e0f6befb959b84208d5f77631276521020ae`](https://github.com/Effect-TS/effect/blob/e670e0f6befb959b84208d5f77631276521020ae/packages/opentelemetry/package.json) | Compatible with core `^3.22.0` and platform `^0.97.0`; defer until external telemetry is required. [npm](https://registry.npmjs.org/%40effect%2Fopentelemetry/0.64.0) |
| `@effect/schema` | `0.75.5` | n/a for recommendation | **Do not add.** Its official npm manifest says “this package has been merged into the main effect package.” [npm](https://registry.npmjs.org/%40effect%2Fschema/0.75.5) |

**Source fact.** The platform-node npm manifest also lists `@effect/cluster`, `@effect/rpc`, and `@effect/sql` as peers, without `peerDependenciesMeta` marking them optional. [npm](https://registry.npmjs.org/%40effect%2Fplatform-node/0.108.1)

**Interpretation.** Adding platform-node may enlarge dependency-resolution work beyond the facilities Pions uses. Exact top-level pins do not by themselves freeze all transitive packages; the lockfile and npm integrity values remain part of the reproducibility boundary.

**Recommendation.** Pin without `^`/`~`, commit the lockfile, and record package integrity in the dependency decision. Never pair v3 core with v4 platform/vitest packages carrying `4.0.0-beta.*` or `4.0.0-rc.*` versions.

## 2. Capability evaluation

### 2.1 `Effect` and typed errors

**Source fact.** Stable Effect models a computation as `Effect<A, E, R>`: success, typed expected error, and required environment. It provides sequential composition, `all`, races, timeout variants, interruption handlers, scoped execution, service provisioning, Promise runners, logging, and spans in the core package. [`Effect.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts)

**Interpretation.** This fits runtime orchestration failures that callers and tests must distinguish: invalid task, policy rejection, store failure, backend startup failure, protocol rejection, timeout, projection failure, and cancel-unproven. It also forces a useful distinction between expected failures (`E`), unexpected defects, and interruption. However, an ever-growing union in every method can become harder to understand than a small Pions-owned error algebra.

**Recommendation.** Define closed, Pions-named tagged operational errors and catch/translate lower-level platform/backend errors at each seam. Use defects only for programmer bugs/invariant violations. At the public boundary, translate the internal `Exit` once; do not require callers to know Effect error channels.

### 2.2 Schema

**Source fact.** The stable main package exports `Schema.Struct`, `Schema.Union`, `Schema.TaggedStruct`, tagged classes/errors, and unknown-value decoders returning Effect, Either, or Promise. [`Schema.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Schema.ts) Upstream has extensive schema decode, class, cause/exit, arbitrary, and JSON Schema tests at the pinned commit. [schema tests](https://github.com/Effect-TS/effect/tree/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Schema)

**Interpretation.** Schema is a strong fit for untrusted boundaries: `TaskSpec`, persisted event envelopes, snapshots, child-channel frames, config, and backend messages. Tagged event schemas align naturally with Pions' closed event vocabulary and schema-version field. Schema does not prove state-transition legality or cross-record invariants such as “completed implies all descendants terminal.”

**Recommendation.** Decode at ingress and on replay, then pass plain immutable domain values to the reducer. Keep transition rules in ordinary exhaustive TypeScript. Avoid Schema classes as the only domain representation if they make fixtures and snapshots harder to inspect; tagged structs plus smart constructors are enough for Phase 0.

### 2.3 Context and Layer

**Source fact.** `Context.Tag`/`GenericTag` identify services; `Layer` can construct, combine, provide, memoize, and scope service implementations, including replacing Clock, ConfigProvider, Logger, and Tracer. [`Context.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Context.ts) · [`Layer.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Layer.ts)

**Interpretation.** The Pions internal seams are almost exactly substitutable services: `AgentBackend`, `EventStore`, `ChildChannel`, `Presentation`, Clock, and deterministic ID/token factory. Layers make production/fake graphs explicit and ensure scoped services close together. But exposing `R` requirements from these services to every caller would make `Runtime` shallow: callers would be assembling dependencies that the runtime is supposed to hide.

**Recommendation.** Use tags/layers at the composition root and for integration-test substitution only. Build one deep `Runtime` module that owns the complete live layer. Do not create tags for pure helpers or make the reducer ask the environment for anything.

### 2.4 Scope and `acquireRelease`

**Source fact.** `Effect.acquireRelease` registers a release action in a `Scope`; release receives the scope's `Exit`. `Effect.scoped` closes the scope. `forkScoped` ties a fiber to a local scope, while normal `fork` is parent-supervised and `forkDaemon` deliberately escapes the parent. [`Effect.ts` resource APIs](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts) The platform filesystem's opened files and scoped temporary paths also require/use Scope. [`FileSystem.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/FileSystem.ts)

**Interpretation.** Scope is a strong fit for runtime-owned listeners, open sockets, file handles, child-channel subscriptions, presentation sessions, and a launched process handle. It reduces leaks across startup failure and interruption. It does not decide whether a pane/process should be retained as evidence, nor does running a finalizer prove an external process stopped.

**Recommendation.** Scope only resources Pions policy says are automatically releasable. A Phase 1 worker pane that must be retained on blocked/failed/unknown is not an unconditional acquire/release resource. A subprocess finalizer should request/escalate cancellation and report evidence; the reducer alone decides `cancelled` versus `unknown` from persisted proof.

### 2.5 Fibers, interruption, and structured concurrency

**Source fact.** Stable Effect provides parent-supervised `fork`, scope-supervised `forkScoped`, detached `forkDaemon`, fiber `await`/`join`, interrupt and interrupt-all, `awaitAllChildren`, interruption handlers, and interruptibility masks. The source documentation explicitly contrasts normal child termination with detached/scoped lifetimes. [`Effect.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts) · [`Fiber.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Fiber.ts) Upstream tests verify interrupted-fiber exits and scope-driven finalization. [`Fiber.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Fiber.test.ts)

**Interpretation.** Fibers are well suited to concurrent backend observation, child-message handling, deadlines, presentation projection, and waiting for descendants. They make accidental orphan **in-process tasks** less likely. They are not Pions operations, and Effect's supervision tree is not Pions' durable lineage tree. Interrupting a fiber that is waiting on a process does not prove the process or its OS descendants stopped.

**Recommendation.** Mirror operation lifetime where convenient, but keep lineage/state in the EventStore. Avoid `forkDaemon` in operation paths. Implement cancellation as the required domain protocol: persist epoch/freeze, snapshot descendants, dispatch post-order, await acknowledgement/death evidence, then persist `cancelled` or `unknown`. Fiber interruption can stop local waiters after that protocol; it must never manufacture the terminal event.

### 2.6 Exit and Cause

**Source fact.** `Exit<A,E>` is either `Success` or `Failure`; Failure carries a `Cause<E>`. Cause distinguishes typed failure, defect (`Die`), and interruption and can represent combined sequential/parallel causes. [`Exit.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Exit.ts) · [`Cause.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Cause.ts)

**Interpretation.** Capturing `runPromiseExit` at the internal/public boundary avoids losing defects or interruption. Cause is valuable diagnostic evidence for concurrent orchestration. It is not a stable Pions persistence schema by default, and its interruption category is still local runtime interruption rather than external cancellation proof.

**Recommendation.** Map Cause into bounded, versioned Pions error records (`typed failure`, `defect`, `local interruption`, relevant summaries) before persistence. Never serialize arbitrary defect objects or leak Cause to Runtime callers. Preserve `cancel_unproven` as a Pions reason, not as a generic interrupted Cause.

### 2.7 Stream

**Source fact.** Stable Stream supports scoped acquisition, finalization, interruption, queue conversion, service/layer provision, timeout, and collection. [`Stream.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Stream.ts)

**Interpretation.** Stream is a good internal shape for backend lifecycle/tool/message events and framed child-socket input. It provides composition and scoped shutdown without callbacks spreading through Runtime. It can overcomplicate the first one-result fake channel and may obscure the exact persistence/ACK ordering if a generic pipeline is introduced too early.

**Recommendation.** Do not require Stream in the first tracer bullet. Introduce it when a real backend supplies multiple events or when the Unix socket is framed. The authoritative consumer must validate → append/apply → publish projection; a Stream is transport, not authority.

### 2.8 Queue and PubSub

**Source fact.** A bounded Queue applies backpressure by suspending offers at capacity; dropping and sliding variants have explicitly lossy behavior. Queue take suspends when empty and queues can be shut down. PubSub gives each scoped subscriber a dequeue; bounded, dropping, sliding, and replay options exist. [`Queue.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Queue.ts) · [`PubSub.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/PubSub.ts) Upstream tests explicitly cover bounded backpressure and lossy dropping/sliding ordering. [`Queue.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Queue.test.ts) · [`PubSub.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/PubSub.test.ts)

**Interpretation.** A bounded Queue fits the single ordered ingestion path and makes overload explicit. PubSub fits best-effort presentation/telemetry after persistence. Neither is durable; dropping/sliding behavior is categorically wrong for authoritative state events or result handoffs.

**Recommendation.** If introduced, use one bounded Queue per controlled ingestion boundary with a documented capacity/overload failure. Use PubSub only for projections after EventStore acceptance. Never ACK a result merely because it entered a queue.

### 2.9 Ref and STM

**Source fact.** `Ref.modify` atomically computes a return value and new value for one in-memory reference. STM provides composable atomic transactions over `TRef`, `TMap`, `TSet`, `TQueue`, and `TPubSub`, committed with `STM.commit`. [`Ref.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Ref.ts) · [`STM.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/STM.ts) · [`TRef.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/TRef.ts)

**Interpretation.** Ref fits a serialized in-memory registry. STM could atomically enforce idempotency, `spawn_frozen`, per-parent fan-out, and per-root live-descendant counts under concurrent spawn/cancel. But STM cannot atomically include an external file/SQLite append. Introducing transactional collections before Phase 0 has real concurrent mutation would create a second conceptual state model around the pure reducer.

**Recommendation.** Keep the Phase 0 reducer as a pure function and serialize EventStore transitions through one deep store/runtime operation. Use Ref only for simple fake/runtime-local coordination. Revisit STM for the second tracer bullet if concurrent spawn/cancel claims cannot be expressed safely with the store's own transaction. The eventual durable store transaction, not STM, must own durable idempotency and freeze/count checks.

### 2.10 Clock and TestClock

**Source fact.** Clock provides current time and sleep. TestClock can set time, inspect sleeps, and deterministically adjust virtual time. [`Clock.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Clock.ts) · [`TestClock.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/TestClock.ts) Official upstream tests use `it.effect` and `TestClock.setTime`/`adjust`. [`TestClock.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/TestClock.test.ts) The Effect Vitest adapter supplies Effect test services. [`@effect/vitest` internals](https://github.com/Effect-TS/effect/blob/e670e0f6befb959b84208d5f77631276521020ae/packages/vitest/src/internal/internal.ts)

**Interpretation.** This directly fits deterministic deadline, acknowledgement timeout, retry, and cancellation tests. For Phase 0 timestamps, Pions also wants a simple deterministic clock value factory; using TestClock throughout is optional, not mandatory.

**Recommendation.** All runtime time/sleep must come from the internal Clock service. The reducer receives timestamps in events and never reads a clock. Use TestClock for orchestration timeout tests; use explicit fixed timestamps for reducer tables/property tests. Never use real sleep.

### 2.11 Config and Redacted

**Source fact.** Config supports typed strings, durations, composition, and `Config.redacted`. Redacted hides ordinary inspection, permits explicit extraction with `Redacted.value`, and has an unsafe wipe operation. [`Config.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Config.ts) · [`Redacted.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Redacted.ts)

**Interpretation.** Config fits startup environment and policy defaults. Redacted helps keep capability/config secrets out of accidental logs and inspection, but it is not an access-control boundary; code can extract the value, and it does not enforce file modes, argv exclusion, or event redaction.

**Recommendation.** Use Config for process-level Pions configuration, not for per-operation domain state. Wrap dynamic capability tokens in Redacted while in memory, but still enforce the Phase 1 protocol rules independently: private file/descriptor, no argv, no metadata/event payload, authenticate before unbounded parsing, and explicit wipe where practical.

### 2.12 Logging and telemetry

**Source fact.** Core Effect includes structured log levels, scoped log annotations, custom Logger layers, spans, tracer replacement, and span annotations/links. [`Effect.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts) · [`Logger.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Logger.ts) · [`Tracer.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Tracer.ts) Pinned upstream tests exercise scoped log annotations and nested/root spans. [`Logger.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Logger.test.ts) · [`Tracer.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Tracer.test.ts)

**Interpretation.** Operation/root IDs, state sequence, backend identity, and cancellation epoch are good log/span annotations. Logs/spans remain observability, like Presentation; they cannot create operation events or prove completion.

**Recommendation.** Use core logging only in Phase 0, with a test logger/sink and an allowlist of bounded non-secret fields. Add no OpenTelemetry dependency yet. If later needed, pin the coherent stable `@effect/opentelemetry@0.64.0` line and export from persisted domain facts rather than treating telemetry as the ledger.

## 3. `@effect/platform-node` facilities

### 3.1 Subprocesses

**Source fact.** Platform Command builds a command from a program plus argv array; shell execution is an explicit option rather than the default. It supports cwd, stdin/stdout/stderr streams, environment replacement via `extendEnv: false`, scoped `start`, PID, exit code, liveness check, and signal-based kill. [`Command.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/Command.ts) · [`CommandExecutor.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/CommandExecutor.ts) The Node layer supplies the executor. [`NodeCommandExecutor.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/src/NodeCommandExecutor.ts) Official tests cover argv execution, streaming stdin/out, cwd, exact environment replacement, startup failure, and interruption. [`CommandExecutor.test.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/test/CommandExecutor.test.ts)

**Interpretation.** This supports shell-free Herdr invocation and wrapper launch, prompt-over-stdin, restricted environment, captured streams, and lifecycle scoping. The public Process model exposes a PID but no random process-instance identity, process-group/session ownership, descendant enumeration, or post-kill OS proof. Fiber interruption in the upstream test demonstrates local cancellation behavior, not Pions' proof standard.

**Recommendation.** Prefer Command for ordinary shell-free CLI calls and consider it for launch. Before selecting it for worker supervision, spike exact POSIX/Windows process-group behavior and proof. Keep an adapter escape hatch to direct Node APIs for `detached`, group signals, exact close observation, and process-instance records. Never map Process.kill success or fiber interruption directly to `operation_cancelled`.

### 3.2 Filesystem

**Source fact.** Platform FileSystem includes read/write, mkdir with options, chmod, rename, remove, stat, streaming, scoped open, and file-handle `sync`; the Node package supplies a layer. [`FileSystem.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/FileSystem.ts) · [`NodeFileSystem.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/src/NodeFileSystem.ts) Upstream tests cover reads, scoped file/temp-path cleanup, and failure shapes. [`FileSystem.test.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/test/FileSystem.test.ts)

**Interpretation.** This is enough to build private `0700` directories, `0600` artifacts, temp-write + sync + rename publication, and typed filesystem failures. Scope-based automatic temp cleanup is useful for disposable staging but conflicts with evidence retention if applied to operation artifacts wholesale.

**Recommendation.** Use the service behind EventStore/artifact interfaces in Phase 1, with Pions-owned atomic/durability helpers and tests for mode, sync, rename, and crash windows. Do not assume `writeFile` alone means durable persistence. Keep evidence directories outside automatic temporary-resource cleanup.

### 3.3 Sockets

**Source fact.** Platform Socket supplies scoped byte channels and SocketServer abstractions. NodeSocketServer wraps `node:net`, accepts Node listen options, reports string addresses as `UnixAddress`, closes the server in a finalizer, and supervises connection handlers with a scoped FiberSet. [`Socket.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/Socket.ts) · [`SocketServer.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/SocketServer.ts) · [`NodeSocketServer.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/src/NodeSocketServer.ts)

**Interpretation.** Unix-domain transport and scoped connection cleanup fit ChildChannel. The package supplies bytes/lifecycle, not Pions framing, maximum sizes, capability authentication, monotonic sequence, at-most-once result conflict detection, or persist-before-ACK.

**Recommendation.** Use it only beneath a deep Pions ChildChannel protocol module. Authenticate a bounded initial frame before accepting larger payloads, decode every frame with Schema, enforce sequence and total size, and make EventStore acceptance the source of the ACK decision.

### 3.4 Testing platform facilities

**Source fact.** Platform services are Context services/layers, and FileSystem exports `makeNoop`/`layerNoop` for controlled implementations. Upstream platform tests compose Node layers explicitly. [`FileSystem.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/FileSystem.ts) · [platform-node tests](https://github.com/Effect-TS/effect/tree/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/test)

**Interpretation.** Substitutability is good, but upstream's own command/filesystem tests use real processes/files. Pions Phase 0/automated Phase 1 requirements are stricter and cannot be satisfied merely by using Effect's test helpers.

**Recommendation.** Implement purpose-built fakes at Pions seams: FakeAgentBackend, InMemoryEventStore, FakeChildChannel, FakePresentation, and later a fake CommandExecutor/FileSystem/Herdr executable contract. Do not provide live Node layers in Phase 0 tests.

## 4. Mapping to Pions

| Pions concept/seam | Best Effect use | Boundary that must remain Pions-owned |
|---|---|---|
| `Runtime` | Internal Effect program assembled once from Layers; Scope owns runtime resources; Promise adapter at edge | Public `spawn/result/cancel` API, operation semantics, idempotency, error vocabulary |
| Pure reducer | Schema-decoded tagged inputs; possibly Effect data helpers, but no effect execution | Legal transitions, terminal immutability, invariant derivation; deterministic pure return value |
| `AgentBackend` | Context service; scoped launch; fibers for observation/deadline; Stream later | Backend event translation, requested/effective/observed config, process/session identity and stop proof |
| `EventStore` | Context service; typed failures; Ref fake in Phase 0; platform FS later | Append/apply transaction, replay authority, monotonic sequence, durable result/event ordering |
| `ChildChannel` | Context service; Queue/Stream and Node Unix sockets later; Schema framing | Authentication, capability secrecy, sequence, size bounds, result single-writer/ACK protocol |
| `Presentation` | Best-effort service in a separate supervised fiber; PubSub after commit; annotated logs | Cannot dispatch semantic events or override reducer state; exact pane ownership/retention |
| persist-before-settle | Sequential Effect composition and narrow interruption masking make ordering explicit | Actual EventStore transaction/durability; result bytes/digest accepted before `self_settled` append |
| cancellation proof | Fibers coordinate waits/timeouts; Scope runs cleanup; Exit/Cause retain local outcome | Epoch/freeze, descendant snapshot, post-order dispatch, backend ACK/death evidence, `unknown` decision |
| first tracer bullet | Layer-provided fakes, Schema ingress, core Effect sequencing, captured Exit | Preserve the exact event sequence and one public result; no Stream/STM/platform machinery required |

### 4.1 Persist-before-settle

**Source fact.** Effect sequencing, uninterruptible masks, and finalization let a runtime make critical-section boundaries explicit. [`Effect.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts)

**Interpretation.** The tracer bullet can visibly sequence:

```text
validate result
→ EventStore.persistResult(bytes, count, digest)
→ append/apply result_persisted
→ append/apply self_settled
→ append/apply operation_completed
→ ACK / complete Handle.result
→ best-effort presentation
```

Effect prevents accidental Promise-chain omissions and makes interruption behavior testable. It cannot make separate writes atomic, and broad uninterruptibility around slow I/O would make cancellation unresponsive.

**Recommendation.** Give EventStore one deep acceptance operation that enforces the persistence and event-order invariant. Use only a narrow interruption mask around publication of the accepted outcome; permit interruptible I/O where cancellation/recovery can classify an ambiguous write and replay safely. ACK only from the committed acceptance result. Projection happens afterward and cannot feed completion back.

### 4.2 Cancellation proof

**Interpretation.** Effect improves the mechanics—bounded parallel observation, deterministic deadlines, finalizers, interruption-safe bookkeeping—but the Pions protocol is intentionally stricter than local structured concurrency.

**Recommendation.** Persist every proof-relevant step. The cancellation orchestrator should return a Pions evidence summary, not merely an Effect Exit. In particular:

1. atomically persist epoch and spawn freeze;
2. read a deterministic live-descendant snapshot;
3. dispatch backend cancellation post-order;
4. wait using Clock/TestClock for authenticated ACK or backend-specific process-death proof;
5. append `operation_cancelled` only when all required proof is present;
6. otherwise append `operation_unknown(reason=cancel_unproven)`;
7. interrupt/close leftover local fibers and scopes without rewriting already-terminal operations.

## 5. Robustness gained versus shallowness/overcomplication

### Robustness Effect adds

- typed operational failures instead of exception-only Promise plumbing;
- explicit expected failure versus defect versus local interruption;
- structured ownership of listeners, sockets, handles, and observation fibers;
- cleanup on startup failure/interruption through Scope;
- composable timeout/race logic with deterministic TestClock tests;
- replaceable internal services through Context/Layer;
- boundary validation from the same stable core package;
- bounded queues/backpressure and scoped streams when continuous events arrive;
- structured log/span correlation without making telemetry authoritative.

### Where Effect would make Pions shallower or less clear

- returning `Effect<…, …, RuntimeDependencies>` from public Runtime would outsource dependency assembly and execution policy to every caller;
- making callers inspect Cause would expose runtime mechanics instead of Pions result/cancellation vocabulary;
- encoding the reducer as Effects/Layers would hide a small deterministic transition table behind runtime machinery and weaken property testing;
- using fiber parenthood as operation lineage would replace durable domain truth with process-local liveness;
- using Scope close as operation cancellation would conflate cleanup request with cancellation proof;
- using PubSub/Stream as EventStore would replace durable ordered evidence with ephemeral transport;
- using STM before concurrent claims exist would duplicate the state machine and still not transact with durable storage;
- adding platform-node, OpenTelemetry, and Effect-specific test adapters in Phase 0 would expand dependency and teaching cost without helping the first success path.

**Recommendation.** The deep module boundary is: **Effect inside Runtime, plain Pions outside Runtime, pure reducer below Runtime**.

## 6. Patterns worth borrowing from `nicobailon/pi-subagents`

The pinned Pions review of `nicobailon/pi-subagents` remains applicable at commit [`7fe9dee1bc186592e3f2b95c07d86c02f2edd57a`](https://github.com/nicobailon/pi-subagents/tree/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a). Effect changes implementation mechanics, not Pions' decision about upstream semantics.

### Borrow

1. **Direct semantic event subscription, not terminal scraping.** Model AgentBackend as an Effect service producing typed observations; use Stream only when needed.
2. **`agent_end.willRetry` versus `agent_settled`.** Keep retrying end signals nonterminal and preserve the stronger settled watermark. [upstream lifecycle](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-lifecycle.ts)
3. **Requested/effective/observed model separation and mismatch failure.** Map backend details into Pions fields rather than accepting silent fallback. [model fallback](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/model-fallback.ts)
4. **Process-instance identity in addition to PID.** Effect's platform Process PID is insufficient; retain upstream's random launch-instance idea and exact-close evidence. [process terminal](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/process-terminal.ts)
5. **Capability ceilings and preflight rejection before resource creation.** Context services should receive only effective policy, not ambient authority. [child tool plan](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-tool-plan.ts)
6. **Session leases and fail-closed unknown outcomes.** Scope simplifies releasing leases, but ownership proof remains explicit persisted data. [session lease](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/session-lease.ts)
7. **Private files, argv arrays, prompt outside argv, bounded event projection, and exact resource identity.** Platform Command/FileSystem can support these patterns.
8. **Atomic promotion and dedupe as delivery techniques.** Combine with Pions' permanent EventStore rather than copying temporary replay files. [result files](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/result-files.ts)

### Do not borrow, and do not let Effect accidentally recreate

- parent terminal completion while descendants remain live;
- pre-order/unacknowledged subtree stop followed by early `stopped` publication;
- process/fiber/pane liveness as semantic completion;
- a second workflow/state model exposed beside Runtime;
- headless worker behavior for the Phase 1 visible-worker contract;
- best-effort files/PubSub as the authoritative append-only ledger.

Effect's `forkDaemon` and an incautious use of scope/fiber interruption could reproduce the first two problems in a different library vocabulary. Keep the Pions reducer and cancellation evidence protocol authoritative.

## 7. Minimal Phase 0 design

### Recommended internal shape

```ts
// Public, plain TS/Promise interface.
interface Runtime {
  spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle>
}

// Internal services may return Effect.
interface EventStore {
  acceptResult(input: AcceptedResult): Effect.Effect<AcceptedSnapshot, StoreError>
  // append/apply and replay methods omitted
}

interface AgentBackend {
  start(operation: Operation): Effect.Effect<BackendHandle, BackendStartError, Scope.Scope>
}

// Pure and synchronous.
function reduce(snapshot: Operation, event: OperationEvent): TransitionResult
```

Use Schema to define/decode `TaskSpec`, event envelopes, result messages, and persisted snapshots. Use Context Tags for the five major seams plus Clock and ID/token factories, then construct one Runtime layer. Keep test fakes as normal small service implementations.

### First tracer bullet

One test should run this internal program through the public adapter:

```text
Runtime.spawn(TaskSpec)
→ append operation_requested
→ append operation_starting
→ FakeAgentBackend.start
→ append operation_started
→ FakeChildChannel result
→ EventStore.acceptResult(bytes, byte count, digest)
→ append result_persisted
→ reduce/apply self_settled(succeeded)
→ reduce/apply operation_completed
→ publish result to Handle once
→ FakePresentation project (failure ignored/recorded)
```

The fake backend should count starts. EventStore should expose its accepted event sequence and stored result. FakeChildChannel should support duplicate-identical and conflicting-result cases. Presentation should support failure and a malicious/fake completed projection. All IDs, tokens, and timestamps are supplied; there is no random/global clock access.

### Why not more in Phase 0

- no Stream is needed for one typed fake result;
- no Queue/PubSub is needed for a synchronous fake event path;
- no STM is needed before concurrent spawn/cancel;
- no platform-node facility is in Phase 0 scope;
- no OpenTelemetry exporter is needed to test domain evidence;
- no separate schema package is needed;
- no Effect type needs to escape Runtime.

## 8. Alternatives

### A. No Effect in Phase 0; plain TypeScript/Promises throughout

**Advantages:** smallest dependency surface, most direct reducer/tracer bullet, no Effect learning cost.  
**Costs:** Phase 1 must hand-build interruption, resource scope, timeout, service substitution, and error/cause discipline or migrate orchestration later.  
**Verdict:** viable if the team is unwilling to commit to Effect v3 before v4 stabilizes; inferior if Phase 1 follows soon.

### B. Effect core only (**recommended**)

**Advantages:** one production dependency already contains Schema/TestClock/concurrency/resources; establishes the eventual orchestration model without platform bloat; lets reducer remain plain.  
**Costs:** version-generation discipline and internal Effect expertise are required; v4 migration will eventually be a separate decision.  
**Verdict:** best balance for Phase 0.

### C. Full Effect stack in Phase 0 (`effect`, platform-node, vitest, telemetry)

**Advantages:** one idiom for all runtime/platform/testing concerns from day one.  
**Costs:** violates Phase 0's actual needs, increases peer/transitive dependencies, tempts real platform use in deterministic tests, and risks prematurely designing around Stream/Layer/STM.  
**Verdict:** reject.

### D. Effect core plus `@effect/vitest`

**Advantages:** official `it.effect`/`it.scoped` helpers automatically provide Effect test services and make TestClock concise; upstream itself uses this pattern.  
**Costs:** pins Vitest 3 compatibility and adds an Effect-specific test surface.  
**Verdict:** acceptable optional dev choice after the test runner is selected; not a Phase 0 production requirement.

## 9. Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Mixing v3 stable and v4 preview docs/APIs | compile failures or subtly different semantics | Exact pins; use commit-pinned v3 source as authority; prohibit beta/rc/snapshot packages in lockfile. |
| Caller-facing Effect types | Runtime becomes a thin dependency-assembly facade | Promise-only public adapter; translate Exit/Cause and provide all Layers internally. |
| Effectful reducer | transition rules become harder to enumerate/replay/property-test | Pure synchronous reducer with explicit inputs; decode before it. |
| Local interruption mistaken for external stop | false `cancelled` terminal state | Separate local Cause from backend acknowledgement/process proof; reducer requires proof event. |
| Scope cleanup deletes evidence | failed/unknown pane/artifacts lost | Scope only disposable handles; encode retention policy explicitly. |
| Queue/PubSub loss or memory-only state | missing authoritative events/results | EventStore commit first; bounded nonlossy ingestion; PubSub only projection. |
| Broad uninterruptible regions | cancellation stalls | narrow masks around in-memory/publication critical sections; recoverable durable writes. |
| STM treated as durable transaction | restart loses freeze/idempotency/count claims | eventual store transaction owns durable claims; STM only process-local coordination. |
| Platform Command lacks process-tree proof | orphan worker or false cancellation | isolated spike; direct Node/OS supervisor adapter where needed; process-instance token and exact close proof. |
| Platform-node peer/dependency breadth | install and maintenance cost | defer to Phase 1; lock coherent exact stable matrix and inspect resulting lockfile before acceptance. |
| Redacted treated as secret isolation | extracted token leaks via logs/events | field allowlists, protocol checks, private descriptors/files, tests scanning argv/log/metadata. |
| Telemetry treated as truth | observer failures alter semantics | telemetry/presentation after persistence, best effort, never reducer input. |
| Effect v4 eventually becomes stable | migration pressure | isolate Effect internally; record v3 pin in an ADR; evaluate v4 only as a deliberate migration. |

## 10. Test strategy

### Pure reducer tests (no Effect test runtime required)

- table-test every legal and illegal transition;
- assert terminal immutability and outcome/descendant/handoff predicates;
- test duplicate, stale-sequence, wrong-actor, and wrong-capability rejection;
- property-test randomized event sequences against invariants;
- use fixed IDs/timestamps and plain immutable values;
- decode representative persisted fixtures separately with Schema.

### Runtime orchestration tests (Effect core)

- execute internal programs with fake Layers and capture `Exit`;
- use TestClock for deadlines, sleeps, retry, and cancel-ack timeout;
- test interruption at each persist-before-settle boundary;
- assert backend starts once under idempotent spawn;
- assert identical duplicate result is ACK-equivalent and conflicting result fails closed;
- assert presentation failure/fake completion cannot mutate EventStore;
- assert scoped fake resources finalize on startup failure without changing semantic state;
- assert defects and local interruption are translated to bounded Pions diagnostics.

### Second tracer bullet: descendants and cancellation

- root → child → grandchild cancellation dispatch is post-order;
- epoch/freeze and concurrent spawn claim are atomic at the chosen store seam;
- old/same/new epoch behavior is deterministic and idempotent;
- use Deferred/latches plus TestClock, never real sleeps;
- acknowledge all nodes for `cancelled`; omit one proof and advance time for `unknown(cancel_unproven)`;
- assert already-terminal descendants are not rewritten;
- assert closing/interruption of local fibers alone cannot satisfy proof.

### Phase 1 platform contract tests (later, still no live Herdr)

- fake CommandExecutor captures exact argv, shell=false, cwd, stdin, and `extendEnv:false` environment;
- fake FileSystem records `0700`/`0600`, temp-write, file sync, rename, and retained evidence behavior;
- fake socket transport tests partial frames, invalid token/version/operation/sequence, oversized initial/result data, duplicate/conflicting results, and disconnects;
- process supervisor fixtures distinguish kill request, signal acknowledgement, exact exit observation, PID reuse/process-instance mismatch, and unknown proof;
- no automated test enumerates or targets a live pane; fake Herdr responses supply opaque identities.

**Source fact.** Official Effect tests demonstrate Effect-aware Vitest tests, TestClock control, fiber interruption/finalization, bounded queue behavior, and explicit platform layer composition at the pinned commits. [`TestClock.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/TestClock.test.ts) · [`Fiber.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Fiber.test.ts) · [`Queue.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Queue.test.ts) · [`CommandExecutor.test.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/test/CommandExecutor.test.ts)

**Interpretation.** These establish upstream behavior and useful testing patterns, not that Pions' domain invariants or OS cancellation proof are supplied by Effect.

## Final recommendation

1. Record Effect **v3 stable** as the selected generation and pin `effect@3.22.1` exactly (canonical source commit `417e0faa80e471d77fc4a67452e68b09ae0ee861`).
2. Add no standalone Schema package. Explicitly reject all Effect 4 beta/RC/snapshot APIs for this implementation line.
3. Keep the reducer pure and exhaustive; use Schema only at boundaries.
4. Keep Runtime/Handle caller-facing APIs Promise-based and Pions-named; contain Context/Layer/Exit/Cause internally.
5. Use Effect core in the first tracer bullet for service substitution, sequencing, typed failures, Scope, and deterministic time—but introduce Stream/Queue/STM only when their concurrency problem appears.
6. Defer `@effect/platform-node@0.108.1` and its coherent peer set to the Phase 1 dependency decision. Use its filesystem and Unix sockets behind Pions seams; accept its command runner only after a static/spike review of process-group ownership and cancellation proof.
7. Keep Pions' durable EventStore, persist-before-settle acceptance operation, reducer, and cancellation evidence protocol authoritative. Effect improves their implementation; it does not replace their semantics.
