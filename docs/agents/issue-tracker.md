# Issue管理：GitHub

このリポジトリのIssueと仕様は、`yasuhito/pions`のGitHub Issuesで管理する。操作には`gh`コマンドを使用する。

ローカルのGit remoteから対象リポジトリを判別できない間は、`-R yasuhito/pions`を明示する。remoteが存在する場合は、明示的な`-R`とリポジトリの自動判別のどちらを使用してもよい。

## 操作方法

- 作成：`gh issue create -R yasuhito/pions --title "..." --body-file <file>`
- コメントとラベルを含む参照：`gh issue view -R yasuhito/pions <number> --comments`
- 一覧：`gh issue list -R yasuhito/pions --state open --json number,title,body,labels,comments`
- コメント：`gh issue comment -R yasuhito/pions <number> --body-file <file>`
- ラベル追加：`gh issue edit -R yasuhito/pions <number> --add-label "..."`
- ラベル削除：`gh issue edit -R yasuhito/pions <number> --remove-label "..."`
- クローズ：`gh issue close -R yasuhito/pions <number> --comment "..."`

GitHubのIssueとプルリクエストは番号空間を共有する。番号の種別が不明な場合は、まず`gh pr view`で確認し、該当しなければ`gh issue view`を使用する。

## 公開作業

プルリクエストをトリアージ対象の依頼として扱わない。

スキルから仕様やチケットの公開を求められた場合は、項目ごとに1件のGitHub Issueを作成する。依存先となるIssueを先に公開する。GitHubでIssue間の依存関係を設定できる場合はその機能を使用し、できない場合は依存するIssueの本文冒頭付近に`Blocked by: #<number>`を記載する。

すべての依存先がクローズされているチケットだけを着手可能とする。承認済みの仕様から作成され、エージェントが実行可能なチケットには`ready-for-agent`を付与する。
