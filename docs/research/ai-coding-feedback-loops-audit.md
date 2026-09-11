# AIコーディングのフィードバックループ監査

## 調査対象

AI Heroの記事[「Essential AI Coding Feedback Loops for TypeScript Projects」](https://www.aihero.dev/essential-ai-coding-feedback-loops-for-type-script-projects)に挙げられた実践を、Pionsの現在の設定と比較した。

## 結論

| 記事の実践                          | 判定     | 根拠                                                                                            |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| TypeScriptと型検査                  | 実践済み | `docs/adr/0001-use-typescript-for-the-runtime.md`、`tsconfig.json`、`package.json`の`typecheck` |
| 自動テスト                          | 実践済み | `package.json`の`test`、`test/`、CIの`npm run check`                                            |
| Huskyによるコミット前検査           | 実践済み | `.husky/pre-commit`、`package.json`の`prepare`                                                  |
| lint-stagedとPrettierによる整形     | 実践済み | `.lintstagedrc`、`.prettierrc`                                                                  |
| ESLint                              | 実践済み | `eslint.config.js`、`package.json`の`lint`                                                      |
| LLMによるローカル開発サーバーの確認 | 対象外   | Pionsはブラウザー向けフロントエンドを持たない。代わりに実環境の手動スモークテストがある         |

## フィードバックループ

`npm run check`は、型検査、ESLint、Prettier整合性検査、テストのアサーション規約検査、自動テストを順番に実行する。`.github/workflows/check.yml`はpushとpull requestでこのコマンドを実行する。

コミット時には`.husky/pre-commit`がlint-stagedによるステージ済みファイルのPrettier整形とESLint自動修正を行い、その後`npm run check`でリポジトリ全体を検査する。検査列は`check`スクリプトへ集約し、コミット前とCIで同じ規約を適用する。

TypeScript 7は調査時点の`typescript-eslint`の対応範囲外であるため、ESLintは`@babel/eslint-parser`と`@babel/plugin-syntax-typescript`でTypeScript構文を解析する。未使用宣言、未定義識別子、型の正しさは`tsc --noEmit`が担当し、`noUnusedLocals`と`noUnusedParameters`も有効にしている。この分担は`docs/adr/0012-separate-eslint-syntax-checks-and-typescript-checks.md`に記録した。

## リポジトリ固有規約の自動検査

`scripts/check-test-assertions.ts`が「各テストケースは1つの振る舞いを1つのアサーションで検証する」という`AGENTS.md`の規約を検査する。この検査も`npm run check`とCIに組み込まれている。

## 対象外または代替手段がある項目

記事のローカル開発サーバー確認はフロントエンドを想定している。Pionsにはブラウザー向け画面がないため、そのまま適用する対象はない。一方、`docs/manual-smoke-test-issue-23.md`、`docs/manual-smoke-test-issue-29.md`、`docs/manual-smoke-test-issue-49.md`には、実際のPi、Herdr、モデル連携を確認する手動スモークテストが記録されている。

## 記事外の補足

`npm run check`とCIは`npm run build`を実行しない。型検査とテスト用コンパイルは行われるが、`tsconfig.build.json`固有の宣言ファイル生成などは通常のCIゲートに含まれない。
