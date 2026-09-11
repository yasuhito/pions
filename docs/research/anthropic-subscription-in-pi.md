# PiからAnthropic有料サブスクリプションを利用する方法の調査

- 参照日: 2026-02-21
- 対象: Pi Coding Agentと、別のPiプロセスを起動するPionsのレビューワーカー

## 結論

**既存手段はあるが、方式によって意味とリスクが大きく異なる。**

1. **Anthropic APIキーを使うだけなら拡張は不要**である。Pi組み込みの`anthropic`プロバイダーと`ANTHROPIC_API_KEY`または`~/.pi/agent/auth.json`を使い、Pionsでは`.pions.json`に`anthropic/claude-opus-5`のような正確な組を指定できる。ただし、これはClaude Pro/Maxの定額枠ではなく、Claude Console/APIの従量課金である。Pi公式文書も、APIキー方式とClaude Pro/Max OAuth方式を別項目としている。[^pi-providers]
2. **Pi組み込みのClaude Pro/Max OAuthログインもある**が、Pi公式文書は、Piのような第三者ハーネスからの利用はClaudeプラン枠ではなく`extra usage`のトークン課金になると明記する。したがって、`/login anthropic`だけでは「Pro/Maxの定額枠でPionsのOpusを動かす」という目的を満たさない。[^pi-providers]
3. **目的に最も近く、規約面で相対的に妥当なのは`pi-claude-bridge`**である。これはAnthropic公式のClaude Agent SDKから**未改変のClaude Code実行ファイル**を起動し、`claude-bridge/claude-opus-5`等をPiプロバイダーとして登録する。Anthropic公式文書は、Agent SDKがClaude Codeをサブプロセスとして起動する構造を説明し、エンドユーザーが未改変のClaude Codeへ自分のサブスクリプションでログインする利用を明示的に認めている。[^bridge-readme][^bridge-source][^agent-sdk-hosting][^anthropic-legal]
4. **Claude Codeに見せかけるヘッダーやシステムプロンプトを書き換え、Piからサブスクリプション枠へ直接流すOAuth互換拡張は存在するが、Pionsには採用しない方がよい。** 代表例は`@gotgenes/pi-anthropic-auth`、`pi-anthropic-oauth`、`sylv-io/pi-anthropic-auth`である。Anthropic公式文書は、OAuthをネイティブAnthropicアプリの通常利用向けとし、第三者アプリでClaude.aiログインを提供したり、Free/Pro/Max資格情報を介して要求を流したりすることを許可していない。Consumer Termsも、明示的な許可またはAPIキーなしの自動・非人間アクセスを禁じる。アカウント停止、突然の非互換化、意図しない追加課金のリスクがある。[^anthropic-legal][^consumer-terms][^gotgenes-source][^leohenon-readme][^sylv-readme]

## 認証・課金方式の整理

| 方式                    | 実際の認証主体                                   | 課金先                                                                 | Piでのモデル例                  | 判断・根拠                                                         |
| ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| Anthropic APIキー       | Pi → Anthropic Messages API                      | Claude Console/API従量課金                                             | `anthropic/claude-opus-5`       | 公式・安定。Pro/Max枠ではない。[^pi-providers][^commercial-terms]  |
| Pi組み込みClaude OAuth  | Pi → Anthropic（第三者ハーネス扱い）             | `extra usage`                                                          | `anthropic/claude-opus-5`       | 認証は公式実装だが定額枠目的には不適。[^pi-providers]              |
| `pi-claude-bridge`      | Pi拡張 → Agent SDK → 未改変Claude Code           | ログインしたClaudeプランの利用枠。プラン・機能により追加利用もあり得る | `claude-bridge/claude-opus-5`   | 条件付き第一候補。[^bridge-readme][^anthropic-legal]               |
| OAuth互換・要求整形拡張 | PiがOAuthトークンを使い、Claude Code用要求へ整形 | 拡張がClaudeプラン枠として分類されることを期待                         | 多くは`anthropic/claude-opus-5` | 規約・停止リスクが高く非推奨。[^gotgenes-source][^anthropic-legal] |

