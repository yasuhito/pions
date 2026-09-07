# Pi CLI可視ワーカー実現可能性プロトタイプ結果

## 結論

**条件付きで可能**。

Herdrの兄弟ペインで公式`pi` CLIの`regular` TUIを表示し、所有者限定ファイルからタスクをユーザーメッセージとして投入し、明示した拡張から既存の認証済みワーカープロトコルへ確定結果を送り、結果受理確認後にPiを正常終了して所有ペインだけを閉じられた。

ただし、拡張が`session_start`直後に自動で初期プロンプトを実行すると、`herdr agent start`の起動完了判定と競合する。高速終了ケースでは、意味上は成功してペインも閉じたのに、`herdr agent start`は30秒後にタイムアウトした。**`herdr agent start`が成功して戻った後にだけ初期プロンプトを解放する、二段階の起動ゲートが必須**である。

## 実験環境と一次証跡

- Pions作業ディレクトリ: `/home/yasuhito/Work/pions`
- Pi: `@earendil-works/pi-coding-agent` 0.85.1
- 使い捨てプロトタイプ: `/tmp/pions-pi-cli-prototype.dNESEB/`
- 拡張: `/tmp/pions-pi-cli-prototype.dNESEB/worker-extension.ts`
- ホスト: `/tmp/pions-pi-cli-prototype.dNESEB/host.mjs`
- 成功プロトコル証跡: `success.jsonl`, `ui.jsonl`, `gated.jsonl`
- 非成功証跡: `failure.jsonl`, `cancel.jsonl`, `unknown.jsonl`
- 起動競合証跡: `race.jsonl`, `race-start.err`
- 公式TUIのANSI出力: `ui-ansi.log`

プロトタイプは製品コードへ追加していない。開始前後の`git status --short`は同一で、既存の未コミット変更を変更していない。実験用に作成した兄弟ペインはすべて閉じた。

代表的な起動コマンドは次のとおり。

```bash
herdr pane split --current --direction down --ratio 0.5 \
  --cwd /home/yasuhito/Work/pions \
  --env PIONS_PROTO_CONFIG=/tmp/pions-pi-cli-prototype.dNESEB/ui.json \
  --env PI_TUI_WRITE_LOG=/tmp/pions-pi-cli-prototype.dNESEB/ui-ansi.log \
  --no-focus

herdr agent start pionsprotoui --kind pi --pane wS9:p1C --timeout 30000 -- \
  --model openai-codex/gpt-5.4-mini \
  --thinking low \
  --tools read,grep,find,ls,bash \
  --no-session \
  --tui-mode regular \
  --no-extensions \
  --extension /tmp/pions-pi-cli-prototype.dNESEB/worker-extension.ts \
  --no-skills --no-prompt-templates --no-themes --approve
```

設定、プロンプト、証跡ファイルは`0600`、親ディレクトリは`0700`とした。Unixドメインソケットは作成直後に明示的に`chmod 600`した。

## 1. 起動設定を同時に適用できるか

**観測結果: 可能。**

`herdr agent start --kind pi`の`--`以降へPiのネイティブ引数を渡した。Herdrの応答に、指定したモデル、思考レベル、ツール、`--no-session`、`--tui-mode regular`、資源探索停止フラグ、明示的な拡張がそのまま`argv`として記録された。

拡張が実行時に報告し、既存の`HostProtocolPeer`が検証した観測設定は次のとおりだった。

```json
{
  "model": {"provider": "openai-codex", "id": "gpt-5.4-mini"},
  "thinkingLevel": "low",
  "tools": ["read", "grep", "find", "ls", "bash"],
  "cwd": "/home/yasuhito/Work/pions"
}
```

`sessionFile`は`undefined`だったため証跡JSONから省略され、`--no-session`による一時セッションも確認できた。TUIの資源表示は`AGENTS.md`と明示した`worker-extension.ts`だけだった。

成立条件:

- Pi引数は必ず`herdr agent start ... -- <Pi引数>`の後半へ渡す。
- 実効設定はコマンド文字列ではなく、拡張から報告された観測値と照合する。
- プロジェクトの`AGENTS.md`を読むには信頼済みプロジェクトで実行するか、今回のように`--approve`を明示する。

失敗時の代替案:

- Herdrが特定のPi引数を透過しない版では、`pane run`による直接起動が代替になるが、Herdrのエージェント起動完了待ちを失うため第一選択にはしない。

## 2. タスクを引数やHerdrメタデータへ載せず表示できるか

**観測結果: 可能。**

実行した操作:

```bash
chmod 700 /tmp/pions-pi-cli-prototype.dNESEB
chmod 600 /tmp/pions-pi-cli-prototype.dNESEB/prompt-ui.utf8
# ペイン環境には設定ファイルのパスだけを渡し、タスク本文は渡さない
```

