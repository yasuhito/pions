# Pions Phase 0 / Phase 1 要求仕様

**Status:** Proposed baseline; TypeScript runtime decision accepted; remaining design under review; implementation not started  
**Date:** 2026-09-06  
**Inputs:** `pions-herdr-subagent-design.html`, `herdr-pi-extensions.md`

## 1. Runtime and package decisions

### Confirmed facts

- Pythonは前セッションの引き継ぎ文に含まれていただけで、選定根拠やADRは存在しなかった。
- 利用者はPi ecosystemとの整合と依存関係削減を理由に、Pions runtimeをTypeScript/Nodeで実装すると決定した。
- PyPI の `subagent==0.3.2` は VS Code/Copilot workspace を払い出す非保守CLIであり、Pions backendではない。この候補の調査は歴史的記録として残すが、今後のruntime選定には関係しない。

### Decision P-001 — accepted

Pionsのruntime、domain model、state reducer、Pi/Herdr adapterは **TypeScript/Node** で実装する。Python sidecarを標準構成にせず、Phase 0はagent package非依存で進める。

具体的なPi SDK/APIおよびEffect packageの採用範囲と固定versionは一次ソース調査後に決める。調査前に依存へ追加しない。

### Primary reference implementation: `nicobailon/pi-subagents`

`nicobailon/pi-subagents` は commit `7fe9dee1bc186592e3f2b95c07d86c02f2edd57a` で静的調査した。これはmanifest version `0.65.1`のTypeScript/Node Pi extensionである。annotated tag `v0.65.1` のtag objectは `dbe28f181fc5c17c6c62de28c396e6cbf6fefa3b`、peel先commitは `83be9c3de2cde1553c0269f383efc1eb1194dc8b` であり、調査対象HEADとは異なるためrelease artifactと同一視しない。

これはPionsの**主要な参照実装**として継続的に利用するが、そのまま依存またはforkにはしない。直接のPi event購読、`agent_end.willRetry`と`agent_settled`の区別、model検証、process-instance identity、capability ceiling、session lease、停止証明不能時の`unknown`を設計へ取り込む。一方、headless worker、親先行completion、acknowledgement前の`stopped` publicationはPionsの要求と異なるためコピーしない。

詳細: `research/nicobailon-pi-subagents.md`

### Proposed Decision P-002 — Effect v3 core

Phase 0では `effect@3.22.1` のみをexact pinで採用する。Effect 4 beta/RC APIと混在させない。Schemaはcore `effect` packageに含まれるため`@effect/schema`を追加しない。`@effect/platform-node`、`@effect/vitest`、Stream/Queue/STM、OpenTelemetryは実際の問題が現れるPhaseまで追加しない。

EffectはRuntime内部のtyped errors、resource scope、structured in-process concurrency、dependency substitution、deterministic clockへ使う。caller-facing `Runtime`/`Handle` interfaceはplain TypeScript/Promiseのままにし、`Effect`、`Layer`、`Context`、`Exit`、`Cause`を漏らさない。reducerはpure synchronous functionを維持する。fiber interruption、Scope finalization、PubSub通知をoperation completion/cancellationの証拠として扱わない。

一次ソース調査: `research/effect-for-pions.md`

### Backend implementation acceptance gate

候補 package は、隔離した spike で以下を満たさなければ採用しない。

1. 1 operation を独立 OS process として起動できる、または Pions worker wrapper の独立 process 内だけで実行できる。
2. async 実行と cancellation を提供し、Pions の deadline/abort を伝播できる。
3. semantic final result と失敗を型付きで取得できる。stdout/terminal scraping を必要としない。
4. lifecycle/tool/message/usage の stream または callback を取得できる。取得不能な項目は明示できる。
5. requested model/reasoning と observed model/reasoning を照合できる。silent fallback を強制しない。
6. tool surface を operation ごとに制限できる。
7. 子から Pions Runtime の `spawn` tool を呼べる。package 自身の暗黙な再帰を lineage として扱わない。
8. prompt、token、result を process argv に置かなくてよい。
9. package 独自 session ID または process identity を記録できる。
10. unsupported capability を成功として偽装しない。

## 2. System seam

呼び出し側が学ぶ外部 interface は `Runtime` だけとする。

```ts
const handle = await runtime.spawn(task, {
  parentOperationId: context.operationId,
});
const result = await handle.result();
await handle.cancel({ scope: "subtree" });
```

内部 seam:

- `AgentBackend`: package 固有イベントと操作を Pions vocabulary へ変換する。
- `PresentationAdapter`: worker の表示・観測を担当する。Phase 1 は `HerdrPresentation`。
- `EventStore`: operation snapshot と append-only event を保存する。
- `ChildChannel`: child reporter と Runtime の認証付き通信を担当する。

Herdr は presentation/liveness adapter であり、semantic result の正本ではない。

