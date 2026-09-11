---
status: accepted
---

# ESLintの構文検査とTypeScriptの検査を分離する

TypeScript 7が`typescript-eslint`の対応範囲外である間、ESLintは`@babel/eslint-parser`でTypeScript構文を読み取り、言語非依存の規則を検査する。未使用宣言、未定義識別子、型の正しさは、対応外のパーサーを強制導入せず、`tsc`の`noUnusedLocals`、`noUnusedParameters`、`strict`で検査する。
