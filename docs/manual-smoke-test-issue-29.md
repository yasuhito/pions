# Issue #29 手動スモークテスト

## 位置付け

この記録は、Pi CLI可視ワーカーを実際のPiとHerdrで端から端まで確認した受け入れ証拠である。自動テストでは置き換えているPi TUI、端末入力、Herdrの起動判定、プロセス停止、ペイン後処理を実機で観測した。この試験は通常の自動テストスイートへ含めない。

## 実行条件

- 実行日: 2026-09-07
- 試験開始時の固定点: `72acb5b102515617a5441545fdc8dff6dddcbf61`
- 通信断修正後の再試験対象: `7358ff769ea7f979a485edc03539ae126e51305e`
- OS: Linux 7.1.8-arch1-3 x86_64
- Node.js: 26.7.0
- Pi: 0.85.1
- Herdr: 0.8.2
- 委譲元とワーカーのモデル: `openai-codex/gpt-5.6-sol`
- 思考レベル: `medium`
- 作業ディレクトリ: `/home/yasuhito/Work/pions`
- 状態保存先: `~/.local/state/pions`

実行前に次を実行し、ソースと可視ワーカーが読む`dist`を一致させた。

```bash
npm run build
npm run typecheck
```

最初の試行では未更新の`dist`がワーカープロトコル版6、ソースが版7だったため、ワーカーTUIに`Worker configuration version does not match`が表示された。`npm run build`後、同じ設定ファイルを`dist`の`decodeWorkerConfig`へ渡す再現コマンドが失敗から成功へ変わり、以後の試験を続行できた。

## 通常完了とTUI

### 操作

`pions_delegate`へ、`CONTEXT.md`を`read`で読み、ドメイン用語を箇条書きで説明するタスクを渡した。別の長時間タスクでは、ワーカーの実行中にHerdrからワーカーペインへ次を送った。

- `/model anthropic/should-not-change`とEnter
- `INJECTED_MESSAGE_MUST_NOT_APPEAR`とEnter

起動前、実行中、終了後に`herdr pane list`でフォーカスを取得した。実行中には`herdr pane process-info`、`herdr agent list`、`herdr pane read`でプロセス、メタデータ、画面を記録した。

### 期待結果

- 委譲元のフォーカスを維持したまま、同じタブの兄弟ペインへ公式`regular` TUIが現れる。
- TUIにタスク、思考、ストリーミング、ツール実行、最終回答が現れる。
- 端末入力から追加メッセージ、Piコマンド、モデル変更が発生しない。
- 認証済み`Result`が永続化されて委譲元Piへ返り、Pi停止後に成功ペインが閉じる。

### 実測結果

`Operation` `0ed52b0e-0324-4d11-aa13-e67b6af9dce9`のペイン`wS9:p2N`に、次を順に観測した。

- 通常のユーザーメッセージとして表示されたタスク
- `Planning parallel reading of context and domain docs`という思考表示
- `read CONTEXT.md`と`read docs/agents/domain.md`というツール表示
- 生成途中から伸びる箇条書き回答
- 最終行`表示確認完了`

イベント列は`operation_requested`、`presentation_owned`、`operation_starting`、`worker_launched`、`operation_started`、`worker_identified`、`result_persisted`、`agent_settled`、`self_settled`、`operation_completed`の順だった。委譲元Piには1,258バイトの本文が返り、ダイジェストは`sha256:566339e12815c0a7ec409027f8843a37d61cf2e203f66aa552cc345268242e44`だった。Pi停止後にペインは自動で閉じた。

端末入力試験の`Operation` `3e0fd8d5-a196-4850-a499-9244a4120983`では、入力したコマンドと文字列はTUIにも返却された`Result`にも現れず、`worker_identified`の実測モデルは引き続き`openai-codex/gpt-5.6-sol`だった。実行前、実行中、終了後のフォーカスはいずれも委譲元ペイン`wS9:p3`だった。

## 起動設定、秘密保持、セッション

### 操作

実行中のワーカーペインに対して、Herdrのプロセス情報、エージェント情報、TUIの読込資源を確認した。各`worker_identified`のPiセッション識別子が、`~/.pi/agent/sessions/--home-yasuhito-Work-pions--`のファイル名に存在するか照合した。

### 期待結果

- タスク本文がプロセス引数、Herdrメタデータ、エージェント名に現れない。
- 信頼済み`AGENTS.md`とPions内部拡張だけを読み、通常のスキル、拡張、プロンプトテンプレートを読まない。
- Pi標準セッションを保存しない。

### 実測結果

Herdrが報告した前景プロセスは`argv: ["pi"]`、エージェント名はタスクと無関係な`pions-30f72c212ca275f6f18207645c`、タイトルは`π - pions`だった。TUI上の起動コマンドにもタスク本文はなく、所有者限定の`worker.v7.json`へのパスだけが渡されていた。

TUIの読込資源には`[Context] AGENTS.md`と`[Extensions] worker-extension.js`だけが表示された。起動指定は`--no-session`、`--no-extensions`、`--no-skills`、`--no-prompt-templates`、`--no-themes`と、明示した内部拡張を含んでいた。

受け入れ試験で記録した各ワーカーPiセッション識別子に一致する標準セッションファイルは0件だった。試験のため別途起動した委譲元Piの標準セッションは保存されており、ワーカーの一時セッションと区別できた。