## 3. Shared domain contract

### 3.1 `TaskSpec`

必須:

- `prompt_ref`: private artifact または channel 上の参照。prompt 本文を argv に入れない。
- `profile`: policy 解決に使う closed identifier。
- `idempotency_key`: 同一 parent scope 内で一意。

任意:

- `model`, `reasoning`, `tools`, `cwd`
- `deadline`
- `result_size_limit`

`requested_config`、policy 適用後の `effective_config`、backend 実測の `observed_config` を別々に保持する。

### 3.2 `Operation`

最低限保持する field:

- `operation_id`, `root_operation_id`, `parent_operation_id`, `depth`
- `state`, `state_seq`, `self_outcome`
- `spawn_frozen`, `cancellation_epoch`
- requested/effective/observed config
- child operation IDs
- backend process/session identity
- Herdr workspace/tab/pane IDs と `surface_owned_by_pions`
- created/started/self-settled/terminal timestamps と deadline
- result pointer, byte count, digest
- terminal reason code

### 3.3 States

Non-terminal:

- `queued`
- `starting`
- `running`
- `blocked`
- `self_settled`
- `draining_descendants`
- `cancelling`

Terminal:

- `completed`
- `failed`
- `cancelled`
- `unknown`

`failed_to_cancel` は state にせず、`unknown` の reason code とする。これにより「停止を証明できないが failed と断言した」状態を避ける。

`self_outcome` は `succeeded | failed`。子孫が残る場合、self failure でも直ちに terminal にせず drain してから `failed` へ進む。

### 3.4 Legal transitions

```text
queued -> starting
starting -> running | self_settled(failed)
running <-> blocked
running | blocked -> self_settled(succeeded|failed)
self_settled -> draining_descendants | completed | failed
draining_descendants -> completed | failed

any non-terminal -> cancelling
cancelling -> cancelled | unknown
```

Rules:

- terminal state から遷移しない。
- `completed` は `self_outcome=succeeded`、全子孫 terminal、pending result handoff 0 の場合だけ。
- `failed` は self failure または policy 上伝播する descendant failure があり、全子孫 terminal、pending handoff 0 の場合だけ。
- `blocked` は terminal ではなく `running` へ戻れる。
- process exit、Herdr `idle/done/unknown`、terminal text は単独で semantic transition を確定しない。
- event の重複・古い `seq`・異なる actor/capability は state を変更しない。

### 3.5 Events

全 event は `event_id`, `operation_id`, operation 単位で単調増加する `seq`, timestamp, actor identity, schema version を持つ。

Minimum vocabulary:

- `operation_requested`
- `operation_starting`
- `operation_started`
- `activity_observed`
- `operation_blocked`, `operation_unblocked`
- `child_attach_requested`, `child_attached`, `child_attach_rejected`
- `self_settled`
- `result_persisted`
- `descendant_drain_started`
- `cancellation_requested`, `cancel_dispatched`, `cancel_acknowledged`
- `operation_completed`, `operation_failed`, `operation_cancelled`, `operation_unknown`

Events are append-only. Snapshot は event 適用の cache であり、イベントと矛盾した場合は再構築できること。

## 4. Phase 0 — deterministic state machine

### 4.1 Scope

実 Herdr、実 agent package、network、wall-clock sleep、SQLite を使わない。

Deliverables:

- immutable/validated domain types
- pure transition reducer
- `Runtime` の最小 orchestration implementation
- `FakeAgentBackend`
- `InMemoryEventStore`
- controllable fake clock
- deterministic operation ID/token factory

Phase 0 の fake nested spawn は状態機械を検証するためのもの。実 child Runtime client と永続 lineage は Phase 2。

### 4.2 Initial policy

```yaml
max_depth: 2
max_children_per_operation: 3
max_live_descendants_per_root: 4
parent_exit_policy: cancel_descendants
completion_policy: wait_for_descendants
```

Limit 超過は queue にせず、typed rejection と event を返す。拒否された要求に operation/surface/process を作らない。

### 4.3 Settlement semantics

- worker の semantic result を永続化してから `self_settled` を適用する。
- 子が0、handoff が0なら terminal outcome を同一 reducer cycle で導出できる。
- 子がある場合は `draining_descendants` へ進む。
- 親へ公開する terminal result は一度だけ。再読込は replay であり再注入ではない。

### 4.4 Cancellation semantics

1. cancellation epoch を増やし、対象 subtree の新規 spawn を atomic に freeze する。
2. live descendants の snapshot を取り、post-order（末端優先）で cancel を dispatch する。
3. 各 child の terminal/cancel acknowledgement を deadline まで待つ。
4. 全停止を証明できれば対象を `cancelled` にする。
5. 一つでも停止を証明できなければ対象を `unknown(reason=cancel_unproven)` にする。
6. 既に terminal の node の outcome は書き換えない。

