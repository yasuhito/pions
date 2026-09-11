# 静的レビュー：`7fe9dee1bc186592e3f2b95c07d86c02f2edd57a` 時点の `nicobailon/pi-subagents`

**レビュー対象リビジョン：** [`7fe9dee1bc186592e3f2b95c07d86c02f2edd57a`](https://github.com/nicobailon/pi-subagents/tree/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a)
**コミットのタイムスタンプ／メッセージ：** 2026-09-06 00:09:30 UTC、`fix(runtime): keep unconfigured prompt-runtime loads inert (#1984)`
**当該リビジョンでのマニフェストバージョン：** `pi-subagents` 0.65.1
**リリースに関する注意事項：** 注釈付きタグオブジェクト `v0.65.1` は `dbe28f181fc5c17c6c62de28c396e6cbf6fefa3b` であり、レビュー対象コミットではなく、コミット `83be9c3de2cde1553c0269f383efc1eb1194dc8b` を指す。レビュー対象スナップショットは同じマニフェストバージョンを持つ現在の `HEAD` であり、タグ付きリリース成果物として記述してはならない。
**手法：** コミットに固定された README、マニフェスト、ドキュメント、関連する TypeScript ランタイムモジュール、および関連する単体／統合テストを静的に調査した。パッケージは**インストールも実行もしていない**。稼働中の Herdr ペイン／ワークスペースおよび Qoral 成果物の調査や操作は行っていない。

## 後続のアーキテクチャ決定

このレビューの後、ユーザーは言語間依存を減らして Pi と整合させるため、Pions に TypeScript/Node を選択した。これにより、レポート当初の言語／形態に関する異議は解消されるが、以下に記載するライフサイクルおよび Herdr との非互換性は変わらない。したがって、`nicobailon/pi-subagents` は主要な参照実装ではあるが、選択された依存関係でも、そのまま置き換え可能な Pions ランタイムでもない。

## エグゼクティブ結論

### パッケージの実体

**ソース上の事実。** これは Python バックエンドではなく、**TypeScript/Node の Pi 拡張機能**である。マニフェストは `type: "module"` を宣言し、`index.ts` と TypeScript API サブパスをエクスポートし、`pi.extensions` 配下に `./index.ts` を登録し、Pi の JavaScript パッケージに依存している。フォアグラウンド経路は親プロセス内で Pi `AgentSession` オブジェクトを作成し、バックグラウンド経路は切り離された Node/Jiti ランナーを起動して、そのランナープロセス内で Pi セッションを作成する。[マニフェスト](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/package.json) · [子セッションファクトリ](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-session.ts) · [バックグラウンド起動](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/async-execution.ts)

**解釈。** これは、想定されていた Python エージェントパッケージとして Phase 0/1 Decision P-001 を満たすことはできない。機能豊富なオーケストレーション拡張機能であり、設計パターンの有用な情報源ではあるが、Pions のバックエンドとして使用するには Node/Pi サイドカー、または Pi の拡張ランタイムを中心とした Pions の再設計が必要になる。

### 全体的な適合性

| 問い                                   | 判定                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Python `AgentBackend` の候補           | **競合** — ランタイム／パッケージ形態が異なり、Python API がない。                                                                                                                                                                                                             |
| 独立プロセス型の非同期バックエンド     | **部分的に適合** — バックグラウンド実行には切り離された Node ランナーがあるが、フォアグラウンド実行はプロセス内であり、公開されている構造化委譲 API はフォアグラウンド専用である。                                                                                             |
| Phase 1 の可視 Herdr ワーカー          | **競合** — 通常の実行は意図的にヘッドレスである。Herdr はメタデータ／調査／ピアペイン統合であり、子の表示基盤ではない。                                                                                                                                                        |
| セマンティックな結果／イベントソース   | **優れた設計材料** — ネイティブな子セッションを直接監視し、端末のスクレイピングではなく、型付きの結果と Pi イベントを使用している。                                                                                                                                            |
| Pions に必要な状態／イベントプロトコル | **相当量のラッパー状態があればアダプターで解決可能** — パッケージのステータスファイルは有用だが、Pions の追記専用で認証済みの操作プロトコルではない。                                                                                                                          |
| 必須の入れ子型完了待機／キャンセル     | **競合** — 入れ子と制限は存在するが、子孫が継続中でも親が終了し得る。stop は子孫の確認応答より前に親を stopped とし、ディスパッチの走査順は後行順ではない。                                                                                                                    |
| 永続化／復旧                           | **混在** — 運用成果物、セッション識別、陳腐化した実行の修復、および再読み込み時の復元は強力だが、権威ある永続イベントストアではなく、Pions の厳密に再生可能な reducer と同等でもない。                                                                                         |
| セキュリティ境界                       | **混在** — ツールの上限、パス検査、非公開の選択ファイル、シェルを介さないプロセス起動、およびフェイルクローズな証明は有用だが、通常のネイティブな子はプロセスの認証情報を継承し、worktree はサンドボックスではなく、複数の成果物／制御ファイルは認証済みの子チャネルではない。 |

**推奨。** このパッケージを Pions の Python バックエンドとして選択したり、通常の Herdr 統合を Phase 1 の可視ワーカーの縦断的スライスに使用したりしては**ならない**。直接的な Pi イベント購読、明示的な `agent_settled` の処理、プロセスインスタンスの証明、モデル検証、ケイパビリティ上限、制限付きファンアウトの主張、セッションリース、フェイルクローズな worktree クリーンアップといった選定したアイデアを、Pions 独自の Python コントラクトの背後で再利用すること。

## エビデンスと分類ルール

- **適合：** 固定されたソースが、関連要件をすでに満たしているか、要件を弱めずに必要なエビデンスを提供している。
- **アダプターで解決可能なギャップ：** Pions は、パッケージの基礎的なセマンティクスを維持しながら、不足している投影、永続化、またはラッパーの振る舞いを追加できる。
- **競合：** パッケージ形態またはライフサイクルのセマンティクスが Phase 0/1 の不変条件と矛盾しており、解消するにはパッケージを迂回するか、実質的に変更する必要がある。
- 「ソース上の事実」は、固定されたコミットが実装している内容を報告する。「解釈」は、その実装を Pions の要件と比較する。「推奨」は規範的なものであり、アップストリームの振る舞いについての主張ではない。

## 1. プロセスと実行モデル

### 1.1 プロセス分離

**ソース上の事実。**

- フォアグラウンド（`async: false`）の子は、**親 Pi プロセス内**で作成される Pi セッションである。ファクトリは 1 つの `ModelRuntime` を共有し、子ごとに個別のセッションマネージャー／リソースローダーを作成し、一時的に `process.env` を適用する時間帯を直列化し、可能であれば Pi の拡張機能キャッシュをリセットする。[README](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/README.md) · [child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-session.ts)
- バックグラウンドの子は、切り離された Node プロセス内で実行される。ランチャーは非公開のランナー設定を書き込み、argv 配列を使う `spawn` で Node + Jiti + `subagent-runner.ts` を起動し、stdout/stderr をファイルへリダイレクトし、PID とランダムな `runnerProcessInstanceId` を記録して、プロセスを unref する。POSIX は `detached: true` を使用するが、Windows は使用しない。[async-execution.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/async-execution.ts) · [background-process-options.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/background-process-options.ts)
- 1 つのバックグラウンドランナーが複数の子 Pi セッションをホストできる。したがって、トップレベルの非同期実行にはランナープロセス境界があるものの、論理的な操作／ステップが必ずしも 1 つの OS プロセスに対応するとは限らない。[subagent-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/subagent-runner.ts)
- オプションの `external-cli` プロファイルは、stdin 経由またはアダプター所有モードでプロンプトを渡し、argv 配列のプロセスを起動する。そのプロセスグループは POSIX 上で終了および検証できる。これらには、ネイティブ Pi の多くのケイパビリティが意図的に欠けている。[external-cli-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/external-cli-runner.ts) · [ツールリファレンス](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/tool-reference.md#external-cli-agent-profiles)

**解釈。** バックエンド受け入れゲート 1 を満たすのは、バックグラウンドランナーという解釈（「独立したラッパープロセス内」）の場合に限られる。フォアグラウンド実行はプロセス分離されていない。共有ランナー／プロセス環境は、Pions が望む 1 操作／ワーカー単位の境界よりも弱い。

**分類：** バックグラウンド専用 Node アダプターについては**アダプターで解決可能なギャップ**。フォアグラウンドモードまたは 1 操作 1 プロセスが必要な場合は**競合**。

### 1.2 フォアグラウンド、バックグラウンド、並列、およびチェーン実行

**ソース上の事実。**

- `async:false` はブロックし、プロセス内のフォアグラウンドな子をストリーミングする。デフォルトのワークフロー実行はバックグラウンドであり、切り離されたフォアグラウンド実行もサポートされる。[README](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/README.md) · [可観測性](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/observability.md)
- 現在の合成方法は `workflowScript` である。キー付き／逐次処理には `runs.run`、並列処理には `runs.all`、並列な逐次レーンには `runs.lanes`、ローリングファンアウトには通常の Promise コンビネーターを用いる。レガシーなトップレベルの `chain`、`tasks`、`parallel` 入力は拒否される。[ワークフロー](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/workflows.md) · [ツールリファレンス](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/tool-reference.md)
- 並列タスクは、タスクおよび並行性の設定によって制限される。通常のデフォルト並行数は 4 で、ワークフロー全体のデフォルト `globalConcurrencyLimit` は 20 である。[設定](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/configuration.md#parallel)

**解釈。** これは、公開のバックグラウンド／並列 API が延期されている Phase 1 の範囲を大幅に超えている。その内部実行プリミティブは有用なエビデンスだが、この拡張機能を採用すると MVP の対象範囲が拡大し、別のワークフロー／状態モデルが持ち込まれる。

**分類：** 実行能力は**適合**。Phase 0/1 のスコープ整合性は**競合**。

### 1.3 非同期、期限、ステアリング、中断、およびキャンセル

**ソース上の事実。**

- バックグラウンド実行は即座に戻り、ファイルの受信箱によって制御される。`interrupt` は実行中の子ターンを一時停止／再開可能な形で中止する。`stop` は終端的で再開不能である。`steer` と `follow_up` には確認応答レシートがある。実行期限とツール単位の期限はセッションを中止する。[control-channel.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/control-channel.ts) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts) · [ツールリファレンス](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/tool-reference.md#status-and-control-actions)
- フォアグラウンド実行は `AbortSignal` をリッスンし、`session.abort()` を呼び出し、セッションが完了しない場合には時間制限付きの強制終了フォールバックを備えている。[フォアグラウンド実行](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/foreground/execution.ts)
- POSIX 上では、所有している外部プロセスグループへ `SIGTERM`、次に `SIGKILL` を送り、その後 `ps` に基づいて検証する。未対応または検証不能な場合は `unknown` を返す。[owned-process-tree.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/owned-process-tree.ts) · [テスト](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/owned-process-tree.test.ts)

**解釈。** ゲート 2（非同期とキャンセル）は、ネイティブなバックグラウンド実行について概ね満たされている。ただし、パッケージの `stop` は Pions の証明済みサブツリーキャンセルプロトコルではなく、ネイティブ子セッションの中止は OS プロセスツリーの証明とは論理的に別物である。

**分類：** 基本的な非同期／期限伝播は**適合**。Pions のキャンセルセマンティクスは**競合**（詳細は §5）。

## 2. 結果と完了のセマンティクス

### 2.1 ネイティブ Pi のセマンティックな結果

**ソース上の事実。** ネイティブな両起動経路は子 `AgentSession` を直接購読し、最終的なアシスタントメッセージ、使用量、ツールイベント、モデル、エラー、セッション識別情報、構造化出力のキャプチャ、および受け入れエビデンスを収集する。ネイティブ Pi の成功を端末テキストのスクレイピングから導出することはない。[フォアグラウンド実行](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/foreground/execution.ts) · [バックグラウンド子ドライバー](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)

ネイティブテキスト、ファイルのみの出力、およびスキーマ検証済みの構造化出力は、それぞれ異なる結果モードである。空の終端出力、モデル不一致、必須出力の欠落、拡張機能／ツールのセットアップエラー、タイムアウト、stop、およびプロバイダー障害は、結果を型付きの失敗に変え得る。[structured-output.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/structured-output.ts) · [single-output.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/single-output.ts)

**解釈。** これはネイティブ Pi セッションに関する受け入れゲート 3 を満たしている。ただし、Pions の認証済み結果メッセージ／ACK トランザクションは提供しない。バックグラウンドの結果の権威性は、パッケージ所有のローカルファイルとランナー／ウォッチャーの関係によって実装されている。

**分類：** セマンティックな型付き結果は**適合**。Pions の結果チャネルコントラクトは**アダプターで解決可能なギャップ**。

### 2.2 `agent_end` と `agent_settled` の比較

**ソース上の事実。** `projectChildLifecycle` は、`agent_end.willRetry === true` の場合に最終ドレインタイマーを明示的にキャンセルする。compaction の再試行がアクティブなままでない限り、`agent_settled` が終端ドレインを開始する。終端のアシスタント `stop` も短いドレインを開始できる。プロンプト／セッションがスタックしたままの場合、ホストは 1 秒の猶予後に中止し、さらに 3 秒後に強制終了する。[child-lifecycle.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-lifecycle.ts) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)

統合テストは、再試行する `agent_end`、compaction の再試行、およびフォアグラウンド／バックグラウンド経路におけるクリーンな終端ウォーターマークとしての `agent_settled` を明示的にカバーしている。[フォアグラウンドテスト](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/integration/single-execution.part-2.test.ts) · [バックグラウンドテスト](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/integration/async-execution.part-1.test.ts)

**解釈。** このパッケージは、再試行する `agent_end` を最終状態として扱うことを正しく回避し、`agent_settled` をより強い Pi ウォーターマークとして認識している。追加の「終端アシスタント stop + 時間制限付き強制クリーンアップ」経路があるため、`agent_settled` はパッケージの終端結果にとって絶対的な前提条件ではない。これは、Pions がウォーターマークの欠落と、その結果として得られるエビデンスを明示的に記録する場合に限り、防御的なパッケージポリシーとして許容できる。
**分類:** イベント間の区別は **適合**。Pions の厳密な証拠ポリシーには **アダプターで解決可能なギャップ**。

### 2.3 公開と at-most-once の動作

**ソース上の事実。** 非同期の結果は、まずセッションで修飾された pending パス配下に書き込まれ、アトミックに昇格される。watcher は配信後に one-shot の結果を削除する前に、サイズ制限付きの replay/archive を書き込む。インメモリ/TTL の完了重複排除キーには、session、run、state が含まれる。リプレイには有効期限があり、永続的な台帳ではなく、ベストエフォートの一時状態として説明されている。[result-files.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/result-files.ts) · [completion-replay.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/completion-replay.ts) · [completion-dedupe.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/completion-dedupe.ts)

**解釈。** これは優れた配信実装だが、Phase 0 の永続的な、settlement より前に結果を記録する追記専用イベント履歴ではない。重複し競合する子の結果は、Pions の単一 writer 認証済みプロトコルによって管理されない。

**分類:** 配信順序/重複排除は **部分的に適合**。永続的でリプレイ可能な settlement には **アダプターで解決可能なギャップ**。

## 3. イベント、コールバック、設定、可観測性

### 3.1 イベントとコールバック

**ソース上の事実。** ネイティブセッションは、`agent_start`、`message_end`、`message_update`、`tool_execution_start/end`、`tool_result_end`、compaction/retry イベント、`agent_end`、`agent_settled` の直接コールバックを公開する。バックグラウンド実行は、サイズ制限付きの子イベントを `events.jsonl` にミラーリングする。`message_update` はサイズ無制限の部分本文を省略する。公開/API プロセス内 API は、started/completed、control、process-terminal、構造化された delegation update/terminal response、Fleet status、extension acknowledgement イベントを公開する。`pi.events` は明示的にプロセスローカルである。[child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-session.ts) · [可観測性](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/observability.md#events) · [extension API](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#structured-delegation-api)

**解釈。** 受け入れゲート 4 は十分にサポートされている。パッケージのイベント語彙とアーティファクトは、なお Pions の operation ごとに単調増加するイベントスキーマへ変換する必要がある。upstream のレコードは、Pions の `event_id`、actor、schema version、認証済み capability、operation ローカルな `seq` を一様には保持していない。

**分類:** イベントの可用性は **適合**。Pions の語彙/認証には **アダプターで解決可能なギャップ**。

### 3.2 モデルと thinking

**ソース上の事実。** モデルの優先順位は、run ごとの指定 → provider スコープの role override → 通常の role override → agent frontmatter → グローバルな subagent default → parent model である。モデルには fallback candidate を設定できる。runtime は Pi を通じて model/thinking を解決し、試行したモデルと最終モデルの情報を記録し、明示的に設定された alias を考慮しつつ、terminal response のモデル ID を要求された provider-qualified candidate と比較する。Thinking は明示的な level と継承された ceiling をサポートし、ソースは解決済み/実効 thinking 値を記録する。[モデルのドキュメント](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/models.md) · [model-fallback.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/model-fallback.ts) · [foreground の検証](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/foreground/execution.ts)

**解釈。** 要求/実効/最終モデルと fallback の試行は、高い可観測性を備えている。Thinking は主として解決済みのポリシーであり、観測されたモデル ID に相当する、provider が報告する独立した「観測済み reasoning level」は存在しない。曖昧なモデル解決と設定済み fallback は意図的であり、暗黙的ではないが、Pions では要求/実効/観測済みフィールドを一つにまとめず、個別に保持する必要がある。

**分類:** モデルの選択/検証は **適合**。観測済み thinking は、捏造せず unavailable として表現するなら **アダプターで解決可能なギャップ**。

### 3.3 ツール、extension、cwd

**ソース上の事実。** Agent profile は、builtin tool、除外、MCP-direct tool、extension、ambient-extension discovery、skill、permission、ネストされた subagent の認可を制御する。Capability ceiling は許可された agent/tool の積集合を取り、extension を拒否でき、ネストされた子/バックグラウンドの子へ伝播し、必要な tool が欠けている場合は spawn 前に拒否する。各 run は cwd と launch-contract の digest/projection を記録する。[child-tool-plan.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-tool-plan.ts) · [child-launch.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-launch.ts) · [capability API](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#capability-ceilings)

foreground セッションは意図的に parent の ambient extension をロードしない。background セッションは、明示的な extension リストまたは capability ceiling によって無効化されない限り、ロードする場合がある。[extension API](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#background-work-provider-api)

**解釈。** ネイティブな子については、受け入れゲート 6 を満たしている。要求された設定と実効設定は launch planning と result metadata から導出できるが、Pions の正確な `TaskSpec`/`Operation` 形式ではない。

**分類:** 小規模な projection adapter を伴う **適合**。

### 3.4 使用量とライブ可観測性

**ソース上の事実。** Progress は、現在の tool/path、サイズ制限付きの最近の output/tool summary、input/output/cache token count、cost、turn、duration、attention state、model、thinking を記録する。Status、FleetView、transcript inspection、JSONL、output log、metadata、result detail は、制限付きでこれらのフィールドを公開する。[可観測性](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/observability.md) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)

**解釈。** これは backend 受け入れゲートの可観測性に関する最低要件を上回り、有用なマッピング入力を提供する。使用量は報告されるが予約されないため、厳格な使用量 budget は後続の launch を拒否できるものの、すでに実行中の子を停止しない。

**分類:** 観測については **適合**。厳格な tree-wide budget reservation には **ギャップ**。

## 4. ネストされた spawn、lineage、limit、budget

### 4.1 ネストされた spawn と lineage

**ソース上の事実。** 子にはデフォルトで `subagent` が与えられない。解決済み tool にそれを明示的に含む子、または profile がネストされた subagent を許可する子には、子にとって安全な fan-out extension が与えられる。Runtime config は depth/max depth、root route、parent run/index、path、継承された capability/thinking ceiling、root fan-out budget を保持する。ネストされた started/updated/completed レコードは capability-bearing file route に書き込まれ、tree としてレンダリングされる。[workflows recursion guard](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/workflows.md#recursion-guard) · [child-runtime-config.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-runtime-config.ts) · [fanout-child.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/extension/fanout-child.ts) · [nested-events.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/nested-events.ts)

**解釈。** ゲート 7 は概念的に満たされている。子は不可視のパッケージ再帰プリミティブではなく、明示的な runtime の `subagent` tool を呼び出す。lineage は Pions の operation ID ではなく run ID と step index を使用し、Pions の idempotency key を実装していない。

**分類:** 明示的なネストされた tool と lineage は **適合**。Pions の identity/idempotency には **アダプターで解決可能なギャップ**。

### 4.2 depth、fan-out、concurrency、使用量 limit

**ソース上の事実。** デフォルトの最大 depth は 2。agent ごとの値は、継承した最大値を厳しくすることしかできない。セッション全体の累積 spawn budget は任意である。root run にはデフォルトで累積 fan-out limit 64 があり、`0700` の budget directory 配下にアトミックに claim される `0600` file として表現される。parallel/task/global active limit はそれぞれ独立している。報告された token/cost budget は reconciliation 後の子を拒否するが、使用量を予約せず、既存の子を cancel しない。[recursion tests](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/recursion-guard.test.ts) · [run-fanout-budget.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/run-fanout-budget.ts) · [設定](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/configuration.md#maxsubagentspawnsperrun)

**解釈。** depth と累積 run limit はよく整合している。Phase 0 は明確に、operation ごとの最大 child 数と root ごとの最大 live descendant 数を、型付きの拒否および作成リソース数ゼロとともに要求する。一方、upstream はスコープの異なる複数の limit を提供し、そのデフォルトの concurrency 動作は常に拒否するのではなく queue に入れる。累積 claim directory は有用な実装上の参考になる。

**分類:** depth/累積 budget は **適合**。正確な fan-out/live-descendant policy には **アダプターで解決可能なギャップ**。

## 5. 子孫の settlement、drain、cancel

### 5.1 生存中の子孫がいる場合の parent settlement

**ソース上の事実。** このパッケージは、foreground の parent が完了した後も nested route を保持し、UI/status layer が生存中の子孫を追跡し続けられるようにする。保持された tracker は、生存中の子孫がいなくなった後にのみ route を削除する。ドキュメントには、detached child は host-session の shutdown 後も継続でき、nested run は個別に表示されるとも記載されている。[retained-nested-route-tracker.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/retained-nested-route-tracker.ts) · [extension API、host lifetime](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#host-session-lifetime-and-completion-wakes)

**解釈。** これは、parent の意味上の完了が、必ずしも子孫の terminal state と保留中の handoff の drain が完了するまで遅延されないことを示す直接的な証拠である。これは Phase 0 の `self_settled -> draining_descendants -> terminal` invariant および `parent_exit_policy: cancel_descendants` と競合する。

**分類:** **競合**。

### 5.2 subtree の stop/cancel 順序と acknowledgement

**ソース上の事実。** stop 時、runner は自身の status/step を直ちに stopped としてマークし、`subagent.run.stopped` を書き込んだ後、stop controller を abort し、ネストされた子孫に stop request を dispatch し、active な direct child を停止する。子孫の traversal は、再帰的にその子孫を yield する前に各 child を yield し（pre-order）、dispatch は parent の stop state を公開する前に terminal acknowledgement を待機しない。失敗は診断用の `subagent.nested.stop_failed` イベントになる。[subagent-runner stop path](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/subagent-runner.ts)

**解釈。** これは、spawn をアトミックに freeze し、生存中の子孫の snapshot を取得し、post-order で cancel し、acknowledgement/death proof を待機し、`cancelled` と `unknown(cancel_unproven)` のいずれかを選択するという Phase 0 の cancel 要件に違反する。要件に一致する cancellation epoch/idempotency protocol は存在しない。

**分類:** **競合**。

**推奨。** upstream の `stop` を、Pions のセマンティクスを備えているかのように `Runtime.cancel(scope="subtree")` へ適応してはならない。Pions supervisor は、freeze、post-order dispatch、acknowledgement、`unknown` classification を独立して管理しなければならない。

## 6. prompt、secret、result transport

### 6.1 prompt transport

**ソース上の事実。**

- foreground の prompt text は、`session.prompt()` へのインメモリ引数として渡される。
- background の prompt/system instruction は、private な `0600` async config JSON file にシリアライズされる。spawn された runner の argv に含まれるのは config path のみであり、prompt は含まれない。runner は後に、その prompt を使用して in-process child session を呼び出す。[async-execution.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/async-execution.ts) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)
- 外部 CLI profile は stdin 経由で結合済み prompt を受け取る。file を必要とする adapter は mode `0600` で作成する。[external-cli-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/external-cli-runner.ts)
- artifact metadata/input placeholder は複数の path で raw task を秘匿し、Herdr metadata は raw task/goal prompt ではなく、サイズ制限付きの明示的な label を使用する。それでも child Pi session の transcript には、必然的に prompt が含まれる。[foreground execution](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/foreground/execution.ts) · [Herdr status](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/integrations/herdr-status.ts)

**解釈。** 受け入れゲート 8 は満たされている。prompt text を process argv に含める必要はない。Pions の `prompt_ref` または認証済み Unix socket protocol は使用していない。

**分類:** argv に prompt がない点は **適合**。Pions の transport 形式には **アダプターで解決可能なギャップ**。

### 6.2 シークレットとチャネル認証

**ソースから確認できる事実。** ネイティブのバックグラウンドランナーは、パッケージの拡張バインディング変数を除いて親の環境を継承し、ネイティブの Pi 子拡張はそのプロセス内で実行される。外部 CLI アダプターは環境変数の許可リストを使用できるが、通常のネイティブランナーは最小権限の環境変数許可リストを実装していない。[async-execution.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/async-execution.ts) · [external-cli-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/external-cli-runner.ts)

ネストされたイベント／制御ルートは、ランダムな UUID ケイパビリティトークンを使用し、ルートが所定の範囲内に収まっていることとメタデータの一致を検証し、イベントサイズを制限し、result-intercom の投影からケイパビリティフィールドを除外する。それでもトークンはルート／インデックス JSON に永続化され、子ランタイム設定にも含まれる。これはローカルの非公開ファイルシステムケイパビリティであり、送信者の単調増加シーケンスを備えた 256 ビットの Pions ソケットトークンではない。[nested-events.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/nested-events.ts) · [result-intercom テスト](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/result-intercom.test.ts)

非同期制御 inbox は形状と境界を検証するが、通常の停止／割り込みファイルは主としてファイルシステムパスの所有権によって保護されており、メッセージごとのケイパビリティ認証やシーケンス番号によって保護されているわけではない。[control-channel.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/control-channel.ts)

**解釈。** Pions のケイパビリティの秘匿性、認証済みの閉じたメッセージ集合、子の単調増加シーケンス、および「境界のないペイロードを解析する前に認証する」という契約は存在しない。一部のファイルは `0600`、一部のディレクトリは `0700` だが、汎用的なすべての成果物ライターがこれらのモードを強制するわけではない。

**分類：** Pions が別個のチャネルを所有する場合に限り **アダプターで解決可能なギャップ**。上流のファイル inbox を同等の認証として扱う場合は **競合**。

## 7. セッションとプロセスのアイデンティティ

**ソースから確認できる事実。** パッケージは、トップレベルの実行 ID、ステップのインデックス／キー、親／ルートのネスト ID、Pi `sessionId`、セッションファイル、親セッションの所有権、ランナー PID、ランダムなランナープロセスインスタンス ID、および外部ライターのプロセスインスタンスレコードを記録する。完了通知の配信は、発生元のセッションと、プロセス内で安定した完了所有者 UUID にスコープされる。保持された状態からの復旧では、正規のセッションファイルと、プロセス間で排他的なセッションリースが使用される。[child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-session.ts) · [session-identity.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/shared/session-identity.ts) · [completion-owner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/shared/completion-owner.ts) · [process-terminal.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/process-terminal.ts) · [session-lease.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/session-lease.ts)

**解釈。** 受け入れゲート 9 は十分に満たされている。それでも Pions には、独自の安定した `operation_id/root_operation_id/parent_operation_id`、冪等性キー、およびこれらのバックエンドアイデンティティへの厳密なマッピングが必要である。

**分類：** アイデンティティマッピングアダプターを伴う **適合**。

## 8. 永続化、再読み込み、再起動、クラッシュリカバリー

### 8.1 永続化されるもの

**ソースから確認できる事実。** バックグラウンド実行は、`status.json`、サイズ制限付きの `events.jsonl`、出力ログ、結果ファイル、セッション JSONL、プロセス終端サイドカー、復旧記述子、アクティブインデックス、任意のワークフロー／ミッション／ハンドオフレコード、およびネストされたレジストリを書き込む。セッションの開始／再読み込みにより、アクティブなジョブ、結果監視、待機サブスクリプション、フォアグラウンド履歴、スケジュール、および Herdr 投影が復元される。[可観測性](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/observability.md#async-run-artifacts) · [拡張ライフサイクル](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/extension/index.ts)

所有元の Pi セッションが終了しても、デタッチされた子は実行を継続する。失われるのは即時通知である。後から一致するセッション／ランタイムが結果を再発見できる。[拡張 API](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#host-session-lifetime-and-completion-wakes)

### 8.2 照合と証明

**ソースから確認できる事実。** 古い実行の照合では、既存の結果ファイルから実行中ステータスを修復できる。正確な PID の終了が観測され、結果が存在しない場合は、失敗結果／ステータスを書き込む。`EPERM` やその他の不確実な生存状態は、終了ではなく不明として扱われる。プロセス終端の証明が `observed` になるのは、稼働中のランチャーがそのランナーの正確な close を確認し、かつライタープロセスツリー／セッションリースの証拠に整合性がある場合に限られる。それ以外では証明は `unknown` となる。[stale-run-reconciler.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/stale-run-reconciler.ts) · [process-terminal.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/process-terminal.ts) · [process-terminal テスト](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/process-terminal.test.ts)

**解釈。** これは単純な PID ポーリングよりも大幅に堅牢であり、設計上の有益な参考情報である。ただし、以下の点がある。

1. `events.jsonl` は診断用でサイズ制限があり（デフォルトは 50 MiB）、正規の追記専用状態ログではない。
2. `status.json` と複数の可変サイドカーは、単一の認証済みイベントストリームから再構築可能な純粋な reducer スナップショットではなく、共同で権威を持つ運用レコードである。
3. 配信済みの結果ファイルは削除され、リプレイ／アーカイブレコードには有効期限がある。
4. 再起動後の照合では、ランチャーによる正確な `close` の観測を遡及的に取得できないため、プロセス証明が正しく不明のままになることがある。
5. 完了所有者のアイデンティティは再読み込みをまたいで同一プロセス内では安定しているが、新しい親プロセスをまたいで永続的ではない。

**分類：** 同一プロセスでの再読み込みと運用上の復旧は **適合**。Phase 0 のイベントストア／reducer と永続的なクラッシュリカバリーの権威性は **アダプターで解決可能なギャップ**。

## 9. 失敗セマンティクス

**ソースから確認できる事実。** パッケージは、完了、失敗、部分完了、一時停止、停止、拒否、タイムアウト、およびプロセス証明不明の各状態を区別する。モデルの不一致、必須出力の欠落、不正な構造化出力、ツール／拡張の拒否、子ランタイムの利用不能、起動ハンドシェイクの失敗、結果を残さず終了したランナー、worktree の不確実性、プロセスツリー検証の失敗は、暗黙に成功へ変換されることなく表面化される。外部ランナーでサポートされていないケイパビリティは、起動前に拒否される。[ツールリファレンス](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/tool-reference.md) · [stale-run-reconciler.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/stale-run-reconciler.ts) · [process-terminal.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/process-terminal.ts)

ただし、Pions 形式の単一の状態機械は存在しない。特に、パッケージの「stopped」は子孫／プロセス終端の証明より先に公開されることがあり、その間もプロセス証明は別のサイドカーに残る。正常な終端アシスタントメッセージの後に強制ドレインが行われると、通常のセッション確定がなくても論理的成功となる場合がある。[subagent-runner.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/subagent-runner.ts) · [run-child-session.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/run-child-session.ts)

**解釈。** 多くのケイパビリティおよびプロセス証明の経路で受け入れゲート 10 は満たされているが、パッケージの論理状態名を Pions の終端状態へ一対一でマッピングすることはできない。Pions は、別個の停止証明なしに `stopped` を `cancelled` へ変換してはならない。

**分類：** フェイルクローズなケイパビリティ報告は **適合**。Pions の終端状態マッピングは **アダプターで解決可能なギャップ**であり、サブツリー停止セマンティクスは **競合**。

## 10. Worktree とセキュリティ境界

**ソースから確認できる事実。** 管理対象の worktree には Git が必要で、通常はソースチェックアウトがクリーンであることを要求し、ベース ref を検証し、安全でない割り当てルートを拒否し、個別のブランチ／worktree を作成し、バイナリパッチとハンドオフ証拠を取得し、不確実／ダーティな作業を削除せず保持する。クリーンアップ権限はレーン表示メタデータとは分離され、最新のチェックを必要とする。[ワークフローの worktree セクション](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/workflows.md#worktree-isolation) · [worktree.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/worktree.ts)

ツールと拡張の許可リストは明示的なポリシー制御だが、上流ドキュメントが正しく述べているとおり、これは OS サンドボックスではなく同一プロセス内のポリシーである。子の Bash／カスタムツールは、そのプロセスユーザーのファイルシステム権限と継承された認証情報で実行される。ホストのワークフローコマンドは、信頼済みリソースの付与を使用するが、それでもワークフローの cwd／環境と PATH の信頼性を継承する。[ケイパビリティ上限](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#capability-ceilings) · [信頼済みワークフローリソース](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#trusted-workflow-resources)

**解釈。** worktree の実装は整合性／クリーンアップの優れた参考例だが、OS セキュリティ境界を満たすものではない。Phase 1 では worktree の作成が明示的に禁止されているため、MVP ではこれらの機能を使用してはならない。

**分類：** worktree の安全対策は **後続設計への参考として適合**。サンドボックスは **提供されない**。Phase 1 での使用は **スコープと競合**。

## 11. Herdr 統合

### 11.1 通常の実行の挙動

**ソースから確認できる事実。** 通常のネイティブサブエージェントはヘッドレスのままである。所有元の対話型 Pi が Herdr 内で実行されている場合（`HERDR_ENV=1` および `HERDR_PANE_ID`）、拡張は `herdr pane report-metadata` を使用して **既存の親ペイン** に非同期処理の集計数／ラベルを報告し、`herdr:busy` と `herdr:blocked` を発行し、再読み込み／再開後に投影を復元し、完了／シャットダウン時に消去する。ワーカーごとにペインを分割することはない。[Herdr ステータスのソース](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/integrations/herdr-status.ts) · [Herdr テスト](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/herdr-status-bridge.test.ts)

任意の Herdr インスペクターペインは、既存の非同期成果物／制御 inbox に対するダッシュボードであり、子セッションでも文字どおりのアタッチでもないことが明記されている。任意のプロジェクトペインは独立した対等な Pi セッションを作成するが、親はその内部のサブエージェントを所有／制御しない。[拡張 API、Herdr](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/docs/extension-api.md#herdr-integration)

### 11.2 Phase 1 との比較

**解釈。** これは中心的な可視ワーカー要件を満たさない。

- オペレーションごとに現在の Pions ペインを分割しない。
- `--no-focus` による子ワーカー起動トランザクションがない。
- 新たに作成された正確なワーカーペインのアイデンティティをオペレーションに対応付けて保存しない。
- そのペイン内でワーカーラッパーを実行しない。
- Phase 1 の前提条件違反として失敗するのではなく、Herdr 外でも通常の実行が有効なままである。
- Herdr メタデータは親の集計表示であり、可視ワーカーのオペレーションレベルの生存状態ではない。

このブリッジは、2 つの優れた要件を具体化している。`pi.exec` を介して argv 配列を使用し、Herdr 投影を意味上の結果の権威ではなくベストエフォートとして扱う。また、生のプロンプトをメタデータに含めることも避けている。

**分類：** 任意の親メタデータは **補助的な投影として適合**。Phase 1 の `HerdrPresentation` とは **競合**。

**推奨事項。** インスペクターやプロジェクトペインのアクションを Phase 1 のワーカーペインとして再解釈しようとしてはならない。Pions が将来この拡張を統合する場合、Pions 自身が正確なペインを作成して所有し、そこで専用ラッパーを起動し、上流のステータスをバックエンドの観測情報としてのみ扱う必要がある。

## 12. 要件別マトリックス

### 12.1 バックエンド受け入れゲート（§1）

|   # | 要件                                                                     | 固定コミットでの証拠                                                                                 | 分類                                                                                    |
| --: | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
|   1 | 独立した OS プロセス、または独立したラッパー内のバックエンド             | 非同期用のデタッチされた Node ランナー。フォアグラウンドは親プロセス内                               | **アダプターで解決可能なギャップ**（バックグラウンドのみ）。フォアグラウンドは **競合** |
|   2 | 非同期処理とキャンセル／デッドラインの伝播                               | 非同期ランナー、制御 inbox、中断とデッドライン                                                       | 基本的なオペレーションには **適合**。サブツリーの証明は異なる                           |
|   3 | 型付きの意味的な結果／失敗。終端出力のスクレイピングなし                 | `AgentSession` のイベント／メッセージを直接取得し、構造化された結果を使用                            | **適合**                                                                                |
|   4 | ライフサイクル／ツール／メッセージ／使用量のストリームまたはコールバック | 豊富な直接サブスクリプションと、サイズ制限付き JSONL／進捗コールバック                               | **適合**                                                                                |
|   5 | 要求／観測されたモデルと推論。暗黙のフォールバックなし                   | モデル候補／試行と終端時のモデル検証。実効的な thinking はあるが、独立して観測された thinking はない | **アダプターで解決可能なギャップ**                                                      |
|   6 | オペレーション単位のツール制限                                           | プロファイルのツール計画、ケイパビリティ上限、必須ツールの事前チェック                               | **適合**                                                                                |
|   7 | 子が Pions Runtime の spawn を呼び出せる                                 | 子はパッケージの子向けに安全な `subagent` を呼び出せるが、Python の Pions Runtime ではない           | Pions には **競合**。有用な設計上の類例                                                 |
|   8 | argv にプロンプト/token/result が存在しない                              | `0600` の設定にあるネイティブのバックグラウンドプロンプト、外部 CLI の stdin/ファイル                | プロンプトには **適合**、Pions の token チャネルは存在しない                            |
|   9 | バックエンドのセッション/プロセス ID                                     | 実行/セッション/PID/プロセスインスタンス/writer ID                                                   | **適合**                                                                                |
|  10 | サポートされていない機能を成功に見せかけない                             | 広範な事前チェックによる拒否と unknown のプロセス証明                                                | **適合**、ただしパッケージの状態は慎重なマッピングが必要                                |

### 12.2 共有ドメインとステートマシン（§§2–4）

| 要件                                                                                                               | 分類                           | 理由                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Runtime` が呼び出し側に公開される唯一の境界であり、バックエンド/プレゼンテーション/store/channel が分離されている | **競合**                       | パッケージは Pi ツール、ワークフロー DSL、RPC、ファイル、TUI、Herdr API を公開している。これはオーケストレーション製品であり、交換可能な Python バックエンド境界ではない。       |
| `TaskSpec.prompt_ref`、profile、idempotency key                                                                    | **不足/競合**                  | profile は存在する。生のプロンプトはメモリ/非公開設定内にある。Pions のプロンプト参照や親スコープの idempotency key はない。                                                     |
| Pions の完全な `Operation` フィールド                                                                              | **アダプターで解決可能な不足** | backend/session/model/cwd/timing のフィールドは大半が存在するが、Pions の lineage、状態シーケンス、キャンセル epoch、result digest、pane 所有権は存在しない。                    |
| Pions の厳密な非終端/終端状態                                                                                      | **競合**                       | アップストリームには running/attention/paused/stopped/partial などがあるが、`self_settled`/`draining_descendants` はなく、stopped はキャンセルが証明済みであることを意味しない。 |
| 正当な reducer 遷移と終端状態の不変性                                                                              | **競合**                       | 純粋な reducer も、権威ある追記専用の遷移モデルもない。可変な状態修復は意図的な設計である。                                                                                      |
| プロセス/Herdr の状態だけでは成功を作り出せない                                                                    | **適合**                       | ネイティブの結果はセッションのセマンティクスから得られ、プロセス証明は分離されたままである。                                                                                     |
| 単調な認証済みイベント envelope                                                                                    | **アダプターで解決可能な不足** | 一部のイベント timestamp/version/capability は存在するが、要求される envelope やシーケンス検証が一律に備わっているわけではない。                                                 |
| 決定論的な Phase 0 の fake backend/store/clock/ID                                                                  | **成果物として競合**           | アップストリームのテストには注入可能な factory/fake があるが、Pions reducer パッケージや決定論的ドメインハーネスはない。                                                         |
| 深さ 2、fan-out 3、live descendants 4、リソースなしなら拒否                                                        | **部分的/不足**                | 深さ 2 は存在する。他のアップストリームの制限はスコープ/デフォルトが異なり、キューに入る場合がある。                                                                             |
| 自己 settlement 前の結果永続化と、親への高々一回の publish                                                         | **部分的に適合**               | 非同期の pending/promoted result は watcher への配信に先行し、重複排除/replay がある。Pions の自己 settlement 遷移や永続的な single-writer イベントはない。                      |
| 親は終端になる前に子孫を待つ                                                                                       | **競合**                       | 保持された子孫追跡では、親が先に完了することが明示的に許可されている。                                                                                                           |
| アトミックな spawn freeze + post-order cancel + ack/death proof + unknown                                          | **競合**                       | キャンセル epoch/freeze はない。ネストした dispatch は pre-order で、親の stopped 状態が最初に書き込まれる。                                                                     |
| 必須の Phase 0 property/table テスト                                                                               | **成果物として競合**           | 広範なアップストリームテストは自身の契約を対象としており、Pions の遷移不変条件を対象としていない。                                                                               |

### 12.3 Phase 1 visible-worker MVP（§5）

| 要件                                                                              | 分類                           | 理由                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 operation、ネストなし、blocking vertical slice                                  | **アダプターで解決可能**       | foreground の単一実行は存在するが、in-process であり、可視の別 worker ではない。                                                                                             |
| 厳格な Herdr 環境事前チェック、headless fallback なし                             | **競合**                       | Herdr は任意であり、通常の起動は headless のままである。                                                                                                                     |
| 現在の Pions pane を split、focus なし、明示的な cwd、返される opaque pane ID     | **競合**                       | 通常の子起動では pane の split は行われない。                                                                                                                                |
| Pions が所有する正確な pane を永続化し、既存/Qoral pane を決して対象にしない      | **競合/未実装**                | operation ごとの worker pane 所有権は存在しない。Project/inspector pane は別機能である。                                                                                     |
| 非公開の `0700` run dir と `0600` prompt/config/result/error                      | **部分的な不足**               | 選択された config/budget/recovery ファイルは `0600` で、一部のディレクトリは `0700` だが、汎用の async/artifact/result writer は Pions の mode を一律には適用しない。        |
| worker の認証済み `hello/started/activity/.../result/cancel_ack` チャネル         | **競合**                       | ネイティブセッションは直接 callback を使用する。detached coordination はパッケージのファイル artifact/inbox を使用し、このプロトコルではない。                               |
| 256-bit capability、argv/log/metadata から隠蔽、単調なシーケンス                  | **競合**                       | ネスト用 UUID capability は永続化され、より限定的である。通常の result/control パスには同等の token/sequence がない。                                                        |
| result を永続化/hash 化し、ACK 後に settle                                        | **アダプターで解決可能な不足** | アトミックな result publish は存在するが、Pions の ACK/hash/state transaction はない。                                                                                       |
| Herdr は projection/liveness 専用                                                 | **適合**                       | アップストリームの Herdr bridge は best effort であり、result authority ではない。                                                                                           |
| operation ごとの正確な Herdr model/state/usage projection                         | **不足**                       | 親 pane の集約 metadata のみ。                                                                                                                                               |
| result なしのプロセス終了 => 証明済みなら failed、未証明なら unknown              | **部分的に適合**               | stale reconciler は、result がなく停止が証明された runner を failed とする。process-terminal sidecar は unknown の証明を保持する。マッピングは明示的なままにする必要がある。 |
| まず backend をキャンセルし、停止が証明されれば cancelled、そうでなければ unknown | **競合**                       | アップストリームは子孫/プロセスの完全な証明より先に stopped を publish する。                                                                                                |
| blocked/failed/unknown/success pane を保持                                        | **競合/該当なし**              | 通常の実行には worker pane がない。                                                                                                                                          |
| fake-Herdr の argv/ownership/security テスト                                      | **成果物として競合**           | Herdr bridge/project/inspector テストはアップストリームのインターフェースを対象としており、Pions の pane transaction fixture を対象としていない。                            |
| terminal output なしで最終結果を再構築                                            | **適合**                       | ネイティブの session/result/status artifact で十分である。                                                                                                                   |

## 13. 確認した関連テストの証拠

テストは実行していない。静的調査には以下のテストが含まれる。

- foreground/background の `agent_end.willRetry` および `agent_settled` の挙動：[single execution](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/integration/single-execution.part-2.test.ts)、[async execution](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/integration/async-execution.part-1.test.ts)
- ネストした control routing、route scoping、reload 時の listener 置換、trusted session-root のチェック：[nested-control.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/nested-control.test.ts)
- depth と継承された limit の挙動：[recursion-guard.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/recursion-guard.test.ts)
- 正確な runner/writer の process-terminal 証明と unknown の結果：[process-terminal.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/process-terminal.test.ts)
- POSIX の子孫 termination/verification：[owned-process-tree.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/owned-process-tree.test.ts)
- Herdr の有効化、親 pane の metadata、prompt-label の redaction、reload projection、Herdr 外での inert な挙動：[herdr-status-bridge.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/herdr-status-bridge.test.ts)
- 外部 CLI の stdin によるプロンプト配信と process-group の停止動作：[external-cli-runner.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/external-cli-runner.test.ts)
- result capability の redaction：[result-intercom.test.ts](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/test/unit/result-intercom.test.ts)

これらのテストは、アップストリーム自身の挙動を裏付けるものである。Phase 0 reducer テストや Phase 1 fake-Herdr safety suite がすでに存在する証拠ではない。

## 14. 以前のレポートからの差異

以前のレポート [`herdr-pi-extensions.md`](./herdr-pi-extensions.md) は、このリビジョンの `nicobailon/pi-subagents` をレビューして**いない**。そこにある名前の似たエントリは、別のリポジトリおよび commit（`MinhDuyDEV/pi-subagents@6df615…`）の **`@minhduydev/pi-subagents` 0.13.0** だった。これらの所見をこのパッケージに帰属させてはならない。

以前のレポートの全体像との重要な相違点は以下のとおりである。

1. **パッケージ形態：** この固定リビジョンは、大規模な in-process/public TypeScript API を備えた TypeScript Pi extension であることが明確であり、Pions が想定する未決定の Python backend ではない。
2. **Herdr の役割：** 以前のレポートで重視された visible-pane subagent パッケージとは異なり、通常の子はここでは headless のままである。Herdr integration は集約された状態を親 pane に projection し、任意の inspector/project peer を開く。
3. **完了処理：** このリビジョンは `agent_end.willRetry` と `agent_settled` の違いを直接かつ堅牢に処理しており、`agent_end` を最終とみなさないという以前のレポートの推奨事項に合致する。
4. **プロセス証明：** このリビジョンでは、runner-instance、writer-process-tree、session-lease の終端証拠が非常に明示的に追加されており、観測できない場合の永続的な `unknown` 証明も含まれる。
5. **ネストしたライフサイクル：** first-class の lineage、depth、visibility、累積 fan-out claim があるにもかかわらず、以前のレポートで推奨された qcts-style の descendant-drained な親 settlement/cancellation は実装して**いない**。親の完了が子孫の完了に先行でき、停止は descendant-first の acknowledged cancellation ではない。
6. **永続化：** このパッケージには、以前のレポートにある小規模な ephemeral 設計よりはるかに豊富な status/result/recovery/mission/worktree artifact があるが、その診断用 JSONL と期限付き completion replay は永続的な Pions event store ではない。
7. **セキュリティ：** model/tool/extension ceiling と worktree cleanup の証拠は、レビューされた多くのパッケージより発達している一方、通常のネイティブ子プロセスは依然としてユーザー権限と継承された環境を共有する。worktree も Pi extension policy も OS sandbox ではない。

## 15. 最終推奨

### ソースに基づく判断

Pions Decision P-001 を解決するパッケージとして `nicobailon/pi-subagents@7fe9dee1bc186592e3f2b95c07d86c02f2edd57a` を却下する。これは Python ではなく、必要な Python backend contract を公開せず、Phase 1 の可視 Herdr worker を作成せず、必要な子孫 settlement/cancellation セマンティクスと競合する。

### 適用する価値のある概念

1. backend/Pi event を直接 subscribe し、通常の終端を示す最も強い watermark として `agent_settled` を保持する。
2. 要求された model candidate、試行した model、最終的に観測された model、および明示的な alias/fallback policy を記録する。
3. 論理的な完了を正確な process-terminal 証明から分離し、利用できない証明を `unknown` として表す。
4. PID に加えてランダムな process-instance ID を使用し、復活/終端証明には canonical-session lease の解放を必須とする。
5. 子孫を通じて厳しくなることしかない capability/tool/thinking ceiling を使用する。
6. アトミックで払い戻しのない root fan-out claim を使用し、子を起動する前に admission group を失敗させる。
7. 不確実な worktree を保持し、破壊的 cleanup の前に新鮮な ID/Git の証拠を必須とする。
8. event、transcript、output、steering、metadata の projection に上限を設け、生のプロンプトを Herdr metadata に含めない。

### Phase 0/1 にコピーすべきでない概念

1. Pions reducer を取り巻く第 2 の workflow DSL/state model。
2. 子孫が live のままでの親 terminal publish。
3. 親の `stopped` を先に publish する pre-order の fire-and-forget 子孫停止。
4. ローカルの未認証 file inbox を Pions の子 capability channel として扱うこと。
5. Phase 1 visible-worker adapter における任意/headless の Herdr 挙動。
6. worktree、tool allowlist、または同一プロセスの extension ceiling を OS isolation として扱うこと。
