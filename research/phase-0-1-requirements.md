# Pions フェーズ0 / フェーズ1 要求仕様

**状態:** ベースライン案。TypeScriptランタイムの決定は承認済み。残りの設計はレビュー中。実装は未着手
**日付:** 2026-09-06
**入力:** `pions-herdr-subagent-design.html`、`herdr-pi-extensions.md`

## 1. ランタイムとパッケージの決定

### 確認済みの事実

- Pythonは前セッションの引き継ぎ文に含まれていただけで、選定根拠やADRは存在しなかった。
- 利用者はPiエコシステムとの整合と依存関係削減を理由に、PionsランタイムをTypeScript/Nodeで実装すると決定した。
- PyPIの`subagent==0.3.2`はVS Code/Copilotワークスペースを払い出す保守されていないCLIであり、Pionsバックエンドではない。この候補の調査は歴史的記録として残すが、今後のランタイム選定には関係しない。

### 決定P-001 — 承認済み

Pionsのランタイム、ドメインモデル、状態リデューサー、Pi/Herdrアダプターは**TypeScript/Node**で実装する。Pythonサイドカーを標準構成にせず、フェーズ0はエージェントパッケージ非依存で進める。

具体的なPi SDK/APIおよびEffectパッケージの採用範囲と固定バージョンは一次ソース調査後に決める。調査前に依存関係へ追加しない。

### 主要な参照実装: `nicobailon/pi-subagents`

`nicobailon/pi-subagents`はコミット`7fe9dee1bc186592e3f2b95c07d86c02f2edd57a`で静的調査した。これはマニフェストバージョン`0.65.1`のTypeScript/Node Pi拡張機能である。注釈付きタグ`v0.65.1`のタグオブジェクトは`dbe28f181fc5c17c6c62de28c396e6cbf6fefa3b`、参照をたどった先のコミットは`83be9c3de2cde1553c0269f383efc1eb1194dc8b`であり、調査対象のHEADとは異なるためリリース成果物と同一視しない。

これはPionsの**主要な参照実装**として継続的に利用するが、そのまま依存先またはフォークにはしない。直接のPiイベント購読、`agent_end.willRetry`と`agent_settled`の区別、モデル検証、プロセスインスタンス識別情報、ケイパビリティ上限、セッションリース、停止証明不能時の`unknown`を設計へ取り込む。一方、ヘッドレスワーカー、親先行完了、確認応答前の`stopped`公開はPionsの要求と異なるためコピーしない。

詳細: `research/nicobailon-pi-subagents.md`

### 決定案P-002 — Effect v3コア

フェーズ0では`effect@3.22.1`のみを完全固定で採用する。Effect 4のベータ版/RC版APIと混在させない。Schemaはコアの`effect`パッケージに含まれるため`@effect/schema`を追加しない。`@effect/platform-node`、`@effect/vitest`、Stream/Queue/STM、OpenTelemetryは実際の問題が現れるフェーズまで追加しない。

Effectはランタイム内部の型付きエラー、リソーススコープ、構造化されたプロセス内並行処理、依存関係の差し替え、決定論的クロックに使う。呼び出し側向けの`Runtime`/`Handle`インターフェースは素のTypeScript/Promiseのままにし、`Effect`、`Layer`、`Context`、`Exit`、`Cause`を漏らさない。リデューサーは純粋な同期関数を維持する。ファイバーの中断、Scopeの終了処理、PubSub通知を操作の完了またはキャンセルの証拠として扱わない。

一次ソース調査: `research/effect-for-pions.md`

### バックエンド実装の受け入れ基準

候補パッケージは、隔離したスパイクで以下を満たさなければ採用しない。

1. 1つの操作を独立したOSプロセスとして起動できる、またはPionsワーカーラッパーの独立プロセス内だけで実行できる。
2. 非同期実行とキャンセルを提供し、Pionsの期限/中止を伝播できる。
3. 意味上の最終結果と失敗を型付きで取得できる。標準出力や端末出力のスクレイピングを必要としない。
4. ライフサイクル/ツール/メッセージ/使用量のストリームまたはコールバックを取得できる。取得不能な項目は明示できる。
5. 要求したモデル/推論と観測したモデル/推論を照合できる。暗黙のフォールバックを強制しない。
6. ツール範囲を操作ごとに制限できる。
7. 子からPions Runtimeの`spawn`ツールを呼べる。パッケージ自身の暗黙な再帰を系譜として扱わない。
8. プロンプト、トークン、結果をプロセスのargvに置かなくてよい。
9. パッケージ独自のセッションIDまたはプロセス識別情報を記録できる。
10. 未対応のケイパビリティを成功と偽装しない。