## 高速終了

### 操作

`pions_delegate`へ、ツールを使わず`FAST_OK`だけを返すタスクを渡した。起動中のTUIを並行して読み、Herdrの起動完了前にはタスク、思考、ツール実行がなく、識別後にタスクが表示されることを確認した。

### 期待結果

`herdr agent start`がタイムアウトせず、起動成功と識別後に`begin`でモデル実行が始まり、通常完了する。

### 実測結果

`Operation` `14c7c648-77b4-40fe-84f1-75f0160adc6f`では、`worker_launched`が15:06:21.744、`operation_started`が15:06:21.758、`worker_identified`が15:06:21.770、`result_persisted`が15:06:30.937に記録された。起動完了前の画面にモデル実行はなく、識別後にだけタスクと回答が現れたため、起動成功後の`begin`で実行されたことを確認できた。起動は約3.9秒で成功し、7バイトの`FAST_OK`が委譲元Piへ返り、`operation_completed`後にペイン`wS9:p2M`が閉じた。Herdrの30秒起動タイムアウトは発生しなかった。

## ワーカー失敗

### 操作

実ワーカーの識別後、`begin`で読む所有者限定プロンプトファイルを意図的に削除し、内部拡張の開始処理を失敗させた。

### 期待結果

失敗が委譲元Piへ返り、意味上の状態が失敗となり、Piプロセスとペインが調査用に残る。

### 実測結果

`Operation` `15b1dca6-2131-4e10-9ec6-0dc8e376f9fe`は委譲元Piへ`agent_failed`を返した。イベント列の末尾は`agent_settled`、`self_settled`、`operation_failed`である。ペイン`wS9:p2F`とそのPiプロセスは残り、エラー画面を調査できた。

## 親キャンセル

### 操作

試験用の委譲元PiをHerdrペインで起動し、ワーカーへ30秒待機するツール実行を委譲した。ワーカーTUIに実行中表示が出た後、委譲元PiへEscapeを送り、進行中のツール呼び出しを中断した。

### 期待結果

委譲元Piへキャンセルが返り、ワーカーPiが停止し、最終画面の残ったペインが保持される。

### 実測結果

`Operation` `883f1276-3244-44f0-a838-02a533b21605`では、`cancellation_requested`、`cancel_dispatched`、`cancel_acknowledged`、`operation_cancelled`が記録された。委譲元Piにはキャンセルが返った。ペイン`wS9:p2K`の前景はPiからシェルへ戻り、Piプロセスが停止した一方、TUIの`Command aborted`と`Error: This operation was aborted`を残したペインは保持された。

## 状態不明

### 停止検証不能

期待結果は、停止を証明できないキャンセルをキャンセル済みへ確定せず、状態不明としてプロセスとペインを保持することである。最初の未ビルド試行で、内部拡張が設定版不一致により識別前に停止した状態から、オペレーションをキャンセルした。`Operation` `27c00b23-68bd-4bb8-8964-fd8258e42c45`は`cancellation_requested`、`cancel_dispatched`の後に、理由`cancel-unproven`の`operation_unknown`となった。ペイン`wS9:p2C`とPiプロセスは保持され、`Worker configuration version does not match`の画面を調査できた。

### 通信断

他の委譲が動いていないことを確認し、1つ目の端末で次を実行した。

```bash
node scripts/manual-smoke-test-issue-29-disconnect.mjs
```

`次のpions_delegate呼び出しを待っています。`と表示された後、2つ目のPiから、`node -e "setTimeout(() => {}, 12000)"`を実行して待つタスクを1回だけ`pions_delegate`へ渡した。スクリプトは新しいワーカー設定を検出し、実ワーカーとランタイムのUnixドメインソケット間へ一時的な中継を置く。中継は`hello`と`started`をランタイムへ、認証済み`begin`をワーカーへそのまま転送した後、ランタイム側の接続だけを正常切断する。製品コードの実行経路に試験用分岐は追加していない。

期待結果は、稼働中のPiを失敗や成功へ確定せず、状態不明としてプロセスとペインを保持することである。最初の実測では`worker_protocol_failed`となったため、`WorkerAdapter.open(Operation): Worker`の継ぎ目へ回帰テストを追加し、稼働中のPiとの通信断も`liveness-unproven`へ分類するよう修正した。

保存した手順を使った修正後の`Operation` `8bcca29b-1f33-4b4d-a7c1-d2d898130526`では、スクリプトに`通信を切断しました。オペレーション状態とHerdrペインを確認してください。`と表示された。イベント列は`operation_requested`、`presentation_owned`、`operation_starting`、`worker_launched`、`operation_started`、`worker_identified`、`operation_unknown`の順となり、末尾の理由は`liveness-unproven`だった。ペイン`wS9:p38`とPiプロセスは保持され、通信断後のTUIを調査できた。

## 自動検査

手動試験後に次を実行し、型検査、全自動テスト、テストのアサーション規約検査、ビルドがすべて成功した。

```bash
npm run typecheck
npm test
npm run check:test-assertions
npm run build
```

## 結論

Issue #29の受け入れ条件を実機で確認した。成功ペインだけが自動で閉じ、失敗、キャンセル、状態不明のペインは意図どおり調査用に残した。プロトコル版変更後の未更新な`dist`は版不一致を起こすため、利用前の`npm run build`は必須である。