PiはOAuthトークンを`~/.pi/agent/auth.json`へ保存し自動更新し、APIキーでは同ファイルの資格情報を環境変数より優先する。APIキーへ確実に切り替えるには、保存済みOAuth資格情報を`/logout anthropic`で除去する必要がある。認証ファイルは`0600`で作成されるが、同じユーザー権限で動く拡張は秘密情報へ到達できる。[^pi-providers][^pi-packages]

## 候補評価

### 1. Pi組み込み`anthropic`プロバイダー

**対応モデル・導入法。** Piの組み込みカタログにあるモデルを`/model`または`--provider anthropic --model <id>`で選ぶ。調査環境のPi 0.85.1では`claude-opus-5`、`claude-opus-4-8`、`claude-opus-4-7`、`claude-opus-4-6`、`claude-opus-4-5`が列挙された。カタログは更新され得るため、実環境では`pi --list-models anthropic`で正確な識別子を確認する。Pi公式は組み込みカタログとモデル更新キャッシュの仕組みを説明している。[^pi-providers][^pi-models]

**APIキー方式。** `export ANTHROPIC_API_KEY=sk-ant-...`、または`/login anthropic`でAPIキーを保存する。追加拡張が不要なので、Pionsの`--no-extensions`方針と衝突しない。費用、レート制限、データ条件はClaude API側であり、Pro/Max購読とは別である。AnthropicのCommercial TermsはAPIキー利用を対象とし、利用料金の支払いを定める。[^pi-providers][^commercial-terms]

**Claude Pro/Max OAuth方式。** `/login anthropic`で購読ログインできるが、Pi公式は第三者ハーネス利用を`extra usage`課金と明記する。これは「ログイン可能」と「定額枠を消費する」を区別すべき例である。保守はPi本体に含まれ最も良好だが、定額枠利用という要件には不適合である。[^pi-providers]

### 2. `pi-claude-bridge` — 条件付き第一候補

**仕組み。** `pi install npm:pi-claude-bridge`で導入するPiパッケージで、`@anthropic-ai/claude-agent-sdk`を依存関係に持ち、`claude-bridge`プロバイダーを登録する。ソースではダミーの`apiKey: "not-used"`と独自`streamSimple`を登録し、Agent SDKの`query()`へ委譲する。SDKはAnthropic公式で、公式文書どおりClaude Codeサブプロセスとローカルの`~/.claude`セッション状態を使う。[^bridge-package][^bridge-source][^agent-sdk-readme][^agent-sdk-hosting]

**対応モデル。** READMEと`src/models.ts`は`claude-bridge/claude-opus-5`、Opus 4.8/4.7/4.6、Sonnet 5/4.6、Haiku 4.5等を登録する。プランや`longContextExtraUsage`設定によって長文脈の可否が異なるため、`provider.plan`を実契約に合わせる必要がある。モデル対応はPi組み込みカタログとClaude Code側の双方に依存する。[^bridge-readme][^bridge-models]

**保守状況。** npmの現行版は0.7.0で、ソース、単体テスト、実APIを使う統合試験手順、既知のセッション再構築問題が公開されている。一方、Anthropic公式パッケージではなく単独保守者のコミュニティ拡張であり、Pi/SDK更新による破損リスクは残る。[^bridge-package][^bridge-readme][^bridge-repo]

**規約評価。** OAuthトークンをPiのHTTP要求へ転用せず、公式SDKが未改変Claude Codeを起動して利用者自身にログインさせる限り、Anthropic公式の「未改変バイナリー」「各エンドユーザー自身の資格情報」という許容例に最も近い。ただし、Anthropicは第三者製品を提供する開発者にはCommercial TermsとAPIキーを原則として求めるため、Pionsを第三者向けサービスとして提供する場合は別評価とAnthropicへの確認が必要である。個人がローカルで自分の契約を使う場合に限定するのが安全である。[^anthropic-legal]