## 2. システム境界

呼び出し側が理解すべき外部インターフェースは`Runtime`だけとする。

```ts
const handle = await runtime.spawn(task, {
  parentOperationId: context.operationId,
});
const result = await handle.result();
await handle.cancel({ scope: "subtree" });
```

内部境界:

- `AgentBackend`: パッケージ固有のイベントと操作をPionsの語彙へ変換する。
- `PresentationAdapter`: ワーカーの表示と観測を担当する。フェーズ1では`HerdrPresentation`。
- `EventStore`: 操作のスナップショットと追記専用イベントを保存する。
- `ChildChannel`: 子のレポーターとRuntime間の認証付き通信を担当する。

Herdrは表示/生存性アダプターであり、意味上の結果の正本ではない。

## 3. 共有ドメイン契約

### 3.1 `TaskSpec`

必須:

- `prompt_ref`: 非公開成果物またはチャネル上の参照。プロンプト本文をargvに入れない。
- `profile`: ポリシー解決に使う閉じた識別子。
- `idempotency_key`: 同一の親スコープ内で一意。

任意:

- `model`、`reasoning`、`tools`、`cwd`
- `deadline`
- `result_size_limit`

`requested_config`、ポリシー適用後の`effective_config`、バックエンド実測の`observed_config`を別々に保持する。

### 3.2 `Operation`

最低限保持するフィールド:

- `operation_id`、`root_operation_id`、`parent_operation_id`、`depth`
- `state`、`state_seq`、`self_outcome`
- `spawn_frozen`、`cancellation_epoch`
- 要求時/有効化後/観測時の設定
- 子操作のID
- バックエンドのプロセス/セッション識別情報
- Herdrのワークスペース/タブ/ペインIDと`surface_owned_by_pions`
- 作成/開始/自己確定/終端のタイムスタンプと期限
- 結果へのポインター、バイト数、ダイジェスト
- 終端理由コード

### 3.3 状態

非終端:

- `queued`
- `starting`
- `running`
- `blocked`
- `self_settled`
- `draining_descendants`
- `cancelling`

終端:

- `completed`
- `failed`
- `cancelled`
- `unknown`

`failed_to_cancel`は状態にせず、`unknown`の理由コードとする。これにより「停止を証明できないが`failed`と断言した」状態を避ける。

`self_outcome`は`succeeded | failed`。子孫が残る場合、自己失敗でも直ちに終端にせず、排出してから`failed`へ進む。

### 3.4 正当な遷移

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

規則:

- 終端状態から遷移しない。
- `completed`は`self_outcome=succeeded`、全子孫が終端、保留中の結果引き渡しが0の場合だけ。
- `failed`は自己失敗またはポリシー上伝播する子孫の失敗があり、全子孫が終端、保留中の引き渡しが0の場合だけ。
- `blocked`は終端ではなく`running`へ戻れる。
- プロセス終了、Herdrの`idle/done/unknown`、端末テキストは単独で意味上の遷移を確定しない。
- イベントの重複、古い`seq`、異なるアクター/ケイパビリティは状態を変更しない。

### 3.5 イベント

全イベントは`event_id`、`operation_id`、操作単位で単調増加する`seq`、タイムスタンプ、アクター識別情報、スキーマバージョンを持つ。

最小語彙:

- `operation_requested`
- `operation_starting`
- `operation_started`
- `activity_observed`
- `operation_blocked`、`operation_unblocked`
- `child_attach_requested`、`child_attached`、`child_attach_rejected`
- `self_settled`
- `result_persisted`
- `descendant_drain_started`
- `cancellation_requested`、`cancel_dispatched`、`cancel_acknowledged`
- `operation_completed`、`operation_failed`、`operation_cancelled`、`operation_unknown`

イベントは追記専用とする。スナップショットはイベント適用結果のキャッシュであり、イベントと矛盾した場合は再構築できること。

## 4. フェーズ0 — 決定論的状態機械

### 4.1 範囲

実Herdr、実エージェントパッケージ、ネットワーク、実時間のスリープ、SQLiteを使わない。

成果物:

- 不変かつ検証済みのドメイン型
- 純粋な遷移リデューサー
- `Runtime`の最小オーケストレーション実装
- `FakeAgentBackend`
- `InMemoryEventStore`
- 制御可能な偽クロック
- 決定論的な操作ID/トークンファクトリー

