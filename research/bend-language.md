# 現行 Bend 言語の調査

調査日: 2026-09-27。対象は [bend-lang.com](https://bend-lang.com/) の **Bend 2** (`bendlang/bend`)。旧 HigherOrderCO/Bend・HVM の構文や実行方法は流用できない。公式ガイドを優先して記述し、Bend 2.0.31 をインストールして `npm run verify:bend` で `verification/bend/` の法則を `--safe` で検査した。[公式 README](https://github.com/bendlang/bend/blob/main/README.md) の制約一覧には、ガイドより古い記述（例: ハブに名前・版がない）が残っているため、変化する機能は最新版のガイドと実装で再確認する。

## 導入と実行

- 公式手順は `curl -fsSL https://bend-lang.com/install.sh | sh`。調査時点の[配布スクリプト](https://bend-lang.com/install.sh)は 2.0.31、Linux/macOS の x64/arm64（Windows は WSL）向けアーカイブを SHA-256 検証後、既定で `~/.bend` に配置する。表示される `~/.bend/bin` を `PATH` に追加する。スクリプトを確認してから実行すること。`bend update` は再取得して更新する。日次の版確認通信は `BEND_NO_TELEMETRY=1` で止められる。
- `bend guide` は言語ガイド、`bend base [--types|<name>]` は標準ライブラリ、`bend --help` はコマンド一覧。`bend file.bend` は検査して `main` を実行（`IO` を返す場合はコンパイル実行、純粋な値を返す場合はチェッカーによる正規化と表示）。`main` がなければ検査のみ。副作用なしで検査するなら `--check-only`。`bend file.bend -o file.js` は JavaScript、`.c` は C、拡張子なしならネイティブ実行ファイルを出力する。ネイティブ化には clang 14 以上、GPU 使用には clang 19 以上（Apple clang 17）と Metal または CUDA 12 が必要。[ガイド Tooling](https://github.com/bendlang/bend/blob/main/guide/GUIDE.md#tooling)・[CLI 実装](https://github.com/bendlang/bend/blob/main/bend2/main.ts)

## 言語と証明

- Python 風の字下げ構文だが、純粋な関数と `IO` の効果を分離する。`import Base`、`type ... is Data/Type`、型付き `def f(x: T) -> U:`、`match ...: case ...:`、`do IO<T>:` を使う。変数は既定で高々一度使用するアフィン、`+x` は再利用可能な `Data` 値、`-x` は実行時に消える値。型推論は限定的で、演算にも `(a + b : U32)` のような注釈を要する。`a b = f(x) g(y)` は独立した並列呼び出し、`f!(x)` は GPU 指定（利用不可なら CPU）。JavaScript 出力では並列性はなく逐次実行する。[ガイド Core Features・Syntax Reference](https://github.com/bendlang/bend/blob/main/guide/GUIDE.md)
- `law add_zero: for x: Nat; {Nat.add(x, 0n) == x : Nat}` のような命題を、同名の `def add_zero(x): ...` で証明する。`{==}` は計算で一致する等式の証明、`%e : P` は等式による書き換え。慣例では人が `LAWS.bend` を保持し、実装側が `PROOF.bend` に `def Laws.add_zero` などを置く。`bend PROOF.bend` は未証明・偽の法則で失敗する。`--safe` は追加で Lean により証明された小さな BendTT カーネルで再検査するが、BendTT への翻訳自体は証明されていない。外国語実装は型から作るモデルとして検査され、C/JS の実装内容は検証されない。`@unsafe` は保証の範囲外。証明は記述した仕様と信頼できる実装の範囲についてのみ成立し、外部プロセスや Node 側の性質まで保証しない。[ガイド Laws and Proofs](https://github.com/bendlang/bend/blob/main/guide/GUIDE.md#laws-and-proofs)

## Node からの呼び出し

- 最も直接的には Node の `node:child_process` の `execFile`/`spawn` で `bend` を引数配列付きで起動し、終了状態と標準出力・標準エラーを処理する。CLI の `bend file.bend --check-only`（検査）、`bend PROOF.bend --safe`（証明検査）、`bend file.bend -o file.js`（生成）、`bend file.bend`（実行）を使い分ける。これは公開された CLI を Node から利用する設計上の提案であり、Node 専用の公式 SDK があるという意味ではない。[CLI 実装](https://github.com/bendlang/bend/blob/main/bend2/main.ts)
- 純粋関数を JS に直接取り込む方法もある。公式ガイドは `bend2/main.ts` を Node の `--import` でプリロードし、`import Game from "./game.bend"` とする方式を示す。インストール版なら `node --import "$HOME/.bend/bend2/main.ts" app.mjs` が配置場所から導ける例（カスタム `BEND_HOME` の場合は変更）。Node が TypeScript の `.ts` を読み込める環境を要する。ローダーが公開するのは定義済みの非 `IO`・非 Base 関数で、`Nat` は `BigInt`、コンストラクターは `{$: "Name", field: value}`、配列はコピーされず所有権に注意が必要。`IO` を含む処理は CLI/生成物側で実行する。[ガイド IO and Concurrency](https://github.com/bendlang/bend/blob/main/guide/GUIDE.md#io-and-concurrency)・[ローダー実装](https://github.com/bendlang/bend/blob/main/bend2/main.ts)

## 採用上の制約

- 開発途上。再帰には停止証明が必要（相互再帰は不可）、計算結果を直接 `match` できず、`if` 構文もない。証明タクティクス・自動証明探索なし。`F32` は公理的で浮動小数点の性質を証明できない。標準ライブラリには TLS、HTTP、JSON、正規表現がなく、必要なら外部実装を足すがその実装は証明対象外。JS ターゲットは単一コアで映像・音声なし。ネイティブ並列化は均等な仕事量に依存し、単一のイベントループ、プログラムごとに GPU 一つ。コンパイラーのチェッカー自体は未証明で、`--safe` の適用範囲と翻訳の信頼境界も確認すべき。既存の Pions の Node/TypeScript 実装をそのまま Bend に移せるという根拠はない。[公式 README Limitations](https://github.com/bendlang/bend/blob/main/README.md#limitations)・[ガイド](https://github.com/bendlang/bend/blob/main/guide/GUIDE.md)