**セキュリティ。** Piパッケージは任意コードをユーザー権限で実行する。さらにこの拡張はClaude Codeプロセス、`~/.claude`のセッション、作業ディレクトリー、PiツールとのMCPブリッジを扱う。PionsのレビューワーカーではAskClaude機能を有効化せず、Pi側の限定ツールだけをClaude Codeへ橋渡しし、`strictMcpConfig`を維持し、デバッグログを常用しない構成が望ましい。[^pi-packages][^bridge-readme][^bridge-source]

### 3. `@gotgenes/pi-anthropic-auth` — 技術的には近いが非推奨

**仕組み・導入法。** `pi install npm:@gotgenes/pi-anthropic-auth`。Pi組み込み`anthropic`プロバイダーを薄い転送ラッパーで再登録し、`sk-ant-oat`のときだけClaude Codeの課金ヘッダーを生成し、Pi固有のシステムプロンプトを除去・中立化する。APIキー要求は変更しない。対応モデルはPi組み込みカタログをそのまま使う。[^gotgenes-readme][^gotgenes-source][^gotgenes-architecture]

**保守状況。** npm現行版は2.0.8、Pi 0.80.8以上をpeer dependencyとし、CI・試験・詳細な呼び出し経路文書があるため、比較対象中では技術文書と追随状況が良い。しかし、背景エージェントがPiの`modelRuntime`を通らない経路は整形されず、**別Piプロセスはそのプロセス自身で拡張を読む必要がある**と明記される。[^gotgenes-package][^gotgenes-architecture][^gotgenes-repo]

**リスク。** Claude Code用課金ヘッダー生成とPi識別情報の除去は、第三者ハーネスをClaude Code要求として分類させる挙動である。Pi自身は同じOAuthを`extra usage`扱いと説明し、Anthropicは第三者アプリによるプラン資格情報のルーティングを禁止している。技術的に動いても規約適合の根拠にはならないため、Pionsには採用しない。[^pi-providers][^anthropic-legal][^gotgenes-source]

### 4. その他の直接OAuth互換拡張

- **`pi-anthropic-oauth`**: `pi install npm:pi-anthropic-oauth`。独自OAuth、Claude Code互換ヘッダー、システムプロンプト中の`Pi`→`Claude Code`書換えを行い、Pi組み込みモデルを利用する。READMEはOpus 5を`claude-opus-5`として挙げる。書換えは既定で`aggressive`であり、要求意味の変化と追随負担が大きい。[^leohenon-readme][^leohenon-repo]
- **`sylv-io/pi-anthropic-auth`**: `pi install git:github.com/sylv-io/pi-anthropic-auth`。組み込み`anthropic`を独自OAuthストリームで置換する。0.0.1で依存する認証コアも含め監査面が広く、README自身が非公式かつOAuth挙動変更の可能性を警告する。[^sylv-readme][^sylv-package][^sylv-repo]

いずれも資格情報を第三者サーバーへ中継しない点は好ましいが、ローカル送信だから規約リスクが消えるわけではない。Anthropic公式の禁止対象は資格情報の収集だけでなく、第三者アプリでのClaude.aiログイン提供とプラン資格情報による要求ルーティングも含む。[^anthropic-legal]

## Pionsで成立させる条件

### A. APIキーまたはPi組み込みOAuthを使う場合

Pionsは委譲元Piのモデルレジストリーでモデル存在と認証設定を検査し、`.pions.json`のモデル、または委譲元モデルを実効設定へ固定する。別Piを`--provider`、`--model`、`--thinking`付きで起動し、観測値が違えば失敗する。したがって、次を満たせばよい。[^pions-extension][^pions-worker]

```json
{
  "review": {
    "model": {
      "provider": "anthropic",
      "id": "claude-opus-5"
    },
    "thinkingLevel": "high"
  }
}
```

1. 委譲元とワーカーが同じ`HOME`/Pi設定ディレクトリー、または同じ`ANTHROPIC_API_KEY`を参照できること。
2. `pi --list-models anthropic`に指定IDがあり、委譲元のモデルレジストリーで認証済みと判定されること。
3. `.pions.json`には秘密情報を書かず、正確な`provider`/`id`だけを書くこと。
4. APIキーなら従量課金、組み込みOAuthなら`extra usage`であることを受け入れること。