フェーズ0の偽の入れ子`spawn`は状態機械を検証するためのもの。実際の子Runtimeクライアントと永続的な系譜はフェーズ2で扱う。

### 4.2 初期ポリシー

```yaml
max_depth: 2
max_children_per_operation: 3
max_live_descendants_per_root: 4
parent_exit_policy: cancel_descendants
completion_policy: wait_for_descendants
```

上限超過はキューに入れず、型付きの拒否とイベントを返す。拒否された要求に操作/サーフェス/プロセスを作らない。

### 4.3 確定の意味論

- ワーカーの意味上の結果を永続化してから`self_settled`を適用する。
- 子が0、引き渡しが0なら終端結果を同一のリデューサーサイクルで導出できる。
- 子がある場合は`draining_descendants`へ進む。
- 親へ公開する終端結果は一度だけ。再読み込みはリプレイであり再注入ではない。

### 4.4 キャンセルの意味論

1. キャンセルエポックを増やし、対象サブツリーの新規`spawn`を原子的に凍結する。
2. 生存中の子孫のスナップショットを取り、後行順（末端優先）でキャンセルを送信する。
3. 各子の終端/キャンセル確認応答を期限まで待つ。
4. 全停止を証明できれば対象を`cancelled`にする。
5. 一つでも停止を証明できなければ対象を`unknown(reason=cancel_unproven)`にする。
6. 既に終端のノードの結果は書き換えない。

同じキャンセルエポックの再要求は冪等。より古いエポックは拒否する。

### 4.5 必須テスト

少なくとも以下をテーブルテスト/プロパティテストで固定する。

- 全ての正当な遷移と全ての不正な遷移
- 結果の永続化前に`self_settled`へ遷移できないこと
- 子なしの成功/失敗
- 子があり、親が先に自己確定する場合
- 子の失敗の伝播ポリシー
- `blocked -> running -> self-settled`
- 深さ/ファンアウト/生存子孫数の上限による拒否とリソース0件
- 同一の冪等性キーが同じハンドルを返し、二重に`spawn`しないこと
- キャンセル時の凍結とキャンセル中の`spawn`拒否
- `root -> child -> grandchild`の後行順キャンセル
- キャンセルのタイムアウトが`unknown`になること
- 終端状態が不変であること
- 重複した/順序が逆転した/未認証のイベントが無効であること
- 無作為なイベント列でも不変条件を破らないこと

### 4.6 終了基準

- テストが端末、サブプロセス、ネットワーク、実時間のスリープに依存しない。
- 任意の操作ツリーについて、終端である理由をイベント列から説明できる。
- キャンセル送信順を決定論的に検証できる。
- バックエンド/表示/storeを差し替えてもリデューサーを変更しない。

## 5. フェーズ1 — Herdrで可視化したワーカーのMVP

### 5.1 範囲

一度に1操作、入れ子なし、ブロッキングな`spawn -> result`の垂直スライス。フェーズ0と同じ状態リデューサーを使い、フェーズ1専用の第二状態機械を作らない。

### 5.2 環境と所有権

- `HERDR_ENV=1`、`HERDR_WORKSPACE_ID`、`HERDR_TAB_ID`、`HERDR_PANE_ID`を事前検査する。
- フェーズ1ではヘッドレスへのフォールバックをしない。Herdr不在は型付きの事前条件違反。
- 呼び出し側のPionsペインを`--current`で分割し、`--no-focus`と明示的な`cwd`を使う。
- 作成応答の不透明なペインIDだけを以後の対象に使う。
- Pionsが作ったペインと、その識別情報を操作に永続化できた場合だけ`surface_owned_by_pions=true`。
- 既存ペイン、Qoralワークスペース/ペイン、フォーカス中のペイン、推測したIDを対象にした操作、名前変更、クローズ、入力をしない。
- フェーズ1はワークスペースやワークツリーを作成しない。

設計時に観測したインストール済み互換性ベースライン: Herdr `0.8.2`。`pane split/run/report-agent/report-agent-session/report-metadata/release-agent`を利用できる。実装では、インストール済みCLIのヘルプ/JSON応答を契約フィクスチャとして固定する。

### 5.3 起動トランザクション

