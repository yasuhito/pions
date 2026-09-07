---
status: superseded by ADR-0005
---

# Pi の `AgentSession` をワーカーバックエンドに使用する

Pions のワーカーラッパーは、`@earendil-works/pi-coding-agent` 0.85.1 の SDK を使用し、独立した Node プロセス内で永続的な `AgentSession` を1つ作成する。CLI の JSON 出力を再解析する経路は持たない。

ワーカーは `AgentSession.sessionId` を Pi セッション識別子として報告し、`subscribe()` から得る `tool_execution_end` をツール利用の証跡とする。使用量と意味上の結果は、`AgentSession.messages` にあるアシスタントメッセージの `usage`、`stopReason`、`errorMessage`、テキスト内容から取得する。成功には `stopReason` が `stop` でエラーがなく、空でないテキスト内容が必要である。確定したアシスタントメッセージが失敗を示す場合は、その失敗を使用量およびツール利用状況とともに報告する。

`agent_end` は `willRetry` が真になり得るため確定には使用しない。`prompt()` が解決し、かつ同じ購読で `agent_settled` を観測した場合だけ、最後のアシスタントメッセージを評価し、成功した内容を結果としてワーカープロトコルへ渡す。ターミナル出力と Herdr の画面状態は表示専用であり、この判定には使用しない。

公開する実行経路は、既存の `Runtime.spawn()` と `OperationHandle.result()` による1回の起動から結果取得までに限定する。Pi SDK のセッション置換、キュー、並列実行、入れ子実行の API は公開しない。
