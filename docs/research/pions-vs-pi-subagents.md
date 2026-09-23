# PionsとPiのサブエージェント実装の比較

調査日: 2026-09-11

## 調査対象

「標準的なサブエージェント」は意味が曖昧なため、次の2つを分けて調べた。

1. `@earendil-works/pi-coding-agent@0.85.1`に同梱された公式の`examples/extensions/subagent`
2. npmで配布されている`pi-subagents@0.67.0`（`nicobailon/pi-subagents`）

前者は導入例であり、後者は多数の機能と文書を持つ独立した拡張である。READMEでは両者をまとめて「Pi標準」と呼ばないほうがよい。

## 結論

Pionsを「`pi-subagents`より高機能」と紹介するのは正確ではない。`pi-subagents`は、複数の組み込みエージェント、前景・背景実行、並列処理、チェーン、進捗表示、実行中の指示変更、ワークツリー、ワークフロー、受け入れ検査など、オーケストレーション機能ではPionsよりはるかに広い。[`pi-subagents` README](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/README.md)

Pionsが強調すべきなのは機能数ではなく、**委譲を永続的で検証可能なオペレーションとして扱うこと**である。特に次の位置付けが正確である。

> Pionsは、たくさんのエージェントを便利に動かすための拡張ではなく、ワーカーの開始、結果受理、停止を、再起動後にも検査できる事実として扱うランタイムである。

## READMEで強調できる違い

### 1. 結果を一時的な通知ではなく、完全性検証可能な正本として残す

Pionsでは、オペレーションが結果本文の固定バイト列を直接所有し、長さとSHA-256を照合した後にだけ再取得する。結果受理はイベントストア上の変更不能な事実であり、Piセッションやランタイムの再起動後も、オペレーション識別子から完全な本文またはUTF-8境界に沿った断片を取得できる。

根拠:

- [`src/internal/runtime.ts`](../../src/internal/runtime.ts)の`retrieveAcceptedResult`と`readResultChunk`
- [`src/internal/result-acceptance.ts`](../../src/internal/result-acceptance.ts)
- [ADR-0013](../adr/0013-use-pi-tools-as-the-result-retrieval-boundary.md)
- [ADR-0027](../adr/0027-store-results-as-operation-owned-utf8-text.md)
- [ADR-0028](../adr/0028-remove-generic-artifact-management.md)