1. タスク/設定/環境を検証する。
2. `operation_requested`と非公開の操作ディレクトリを永続化する。
3. モード`0700`の実行ディレクトリ配下に、モード`0600`でプロンプト/設定成果物を作成する。
4. フォーカスを移さずに現在のPionsペインを分割し、返されたペイン識別情報と所有権を永続化する。
5. そのペインでPionsワーカーラッパーをちょうど1つ起動する。
6. ワーカーは非公開パスまたは認証付きローカルチャネルからプロンプト/設定を読み、プロンプトをargvからは決して読まない。
7. ワーカーは認証し、`started`を送出する。Runtimeはバックエンドのプロセス/セッション識別情報を記録する。
8. バックエンドは意味上の結果を送出する。Runtimeは検証し、サイズを制限し、永続化し、ハッシュを算出し、確認応答してから確定する。
9. Runtimeは状態をHerdrへ投影する。投影失敗は可観測性を低下させるが、意味上の完了を捏造できない。

手順4より前のロールバックではHerdrリソースを作成しない。手順4より後で起動に失敗した場合、保持すべき証拠がないときに限り、新しく作成した識別情報が完全一致するペインだけを閉じてもよい。それ以外の場合は保持し、理由を記録する。

### 5.4 子チャネル

- フェーズ1の既定値はUnixドメインソケット。非公開メールボックスは、パッケージの制約で必要な場合に限って使用でき、同じプロトコルを満たさなければならない。
- 操作ごとのランダムなケイパビリティ（最低256ビット）、操作ID、プロトコルバージョン、単調増加する子シーケンス。
- ソケット/実行ディレクトリは`0700`。プロンプト/設定/結果/エラー成果物は`0600`。
- ケイパビリティはログに記録せず、Herdrメタデータに表示せず、平文のイベントペイロードに永続化せず、argvで渡さない。非公開のケイパビリティファイルまたは継承した記述子は許容する。
- 閉じたメッセージ型: `hello`、`started`、`activity`、`blocked`、`unblocked`、`result`、`failed`、`cancel_ack`。
- 上限のないペイロードを解析する前に認証する。メッセージ単位および結果全体の上限を強制する。
- 結果の受け入れは単一ライターかつ最大1回とする。同一結果の重複は再配信せずに確認応答し、内容が異なる2つ目の結果は閉鎖的に失敗させる。

### 5.5 Herdrへの投影

専用のソース名前空間（例: `pions`）と操作単位のエージェントラベルを使う。上限があり、機密でないデータだけを投影する。

- 短い操作IDとプロファイル
- 現在のPions状態
- 判明している場合は有効なモデル/推論
- 経過時間と、取得できる場合は上限付きの使用量

対応付け:

- `starting`、`running`、`draining_descendants`、`cancelling` -> Herdrの`working`とPions状態ラベル
- `blocked` -> Herdrの`blocked`
- 確定した成功/失敗 -> 最終メタデータを報告してから`release-agent`。終端ペインの保持はPionsのポリシーとする
- 不確かなアダプター/プロセス状態 -> Herdrの`unknown`。Pionsの完了には決して対応付けない

全ての更新に単調増加する`seq`を付ける。投影エラーは記録し、再試行可能とする。

### 5.6 生存性と完了の違い

- Herdr/プロセス状態が証明するのは可視性/生存性だけである。
- 認証済みのバックエンド結果を意味上の証拠とする。
- Runtimeは確認応答の送信前かつ終端遷移前に結果を永続化する。
- 受理済みの結果なしでプロセスが終了した場合、停止が証明されていれば`failed(reason=process_exited_without_result)`とする。
- 見失った、または識別不能なプロセスは`unknown(reason=liveness_unproven)`とする。
- Herdrペインの消失を正常完了と解釈してはならない。

### 5.7 キャンセルと保持

- フェーズ1のキャンセルは単一操作のキャンセルを意味する。サブツリーの挙動はフェーズ0から引き継ぐが、子孫は存在しない。
- 先にバックエンドへキャンセルを送り、期限まで待ってから、選定したパッケージアダプター契約に従って強制処理へ進む。
- 停止を証明できれば`cancelled`、証明できなければ`unknown`とする。
- `blocked`、`failed`、`unknown`のペインは常に保持する。
- 成功したペインはフェーズ1では保持する。成功時の自動クリーンアップは範囲外。
- 「キャンセル」「サーフェスを閉じる」「履歴を破棄する」は別々の操作のままとする。

### 5.8 必須テスト

自動テストでは既存の稼働中ペインではなく、偽のHerdr実行ファイル/セッションを使うこと。