同じ cancellation epoch の再要求は idempotent。より古い epoch は拒否する。

### 4.5 Required tests

少なくとも以下を table/property tests で固定する。

- 全 legal transition と全 illegal transition
- result persistence 前に `self_settled` できない
- child なしの成功/失敗
- child ありで parent が先に self-settle
- child failure の伝播 policy
- blocked -> running -> self-settled
- depth/fan-out/live-descendant limit の拒否と resource 0件
- 同一 idempotency key が同じ handle を返し二重 spawn しない
- cancellation freeze と cancellation 中の spawn 拒否
- root -> child -> grandchild の post-order cancel
- cancel timeout が `unknown` になる
- terminal state が immutable
- duplicate/out-of-order/unauthenticated event が無効
- randomized event sequence でも invariant を破らない

### 4.6 Exit criteria

- test が terminal、subprocess、network、実時間 sleep に依存しない。
- 任意の operation tree について、なぜ terminal かを event列から説明できる。
- cancel dispatch 順が deterministic に検証できる。
- backend/presentation/store を差し替えても reducer を変更しない。

## 5. Phase 1 — Herdr visible worker MVP

### 5.1 Scope

一度に1 operation、入れ子なし、blocking `spawn -> result` の vertical slice。Phase 0 と同じ state reducer を使い、Phase 1 専用の第二状態機械を作らない。

### 5.2 Environment and ownership

- `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` を preflight する。
- Phase 1 では headless fallback をしない。Herdr 不在は typed precondition failure。
- caller の Pions pane を `--current` で split し、`--no-focus` と明示 `cwd` を使う。
- creation response の opaque pane ID だけを以後の target に使う。
- Pions が作った pane と、その identity を operation に永続化できた場合だけ `surface_owned_by_pions=true`。
- 既存 pane、Qoral workspace/pane、focused pane、推測した ID を target/rename/close/input しない。
- Phase 1 は workspace や worktree を作成しない。

Installed compatibility baseline observed for design: Herdr `0.8.2`; `pane split/run/report-agent/report-agent-session/report-metadata/release-agent` are available. Implementation は installed CLI help/JSON response を contract fixture に固定する。

### 5.3 Launch transaction

1. Validate task/config/environment.
2. Persist `operation_requested` and private operation directory.
3. Create prompt/config artifacts as mode `0600` under a mode `0700` run directory.
4. Split the current Pions pane with no focus; persist returned pane identity and ownership.
5. Start exactly one Pions worker wrapper in that pane.
6. Worker reads prompt/config by private path or authenticated local channel, never prompt argv.
7. Worker authenticates and emits `started`; Runtime records backend process/session identity.
8. Backend emits semantic result; Runtime validates, size-bounds, persists, hashes, ACKs, then settles.
9. Runtime projects state to Herdr. Projection failure degrades observability but cannot manufacture semantic completion.

Before step 4, rollback creates no Herdr resource. After step 4, startup failure may close only the newly created, exact-identity pane if no evidence worth retaining exists; otherwise retain it and record the reason.

### 5.4 Child channel

- Phase 1 default: Unix domain socket. Private mailbox may be used only if package constraints require it and must satisfy the same protocol.
- Per-operation random capability (minimum 256 bits), operation ID, protocol version, monotonic child sequence.
- Socket/run directory `0700`; prompt/config/result/error artifacts `0600`.
- Capability is not logged, displayed in Herdr metadata, persisted in plaintext event payload, or passed in argv. A private capability file or inherited descriptor is acceptable.
- Closed message types: `hello`, `started`, `activity`, `blocked`, `unblocked`, `result`, `failed`, `cancel_ack`.
- Authenticate before parsing unbounded payloads; enforce per-message and total-result limits.
- Result acceptance is single-writer and at-most-once. Duplicate identical result is ACKed without redelivery; conflicting second result fails closed.

### 5.5 Herdr projection

Use a dedicated source namespace, e.g. `pions`, and operation-scoped agent label. Project only bounded, non-secret data:

- short operation ID and profile
- current Pions state
- effective model/reasoning when known
- elapsed time and bounded usage when available

Mapping:

- `starting`, `running`, `draining_descendants`, `cancelling` -> Herdr `working` plus Pions state label
- `blocked` -> Herdr `blocked`
- settled success/failure -> report final metadata, then `release-agent`; terminal pane retention is a Pions policy
- uncertain adapter/process state -> Herdr `unknown`; never map it to Pions completion

All updates carry monotonic `seq`. Projection errors are recorded and retryable.

### 5.6 Liveness vs completion

- Herdr/process state proves only visibility/liveness.
- Authenticated backend result is semantic evidence.
- Runtime persists result before sending ACK and before terminal transition.
- Process exit without accepted result -> `failed(reason=process_exited_without_result)` if death is proven.
- Lost/unidentifiable process -> `unknown(reason=liveness_unproven)`.
- Herdr pane disappearance cannot be interpreted as successful completion.

