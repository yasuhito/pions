# エージェント向け指示

## ドメイン文書

Pionsの調査、設計、仕様策定、実装に着手する前に、`CONTEXT.md`と`docs/adr/`にある関連文書を読む。詳細は`docs/agents/domain.md`に従う。

## 互換性

設計と実装は常に最新版だけを対象とする。過去の形式や振る舞いとの互換性を保つ分岐、移行処理、非推奨経路は削除し、現行形式へ一本化する。互換性が仕様として明示された場合だけ例外とする。

## テスト

各テストケースは、1つの振る舞いを1つのアサーションで検証する。複数のアサーションが必要な場合は、観測対象ごとに適切な名前のテストケースへ分割する。

`npm test`とは別に、本物のPiとHerdrを使った委譲のE2E検証を`npm run test:e2e`で実行できる。既存のHerdrセッションやワークスペースを変更しない隔離環境で動く。必要条件と後始末の仕組みは`docs/e2e-real-pi-herdr.md`を参照。CIには含めない。

## 文書作成

`README.md`は英語で作成・更新する。それ以外の人向け文書は日本語で作成・更新する。ADR、調査記録、GitHub Issue、Markdown文書、HTMLレポートもこれに含む。

日本語文では、一般語を自然な日本語または定着したカタカナ語で書く。正確さに必要なコード識別子、パッケージ名、コマンド、プロトコルリテラルだけをバッククォートで残す。

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