- argvの完全一致、シェルを介さないサブプロセス呼び出し、フォーカスを奪わないこと
- 応答IDの解析。予測したIDやフォーカス中のIDを使わないこと
- 起動成功と報告投影の順序
- 分割失敗時に所有サーフェスを作らないこと
- 実行/開始失敗時に、新しく作成した完全一致のサーフェスだけをロールバックすること
- 確認応答/終端遷移より前に結果を永続化すること
- 重複した結果と競合する結果の処理
- 不正なトークン、操作ID、プロトコルバージョン、シーケンス、過大なペイロード
- 結果なしのプロセス終了
- ペイン消失/投影失敗によって完了が作られないこと
- キャンセル確認済みの場合と証明不能の場合
- 証拠ペインの保持規則
- プロンプト/ケイパビリティがargv、ログ、Herdrメタデータに含まれないこと
- 既存/Qoralサーフェスを表すフィクスチャを対象にするコマンドが一つもないこと

手動受け入れテストでは、**Pions呼び出し元ペインからのみ、Pions所有の新しい兄弟ペイン**を1つ作成してよい。変更対象を列挙したり、既存のQoralペインを対象にしたりしてはならない。

### 5.9 終了基準

- 人が、フォーカスを奪われることなく、新しく作成されたPions所有のHerdrペインで実際のワーカーを1つ観察できる。
- 端末出力を読まずに、Pionsの記録から最終結果と状態を再構築できる。
- 結果の永続化前/後にワーカーを強制終了した場合、誤った成功を生じさせず、規定の`failed`/終端挙動になる。
- 既存のペインを変更もクローズもしない。
- 選定したバックエンドパッケージが受け入れ基準を満たし、観測したイベント/キャンセルマトリクスが文書化されている。

## 6. 明示的に延期する項目

- 子Runtimeクライアントと実際の入れ子`spawn`
- SQLite/WALと再起動時の照合
- 並列/バックグラウンド公開インターフェース
- ワークツリーと書き込み可能範囲の調停
- ペインの自動クリーンアップ
- 永続的で再利用可能なワーカー
- 汎用Herdrモデルツール
- スケジューラー/DAG/レビューワークフロー

これらはフェーズ2以降に属し、フェーズ0/1のインターフェースを拡大してはならない。

## 7. 残っている着手阻害事項

決定P-001（TypeScript/Node）は完了済み。フェーズ0開始前に残る依存関係の決定は以下のとおり。

- 決定案P-002（`effect@3.22.1`のコアのみ）を承認済みにするか
- Piの子セッション/イベントインターフェースをどの公式パッケージ/バージョンから利用するか
- テストランナーとTypeScriptのビルド/チェック用ツールチェーン

フェーズ0のトレーサーバレット自体は実エージェントパッケージなしで開始可能。プロジェクトのひな型作成と依存関係の追加は、Effectの決定およびツールチェーン選定後に行う。

## 8. 最初のトレーサーバレット

### 決定T-001

最初のトレーサーバレットは**エージェントパッケージ/プラットフォーム非依存の単一操作成功経路**とする。EffectコアをRuntime内部で使うが、実エージェント、実サブプロセス、実Herdr、ネットワーク、SQLite、入れ子、キャンセルは含めない。

1本のテストで以下の全境界を通す。

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

受け入れ条件:

1. `TaskSpec(prompt_ref, profile, idempotency_key)`から1つの操作を作る。
2. イベント列は最低でも`operation_requested -> operation_starting -> operation_started -> result_persisted -> self_settled -> operation_completed`となる。
3. 結果本文、バイト数、ダイジェストが保存される前に`self_settled`または`completed`へ進めない。
4. `Handle.result()`は型付きの結果を一度公開し、同じ冪等性キーで再度`spawn`した場合は同じハンドル/結果を返してバックエンドを二重起動しない。
5. 同一`seq`、同一ダイジェストの結果再送は確認応答相当として無害とし、同じ操作に異なるダイジェストを持つ2つ目の結果が届いた場合は閉鎖的に失敗させる。
6. 表示の失敗または偽の`completed`投影は操作状態を変更できない。
7. EffectのClock/TestClockと決定論的なID/トークンファクトリーを使い、テストは実時間のスリープや外部プロセスに依存しない。
8. 内部オーケストレーションは偽のLayer群で実行して`Exit`を検証できるが、公開`Runtime`/`Handle`からEffect型を返さない。
9. リデューサーをEffectプログラムにせず、素の不変な入力/出力を扱う純粋な同期関数とする。

このバレットの目的は状態語彙を網羅することではなく、`Runtime`、バックエンド、チャネル、store、表示の境界と「確定前に永続化する」という最重要の順序を最小の垂直スライスで実証すること。次のバレットで親子の排出と子孫優先のキャンセルを追加し、その後に偽のHerdr起動トランザクションへ進む。
