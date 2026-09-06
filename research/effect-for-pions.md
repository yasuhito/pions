# Pions のための Effect：安定版世代の適合性、境界、および Phase 0 の推奨事項

**ステータス：** 調査に基づく推奨事項；依存関係の変更なし
**調査日：** 2026-09-06
**方法：** 静的調査のみ。パッケージのインストールも実行も行っていない。情報源は、Effect の公式サイト／レジストリメタデータ、正確なコミット時点の正規 [`Effect-TS/effect`](https://github.com/Effect-TS/effect) リポジトリ、公式のパッケージマニフェスト／リリース、および上流のテスト／例に限定した。バージョン指定のないウェブサイトは方向性を把握するためのものとして扱い、バージョン固定された API の根拠とはしなかった。Herdr または Qoral のリソースを調査したり操作したりしていない。

## 結論の要約

**推奨事項。** Pions のオーケストレーション実装、境界スキーマ、型付きの運用エラー、テストクロック、リソーススコープ、および構造化されたプロセス内並行処理には、**Effect v3 を正確に `effect@3.22.1` に固定して**採用する。呼び出し元向けの `Runtime`/`Handle` インターフェースに `Effect`、`Layer`、`Context`、`Exit`、または `Cause` を含めてはならず、純粋な操作リデューサーを Effect プログラムとして記述してもならない。要件で約束された公開形状を維持する：

```ts
const handle = await runtime.spawn(task, options)
const result = await handle.result()
await handle.cancel({ scope: "subtree" })
```

内部では、ブートストラップされた 1 つの Effect プログラムで `AgentBackend`、`EventStore`、`ChildChannel`、`Presentation`、クロック、および ID／トークンサービスを合成できる。薄いアダプターがそのプログラムを実行し、型付けされた結果を公開 Promise API に変換する。

**Phase 0** では、次のみを追加する：

```json
{
  "dependencies": {
    "effect": "3.22.1"
  }
}
```

`Effect.runPromiseExit` の周囲では、プロジェクトの通常のテストランナーを使用する。Vitest を選択し、Effect 対応のテスト操作性に追加の依存関係を導入する価値があるなら、正確な開発依存関係 `@effect/vitest@0.30.0` を追加する；これは有用だが、トレーサーバレットを実証するために必須ではない。`@effect/schema` は追加しないこと：Schema は `effect` の一部であり、独立パッケージはメインパッケージに統合されたものとして公式に非推奨となっている。Phase 0 を開始するためだけに、`@effect/platform-node`、Stream 基盤、STM ベースのレジストリ、または OpenTelemetry を追加しないこと。

**Phase 1** では、一貫性のある安定版プラットフォーム一式 `@effect/platform-node@0.108.1`、`@effect/platform@0.97.1`、およびパッケージマネージャーが要求する互換性のあるピアを別途評価し、受け入れる場合は固定する。そのファイルシステムおよび Unix ソケットサービスは Pions によく適合する。そのコマンド API は有用なサブプロセスプリミティブだが、それだけでは Pions が必要とするプロセスインスタンスの識別、子孫プロセスグループの終了、またはキャンセルの証明を確立できない；同じサービス境界の背後で、小規模な Node 固有の `AgentBackend` プロセススーパーバイザーが `node:child_process`／OS 操作を直接必要とする可能性は残る。

最大の利点は「関数型スタイル」ではない。割り込み、クリーンアップ、タイムアウト、依存関係の置換、エラー原因、および決定論的な時間を、**ランタイム内部で**第一級のものにすることである。最大のリスクは、それらの仕組みを Pions のドメイン上の証拠と取り違えることだ：ファイバーの割り込みはワーカープロセスが停止した証明ではなく、スコープのファイナライズは `operation_cancelled` ではなく、`PubSub` 通知は権威あるイベントではなく、メモリ内でのシーケンシング成功は永続的な persist-before-settle ではない。

## 1. 安定版世代と正確な固定

### 1.1 安定版とプレビュー版

**情報源に基づく事実。** 調査日時点で、公式 npm の `latest` dist-tag は `effect@3.22.1` だった。同じレジストリでは `beta` として `effect@4.0.0-beta.107`、`rc` として `effect@4.0.0-rc.112` も公開されていた；GitHub は v4 RC リリースをプレリリースとして表示していた。正規の注釈付きタグ `effect@3.22.1` は、コミット [`417e0faa80e471d77fc4a67452e68b09ae0ee861`](https://github.com/Effect-TS/effect/tree/417e0faa80e471d77fc4a67452e68b09ae0ee861) を指す。そのコミットのマニフェストにはバージョン `3.22.1` と記載され、メインパッケージから Schema をエクスポートしている。[固定されたマニフェスト](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/package.json) · [不変の npm メタデータ](https://registry.npmjs.org/effect/3.22.1) · [v4 RC リリース](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.112)

**解釈。** 現在の安定版世代は **Effect 3** である。Effect 4 はプレビュー／リリース候補の系列であり、より新しく、バージョン指定のないウェブサイトや current-main の例で主流になっている可能性があっても、安定版の系列ではない。

**推奨事項。** コアとなる Phase 0 の作業では、コミット `417e0f…` を API の根拠として扱う。v4 beta／RC の例、インポート、サービス API、またはパッケージのバージョニングを v3 コードにコピーしないこと。実装時に API を調べる際は毎回、このコミットまたは正確に固定してインストールした成果物の宣言ファイルと照合すべきである。

### 1.2 一貫性のある安定版パッケージマトリックス

| パッケージ | 正確な安定版 | 正規リリースコミット | 互換性と判断 |
|---|---:|---|---|
| `effect` | `3.22.1` | [`417e0faa80e471d77fc4a67452e68b09ae0ee861`](https://github.com/Effect-TS/effect/tree/417e0faa80e471d77fc4a67452e68b09ae0ee861) | **Phase 0 の依存関係。** Effect、Schema、Context/Layer、Scope、ファイバー、Exit/Cause、Stream、Queue/PubSub、Ref/STM、Clock/TestClock、Config/Redacted、Logger、および Tracer を含む。 |
| `@effect/platform` | `0.97.1` | [`417e0faa80e471d77fc4a67452e68b09ae0ee861`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/platform/package.json) | ピアとして `effect ^3.22.1` が必要；Phase 1 まで延期。[npm](https://registry.npmjs.org/%40effect%2Fplatform/0.97.1) |
| `@effect/platform-node-shared` | `0.61.1` | [`417e0faa80e471d77fc4a67452e68b09ae0ee861`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/platform-node-shared/package.json) | platform-node からの推移的依存関係；ピアとして同じコア／プラットフォーム系列が必要。[npm](https://registry.npmjs.org/%40effect%2Fplatform-node-shared/0.61.1) |
| `@effect/platform-node` | `0.108.1` | [`bd20125fb9b8ce42f814ba738513daaf83ce723d`](https://github.com/Effect-TS/effect/tree/bd20125fb9b8ce42f814ba738513daaf83ce723d) | ピアとして `effect ^3.22.1` および `@effect/platform ^0.97.1` が必要；Node `>=18`。Phase 1 まで延期。[マニフェスト](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node/package.json) · [npm](https://registry.npmjs.org/%40effect%2Fplatform-node/0.108.1) |
| `@effect/vitest` | `0.30.0` | [`e670e0f6befb959b84208d5f77631276521020ae`](https://github.com/Effect-TS/effect/tree/e670e0f6befb959b84208d5f77631276521020ae) | 任意の開発依存関係；ピアは `effect ^3.22.0`、`vitest ^3.2.0`。[マニフェスト](https://github.com/Effect-TS/effect/blob/e670e0f6befb959b84208d5f77631276521020ae/packages/vitest/package.json) · [npm](https://registry.npmjs.org/%40effect%2Fvitest/0.30.0) |
| `@effect/opentelemetry` | `0.64.0` | [`e670e0f6befb959b84208d5f77631276521020ae`](https://github.com/Effect-TS/effect/blob/e670e0f6befb959b84208d5f77631276521020ae/packages/opentelemetry/package.json) | コア `^3.22.0` およびプラットフォーム `^0.97.0` と互換性あり；外部テレメトリが必要になるまで延期。[npm](https://registry.npmjs.org/%40effect%2Fopentelemetry/0.64.0) |
| `@effect/schema` | `0.75.5` | 推奨対象外 | **追加しないこと。** 公式 npm マニフェストには「this package has been merged into the main effect package」と記載されている。[npm](https://registry.npmjs.org/%40effect%2Fschema/0.75.5) |

**情報源に基づく事実。** platform-node の npm マニフェストでは、`@effect/cluster`、`@effect/rpc`、および `@effect/sql` もピアとして列挙されており、`peerDependenciesMeta` で任意とは指定されていない。[npm](https://registry.npmjs.org/%40effect%2Fplatform-node/0.108.1)

**解釈。** platform-node の追加により、Pions が使用する機能の範囲を超えて依存関係解決の作業が増える可能性がある。最上位を正確に固定するだけでは、すべての推移的パッケージは固定されない；ロックファイルと npm の integrity 値も、再現可能性の境界の一部であり続ける。

**推奨事項。** `^`／`~` を付けずに固定し、ロックファイルをコミットし、依存関係の判断にパッケージの integrity を記録すること。v3 コアと、`4.0.0-beta.*` または `4.0.0-rc.*` バージョンを持つ v4 の platform／vitest パッケージを決して組み合わせないこと。

## 2. 機能評価

### 2.1 `Effect` と型付きエラー

**情報源に基づく事実。** 安定版 Effect は計算を `Effect<A, E, R>`、すなわち成功、型付けされた想定内エラー、および必要な環境としてモデル化する。コアパッケージで、逐次合成、`all`、競合、タイムアウトの各種バリアント、割り込みハンドラー、スコープ付き実行、サービス提供、Promise ランナー、ロギング、および span を提供する。[`Effect.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts)

**解釈。** これは、呼び出し元とテストが区別する必要のあるランタイムオーケストレーションの失敗、すなわち無効なタスク、ポリシーによる拒否、ストア障害、バックエンド起動障害、プロトコル拒否、タイムアウト、プロジェクション障害、およびキャンセル未証明に適合する。また、想定内の失敗（`E`）、予期しない欠陥、および割り込みの有用な区別を強制する。ただし、すべてのメソッドで増え続ける union は、小規模な Pions 独自のエラー代数よりも理解しにくくなり得る。

**推奨事項。** 閉じた Pions 名義のタグ付き運用エラーを定義し、各境界で下位レベルのプラットフォーム／バックエンドエラーを捕捉して変換する。欠陥はプログラマーのバグ／不変条件違反にのみ使用する。公開境界では、内部の `Exit` を一度だけ変換する；呼び出し元に Effect のエラーチャネルを理解させてはならない。

### 2.2 Schema

**情報源に基づく事実。** 安定版のメインパッケージは、`Schema.Struct`、`Schema.Union`、`Schema.TaggedStruct`、タグ付きクラス／エラー、および Effect、Either、または Promise を返す未知値のデコーダーをエクスポートする。[`Schema.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Schema.ts) 上流には、固定されたコミット時点で、schema の decode、class、cause/exit、arbitrary、および JSON Schema に関する広範なテストがある。[schema のテスト](https://github.com/Effect-TS/effect/tree/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Schema)

**解釈。** Schema は、`TaskSpec`、永続化されたイベントエンベロープ、スナップショット、子チャネルのフレーム、設定、およびバックエンドメッセージといった信頼できない境界に非常によく適合する。タグ付きイベントスキーマは、Pions の閉じたイベント語彙およびスキーマバージョンフィールドと自然に整合する。Schema は、状態遷移の合法性や「completed はすべての子孫が terminal であることを意味する」といったレコード横断の不変条件を証明するものではない。

**推奨事項。** 入力時およびリプレイ時にデコードし、その後はプレーンでイミュータブルなドメイン値をリデューサーに渡す。遷移ルールは通常の網羅的な TypeScript に保持する。フィクスチャやスナップショットを調べにくくする場合は、Schema クラスを唯一のドメイン表現として使用しない；Phase 0 にはタグ付き struct とスマートコンストラクターで十分である。

### 2.3 Context と Layer

**情報源に基づく事実。** `Context.Tag`／`GenericTag` はサービスを識別する；`Layer` は、Clock、ConfigProvider、Logger、および Tracer の置換を含め、サービス実装を構築、結合、提供、メモ化、およびスコープ化できる。[`Context.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Context.ts) · [`Layer.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Layer.ts)

**解釈。** Pions の内部境界は、ほぼそのまま置換可能なサービスである：`AgentBackend`、`EventStore`、`ChildChannel`、`Presentation`、Clock、および決定論的な ID／トークンファクトリ。Layer により本番／fake のグラフが明示され、スコープ付きサービスがまとめてクローズされることが保証される。しかし、これらのサービスの `R` 要件をすべての呼び出し元に公開すると、`Runtime` は浅いものになる：呼び出し元が、ランタイムが隠蔽すべき依存関係を組み立てることになる。

**推奨事項。** tag／layer は合成ルートと統合テストでの置換にのみ使用する。完全な live layer を所有する、深い 1 つの `Runtime` モジュールを構築する。純粋なヘルパーに tag を作成したり、リデューサーに環境から何かを要求させたりしないこと。

### 2.4 Scope と `acquireRelease`

**情報源に基づく事実。** `Effect.acquireRelease` は解放アクションを `Scope` に登録する；release はスコープの `Exit` を受け取る。`Effect.scoped` はスコープを閉じる。`forkScoped` はファイバーをローカルスコープに結び付ける一方、通常の `fork` は親に監督され、`forkDaemon` は意図的に親から離脱する。[`Effect.ts` のリソース API](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts) プラットフォームのファイルシステムで開かれたファイルとスコープ付き一時パスも Scope を必要とする／使用する。[`FileSystem.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/FileSystem.ts)

**解釈。** Scope は、ランタイムが所有するリスナー、開いたソケット、ファイルハンドル、子チャネルのサブスクリプション、プレゼンテーションセッション、および起動済みプロセスハンドルに非常によく適合する。起動失敗や割り込みにまたがるリークを減らす。これは、pane／プロセスを証拠として保持すべきかどうかを決定するものではなく、ファイナライザーを実行しても外部プロセスが停止した証明にはならない。

**推奨事項。** Pions のポリシーが自動的に解放可能と定めたリソースのみをスコープ化する。blocked／failed／unknown のときに保持する必要がある Phase 1 の worker pane は、無条件の acquire/release リソースではない。サブプロセスのファイナライザーはキャンセルを要求／エスカレートし、証拠を報告すべきである；永続化された証明に基づいて `cancelled` と `unknown` のどちらかを決定するのはリデューサーだけである。

### 2.5 ファイバー、割り込み、および構造化並行処理

**情報源に基づく事実。** 安定版 Effect は、親に監督される `fork`、スコープに監督される `forkScoped`、切り離された `forkDaemon`、ファイバーの `await`／`join`、interrupt と interrupt-all、`awaitAllChildren`、割り込みハンドラー、および割り込み可能性マスクを提供する。ソースドキュメントでは、通常の子の終了と、切り離された／スコープ付きライフタイムを明示的に対比している。[`Effect.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts) · [`Fiber.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Fiber.ts) 上流のテストでは、割り込まれたファイバーの exit と、スコープ駆動のファイナライズを検証している。[`Fiber.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Fiber.test.ts)
**解釈。** Fiber は、バックエンドの並行監視、子メッセージの処理、デッドライン、プレゼンテーションへの投影、子孫の待機に適している。Fiber によって、意図せず孤立した **プロセス内タスク** が生じにくくなる。Fiber は Pions の操作ではなく、Effect の supervision tree は Pions の永続的な lineage tree ではない。プロセスを待機している Fiber を中断しても、そのプロセスや OS 上の子孫が停止したことの証明にはならない。

**推奨事項。** 都合がよい場合は操作のライフタイムを反映させるが、lineage/state は EventStore に保持する。操作パスでは `forkDaemon` を避ける。キャンセルは必須のドメインプロトコルとして実装する。すなわち、epoch/freeze を永続化し、子孫のスナップショットを取得し、post-order でディスパッチし、確認応答／終了の証拠を待ってから、`cancelled` または `unknown` を永続化する。そのプロトコルの完了後、Fiber の中断によってローカルな待機処理を停止してもよいが、それによって終端イベントを捏造してはならない。

### 2.6 Exit と Cause

**ソース上の事実。** `Exit<A,E>` は `Success` または `Failure` のいずれかであり、Failure は `Cause<E>` を保持する。Cause は型付き失敗、defect（`Die`）、中断を区別し、逐次／並列に結合された Cause も表現できる。[`Exit.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Exit.ts) · [`Cause.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Cause.ts)

**解釈。** 内部／公開境界で `runPromiseExit` を捕捉すれば、defect や中断が失われることを防げる。Cause は並行オーケストレーションの診断証拠として有用である。ただしデフォルトでは安定した Pions 永続化スキーマではなく、その中断カテゴリも外部キャンセルの証明ではなく、ローカルランタイムの中断にすぎない。

**推奨事項。** 永続化の前に、Cause をサイズ制限付きでバージョン管理された Pions エラーレコード（`typed failure`、`defect`、`local interruption`、関連する要約）へマッピングする。任意の defect オブジェクトをシリアライズしたり、Runtime の呼び出し元に Cause を漏らしたりしてはならない。`cancel_unproven` は一般的な interrupted Cause ではなく、Pions の reason として保持する。

### 2.7 Stream

**ソース上の事実。** 安定版の Stream は、スコープ付き取得、ファイナライズ、中断、Queue への変換、service/layer の提供、タイムアウト、収集をサポートする。[`Stream.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Stream.ts)

**解釈。** Stream は、バックエンドのライフサイクル／ツール／メッセージイベントや、フレーム化された子ソケット入力の内部表現として適している。コールバックを Runtime 全体へ拡散させずに、合成とスコープ付きシャットダウンを提供する。最初の単一結果 fake channel には複雑すぎる可能性があり、汎用パイプラインを早期に導入すると、永続化／ACK の厳密な順序が不明瞭になるおそれがある。

**推奨事項。** 最初の tracer bullet では Stream を必須にしない。実際のバックエンドが複数のイベントを提供するようになったとき、または Unix socket がフレーム化されたときに導入する。権威ある consumer は、検証 → append/apply → projection の publish を行わなければならない。Stream は transport であり、authority ではない。

### 2.8 Queue と PubSub

**ソース上の事実。** bounded Queue は容量上限に達すると offer を suspend して backpressure を適用する。dropping variant と sliding variant には、明示的に非可逆な挙動がある。Queue の take は空の場合に suspend し、Queue はシャットダウンできる。PubSub は、スコープ付き subscriber ごとに dequeue を提供する。bounded、dropping、sliding、replay の各オプションが存在する。[`Queue.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Queue.ts) · [`PubSub.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/PubSub.ts) upstream のテストでは、bounded backpressure と、非可逆な dropping/sliding の順序が明示的にカバーされている。[`Queue.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Queue.test.ts) · [`PubSub.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/PubSub.test.ts)

**解釈。** bounded Queue は単一の順序付き ingestion path に適合し、過負荷を明示化する。PubSub は永続化後の best-effort なプレゼンテーション／telemetry に最も適している。どちらも永続的ではない。dropping/sliding の挙動は、権威ある状態イベントや結果の受け渡しには断じて不適切である。

**推奨事項。** 導入する場合は、制御された ingestion boundary ごとに bounded Queue を 1 つ使用し、capacity／overload failure を文書化する。PubSub は EventStore に受理された後の projection にのみ使用する。結果が Queue に入ったというだけで ACK してはならない。

### 2.9 Ref と STM

**ソース上の事実。** `Ref.modify` は、1 つのインメモリ参照について、戻り値と新しい値をアトミックに計算する。STM は、`TRef`、`TMap`、`TSet`、`TQueue`、`TPubSub` に対する合成可能なアトミックトランザクションを提供し、`STM.commit` でコミットされる。[`Ref.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Ref.ts) · [`STM.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/STM.ts) · [`TRef.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/TRef.ts)

**解釈。** Ref はシリアライズされたインメモリ registry に適している。STM を使えば、並行する spawn/cancel のもとで、idempotency、`spawn_frozen`、parent ごとの fan-out、root ごとの live-descendant count をアトミックに強制できる可能性がある。しかし STM は、外部の file/SQLite append をアトミックに含めることができない。Phase 0 で実際の並行 mutation が発生する前に transactional collection を導入すると、純粋な reducer の周囲に第 2 の概念的な状態モデルが生じる。

**推奨事項。** Phase 0 の reducer は純粋関数のままにし、EventStore の transition は 1 つの深い store/runtime operation を通じてシリアライズする。Ref は単純な fake／runtime-local coordination にのみ使用する。並行 spawn/cancel の claim を store 自身の transaction で安全に表現できない場合は、2 番目の tracer bullet で STM を再検討する。永続的な idempotency と freeze/count check を担うのは STM ではなく、最終的な durable store transaction でなければならない。

### 2.10 Clock と TestClock

**ソース上の事実。** Clock は現在時刻と sleep を提供する。TestClock は時刻の設定、sleep の検査、仮想時間の決定論的な調整ができる。[`Clock.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Clock.ts) · [`TestClock.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/TestClock.ts) 公式の upstream テストでは、`it.effect` と `TestClock.setTime`/`adjust` が使用されている。[`TestClock.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/TestClock.test.ts) Effect の Vitest adapter は Effect の test service を提供する。[`@effect/vitest` internals](https://github.com/Effect-TS/effect/blob/e670e0f6befb959b84208d5f77631276521020ae/packages/vitest/src/internal/internal.ts)

**解釈。** これは、決定論的な deadline、acknowledgement timeout、retry、cancellation のテストに直接適合する。Phase 0 の timestamp については、Pions は単純で決定論的な clock value factory も必要としている。全体で TestClock を使用することは任意であり、必須ではない。

**推奨事項。** ランタイムの time/sleep はすべて内部 Clock service から取得しなければならない。reducer は event 内の timestamp を受け取り、clock を読み取ることはない。オーケストレーションの timeout test には TestClock を使用し、reducer の table/property test には明示的な固定 timestamp を使用する。実時間の sleep は決して使用しない。

### 2.11 Config と Redacted

**ソース上の事実。** Config は、型付き string、duration、composition、`Config.redacted` をサポートする。Redacted は通常の inspection から値を隠し、`Redacted.value` による明示的な抽出を許可し、安全でない wipe operation を備える。[`Config.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Config.ts) · [`Redacted.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Redacted.ts)

**解釈。** Config は起動時の環境と policy default に適している。Redacted は capability/config secret が偶発的な log や inspection に現れないようにする助けになるが、access-control boundary ではない。コードは値を抽出でき、file mode、argv からの除外、event の redaction を強制するものでもない。

**推奨事項。** Config は process-level の Pions 設定に使用し、operation ごとの domain state には使用しない。dynamic capability token はメモリ内では Redacted でラップするが、それとは独立して Phase 1 の protocol rule を適用する。すなわち、private file/descriptor、argv 不使用、metadata/event payload 不使用、非境界的な parsing より前の認証、実用上可能な場合の明示的な wipe である。

### 2.12 Logging と telemetry

**ソース上の事実。** Effect core には、structured log level、scoped log annotation、custom Logger layer、span、tracer replacement、span annotation/link が含まれる。[`Effect.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts) · [`Logger.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Logger.ts) · [`Tracer.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Tracer.ts) 固定された upstream テストでは、scoped log annotation と nested/root span が検証されている。[`Logger.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Logger.test.ts) · [`Tracer.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Tracer.test.ts)

**解釈。** Operation/root ID、state sequence、backend identity、cancellation epoch は、log/span annotation として適している。log/span は Presentation と同様、あくまで observability であり、operation event を作成したり completion を証明したりすることはできない。

**推奨事項。** Phase 0 では core logging のみを使用し、test logger/sink と、サイズ制限された非 secret field の allowlist を用いる。OpenTelemetry dependency はまだ追加しない。後で必要になった場合は、整合する安定版の `@effect/opentelemetry@0.64.0` 系列に固定し、telemetry を ledger として扱うのではなく、永続化された domain fact から export する。

## 3. `@effect/platform-node` の機能

### 3.1 Subprocess

**ソース上の事実。** Platform Command は、program と argv array から command を構築する。shell execution はデフォルトではなく明示的なオプションである。cwd、stdin/stdout/stderr stream、`extendEnv: false` による environment replacement、scoped `start`、PID、exit code、liveness check、signal-based kill をサポートする。[`Command.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/Command.ts) · [`CommandExecutor.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/CommandExecutor.ts) Node layer が executor を提供する。[`NodeCommandExecutor.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/src/NodeCommandExecutor.ts) 公式テストは、argv execution、streaming stdin/out、cwd、厳密な environment replacement、startup failure、中断をカバーしている。[`CommandExecutor.test.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/test/CommandExecutor.test.ts)

**解釈。** これは、shell を介さない Herdr invocation と wrapper launch、stdin 経由の prompt、制限された environment、stream の capture、lifecycle scoping をサポートする。公開 Process model は PID を公開するが、ランダムな process-instance identity、process-group/session ownership、descendant enumeration、kill 後の OS 上の proof は提供しない。upstream test における Fiber interruption が示すのはローカルな cancellation behavior であり、Pions の proof standard ではない。

**推奨事項。** 通常の shell-free CLI call には Command を優先し、launch にも検討する。worker supervision 用に選択する前に、POSIX/Windows の厳密な process-group behavior と proof を spike で検証する。`detached`、group signal、厳密な close observation、process-instance record のために、Node API を直接使用できる adapter escape hatch を維持する。Process.kill の成功や Fiber interruption を直接 `operation_cancelled` にマッピングしてはならない。

### 3.2 Filesystem

**ソース上の事実。** Platform FileSystem には、read/write、option 付き mkdir、chmod、rename、remove、stat、streaming、scoped open、file-handle の `sync` が含まれ、Node package が layer を提供する。[`FileSystem.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/FileSystem.ts) · [`NodeFileSystem.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/src/NodeFileSystem.ts) upstream test は、read、scoped file/temp-path cleanup、failure shape をカバーしている。[`FileSystem.test.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/test/FileSystem.test.ts)

**解釈。** これは、private な `0700` directory、`0600` artifact、temp-write + sync + rename による publish、型付き filesystem failure を構築するのに十分である。scope-based automatic temp cleanup は disposable staging には有用だが、operation artifact 全体に適用すると evidence retention と競合する。

**推奨事項。** Phase 1 では EventStore/artifact interface の背後でこの service を使用し、Pions 所有の atomic/durability helper、および mode、sync、rename、crash window の test を用意する。`writeFile` だけで durable persistence が実現すると思い込んではならない。evidence directory は automatic temporary-resource cleanup の対象外に保つ。

### 3.3 Socket

**ソース上の事実。** Platform Socket は、scoped byte channel と SocketServer abstraction を提供する。NodeSocketServer は `node:net` をラップし、Node listen option を受け取り、string address を `UnixAddress` として報告し、finalizer で server を閉じ、scoped FiberSet で connection handler を supervise する。[`Socket.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/Socket.ts) · [`SocketServer.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/SocketServer.ts) · [`NodeSocketServer.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/src/NodeSocketServer.ts)

**解釈。** Unix-domain transport と scoped connection cleanup は ChildChannel に適合する。この package が提供するのは byte/lifecycle であり、Pions の framing、maximum size、capability authentication、monotonic sequence、at-most-once result conflict detection、persist-before-ACK ではない。

**推奨事項。** 深い Pions ChildChannel protocol module の下層でのみ使用する。より大きな payload を受け入れる前に、サイズ制限された initial frame を認証し、すべての frame を Schema で decode し、sequence と total size を強制し、EventStore による受理を ACK decision の source とする。

### 3.4 Platform 機能のテスト

**ソース上の事実。** Platform service は Context service/layer であり、FileSystem は制御された実装向けに `makeNoop`/`layerNoop` を export する。upstream の platform test は Node layer を明示的に compose する。[`FileSystem.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/src/FileSystem.ts) · [platform-node tests](https://github.com/Effect-TS/effect/tree/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/test)

**解釈。** 代替可能性は有用だが、upstream 自身の command/filesystem test は実際の process/file を使用している。Pions の Phase 0／自動化された Phase 1 の要件はより厳格であり、Effect の test helper を使用するだけでは満たせない。

**推奨事項。** Pions の seam に専用 fake を実装する。FakeAgentBackend、InMemoryEventStore、FakeChildChannel、FakePresentation、および後の fake CommandExecutor/FileSystem/Herdr executable contract である。Phase 0 test では live Node layer を提供してはならない。

## 4. Pions へのマッピング

| Pions の概念／seam | Effect の最適な用途 | Pions 所有のまま維持すべき境界 |
|---|---|---|
| `Runtime` | Layer から一度だけ組み立てる内部 Effect program。Scope が runtime resource を所有し、edge に Promise adapter を置く | 公開 `spawn/result/cancel` API、operation semantics、idempotency、error vocabulary |
| Pure reducer | Schema で decode された tagged input。Effect data helper を使用する可能性はあるが、effect execution は行わない | legal transition、terminal immutability、invariant derivation、決定論的な pure return value |
| `AgentBackend` | Context サービス、スコープ付き起動、観測／期限用の fiber、後の段階で Stream | バックエンドイベントの変換、要求／実効／観測設定、プロセス／セッションの同一性と停止証明 |
| `EventStore` | Context サービス、型付き失敗、Phase 0 では Ref の fake、後の段階でプラットフォーム FS | append/apply トランザクション、リプレイの権威性、単調増加シーケンス、永続的な結果／イベント順序 |
| `ChildChannel` | Context サービス、後の段階で Queue/Stream と Node Unix ソケット、Schema フレーミング | 認証、ケイパビリティの秘匿性、シーケンス、サイズ上限、結果の単一ライター／ACK プロトコル |
| `Presentation` | 別の監督対象 fiber 内のベストエフォート型サービス、コミット後の PubSub、注釈付きログ | セマンティックイベントをディスパッチしたり、reducer の状態を上書きしたりできないこと、pane の厳密な所有権／保持 |
| settle 前の永続化 | 逐次的な Effect 合成と狭い割り込みマスキングにより順序を明示 | 実際の EventStore トランザクション／耐久性、`self_settled` の append 前に結果の bytes/digest を受理 |
| キャンセル証明 | fiber が待機／タイムアウトを調整、Scope がクリーンアップを実行、Exit/Cause がローカルな結果を保持 | epoch/freeze、子孫スナップショット、後順ディスパッチ、バックエンドの ACK／終了証拠、`unknown` 判定 |
| 最初の tracer bullet | Layer により提供される fake、Schema ingress、Effect の中核的な順序付け、捕捉された Exit | 正確なイベントシーケンスと単一の公開結果を維持、Stream/STM/プラットフォーム機構は不要 |

### 4.1 settle 前の永続化

**出典の事実。** Effect の順序付け、割り込み不能マスク、finalization により、ランタイムはクリティカルセクションの境界を明示できる。[`Effect.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/src/Effect.ts)

**解釈。** tracer bullet では、次の順序を明示できる。

```text
結果を検証
→ EventStore.persistResult(bytes, count, digest)
→ result_persisted を append/apply
→ self_settled を append/apply
→ operation_completed を append/apply
→ ACK / Handle.result を完了
→ ベストエフォートの presentation
```

Effect は、Promise チェーンでの偶発的な処理漏れを防ぎ、割り込み動作をテスト可能にする。別々の書き込みをアトミックにすることはできず、低速な I/O を広範囲にわたって割り込み不能にすると、キャンセルへの応答性が失われる。

**推奨。** 永続化とイベント順序の不変条件を強制する、深い単一の受理操作を EventStore に持たせる。受理済み結果の公開周辺だけに狭い割り込みマスクを使用し、キャンセル／復旧によって曖昧な書き込みを分類し、安全にリプレイできる箇所では割り込み可能な I/O を許可する。コミット済みの受理結果からのみ ACK を返す。projection はその後に行い、完了へフィードバックしてはならない。

### 4.2 キャンセル証明

**解釈。** Effect は、並列観測の上限設定、決定的な期限、finalizer、割り込みに対して安全な bookkeeping といった機構を改善するが、Pions プロトコルは意図的にローカルな structured concurrency より厳格である。

**推奨。** 証明に関連するすべての手順を永続化する。キャンセル orchestrator は単なる Effect Exit ではなく、Pions の証拠サマリーを返すべきである。具体的には次のとおり。

1. epoch と spawn freeze をアトミックに永続化する。
2. 決定的な稼働中子孫スナップショットを読み取る。
3. バックエンドのキャンセルを後順でディスパッチする。
4. Clock/TestClock を使い、認証済み ACK またはバックエンド固有のプロセス終了証明を待つ。
5. 必要な証明がすべて揃った場合にのみ `operation_cancelled` を append する。
6. それ以外の場合は `operation_unknown(reason=cancel_unproven)` を append する。
7. すでに終端状態にある operation を書き換えることなく、残ったローカル fiber と scope を interrupt/close する。

## 5. 得られる堅牢性と、浅薄化／過剰複雑化との比較

### Effect が加える堅牢性

- 例外だけに依存した Promise の配管ではなく、型付きの運用上の失敗。
- 予期される失敗、defect、ローカル割り込みの明示的な区別。
- listener、socket、handle、観測 fiber の構造化された所有権。
- Scope による起動失敗／割り込み時のクリーンアップ。
- 決定的な TestClock テストを備えた、合成可能な timeout/race ロジック。
- Context/Layer により置換可能な内部サービス。
- 同一の安定したコアパッケージによる境界検証。
- 継続的なイベント到着時の上限付き queue／backpressure とスコープ付き stream。
- telemetry を権威あるものにすることのない、構造化された log/span の相関付け。

### Effect によって Pions が浅薄または不明瞭になる箇所

- 公開 Runtime から `Effect<…, …, RuntimeDependencies>` を返すと、依存関係の組み立てと実行ポリシーを各 caller に委ねることになる。
- caller に Cause を調べさせると、Pions の結果／キャンセルの語彙ではなくランタイム機構が露出する。
- reducer を Effects/Layers としてエンコードすると、小さく決定的な遷移表がランタイム機構の背後に隠れ、property testing が弱まる。
- fiber の親子関係を operation lineage として使用すると、永続的なドメイン上の真実がプロセスローカルな liveness に置き換わる。
- Scope の close を operation のキャンセルとして使用すると、クリーンアップ要求とキャンセル証明が混同される。
- PubSub/Stream を EventStore として使用すると、永続的で順序付けられた証拠が一時的な transport に置き換わる。
- 並行 claim が存在する前に STM を使用すると、状態機械が重複し、それでも永続ストレージとはトランザクションを構成できない。
- Phase 0 で platform-node、OpenTelemetry、Effect 固有のテスト adapter を追加すると、最初の成功パスには役立たないまま、依存関係と学習コストが増大する。

**推奨。** 深いモジュール境界は、**Runtime の内側に Effect、Runtime の外側にプレーンな Pions、Runtime の下層に純粋な reducer** とする。

## 6. `nicobailon/pi-subagents` から借用する価値のあるパターン

`nicobailon/pi-subagents` に関する固定済みの Pions レビューは、commit [`7fe9dee1bc186592e3f2b95c07d86c02f2edd57a`](https://github.com/nicobailon/pi-subagents/tree/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a) においても引き続き適用できる。Effect が変えるのは実装機構であり、upstream のセマンティクスに関する Pions の判断ではない。

### 借用するもの

1. **終端状態の scraping ではなく、セマンティックイベントの直接 subscription。** AgentBackend を型付き observation を生成する Effect サービスとしてモデル化し、必要な場合にのみ Stream を使用する。
2. **`agent_end.willRetry` と `agent_settled` の区別。** retry 中の end signal は非終端のままにし、より強い settled watermark を維持する。[upstream の lifecycle](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-lifecycle.ts)
3. **要求／実効／観測モデルの分離と不一致時の失敗。** 暗黙の fallback を受け入れるのではなく、バックエンドの詳細を Pions の field にマッピングする。[model fallback](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/model-fallback.ts)
4. **PID に加えたプロセスインスタンスの同一性。** Effect の platform Process PID だけでは不十分である。upstream のランダムな launch-instance という発想と、厳密な close の証拠を維持する。[process terminal](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/process-terminal.ts)
5. **リソース作成前のケイパビリティ上限と preflight rejection。** Context サービスには ambient authority ではなく、実効ポリシーだけを渡すべきである。[child tool plan](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/child-tool-plan.ts)
6. **セッション lease と fail-closed な unknown outcome。** Scope によって lease の解放は簡単になるが、所有権の証明は引き続き明示的な永続化データである。[session lease](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/shared/session-lease.ts)
7. **private file、argv array、argv 外の prompt、上限付き event projection、厳密なリソース同一性。** Platform Command/FileSystem でこれらのパターンを支援できる。
8. **delivery 手法としての atomic promotion と dedupe。** 一時的な replay file をコピーするのではなく、Pions の永続的な EventStore と組み合わせる。[result files](https://github.com/nicobailon/pi-subagents/blob/7fe9dee1bc186592e3f2b95c07d86c02f2edd57a/src/runs/background/result-files.ts)

### 借用せず、Effect による偶発的な再現も避けるもの

- 子孫が稼働中のままでの親の終端完了。
- subtree の前順／未 ACK の停止後に行う、早すぎる `stopped` の公開。
- セマンティックな完了として扱われる process/fiber/pane の liveness。
- Runtime と並んで公開される第 2 の workflow/state model。
- Phase 1 の visible-worker contract に対する headless worker の動作。
- 権威ある append-only ledger としてのベストエフォートな file/PubSub。

Effect の `forkDaemon` と、scope/fiber interruption の不注意な使用は、最初の 2 つの問題を別のライブラリの語彙で再現し得る。Pions の reducer とキャンセル証拠プロトコルを権威あるものとして維持する。

## 7. 最小限の Phase 0 設計

### 推奨する内部構造

```ts
// 公開される、プレーンな TS/Promise インターフェース。
interface Runtime {
  spawn(task: TaskSpec, options?: SpawnOptions): Promise<OperationHandle>
}

// 内部サービスは Effect を返してもよい。
interface EventStore {
  acceptResult(input: AcceptedResult): Effect.Effect<AcceptedSnapshot, StoreError>
  // append/apply および replay メソッドは省略
}

interface AgentBackend {
  start(operation: Operation): Effect.Effect<BackendHandle, BackendStartError, Scope.Scope>
}

// 純粋かつ同期的。
function reduce(snapshot: Operation, event: OperationEvent): TransitionResult
```

Schema を使用して `TaskSpec`、イベントエンベロープ、結果メッセージ、永続化されたスナップショットを定義・デコードする。5 つの主要な境界に加えて Clock と ID/token ファクトリに Context Tags を使用し、そのうえで単一の Runtime layer を構築する。テスト用 fake は通常の小さなサービス実装として維持する。

### 最初の tracer bullet

1 つのテストで、公開アダプターを通じて次の内部プログラムを実行する必要がある：

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

fake backend は起動回数をカウントする必要がある。EventStore は受理したイベントシーケンスと保存済み結果を公開する必要がある。FakeChildChannel は、同一内容の重複結果と競合する結果のケースをサポートする必要がある。Presentation は失敗と、悪意ある/fake の completed projection をサポートする必要がある。すべての ID、token、timestamp は供給され、ランダム機能やグローバルクロックへのアクセスは存在しない。

### Phase 0 でこれ以上を行わない理由

- 型付けされた fake result が 1 つだけなら Stream は不要である；
- 同期的な fake event path には Queue/PubSub は不要である；
- 並行 spawn/cancel より前に STM は不要である；
- platform-node の機能は Phase 0 のスコープ外である；
- ドメイン上の証拠をテストするために OpenTelemetry exporter は不要である；
- 独立した schema package は不要である；
- Effect 型を Runtime の外に出す必要はない。

## 8. 代替案

### A. Phase 0 では Effect を使わず、全面的にプレーンな TypeScript/Promises を使用する

**利点：** 依存関係の範囲が最小で、reducer/tracer bullet が最も直接的になり、Effect の学習コストがない。
**コスト：** Phase 1 では、中断、リソーススコープ、timeout、サービス差し替え、error/cause の規律を手作業で構築するか、後からオーケストレーションを移行する必要がある。
**結論：** v4 が安定する前にチームが Effect v3 の採用を確約したくない場合は実行可能だが、Phase 1 がすぐに続くなら劣る。

### B. Effect core のみ（**推奨**）

**利点：** 1 つの本番依存関係だけですでに Schema/TestClock/concurrency/resources を含む；platform の肥大化を招かず、最終的なオーケストレーションモデルを確立できる；reducer をプレーンなまま保てる。
**コスト：** バージョン世代に関する規律と Effect の内部的な専門知識が必要である；v4 への移行はいずれ独立した判断になる。
**結論：** Phase 0 に最適なバランスである。

### C. Phase 0 で Effect のフルスタック（`effect`, platform-node, vitest, telemetry）を使用する

**利点：** 初日から runtime/platform/testing に関するすべての懸念事項に 1 つのイディオムを使用できる。
**コスト：** Phase 0 の実際のニーズに反し、peer/transitive dependencies を増加させ、決定論的テストで実際の platform を使う誘惑を生み、Stream/Layer/STM を中心に時期尚早な設計を行うリスクがある。
**結論：** 却下。

### D. Effect core と `@effect/vitest`

**利点：** 公式の `it.effect`/`it.scoped` ヘルパーが Effect のテストサービスを自動的に提供し、TestClock を簡潔にする；upstream 自体もこのパターンを使用している。
**コスト：** Vitest 3 互換性に固定され、Effect 固有のテストサーフェスが追加される。
**結論：** テストランナー選定後の任意の dev 向け選択肢としては許容可能だが、Phase 0 の本番要件ではない。

## 9. リスクと緩和策

| リスク | 結果 | 緩和策 |
|---|---|---|
| v3 stable と v4 preview の docs/APIs の混在 | コンパイル失敗または微妙に異なるセマンティクス | 厳密なバージョン固定；commit-pinned v3 source を典拠とする；lockfile 内の beta/rc/snapshot packages を禁止する。 |
| 呼び出し元に公開される Effect 型 | Runtime が薄い依存関係組み立て facade になる | Promise-only の公開アダプター；Exit/Cause を変換し、すべての Layers を内部で提供する。 |
| Effectful reducer | 遷移ルールの列挙/replay/property-test が難しくなる | 明示的な入力を持つ純粋で同期的な reducer；その前段で decode する。 |
| ローカルな中断を外部の stop と誤認 | 誤った `cancelled` terminal state | ローカルの Cause と backend acknowledgement/process proof を分離する；reducer は proof event を要求する。 |
| Scope cleanup が証拠を削除 | failed/unknown pane/artifacts が失われる | Scope の対象を破棄可能な handles のみにする；retention policy を明示的にエンコードする。 |
| Queue/PubSub の損失またはメモリ内のみの state | 権威ある events/results の欠落 | EventStore への commit を先に行う；bounded nonlossy ingestion；PubSub は projection のみに使用する。 |
| 広範な uninterruptible regions | cancellation が停滞する | メモリ内/公開の critical sections 周辺だけを狭く mask する；durable writes を復旧可能にする。 |
| STM を durable transaction と見なす | 再起動により freeze/idempotency/count claims が失われる | 最終的な store transaction が durable claims を所有する；STM は process-local coordination のみに使用する。 |
| Platform Command に process-tree proof がない | 孤立した worker または誤った cancellation | isolated spike；必要な場合は直接的な Node/OS supervisor adapter；process-instance token と正確な close proof。 |
| Platform-node の peer/dependency の広さ | install と maintenance のコスト | Phase 1 まで延期する；一貫した厳密な stable matrix を固定し、受け入れ前に生成された lockfile を検査する。 |
| Redacted を secret isolation と見なす | 抽出された token が logs/events 経由で漏洩 | field allowlists、protocol checks、private descriptors/files、argv/log/metadata をスキャンする tests。 |
| Telemetry を真実と見なす | observer の失敗がセマンティクスを変える | telemetry/presentation は persistence の後に実行し、best effort とし、決して reducer input にしない。 |
| Effect v4 がいずれ安定版になる | 移行圧力 | Effect を内部に隔離する；v3 pin を ADR に記録する；v4 は意図的な移行としてのみ評価する。 |

## 10. テスト戦略

### 純粋な reducer のテスト（Effect test runtime は不要）
- 正当および不正なすべての遷移をテーブルテストする。
- 終端状態の不変性と、outcome/descendant/handoff の各述語を表明する。
- 重複、古いシーケンス、誤ったアクター、誤ったケイパビリティの拒否をテストする。
- ランダム化されたイベントシーケンスを不変条件に照らしてプロパティテストする。
- 固定の ID/タイムスタンプと、単純な不変値を使用する。
- 永続化された代表的なフィクスチャを Schema で個別にデコードする。

### ランタイムオーケストレーションのテスト（Effect core）

- 偽の Layers を用いて内部プログラムを実行し、`Exit` を取得する。
- デッドライン、スリープ、リトライ、cancel-ack タイムアウトには TestClock を使用する。
- persist-before-settle の各境界での中断をテストする。
- 冪等な spawn においてバックエンドが一度だけ起動することを表明する。
- 内容が同一の重複結果は ACK と同等であり、競合する結果はフェイルクローズすることを表明する。
- presentation の失敗や偽の完了が EventStore を変更できないことを表明する。
- スコープ付きの偽リソースが、意味論上の状態を変更することなく起動失敗時にファイナライズされることを表明する。
- defect とローカルな中断が、上限のある Pions 診断へ変換されることを表明する。

### 2 本目のトレーサーバレット：子孫とキャンセル

- root → child → grandchild のキャンセルディスパッチは後行順とする。
- epoch/freeze と並行する spawn claim は、選択したストア境界でアトミックとする。
- 古い/同じ/新しい epoch における挙動は決定的かつ冪等とする。
- 実際のスリープは決して使わず、Deferred/latch と TestClock を使用する。
- `cancelled` にするには全ノードを確認応答済みにする。証明を 1 つ省略して時刻を進め、`unknown(cancel_unproven)` にする。
- すでに終端状態にある子孫が書き換えられないことを表明する。
- ローカル fiber の終了/中断だけでは証明を満たせないことを表明する。

### Phase 1 のプラットフォーム契約テスト（後で実施、引き続き live Herdr は使用しない）

- 偽の CommandExecutor は、正確な argv、shell=false、cwd、stdin、および `extendEnv:false` 環境を取得する。
- 偽の FileSystem は、`0700`/`0600`、一時書き込み、ファイル同期、rename、証拠保持の挙動を記録する。
- 偽のソケットトランスポートで、部分フレーム、無効な token/version/operation/sequence、サイズ超過の初期データ/結果データ、重複/競合する結果、切断をテストする。
- プロセススーパーバイザーのフィクスチャは、kill 要求、シグナル確認応答、正確な終了観測、PID 再利用/プロセスインスタンス不一致、証明不明を区別する。
- 自動テストでは live pane を列挙したり対象にしたりしない。偽の Herdr 応答が不透明な ID を提供する。

**出典に基づく事実。** Effect の公式テストは、Effect 対応の Vitest テスト、TestClock による制御、fiber の中断/ファイナライズ、上限付きキューの挙動、明示的なプラットフォームレイヤー構成を、固定されたコミットで実証している。[`TestClock.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/TestClock.test.ts) · [`Fiber.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Fiber.test.ts) · [`Queue.test.ts`](https://github.com/Effect-TS/effect/blob/417e0faa80e471d77fc4a67452e68b09ae0ee861/packages/effect/test/Queue.test.ts) · [`CommandExecutor.test.ts`](https://github.com/Effect-TS/effect/blob/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node-shared/test/CommandExecutor.test.ts)

**解釈。** これらが確立するのは upstream の挙動と有用なテストパターンであり、Pions のドメイン不変条件や OS キャンセル証明が Effect によって提供されるということではない。

## 最終推奨事項

1. 選択する世代として Effect **v3 stable** を記録し、`effect@3.22.1` に厳密に固定する（正規ソースコミット `417e0faa80e471d77fc4a67452e68b09ae0ee861`）。
2. 独立した Schema パッケージは追加しない。この実装ラインでは、Effect 4 の beta/RC/snapshot API をすべて明示的に拒否する。
3. reducer は純粋かつ網羅的に保ち、Schema は境界でのみ使用する。
4. Runtime/Handle の呼び出し元向け API は Promise ベースかつ Pions 固有の名前のままにし、Context/Layer/Exit/Cause は内部に封じ込める。
5. 最初のトレーサーバレットでは、サービス置換、シーケンシング、型付き失敗、Scope、決定的な時間処理に Effect core を使用する。ただし、Stream/Queue/STM は、それぞれが解決する並行処理上の問題が現れた時点でのみ導入する。
6. `@effect/platform-node@0.108.1` と整合する peer セットの採用は、Phase 1 の依存関係決定まで延期する。そのファイルシステムと Unix ソケットは Pions の境界の背後で使用する。コマンドランナーは、プロセスグループの所有権とキャンセル証明について静的レビュー/spike レビューを行った後にのみ採用する。
7. Pions の永続的な EventStore、persist-before-settle の受け入れ操作、reducer、キャンセル証拠プロトコルを権威あるものとして維持する。Effect はそれらの実装を改善するものであり、その意味論を置き換えるものではない。