`pi-subagents@0.67.0`も背景実行の結果ファイル、再生記録、出力アーカイブを持つ。ただし公式文書では、結果ファイルは通知後に消費・削除され、再生記録は期限付きのベストエフォートな一時状態であって永続台帳ではないと説明されている。出力ファイルがない場合のアーカイブ本文も子ごとに64 KiBへ制限される。[`docs/observability.md`の「Async run artifacts」](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/observability.md#async-run-artifacts)

したがって、安全な表現は「`pi-subagents`は結果を保存しない」ではなく、次のようになる。

> Pionsは、通知や観測用アーカイブとは別に、受理済み結果の同一バイト列を完全性検証して再取得することを公開契約にしています。

### 2. 停止を推測せず、証明できない状態を残す

Pionsは、プロセスやワークスペースが見えないことだけから停止済みと判断しない。開始トークンを含むワーカー識別情報に基づいて停止を確認し、確認できなければ`unknown`として残す。キャンセルも停止証拠が得られた場合だけキャンセル済みとする。

根拠:

- [`CONTEXT.md`](../../CONTEXT.md)の「Worker identity」「Terminal completion」
- [`src/internal/runtime.ts`](../../src/internal/runtime.ts)のキャンセル処理
- [ADR-0005](../adr/0005-use-pi-cli-for-visible-workers.md)

ここは比較時に注意が必要である。現在の`pi-subagents`も、背景ランナーについてプロセス終端証拠を`observed`または`unknown`として表し、結果ファイルやPID消失から終了を推論しない設計を持つ。[`docs/observability.md`の「Process-terminal proof」](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/observability.md#process-terminal-proof)

そのため「Pionsだけが停止を検証する」とは書けない。Pions固有の訴求点は、停止確認をオペレーションの終端条件と再試行安全性へ一貫して結び付けていることである。

### 3. 実行中のワーカーを、実際のPi TUIとして観測できる

PionsのワーカーはHerdrの専用ワークスペースで実際の`pi` CLIとして動く。表示は状態の正本ではないが、人間は通常のPi TUIをそのまま観測できる。

根拠:

- [`src/internal/herdr-presentation.ts`](../../src/internal/herdr-presentation.ts)
- [`src/internal/visible-worker.ts`](../../src/internal/visible-worker.ts)
- [ADR-0005](../adr/0005-use-pi-cli-for-visible-workers.md)
- [ADR-0026](../adr/0026-run-workers-in-dedicated-herdr-workspaces.md)

`pi-subagents`は前景ワーカーを親Piプロセス内のセッションとして実行し、背景ワーカーを分離ランナープロセス内のセッションとして実行する。FleetViewと専用インスペクターによる観測はPionsより高機能だが、実ワーカーのPi TUIそのものを別ペインで見せる方式ではない。[`docs/observability.md`の「Foreground runs」と「FleetView」](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/observability.md#foreground-runs)

安全な訴求は次のとおりである。

> Pionsはワーカーの表示を再現しません。各ワーカーはHerdrの専用ワークスペース内の本物のPi TUIとして見えます。ただし、意味上の完了は画面ではなく永続記録から判定します。

### 4. 公式の簡易例と比べるなら、タスク本文をプロセス引数へ置かない

Pi同梱のsubagent例は、システムプロンプトを権限`0600`の一時ファイルへ保存する一方、タスク本文は`Task: ${task}`として`pi`のプロセス引数へ追加する。[公式例の`index.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/index.ts)

Pionsはタスク本文を権限`0600`の私有ファイルへ保存し、プロセス引数には本文を置かない。

根拠:

- [`src/internal/pi-extension.ts`](../../src/internal/pi-extension.ts)の`writePrivatePrompt`
- [`src/internal/visible-worker.ts`](../../src/internal/visible-worker.ts)の起動引数構築
- [ADR-0005](../adr/0005-use-pi-cli-for-visible-workers.md)

ただし、この比較はあくまでPi同梱の簡易例に対するものである。現在の`pi-subagents`全体に対して「タスクを引数へ露出する」と主張してはいけない。

## Pionsが現時点で劣る点

READMEの信頼性を保つため、次の制約も明記すべきである。

- Herdrが必須であり、利用できない場合にヘッドレス実行へ切り替えない。
- 現在のPi拡張は一段の汎用ワーカーだけを提供し、ワーカープロファイルや入れ子委譲を持たない。
- `pi-subagents`のような組み込みエージェント群、チェーン、背景実行、実行中の指示変更、ワークフロー、FleetViewを持たない。
- npmから1コマンドで導入できる配布状態にはまだなっていない。

## READMEの推奨メッセージ

冒頭では、比較対象を名指しして勝敗を宣言するより、次の3点へ絞るとよい。

1. **Durable** — 委譲、結果受理、停止を再起動後も読めるオペレーションとして残す。
2. **Verifiable** — 結果を固定バイト列として保存し、長さとSHA-256を検証して再取得する。
3. **Visible, but not screen-scraped** — 本物のPi TUIをHerdrで見せるが、画面から完了を推測しない。

英語の短い候補:

> Pions is a durable, verifiable runtime for visible Pi workers. It treats delegation as an operation with persisted lifecycle evidence—not just a child session and a returned string.

日本語の説明候補:

> Pionsは、可視のPiワーカーを動かすための、永続的で検証可能なランタイムです。サブエージェントへの委譲を、一時的な子セッションと戻り文字列ではなく、ライフサイクル証跡と完全性検証可能な結果を持つオペレーションとして扱います。

## 避けるべき表現

- 「`pi-subagents`より安全」— 両者の脅威モデルが異なり、`pi-subagents`にも終端証拠、ケイパビリティ、受け入れゲートがある。
- 「唯一の永続的サブエージェント」— `pi-subagents`にも背景実行と保存済み実行資料がある。
- 「完全に隔離された」「サンドボックス」— ワーカーは親と同じ作業ディレクトリとプロセスユーザーの権限を使う。
- 「Pionsだけが停止を確認する」— `pi-subagents@0.67.0`にもプロセス終端証拠がある。
- 「`pi-subagents`は結果を保存しない」— 一時結果、再生記録、出力アーカイブを保存する。
- 「Pi公式のsubagentより優れている」— 公式側は製品ではなく拡張の例であり、公平な比較ではない。

## 一次ソース

- [Pi公式subagent例 README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/README.md)
- [Pi公式subagent例 実装](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/index.ts)
- [`pi-subagents@0.67.0` README](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/README.md)
- [`pi-subagents@0.67.0` Observability](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/observability.md)
- [`pi-subagents@0.67.0` result files](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/background/result-files.ts)
- [`pi-subagents@0.67.0` acceptance](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/shared/acceptance.ts)
- [`pi-subagents@0.67.0` retained nested routes](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/background/retained-nested-route-tracker.ts)
- Pionsの[`CONTEXT.md`](../../CONTEXT.md)と[`docs/adr/`](../adr/)