拡張は`PIONS_PROTO_CONFIG`が指す設定から`promptPath`を取得し、その`0600`ファイルを読み、`pi.sendUserMessage(prompt)`で投入した。TUIには通常のユーザーメッセージとして日本語タスクが表示された。

`prompt_loaded`証跡の`process.argv`、Herdrの`agent start`応答の`argv`、`pane get`および`pane process-info`にタスク本文は存在しなかった。Herdrメタデータにもタスク本文は設定していない。

成立条件:

- タスク本文と権限情報を別の所有者限定ファイルに置く。
- ペインへ渡すのは設定ファイルのパスだけにする。
- `pi.sendUserMessage()`は`expandPromptTemplates`を有効にせず使う。

失敗時の代替案:

- `@prompt.md`はPiのプロセス引数にプロンプトパスを露出するため、この要件の代替にはしない。

## 3. 入力を操作不能にしつつ公式TUIを維持できるか

**観測結果: 可能。**

拡張は`CustomEditor`を継承した`LockedEditor`を設定し、`handleInput()`ですべての入力を破棄した。

実行した操作:

```bash
herdr pane send-text wS9:p1C 'SHOULD_NOT_BECOME_USER_MESSAGE'
herdr pane send-keys wS9:p1C enter
```

送信文字列はTUIのANSIログにも拡張のイベント証跡にも現れず、追加のユーザーメッセージやエージェント実行も発生しなかった。

同じTUIで次を実機観測した。

- 思考表示: `Planning bash command execution`
- ツール表示: `$ sleep 5; printf ...`、`tool-stream-proof`、`Took 5.0s`
- ストリーミング: 読み取り時点では最終回答が13行目まで表示され、`Working`が表示中だった
- 最終回答: `UI_PROOF_BEGIN`から`UI_PROOF_END`

`ui-ansi.log`にも`Planning bash command execution`、`tool-stream-proof`、`Working`、`UI_PROOF_BEGIN`が残った。

成立条件:

- 公式Interactive TUIをそのまま使い、拡張がエディター部品だけを置換する。
- キャンセルや終了はキーボードではなく、認証済み制御経路から行う。

失敗時の代替案:

- 全入力破棄が運用上強すぎる場合は、印字可能文字とEnterだけを破棄し、緊急終了キーだけを所有者方針に従って通す。ただし観測専用という境界は弱くなる。

## 4. 明示した内部拡張だけで確定結果を報告できるか

**観測結果: 可能。**

プロトタイプ拡張は製品のビルド済み`WorkerProtocolPeer`、ホストは`HostProtocolPeer`をそのまま使用した。`--no-extensions --extension <内部拡張>`により、探索された通常拡張を無効化し、明示拡張だけを読み込んだ。

観測したフレーム列:

1. `hello`
2. `started`
3. `result`
4. `done`
5. ホストから`ack`

`message_end`から確定アシスタントメッセージを保持し、`agent_settled`を観測した後だけ`result`と`done`を送った。成功例の受理本文は`PROTOTYPE_SUCCESS: pions`で、ダイジェスト、使用量、`read`ツール呼び出し証跡も`HostProtocolPeer`で受理された。Herdrの`idle`は完了判定に使っていない。

成立条件:

- `agent_end`ではなく`agent_settled`を確定境界にする。
- 最後のアシスタントメッセージの`stopReason`、エラー、空文字を検査する。
- 拡張内の例外はPiがログ化して続行する仕様なので、通信失敗を明示的に状態不明として扱う。

失敗時の代替案:

- 拡張イベントで必要な確定情報を取得できなくなったPi版では、CLIのJSON/RPCモードは公式TUIを失うため同一要件を満たさない。Pi版を固定するか、上流APIを追加する必要がある。

## 5. 結果受理確認まで生存し、確認後に正常終了できるか

**観測結果: 可能。**

`ui`実験ではホストが`results_received`後に15秒待ってからACKを送った。

- `before_ack`: `workerAlive: true`
- 15秒後の`ack_sent`: `workerAlive: true`
- 直後に拡張が`ack_received`を記録
- 続いて`session_shutdown { reason: "quit" }`
- ホストがプロセス停止を観測

拡張はACK前には`ctx.shutdown()`を呼ばず、ACK受信後にだけ呼んだ。通信切断実験ではACKがないためPiは終了せず、ペインも保持された。

成立条件:

- ACK待ち中もソケットと拡張状態を生存させる。
- ACK受信後に`ctx.shutdown()`でPiの正常終了を要求する。
- ACK待ちに製品側の期限と状態不明への遷移を定義する。

失敗時の代替案:

- `ctx.shutdown()`が利用できないPi版では、外部からSIGTERMする方法は正常終了の証拠を弱めるため、対応Pi版の固定が望ましい。

## 6. 成功時だけ閉じ、非成功時は保持できるか

**観測結果: 可能。**

ホストは次の順序でのみペインを閉じた。

