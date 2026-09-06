---
status: accepted
---

# Pions ランタイムに TypeScript を使用する

Pions は、Python のスーパーバイザーを導入するのではなく、ランタイム、状態モデル、Pi/Herdr アダプターを Node 上の TypeScript で実装する。これにより、言語間の依存関係が減り、実装が Pi ネイティブの拡張／セッションインターフェースと整合する。`nicobailon/pi-subagents` は主要な参照実装だが、Pions はその親優先の完了セマンティクスや確認応答を伴わないサブツリー停止セマンティクスを模倣せず、別途決定しない限り依存関係として採用しない。