### 5.7 Cancellation and retention

- Phase 1 cancel means cancelling the single operation; subtree behavior is inherited from Phase 0 but has no descendants.
- Send backend cancellation first, wait to deadline, then escalate according to the selected package adapter contract.
- Proven stop -> `cancelled`; unproven stop -> `unknown`.
- `blocked`, `failed`, `unknown` panes are always retained.
- Successful panes are retained in Phase 1; automatic success cleanup is out of scope.
- `cancel`, `close surface`, and `forget history` remain distinct operations.

### 5.8 Required tests

Automated tests must use a fake Herdr executable/session, not existing live panes:

- exact argv, shell-free subprocess invocation, no focus theft
- response ID parsing; no predicted/focused ID use
- launch success and report projection sequence
- split failure creates no owned surface
- run/start failure only rolls back exact newly-created surface
- result persisted before ACK/terminal transition
- duplicate and conflicting result handling
- invalid token, operation ID, protocol version, sequence, oversized payload
- process exit without result
- missing pane/projection failure does not create completion
- cancellation acknowledged vs unproven
- evidence pane retention rules
- prompt/capability absent from argv, logs, and Herdr metadata
- no command ever targets a fixture representing pre-existing/Qoral surfaces

One manual acceptance test may create a **new Pions-owned sibling pane from the Pions caller pane only**. It must not enumerate for mutation or target existing Qoral panes.

### 5.9 Exit criteria

- Human can watch one real worker in a newly created Pions-owned Herdr pane without focus theft.
- The final result and state can be reconstructed from Pions records without reading terminal output.
- Killing the worker before/after result persistence yields the specified `failed`/terminal behavior without false success.
- No existing pane is changed or closed.
- The selected backend package has passed the acceptance gate and its observed event/cancellation matrix is documented.

## 6. Explicitly deferred

- child Runtime client and real nested spawn
- SQLite/WAL and restart reconciliation
- parallel/background public interface
- worktrees and writable-scope arbitration
- automatic pane cleanup
- persistent reusable workers
- generic Herdr model tool
- scheduler/DAG/review workflow

These belong to Phase 2+ and must not enlarge the Phase 0/1 interface.

## 7. Remaining blocking inputs

Decision P-001（TypeScript/Node）はclosed。Phase 0開始前に残るdependency decisionは以下:

- Proposed Decision P-002（`effect@3.22.1` core only）をacceptedにするか
- Piのchild session/event interfaceをどの公式package/versionから利用するか
- test runnerとTypeScript build/check toolchain

Phase 0のtracer bullet自体は実agent packageなしで開始可能。project scaffoldとdependency追加はEffect decisionおよびtoolchain選定後に行う。

## 8. First tracer bullet

### Decision T-001

最初のtracer bulletは **agent package/platform非依存のsingle-operation success path** とする。Effect coreをRuntime内部で使うが、実agent、実subprocess、実Herdr、network、SQLite、nesting、cancellationは入れない。

一本のtestから以下の全seamを通す。

```text
Runtime.spawn(TaskSpec)
  -> operation/event persistence
  -> FakeAgentBackend start
  -> FakeChildChannel typed result
  -> result bytes + digest persistence
  -> reducer self_settled(succeeded)
  -> completed derivation
  -> Handle.result()
  -> FakePresentation projection
```

Acceptance:

1. `TaskSpec(prompt_ref, profile, idempotency_key)` から1 operationを作る。
2. event列は最低でも `operation_requested -> operation_starting -> operation_started -> result_persisted -> self_settled -> operation_completed` となる。
3. result本文・byte count・digestが保存される前に`self_settled`または`completed`へ進めない。
4. `Handle.result()` はtyped resultを一度公開し、同じidempotency keyの再spawnは同じhandle/resultを返してbackendを二重起動しない。
5. 同一seq・同一digestのresult再送はACK相当として無害、同じoperationに異なるdigestの二つ目のresultはfail closedとなる。
6. presentation failureまたは偽の`completed` projectionはoperation stateを変更できない。
7. EffectのClock/TestClockとdeterministic ID/token factoryを使い、testは実時間sleepや外部processに依存しない。
8. internal orchestrationはfake Layer群で実行して`Exit`を検証できるが、public `Runtime`/`Handle`からEffect型を返さない。
9. reducerはEffect programにせず、plain immutable input/outputのpure synchronous functionとする。

このbulletの目的はstate vocabularyを網羅することではなく、`Runtime`、backend、channel、store、presentationのseamと「persist-before-settle」という最重要orderingを最小のvertical sliceで実証すること。次のbulletでparent/child drainとdescendant-first cancellationを追加し、その後にfake Herdr launch transactionへ進む。