Piの解決順はCLIキー、`auth.json`、環境変数、カスタム設定の順なので、保存済みOAuthがある状態で`ANTHROPIC_API_KEY`を設定しただけではAPIキーへ切り替わらない。[^pi-providers]

### B. `pi-claude-bridge`を使う場合

設定例は次のようになる。[^pions-extension][^bridge-readme]

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

Pionsは`pi-claude-bridge` 0.7.0を依存関係とロックファイルで固定し、委譲元のプロジェクト拡張とClaudeワーカーの双方へ同じ実エントリーを読み込む。ワーカーでは`--no-extensions`を維持し、Pions内部拡張と固定版プロバイダー拡張だけを個別の`--extension`で指定する。起動直前にパッケージ名、版、エントリーを再検査し、不一致ならオペレーションを開始しない。[^pions-worker][^pi-extensions]

運用上は次を満たす必要がある。

1. 未改変Claude Codeで`claude`を実行し、同一利用者の`~/.claude`へ事前にログインする。分離する場合は委譲元Piの起動前から`CLAUDE_CONFIG_DIR`を指定する。資格情報はPions設定や引数へ複製しない。[^pions-extension][^bridge-source][^anthropic-auth]
2. `provider.plan`は実契約に合わせる。Pionsは`longContextExtraUsage: true`を拒否し、未ログイン、モデル利用不可、プラン不適合を別の型付き理由として返し、別モデルへフォールバックしない。[^pions-extension][^bridge-models]
3. `AskClaude`、Claude Code自動メモリー、利用者MCPを無効に保つ。Pionsはこれらを弱める設定を起動前に拒否し、Claude Code内蔵ツールではなくPiから橋渡しした許可済みツールだけを使う。[^bridge-source][^pi-packages]
4. 実契約でのOpus 5、課金先、並列時のレート制限、キャンセル後のClaude Code子プロセスは[Issue #49手動スモークテスト](../manual-smoke-test-issue-49.md)に従って確認する。

### C. 直接OAuth互換拡張を使う場合

技術的条件はBの1と同様で、**各ワーカーPiへ対象拡張を明示ロード**しなければならない。`@gotgenes/pi-anthropic-auth`自身もfork子プロセスはプロセス単位でラッパーを読み込むと説明する。親だけへインストールしても別ランタイムへプロバイダー変更は伝播しない。[^gotgenes-architecture][^pions-worker]

ただし、これはAnthropicの認証利用方針と衝突するため、実装条件を満たしても採用判断は「不可」とする。秘密情報を`.pions.json`やプロセス引数へ複製せず、認証ファイル権限、拡張の供給元固定、更新差分監査も必要である。[^anthropic-legal][^pi-packages]

## 推奨

1. **安定性と規約確実性を優先するなら、Pi組み込み`anthropic`＋Anthropic APIキーを使う。** Pro/Maxとは別課金である。[^pi-providers][^commercial-terms]
2. **自分のPro/Max枠をローカルPionsで使う必要があるなら、`pi-claude-bridge`を小規模に検証する。** 未改変Claude Code、利用者本人のログイン、ローカル利用、明示的なワーカー拡張読込を採用条件とする。[^bridge-readme][^anthropic-legal][^pions-worker]
3. **要求整形型OAuth拡張は採用しない。** 動作実績よりAnthropic公式の認証方針を優先する。[^anthropic-legal][^gotgenes-source]
4. 導入前に、Opus 5が実契約で選択可能か、定額枠か追加利用か、並列ワーカー時の上限、キャンセル後のClaude Code子プロセス停止、ツール制限、資格情報・セッション保存先を手動スモークテストする。モデル提供とプラン条件は変更され得る。[^anthropic-auth][^anthropic-legal][^bridge-readme]

## 参照資料

すべて参照日 2026-02-21。

[^pi-providers]: [Pi公式: Providers](https://pi.dev/docs/latest/providers)（参照日: 2026-02-21）

[^pi-models]: [Pi公式: Custom Models](https://pi.dev/docs/latest/models)（参照日: 2026-02-21）

[^pi-packages]: [Pi公式: Pi Packages](https://pi.dev/docs/latest/packages)（参照日: 2026-02-21）

[^pi-extensions]: [Pi公式: Extensions](https://pi.dev/docs/latest/extensions)（参照日: 2026-02-21）

[^anthropic-auth]: [Anthropic公式: Claude Code Authentication](https://code.claude.com/docs/en/authentication)（参照日: 2026-02-21）

[^agent-sdk-readme]: [Anthropic公式: Claude Agent SDK TypeScript README](https://github.com/anthropics/claude-agent-sdk-typescript#readme)（参照日: 2026-02-21）

[^agent-sdk-hosting]: [Anthropic公式: Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting)（参照日: 2026-02-21）

[^anthropic-legal]: [Anthropic公式: Claude Code Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)（参照日: 2026-02-21）

[^consumer-terms]: [Anthropic公式: Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)（参照日: 2026-02-21）

[^commercial-terms]: [Anthropic公式: Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)（参照日: 2026-02-21）

[^bridge-readme]: [`pi-claude-bridge` README](https://github.com/elidickinson/pi-claude-bridge#readme)（参照日: 2026-02-21）

[^bridge-package]: [`pi-claude-bridge` package metadata](https://github.com/elidickinson/pi-claude-bridge/blob/main/package.json)（参照日: 2026-02-21）

[^bridge-source]: [`pi-claude-bridge` provider source](https://github.com/elidickinson/pi-claude-bridge/blob/main/src/index.ts)（参照日: 2026-02-21）

[^bridge-models]: [`pi-claude-bridge` model source](https://github.com/elidickinson/pi-claude-bridge/blob/main/src/models.ts)（参照日: 2026-02-21）

[^bridge-repo]: [`pi-claude-bridge` repository metadata](https://api.github.com/repos/elidickinson/pi-claude-bridge)（参照日: 2026-02-21）

[^gotgenes-readme]: [`@gotgenes/pi-anthropic-auth` README](https://github.com/gotgenes/pi-anthropic-auth#readme)（参照日: 2026-02-21）

[^gotgenes-package]: [`@gotgenes/pi-anthropic-auth` package metadata](https://github.com/gotgenes/pi-anthropic-auth/blob/main/package.json)（参照日: 2026-02-21）

[^gotgenes-source]: [`@gotgenes/pi-anthropic-auth` request shaping source](https://github.com/gotgenes/pi-anthropic-auth/blob/main/src/request-shaping.ts)（参照日: 2026-02-21）

[^gotgenes-architecture]: [`@gotgenes/pi-anthropic-auth` architecture](https://github.com/gotgenes/pi-anthropic-auth/blob/main/docs/architecture.md)（参照日: 2026-02-21）

[^gotgenes-repo]: [`@gotgenes/pi-anthropic-auth` repository metadata](https://api.github.com/repos/gotgenes/pi-anthropic-auth)（参照日: 2026-02-21）

[^leohenon-readme]: [`pi-anthropic-oauth` README](https://github.com/leohenon/pi-anthropic-oauth#readme)（参照日: 2026-02-21）

[^leohenon-repo]: [`pi-anthropic-oauth` repository metadata](https://api.github.com/repos/leohenon/pi-anthropic-oauth)（参照日: 2026-02-21）

[^sylv-readme]: [`sylv-io/pi-anthropic-auth` README](https://github.com/sylv-io/pi-anthropic-auth#readme)（参照日: 2026-02-21）

[^sylv-package]: [`sylv-io/pi-anthropic-auth` package metadata](https://github.com/sylv-io/pi-anthropic-auth/blob/main/package.json)（参照日: 2026-02-21）

[^sylv-repo]: [`sylv-io/pi-anthropic-auth` repository metadata](https://api.github.com/repos/sylv-io/pi-anthropic-auth)（参照日: 2026-02-21）

[^pions-extension]: [Pions: Pi拡張とモデル設定](https://github.com/yasuhito/pions/blob/main/docs/pi-extension.md)（参照日: 2026-02-21）

[^pions-worker]: [Pions: 可視ワーカー起動実装](https://github.com/yasuhito/pions/blob/main/src/internal/visible-worker.ts)（参照日: 2026-02-21）