1. 認証済み結果を受理
2. ACKを送信
3. 拡張が`ctx.shutdown()`を実行
4. Piプロセス停止を観測
5. `herdr pane close <所有ペインID>`

成功例では`worker_stop_observed { stopped: true }`後に`pane_close_requested`が成功し、`pane get`は`pane_not_found`になった。

非成功の実機結果:

- 失敗: `worker_failed`を送るようプロトタイプで注入し、ホストは`non_success_retained`を記録。Piプロセスとペインは生存。
- キャンセル: ホストが既存プロトコルの`cancel`を送り、Piの最終メッセージは`stopReason: "aborted"`、拡張は`cancelled`を返した。Piプロセスとペインは生存。
- 状態不明: ホストが`started`後にソケットを切断。拡張は`socket_ended { settled: false }`を記録し、後にモデル実行が終わってもACKを得られず、Piプロセスとペインは生存。

失敗ケースはプロバイダー障害そのものではなく、確定後に`worker_failed`フレームを注入して閉鎖方針を検証したもの。キャンセルと通信断は実際の制御経路で発生させた。観測後、保持された3ペインは実験所有者として手動で閉じた。

成立条件:

- ペインIDをオペレーション所有物として保持する。
- プロセス停止確認ではPIDだけでなく、既存実装どおりプロセス開始トークンも照合する。
- `worker_failed`、`worker_cancelled`、通信断、検証不能では自動閉鎖しない。

失敗時の代替案:

- Herdrに「プロセスの正常終了後だけ自動閉鎖」という原子的操作がないため、Pionsが停止確認と所有ペイン閉鎖を順に実行する。閉鎖失敗は表示上の後処理失敗として記録する。

## 7. Herdr起動待ちと自動実行・終了に競合がないか

**観測結果: 競合がある。未対策では不可、起動ゲート付きなら可能。**

### 実行中に起動完了した例

`ui`実験では次の時系列だった。

- 拡張の自動プロンプト投入: `1788750996935`
- `herdr agent start`の復帰: `1788751000042`
- `bash`ツール終了: `1788751004731`

つまりHerdrはPiが実行中なのに`agent_status: "idle"`と報告して起動成功した。実際のTUIには同時刻に`Working`とストリーミング途中の回答が表示されていた。したがって、起動応答の`idle`を意味上の状態として利用できない。

### 高速終了で再現した競合

ACK遅延なしで短いタスクを起動した。

```bash
herdr agent start pionsprotorace --kind pi --pane wS9:p1G --timeout 30000 -- <同じPi引数>
```

Pi側は約2秒で結果送信、ACK受信、正常終了、ペイン閉鎖まで成功した。しかし`herdr agent start`は起動成功を観測できず、30,068ミリ秒後に次で失敗した。

```json
{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}
```

### 起動ゲートで解消した例

拡張はTUI初期化後に非同期で所有者限定ゲートファイルを待ち、呼び出し元は`herdr agent start`が戻ってからゲートを作成した。

- `waiting_for_launch_gate`: `1788751196960`
- `herdr agent start`成功復帰: `1788751199839`、所要3,651ミリ秒
- `launch_gate_observed`: `1788751199847`
- その後、高速タスク、ACK、正常終了、ペイン閉鎖が成功

成立条件:

- 拡張は`session_start`中にTUIとプロトコル接続を初期化するが、初期プロンプトはまだ送らない。
- Pionsが`herdr agent start`の成功応答を受けた後に、認証済みの「実行開始」通知を拡張へ送る。
- 拡張はその通知後に所有者限定プロンプトファイルを読み、`pi.sendUserMessage()`する。

製品向けの推奨継ぎ目:

- 実験ではゲートファイルを使ったが、製品では既存の認証済みソケット対話へホストからワーカーへの`begin`フレームを追加する方がよい。
- `begin`は`hello`と`started`の認証・設定照合後、かつ`herdr agent start`成功後にだけ送る。
- 固定時間の`setTimeout`は端末負荷やモデル速度で再発するため代替にしない。

失敗時の代替案:

- `herdr pane run`で起動完了待ち自体を捨てる方法はあるが、Pi認識と準備完了の保証を失う。
- 自動終了を行わず人が閉じる方法は中心要件を満たさない。

## 実装Issueへ戻すべき要点

1. Pi CLI起動引数をADR-0005どおり固定し、観測設定を拡張から照合する。
2. ワーカープロトコルにホスト発の`begin`段階を追加し、`herdr agent start`完了後だけ初期プロンプトを解放する。
3. 結果確定は`message_end`で保持した最終アシスタントメッセージと`agent_settled`の組み合わせで行う。
4. ACK後は`ctx.shutdown()`し、開始トークン付きプロセス停止確認後に、Pionsが所有ペインだけを閉じる。
5. 失敗、キャンセル、通信断、ACK不明、停止検証不能ではペインを保持する。
6. ソケット、設定、プロンプトは作成後に明示的に所有者限定権限へする。
