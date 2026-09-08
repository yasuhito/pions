# Issue #49 手動スモークテスト

## 位置付け

この手順は、実際のClaude Pro/Max契約、Claude Code、Pi、Herdrを使い、固定版`pi-claude-bridge`によるワーカー実行を確認する。課金先、プラン利用枠、Claude Code子プロセスは自動テストでは確認できないため、リリース前に実施する。

## 事前条件

- `npm install`で`pi-claude-bridge` 0.7.0を導入済みである。
- `npm run build`、`npm run typecheck`、`npm test`が成功する。
- `claude`を起動し、試験するClaude Pro/Maxアカウントでログイン済みである。
- 分離したClaude設定を使う場合、委譲元Piの起動前から同じ`CLAUDE_CONFIG_DIR`を設定する。
- `CLAUDE_BRIDGE_DEBUG`は無効にする。
- Claudeの利用量画面と追加利用設定を試験前に記録する。

`.pions.json`を次の内容にする。

```json
{
  "review": {
    "model": {
      "provider": "claude-bridge",
      "id": "claude-opus-5"
    },
    "thinkingLevel": "high"
  }
}
```

必要なら`~/.pi/agent/claude-bridge.json`へ実契約だけを指定する。追加利用は有効にしない。

```json
{
  "askClaude": { "enabled": false },
  "provider": {
    "plan": "max",
    "strictMcpConfig": true,
    "autoMemoryEnabled": false,
    "longContextExtraUsage": false
  }
}
```

## Opus 5の通常完了

1. 委譲元Piから、リポジトリ内の文書を読み短い要約を返すタスクを`pions_delegate`へ渡す。
2. ワーカーTUIで`claude-bridge/claude-opus-5`と思考レベル`high`を確認する。
3. `read`などの許可済みツールだけが表示され、結果が委譲元へ返ることを確認する。
4. 成功後にPiとClaude Codeのプロセスが終了し、成功ペインが閉じることを確認する。
5. Claudeの利用量画面を再確認し、利用が契約プラン枠へ計上され、追加利用の課金が発生していないことを記録する。
6. 提供されたコンテキスト長と`provider.plan`の実効値をClaude Codeまたは契約画面で確認する。

## 拡張と秘密情報

実行中のHerdrプロセス情報とワーカーTUIを確認する。

- 起動引数に`--no-extensions`があり、`worker-extension.js`と固定版`pi-claude-bridge/src/index.ts`だけが`--extension`で指定される。
- グローバルまたはプロジェクトの別拡張、スキル、プロンプトテンプレート、利用者MCP、`AskClaude`が利用可能にならない。
- `.pions.json`、`worker.v7.json`、プロセス引数、Herdrメタデータ、永続イベント、ログ、返却された結果にOAuthトークンやClaude資格情報がない。

`node_modules/pi-claude-bridge/package.json`の版、または`src`配下の内容を一時的に変更し、起動前に版またはソースダイジェストの不一致で拒否されることも確認する。試験後は`npm ci`で正規状態へ戻す。

## 明示的な失敗

次を別々に実施し、それぞれ別モデルへ切り替わらず、原因に対応する失敗になることを確認する。

1. `CLAUDE_CONFIG_DIR`を未ログインの空ディレクトリへ向ける。期待理由は`model_auth_unavailable`。
2. 契約で利用できないモデル識別子を試験用の固定カタログで選ぶ。期待理由は`model_not_found`。
3. Opus 5を利用できないプランで実行する。期待理由は`unsupported_capability`。
4. `strictMcpConfig: false`、`askClaude.enabled: true`、`autoMemoryEnabled: true`、`longContextExtraUsage: true`を一つずつ指定し、いずれもワーカー起動前に拒否されることを確認する。

## 並列実行とレート制限

独立した四つ以上の`pions_delegate`をPiの並列ツール実行で開始する。全ワーカーがOpus 5を選び、個別の結果を返すことを確認する。プランのレート制限を超えた場合は、そのエラー内容、同時実行数、再開可能時刻を記録し、Codexなどへフォールバックしないことを確認する。

## キャンセルと状態不明

1. Claudeワーカーに長時間の読み取りまたはテストを依頼する。
2. Claude Code子プロセスのPIDを記録する。
3. 委譲元Piで実行を中断する。
4. Agent SDKの中断後にClaude Code子プロセスとワーカーPiが停止し、オペレーションがキャンセル済み、ペインが調査用に保持されることを確認する。
5. 試験用に停止観測を不能にした経路では、キャンセル済みにせず状態不明となり、Pi、Claude Code、およびペインの情報が調査用に残ることを確認する。

## 既存プロバイダーの回帰

`.pions.json`を既存のCodex設定へ戻して1件委譲する。Claude bridgeを起動引数へ追加せず、従来どおり終端完了して結果を返すことを確認する。

## 記録項目

実施日、Pionsコミット、Pi・Herdr・Claude Code・`pi-claude-bridge`の版、契約プラン、追加利用設定、各オペレーション識別子、選択モデル、思考レベル、並列数、レート制限、課金先、キャンセル後のPID状態をこの文書へ追記する。資格情報そのものは記録しない。
