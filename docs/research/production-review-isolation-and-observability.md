# 本番ホストにおける正式レビューワーカーの隔離と観測の機構

調査日: 2026-09-14

## この文書の位置付け

Wayfinder判断チケット「deadloopのAutomation hostとQoralのHerdrホストが実際に動作する対象環境で、正式レビューワーカーのファイル、コマンド、ネットワーク、外部資源へのアクセス強制、元リポジトリへのアクセス拒否、ワーカーと子プロセスの停止または実効的なアクセス遮断、および資源解放の確認に使える機構としてどのようなものが利用でき、それぞれが何を保証し、何を保証しないか」への一次情報調査である。

Pionsの用語では、ここで扱う対象は「資源アダプター」が担う責任範囲そのものである。Pionsは実行ワークスペースの所有権、削除権限、実行中のアクセス強制、後始末の権限を持たない（[`CONTEXT.md:135`](../../CONTEXT.md)）。本文書は、その外部の資源アダプターを本番ホスト上で実装するとしたら何が使えるかを、機構ごとに「保証すること」「保証しないこと」に分けて整理する。

実装も環境変更も行っていない。ホストに対しては読み取りと、状態を残さない使い捨てプロセスの実行だけを行った。

## 1. 対象環境の実行形態（一次情報）

### 1.1 deadloop の Automation host

- Automation hostとWorkerは**同一のOSユーザー**で動く。Herdrはファイルシステムのサンドボックスを提供しない。
  > "The Pi + Herdr support path runs the Automation host and Workers as the same operating-system user. ... Herdr does not provide a filesystem sandbox that contains an actively hostile same-user Worker."
  > [`/home/yasuhito/Work/deadloop/docs/herdr-runner.md`](file:///home/yasuhito/Work/deadloop/docs/herdr-runner.md)（"Runner boundary"節の末尾）
- 同じ結論をADRが決定として固定している。ファイルモード`0700`/`0600`は誤操作の分離であって、敵対的な同一ユーザープロセスの封じ込めではない。
  > "File ownership and modes such as `0700` and `0600` therefore separate runtime state from ordinary repository content, but they do not prevent a Worker from deliberately searching for and replacing another file owned by that user."
  > "Supporting that threat model requires an execution runtime with an enforceable isolation boundary, such as a separate operating-system identity or a filesystem sandbox."
  > [`/home/yasuhito/Work/deadloop/docs/adr/0015-worker-trust-boundary.md`](file:///home/yasuhito/Work/deadloop/docs/adr/0015-worker-trust-boundary.md)
- Workerは**Herdrのworktree上のペイン**に起動される（`herdr agent start <name> --kind <kind> --pane <root-pane> -- <native-agent-args...>`）。後片付けは`herdr workspace close`だけで、linked worktreeとbranchは残す。[`docs/herdr-runner.md`](file:///home/yasuhito/Work/deadloop/docs/herdr-runner.md)（"Attempt workspace lifecycle" / "Completion and cleanup"）
- `bash`の読み取り専用利用は「指示上の方針であり、隔離とはみなさない」とPions側でも明示されている（[`docs/adr/0004-use-a-pi-extension-for-operation-delegation.md:11`](../adr/0004-use-a-pi-extension-for-operation-delegation.md)）。

### 1.2 Qoral の Herdrホスト

- 同様に同一UIDで動き、ガードは**誤操作防止の境界であってセキュリティ境界ではない**と明記されている。
  > 「assignment guardとこの再検証は誤操作を防ぐための境界であり、同じUIDのhost processに対するsecurity boundaryではない。」
  > [`/home/yasuhito/Work/qoral-mainline-integration/docs/agents/trusted-execution.md`](file:///home/yasuhito/Work/qoral-mainline-integration/docs/agents/trusted-execution.md)（"Spawn直前の再検証と境界"）
- lifecycle commandについても同じ。
  > 「assignment guardとlifecycle commandはaccidental-misuse guardであり、security boundaryではない。」
  > [`/home/yasuhito/Work/qoral-mainline-integration/docs/agents/workspace-lifecycle.md`](file:///home/yasuhito/Work/qoral-mainline-integration/docs/agents/workspace-lifecycle.md)（"作成"節）
- ペイン分割は隔離ではないことも運用指示に書かれている。
  > 「ペインの分割はファイルを隔離しない。」
  > [`/home/yasuhito/Work/qoral-mainline-integration/AGENTS.md`](file:///home/yasuhito/Work/qoral-mainline-integration/AGENTS.md)（"Herdrでの作業分担"）
- Qoralの`trusted_execution`が持つ最強の`authoritative` kindでも、保証しているのは**実行ファイルの出自（root所有・mtree照合・ALPM package identity）と環境の固定**であり、起動後のプロセスのアクセス制限ではない。root所有のsystem executableとALPM databaseを同時に改変できるroot processは明示的にscope外とされている（同`docs/agents/trusted-execution.md`）。

### 1.3 Pions 側の要求

- レビュー入力準備完了は「準備時点の事実」であり、その後の不変性、元リポジトリの不可視性、実行中のアクセス強制、本番ホストの隔離を**証明しない**（[`docs/adr/0022-bind-review-input-readiness-to-the-start-gate.md:11`](../adr/0022-bind-review-input-readiness-to-the-start-gate.md)、[`docs/adr/0017-prepare-formal-review-input-from-verified-artifacts.md:9,11`](../adr/0017-prepare-formal-review-input-from-verified-artifacts.md)）。
- 権限目録は「権限の宣言、現在の観測、および実行中の強制は独立」と定義し、強制の保証は資源証明が別に示すとしている（[`CONTEXT.md:219`](../../CONTEXT.md)）。
- 資源取得処理は「実行主体へアクセスを許可した場合はその**遮断後にだけ**解放できる」「解放済みは資源を保持していないことが確認済みである事実」と定義する（[`CONTEXT.md`](../../CONTEXT.md) "Resource acquisition"）。つまりアダプターには**遮断の実効性**と**解放の確認**の両方が要求される。
- 単体・統合テストの合格や非本番接続試験の成功を、本番ホストの継続的なアクセス隔離・停止遮断・後始末の証拠として扱ってはならない（[`docs/adr/0024-validate-trusted-formal-review-bootstrap-identities.md:11`](../adr/0024-validate-trusted-formal-review-bootstrap-identities.md)、[`CONTEXT.md`](../../CONTEXT.md) "Non-production connection test record"）。

### 1.4 実ホストでの実測（現状の形態）

Herdrサーバーとその配下の全ペインシェル・全エージェントプロセスは、**同一の名前空間と同一の単一cgroup**にいる。

```
$ for p in <herdr server> <pane bash> <pi>; do cat /proc/$p/cgroup; readlink /proc/$p/ns/{pid,net,mnt}; done
0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-ghostty-surface-transient-2806392.scope   （3プロセスとも同一）
pid:[4026531836] net:[4026531833] mnt:[4026531832]                                                      （ホストの初期名前空間と同一）
```

この事実の帰結は重要である。

- **ワーカー単位のcgroup停止は現状では不可能**。そのcgroupを`cgroup.kill`すればHerdrサーバーと全ペインが死ぬ。
- **ワーカー単位のnamespace隔離は現状ゼロ**。mount/PID/network/userすべてホストと共有している。
- Pions自身も`herdr`を`execFile`で起動し`--cwd`を渡すだけで、隔離層を挟んでいない（[`src/internal/herdr-presentation.ts:29,166,262`](../../src/internal/herdr-presentation.ts)）。

## 2. 実ホストの実測条件

| 項目 | 実測値 | 意味 |
|---|---|---|
| kernel | `7.1.8-arch1-3` x86_64（Omarchy / Arch系） | cgroup v2、`cgroup.kill`（5.14+）、freezer v2（5.2+）すべて利用可 |
| 非特権user namespace | `kernel.unprivileged_userns_clone = 1`、`user.max_user_namespaces = 255450` | 非特権プロセスがuserns/mount/PID/netnsを作れる |
| AppArmor userns制限 | `kernel.apparmor_restrict_unprivileged_userns` は**存在しない** | Ubuntu系の非特権userns制限は掛かっていない |
| bubblewrap | `/usr/bin/bwrap` 0.11.2、**非setuid**（`-rwxr-xr-x root root`） | rootless動作。setuid経路は上流で削除済み |
| systemd | 261（`+SECCOMP +BPF_FRAMEWORK +AUDIT +APPARMOR -SELINUX`） | user managerのsandboxing機能が新しい世代で使える |
| cgroup v2 delegation | `user@1000.service`: `Delegate=yes`, `DelegateControllers=cpu memory pids` | ユーザーは`cpu`/`memory`/`pids`だけ委譲される。`io`/`cpuset`は**未委譲** |
| ユーザースコープの制御ファイル | `cgroup.kill`が`--w------- yasuhito`、`cgroup.freeze`/`cgroup.events`/`cgroup.procs`がユーザー所有 | 非特権でも自分のscopeに対して`kill`/`freeze`/`populated`観測ができる |
| Docker | 29.7.2、**rootfulデーモンがactive**、`/var/run/docker.sock` `660 root:docker` | 後述のとおり危険 |
| 現ユーザーのgroup | `... 967(docker), 998(wheel)` | **現状、ワーカーは既にroot相当の権限を取得できる**（後述4.8） |
| rootless Docker前提 | `/etc/subuid`=`yasuhito:100000:65536`、`newuidmap`に`cap_setuid=ep` | rootless Dockerの前提条件は満たしている |
| ネットワークフィルタ補助 | `slirp4netns` / `pasta(passt)` / `firejail` いずれも**未導入** | 非特権でのネットワーク許可リストは現状「素材がない」 |
| auditd | `inactive`、`auditctl`は非rootでは読めない | 監査ログによる観測は現状使えない |

## 3. 機構ごとの保証と非保証

### 3.1 user namespace（非特権コンテナの土台）

保証すること:

- 非特権プロセスがusernsを作り、その中で完全な能力集合を得られる。これによりmount/PID/network namespaceも非特権で作れる。
  > "Since Linux 3.8, unprivileged processes can create user namespaces, and the other types of namespaces can be created with just the CAP_SYS_ADMIN capability in the caller's user namespace."
  > [user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)

保証しないこと:

- 名前空間の**外**に対する特権は一切与えない。
  > "the process has full privileges for operations inside the user namespace, but is unprivileged for operations outside the namespace."
  > [user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)
  裏返すと、**同じUIDが持つホスト上のファイルへの通常のアクセス権はusernsでは減らない**。減らすのはmount namespaceによる「見せない」操作である。
- ブロックデバイスのマウントは初期usernsのCAP_SYS_ADMINが必要（同上）。
- 非特権usernsはkernelのattack surfaceを広げる方向にも働く。これは設定で無効化される運用が実際にある（本ホストでは有効）ため、**ホスト設定への依存**が残る。

### 3.2 mount namespace / bubblewrap（ファイルアクセス強制の主役）

保証すること（実測済み）:

使い捨てプロセスで検証した結果、`--unshare-all`＋明示bindだけのビューが構成でき、ホームディレクトリは見えず、ネットワークはloopbackのみ、PID名前空間も分離された。

```
$ bwrap --unshare-all --ro-bind /usr /usr --ro-bind /etc /etc ... --proc /proc --dev /dev \
        --die-with-parent --new-session /bin/sh -c 'echo PID=$$; id -u; ls /home; ip link'
PID=2
1000
ls: cannot access '/home': No such file or directory
1: lo: <LOOPBACK,UP,LOWER_UP> ...
```

- `--ro-bind SRC DEST`は読み取り専用bind、`--unshare-all`は`--unshare-user-try --unshare-ipc --unshare-pid --unshare-net --unshare-uts --unshare-cgroup-try`と等価（`man 1 bwrap`, bubblewrap 0.11.2 / 上流定義 <https://github.com/containers/bubblewrap/blob/main/bwrap.xml>）。
- `--new-session`は`setsid()`で制御端末を切り離し、`TIOCSTI`によるサンドボックス外コマンド実行（CVE-2017-5226）を防ぐ（`man 1 bwrap`、[bubblewrap README "Limitations"](https://github.com/containers/bubblewrap/blob/main/README.md)）。
- `--die-with-parent`は「bwrapまたはその親が死んだとき、親から子へ順にサンドボックス内の全プロセスをSIGKILLする」（`man 1 bwrap`）。
- `PR_SET_NO_NEW_PRIVS`によりsetuidバイナリが無効化される（[bubblewrap README "System security"](https://github.com/containers/bubblewrap/blob/main/README.md)）。

保証しないこと:

- **bubblewrap自体はセキュリティポリシーを持たない**。保護の強さは引数で決まり、引数を組み立てる側が脅威モデルを定義する責任を負う。
  > "bubblewrap is not a complete, ready-made sandbox with a specific security policy. ... the level of protection between the sandboxed processes and the host system is entirely determined by the arguments passed to bubblewrap."
  > [bubblewrap README "Sandbox security"](https://github.com/containers/bubblewrap/blob/main/README.md)
- **持ち込んだものはすべて昇格経路になりうる**。
  > "Everything mounted into the sandbox can potentially be used to escalate privileges. For example, if you bind a D-Bus socket into the sandbox, it can be used to execute commands via systemd."
  > [同README "Limitations"](https://github.com/containers/bubblewrap/blob/main/README.md)
  正式レビューワーカーの現実では、`$HOME/.pi`、認証情報、`SSH_AUTH_SOCK`、`DBUS_SESSION_BUS_ADDRESS`、`/var/run/docker.sock`、Herdr APIソケットがこれに当たる。
- **継承済みファイル記述子は名前空間で消えない**。起動前に開かれたディレクトリfdやソケットfdは、mount namespaceを作っても有効なままである。閉じる責任は起動側にある（kernel man-pagesはfdの名前空間非依存性を前提としており、bwrapは`--sync-fd`等の明示fdを除いて自動的な整理を約束していない）。
- ファイルの**書き込み範囲の宣言**と、範囲外書き込みの阻止は別物である。Pions側も「書き込み範囲の宣言と照合は、範囲外書き込みの阻止や基本ソフトウェア・コンテナによる隔離を意味しない」としている（[`CONTEXT.md:147`](../../CONTEXT.md)）。

### 3.3 PID namespace（子孫の確定と一括停止）

保証すること:

- PID名前空間のinit（PID 1）が終了すると、**kernelが名前空間内の全プロセスをSIGKILLする**。
  > "If the 'init' process of a PID namespace terminates, the kernel terminates all of the processes in the namespace via a SIGKILL signal. ... a subsequent fork(2) into this PID namespace fail with the error ENOMEM"
  > [pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
  これは「ワーカーと子プロセスの停止」に対する**強い**保証である。孤児プロセスも名前空間のinitに再親付けされるため、名前空間外へ逃げられない（同man）。
- bubblewrapは既定でサンドボックス内に自前のpid1を置いてreapする（[bubblewrap README "Sandboxing"](https://github.com/containers/bubblewrap/blob/main/README.md)）。`--as-pid-1`を使うとこのreaperを置かない（`man 1 bwrap`）ので、正式レビューワーカーでは**使わない**べきである。

保証しないこと:

- PID名前空間の破棄は、そのプロセス群が**ホスト上に残した副作用**（書き込んだファイル、外部APIへの送信、作成した外部資源）を取り消さない。
- PID名前空間だけではファイルもネットワークも制限しない。
- `setns(2)`で外から入ってきたプロセスとの関係など、端のケースがある（[pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)）。

### 3.4 network namespace（ネットワーク遮断）

保証すること:

- ネットワークデバイス、IPv4/IPv6スタック、ルーティング、ファイアウォール規則、`/proc/net`、ポート番号、および**UNIXドメインのabstract socket名前空間**まで分離する。
  > "Network namespaces provide isolation of the system resources associated with networking: network devices, IPv4 and IPv6 protocol stacks, IP routing tables, firewall rules, the /proc/net directory ..., port numbers (sockets), and so on. In addition, network namespaces isolate the UNIX domain abstract socket namespace"
  > [network_namespaces(7)](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)
- 空のnetnsは実質「ネットワーク全拒否」であり、実測でも`lo`のみだった（3.2）。

保証しないこと:

- **ファイルシステム上のUNIXソケットは遮断しない**。abstract socketは分離されるが、`/run/user/1000/...`のようなパス上のソケットはmount namespace側で隠さない限り到達できる。systemdも同じ注意を明記している。
  > "for AF_UNIX this has the effect that AF_UNIX sockets in the abstract socket namespace of the host will become unavailable ... (however, those located in the file system will continue to be accessible)."
  > [systemd.exec(5) `PrivateNetwork=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- **「特定の宛先だけ許可」はnetnsだけでは作れない**。正式レビューワーカーはモデルAPIへの外向き通信を必要とするため、全遮断は選択肢にならず、許可リストには別機構（後述）が要る。本ホストには`slirp4netns`も`pasta`も入っていない。

### 3.5 seccomp（コマンド・システムコールの制限）

保証すること:

- フィルタは`fork`/`clone`/`execve`をまたいで保持される（[seccomp(2)](https://man7.org/linux/man-pages/man2/seccomp.2.html)）。非特権で使うには事前に`prctl(PR_SET_NO_NEW_PRIVS, 1)`が必要（同man）。
- BPFはポインタを参照できないため、**TOCTOU攻撃に原理的に強い**。
  > "BPF makes it impossible for users of seccomp to fall prey to time-of-check-time-of-use (TOCTOU) attacks ... BPF programs may not dereference pointers"
  > [kernel seccomp_filter.rst](https://www.kernel.org/doc/Documentation/userspace-api/seccomp_filter.rst)
- bubblewrapは`--seccomp FD` / `--add-seccomp-fd FD`でcBPFプログラムを適用できる（`man 1 bwrap`）。

保証しないこと:

- **seccompはサンドボックスではない**。上流ドキュメントが明言している。
  > "System call filtering isn't a sandbox. It provides a clearly defined mechanism for minimizing the exposed kernel surface. It is meant to be a tool for sandbox developers to use."
  > [kernel seccomp_filter.rst](https://www.kernel.org/doc/Documentation/userspace-api/seccomp_filter.rst)
- ポインタを参照できない以上、**パス単位・宛先アドレス単位の許可はできない**。「このファイルだけ読める」「このホストにだけ接続できる」はseccompでは表現できず、mount namespaceやネットワーク側の機構が必要。
- 複数ABI（x86/x86-64）を閉じないと迂回される。systemdは`SystemCallArchitectures=native`との併用を推奨している（[systemd.exec(5) `SystemCallFilter=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)）。

### 3.6 cgroup v2（停止・資源制限・解放確認）

保証すること:

- `cgroup.kill`に`1`を書くと、**そのcgroupツリー全体**の全プロセスがSIGKILLされ、**同時フォークに対しても正しく処理され、移動に対しても保護される**。
  > "Writing '1' to the file causes the cgroup and all descendant cgroups to be killed. ... Killing a cgroup tree will deal with concurrent forks appropriately and is protected against migrations."
  > [kernel cgroup-v2.rst `cgroup.kill`](https://www.kernel.org/doc/Documentation/admin-guide/cgroup-v2.rst)
  これは`kill(-pgid)`やプロセスツリー走査より強く、**PID名前空間を使わない場合の「子孫の確定＋一括停止」の最良手段**である。
- `cgroup.freeze`に`1`で全プロセスを停止でき、完了は`cgroup.events`の`frozen`で観測できる（同rst）。凍結中でも致命シグナルで殺せる（同rst）。
- `cgroup.events`の`populated`は「そのcgroupまたは子孫に生きているプロセスがあるか」を示し、**値変化でファイル変更イベントが発生する**ため、`inotify`/`poll`で待てる。
  > "populated: 1 if the cgroup or its descendants contains any live processes; otherwise, 0."
  > [kernel cgroup-v2.rst `cgroup.events`](https://www.kernel.org/doc/Documentation/admin-guide/cgroup-v2.rst)、[cgroups(7)](https://man7.org/linux/man-pages/man7/cgroups.7.html)
  `populated 0`＋cgroupディレクトリの`rmdir`成功は、**「資源解放の確認」に使える決定論的な事実**になる。実測でも`populated 1`を読めた。
- 本ホストではユーザーのscope配下で`cgroup.kill`/`cgroup.freeze`/`cgroup.events`がユーザー所有であり、**非特権のまま使える**（2章の実測）。

保証しないこと:

- **cgroupはアクセス制御機構ではない**。ファイル、ネットワーク宛先、外部APIへのアクセスを一切制限しない。
- SIGKILLは**プロセスを止めるだけ**で、すでに外部へ送った要求、外部サービス上に作られた資源、書き込み済みのファイルは取り消さない。したがってPionsの「アクセス遮断」は、外部資源については別途アダプターの資格情報失効が必要になる。
- 委譲された制御は限定的。本ホストの`DelegateControllers`は`cpu memory pids`だけで、`io`と`cpuset`は非特権では使えない。ディスクI/Oによる資源枯渇は制限できない。
- `populated 0`は「このcgroupにプロセスがいない」だけを示す。cgroupに入れ損ねたプロセスや、cgroup外へ委譲されたデーモンは数えない。
- cgroups(7)のman-pageは`cgroup.kill`を記載していない（古い）。一次情報はkernel documentationを見る必要がある。

### 3.7 systemd（ユーザーマネージャ経由の統合）

利用形態は2つある。`systemd-run --user --scope`（呼び出し元の子プロセスとして走り、新しいscope cgroupに入る）と`systemd-run --user`のtransient `.service`である（[systemd-run(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)）。

保証すること:

- **どちらでもワーカー専用のcgroupが得られる**。これだけで3.6の`cgroup.kill`/`freeze`/`events`がワーカー単位で使えるようになり、`systemctl --user stop`、`--wait`、`-p Result`、journalの`_SYSTEMD_USER_UNIT`による観測が付いてくる。現状のHerdrペイン相乗りcgroup問題（1.4）を解く最小の変更はここである。
- `.service`側では、user managerでも`PrivateUsers=`と併用すれば名前空間系の設定が効く。
  > "most namespacing settings, that will not work on their own in user services, will work when used in conjunction with PrivateUsers=true."
  > [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- `PrivateNetwork=`はloopbackのみのnetnsを作る。user managerでも使えるが、その場合は`PrivateUsers=`が暗黙に有効化され、`kernel.unprivileged_userns_clone`に依存する。
  > "This option is only available for system services, or for services running in per-user instances of the service manager in which case PrivateUsers= is implicitly enabled (requires unprivileged user namespaces support ...)"
  > [systemd.exec(5) `PrivateNetwork=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

保証しないこと:

- **`--scope`にはexec系のサンドボックス設定が効かない**。scopeはsystemdが実行するのではなく呼び出し元の子だからである。Herdrペインの中でTTYを保ったまま可視ワーカーを走らせたい（Pions ADR-0005の要求）場合、`--scope`＋bwrapの組み合わせが必要になり、隔離はbwrap側の責任になる。
- **サンドボックス機能は「静かに無効化される」**。
  > "many of these sandboxing features are gracefully turned off on systems where the underlying security mechanism is not available."
  > [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
  つまり**設定したことは強制されたことを意味しない**。Pionsの「宣言・観測・強制は独立」（[`CONTEXT.md:219`](../../CONTEXT.md)）と正確に一致する。資源証明は「設定値」ではなく「有効になったことの観測」を含まなければならない。
- 読み取り専用化は**IPCを閉じない**。
  > "the various options that turn directories read-only (such as ProtectSystem=, ReadOnlyPaths=, ...) do not affect the ability for programs to connect to and communicate with AF_UNIX sockets in these directories. These options cannot be used to lock down access to IPC services hence."
  > [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- `PrivateNetwork=`自体が単独のセキュリティ根拠にならないと明記されている。
  > "the unit should be written in a way that does not solely rely on this setting for security."
  > [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- **IPアドレス許可リストはユーザーユニットでは当てにできない**。`IPAccounting=`は「現在システムサービスのみで、ユーザーサービスでは利用できない」と明記されている（[systemd.resource-control(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)）。`IPAddressAllow=`/`IPAddressDeny=`、`SocketBindAllow/Deny=`、`RestrictNetworkInterfaces=`はいずれもcgroup-BPFフックの実装であり、さらに上流は次のとおり明言している。
  > "these settings might not be supported on some systems (for example if eBPF control group support is not enabled ...). These settings will have no effect in that case. If compatibility with such systems is desired it is hence recommended to not exclusively rely on them for IP security."
  > [systemd.resource-control(5) `IPAddressAllow=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
  「ユーザーマネージャでBPFフックが実際にattachされるか」は本調査では**実測していない**（環境変更を避けたため）。未確定事項として6章に残す。
- `PrivatePIDs=`は`Type=forking`と併用できず、`/proc`がマスクされている環境ではユーザーサービスで失敗しうる（[systemd.exec(5) `PrivatePIDs=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)）。

### 3.8 Docker

保証すること:

- `--network none`で完全なネットワーク遮断、`-v src:dst:ro`で読み取り専用bind、`--read-only`でrootfs読み取り専用、`--pids-limit`/`-m`で資源上限、`--cap-drop`/`--security-opt`で能力とseccompの制御ができる（[docker container run](https://docs.docker.com/reference/cli/docker/container/run/)）。
- 停止と観測の道具立ては最も整っている。`docker stop`はSIGTERM→猶予後SIGKILL（[docker container stop](https://docs.docker.com/reference/cli/docker/container/stop/)）、`docker kill`は即時、`docker wait`は終了コード、`docker events`は`start`/`die`/`destroy`等の**構造化イベントストリーム**、`docker inspect`は現在状態、`--rm`は終了時にコンテナと匿名ボリュームを自動削除する（[docker container run](https://docs.docker.com/reference/cli/docker/container/run/)）。**資源解放の確認**という観点では`inspect`のNotFound＋`events`の`destroy`が最も明確な証拠になる。

保証しないこと（かつ**現状で最大の危険**）:

- **Docker daemonを操作できることはroot相当である**。
  > "only trusted users should be allowed to control your Docker daemon. ... you can start a container where the `/host` directory is the `/` directory on your host; and the container can alter your host filesystem without any restriction."
  > [Docker Engine security](https://docs.docker.com/engine/security/)
- 本ホストでは**現ユーザーが`docker`グループに属し、rootfulデーモンが動いている**（`uid=1000(yasuhito) groups=...,967(docker)`、`/var/run/docker.sock 660 root:docker`、daemon active）。したがって**今日のdeadloop WorkerとQoral割当ワーカーは、その気になればホストのrootを取れる**。これは1.1/1.2の「同一UID・セキュリティ境界なし」という既存の記述よりさらに強い事実であり、正式レビューワーカーをDockerで隔離するか否か以前の問題である。ワーカーからDockerソケットが見えないようにすること（mount namespaceで隠す／別ユーザーで走らせる）が先に要る。
- rootless Dockerならデーモンもコンテナも非rootのuserns内で動く（[Rootless mode](https://docs.docker.com/engine/security/rootless/)）。本ホストは前提条件（`/etc/subuid`、`newuidmap`のcap_setuid）を満たしているが、rootlessへの移行は**環境変更**であり本調査の範囲外とした。
- コンテナ化してもHerdrの可視ペインにワーカーを見せる要件（Pions ADR-0005、deadloopの`herdr agent start`契約）とは素直に噛み合わない。`docker run -it`をペイン内で走らせる形になり、ペイン＝コンテナのライフサイクル結合を別途設計する必要がある。

## 4. 要求項目ごとの対応

| 要求 | 使える機構 | 保証の強さ | 主な抜け |
|---|---|---|---|
| ファイルアクセス強制 | mount namespace（bwrap `--ro-bind`/`--tmpfs`）、Docker bind `:ro`＋`--read-only` | 強い。見えないものは開けない | 継承fd、bindで持ち込んだソケット、既に開かれた資源 |
| コマンド（実行系）強制 | mount namespaceでバイナリを見せない＋seccomp＋`no_new_privs` | 中。「何を実行できるか」はmount側、「どのsyscallか」はseccomp側 | seccompはパス判定不可。インタプリタ経由の実質実行は塞げない |
| ネットワーク強制（全拒否） | network namespace（bwrap `--unshare-net`、systemd `PrivateNetwork=`、Docker `--network none`） | 強い | ファイルパス上のUNIXソケットは対象外 |
| ネットワーク強制（許可リスト） | cgroup-BPF（`IPAddressAllow=`）、netns＋フィルタリングプロキシ（`pasta`/`slirp4netns`） | **現状弱い/未整備** | ユーザーマネージャでのBPF有効性が未確認。プロキシ実装は未導入 |
| 外部資源アクセス強制 | 資格情報を渡さない（mount/env制御）＋外部側の失効 | 中 | kernel機構では表現できない。アダプター責任 |
| 元リポジトリへのアクセス拒否 | mount namespaceで元リポジトリをbindしない | 強い。ただし**下記5章の前提**が必要 | linked worktreeは成立しない |
| ワーカーと子孫の停止 | PID namespace（init終了で全SIGKILL）、cgroup `cgroup.kill` | **強い**。両方とも同時フォークに強い | 外部へ出た副作用は取り消せない |
| 実効的なアクセス遮断 | 上記停止＋`cgroup.freeze`（即時凍結）＋資格情報失効 | 中〜強 | 外部資源側の遮断はkernelの外 |
| 資源解放の確認 | `cgroup.events`の`populated 0`＋cgroup `rmdir`成功、bwrap `--json-status-fd`の`exit-code`、`docker inspect`のNotFound＋`events`の`destroy` | 強い | cgroupに入れ損ねたプロセスは数に入らない |
| 観測 | `cgroup.events`のinotify、`memory.events`/`pids.events`、bwrap `--json-status-fd`/`--info-fd`（child-pidとexit-code）、`journalctl --user -u`、`docker events`/`inspect` | 中〜強 | auditdは本ホストで`inactive`かつ非rootで読めない |

## 5. 元リポジトリ非公開とlinked worktreeは両立しない（実測）

これは設計上の分岐点になる具体的な事実である。deadloopもQoralも、作業領域を**元リポジトリのlinked worktree**として作る（[deadloop `docs/herdr-runner.md`](file:///home/yasuhito/Work/deadloop/docs/herdr-runner.md)、[Qoral `docs/agents/workspace-lifecycle.md`](file:///home/yasuhito/Work/qoral-mainline-integration/docs/agents/workspace-lifecycle.md)）。linked worktreeの`.git`は元リポジトリを指すファイルであり、オブジェクトデータベースは元リポジトリ側にある。

```
$ cat /home/yasuhito/Work/qoral-mainline-integration/.git
gitdir: /home/yasuhito/Work/qoral/.git/worktrees/qoral-mainline-integration
```

元リポジトリをbindせずにworktreeだけをサンドボックスへ入れると、gitは動かない。

```
$ bwrap --unshare-all ... --ro-bind /tmp/pions-prototype-80 /work --chdir /work \
        /bin/sh -c 'cat .git; git rev-parse HEAD'
gitdir: /home/yasuhito/Work/pions/.git/worktrees/pions-prototype-80
fatal: not a git repository: (null)
```

したがって「元リポジトリへのアクセス拒否」を満たす正式レビュー実行ワークスペースは、**linked worktreeであってはならない**。独立したクローンか、Pions ADR-0017が言う「検証済み依存閉包の固定バイト列」のエクスポートである必要がある。Pionsの現行ADRはすでにこの形（固定入力の書き出し）を採っており、[`docs/adr/0017`](../adr/0017-prepare-formal-review-input-from-verified-artifacts.md)と整合する。一方で、deadloop/Qoralの既存ワークスペース生成経路をそのまま資源アダプターとして流用することはできない。

## 6. これらの機構だけでは保証できないこと

1. **副作用の取り消し**。停止も遮断も、外部APIへ送信済みの内容、外部サービス上に作られた資源、書き込み済みのファイルを元に戻さない。Pionsの「アクセス遮断後にだけ解放できる」は、外部資源については資格情報の失効を伴わなければ意味を持たない。
2. **同一UIDの相互干渉**。Herdrサーバー、他ペイン、ホストの状態ファイルは同じUIDである。サンドボックス化したのはワーカーだけで、**サンドボックスを作る側（Automation host、Herdr、Pions Runtime）が同じUIDに晒されている状況は変わらない**。deadloop ADR-0015が言う「別のOS identity」まで行かないと、この層は閉じない。
3. **設定と強制の乖離**。systemdは機構が無ければ静かに無効化し、cgroup-BPFは環境次第で無効になる。**資源証明は設定値の複製ではなく、有効化の観測でなければならない**。これはPionsの定義（[`CONTEXT.md:219`, "Resource proof"](../../CONTEXT.md)）と同じ方向だが、「何をもって観測とするか」はまだ決まっていない。
4. **kernelそのものの脆弱性**。非特権usernsはattack surfaceを広げる。seccompは「kernel surfaceの最小化の道具」であってサンドボックスではないと上流が明言している。
5. **TOCTOU**。Qoralが既に文書化しているとおり、検証からexecまでの間に同じUIDの別プロセスが実行ファイルを差し替えるraceは残る（[`docs/agents/trusted-execution.md`](file:///home/yasuhito/Work/qoral-mainline-integration/docs/agents/trusted-execution.md)）。
6. **監査証跡**。本ホストのauditdは`inactive`であり、非rootでは読めない。「誰が何にアクセスしたか」の独立した記録は現在存在しない。journalは「systemdが何を起動したか」までしか答えない。
7. **非本番での成功の外挿**。Pions ADR-0024が既に禁じているとおり、テストや接続試験の成功は本番の隔離の証拠にならない。本調査の実測も「この機構がこのホストで動く」ことまでしか示さない。

## 7. Questionへの推奨結論

**推奨: `systemd-run --user --scope`（ワーカー専用cgroup）＋ その中で`bwrap`（mount/PID/user namespace）という2層を、正式レビューワーカーの本番資源アダプターの基本形とする。ネットワークは当面「全拒否」か「無制限」の二択として扱い、許可リストは別の判断チケットへ切り出す。Dockerは正式レビューワーカーの隔離手段としては採用しない。**

理由:

- 停止と解放確認は、`cgroup.kill`（同時フォーク耐性・移動耐性）と`cgroup.events`の`populated`（変更イベント通知付き）で**決定論的かつ非特権で**得られる。これがPionsの「遮断後にだけ解放」「解放済みは確認済みの事実」という定義に最も素直に対応する。現状のHerdr相乗りcgroup（1.4）ではこれが一切成立しないので、ここが最小で最大の改善点である。
- ファイルアクセス強制と元リポジトリ非公開は、mount namespaceでしか実現できない。bwrapはrootless・非setuid・依存が軽く、`--die-with-parent`と`--json-status-fd`で親子結合と終了コード回収まで揃う。
- PID namespaceはcgroup killと冗長だが、**init終了で全プロセスがkernelにSIGKILLされる**という独立した保証を足すので、両方使う価値がある。
- Dockerを推奨しない理由は3つ。(a) 現行はrootfulで、デーモン操作＝root相当だと上流が明言している。(b) そのためにワーカーからソケットを隠す作業が必須になり、結局mount namespaceが要る。(c) Herdr可視ペインとの結合が設計上の追加コストになる。逆に言えば、rootless Dockerへ移行済みの環境なら`docker events`/`inspect`の観測品質は魅力的で、再評価の価値がある。
- ネットワーク許可リストを当面切り離す理由は、素材が無いからである。`IPAddressAllow=`はユーザーマネージャで効くか未確認、`pasta`/`slirp4netns`は未導入。「モデルAPIにだけ出られる」を本番保証として約束できる材料が現時点で無い以上、権限目録に「ネットワーク=全拒否」か「ネットワーク=無制限（強制なし、宣言のみ）」しか書けない、と正直に扱うほうがPionsの用語定義に合う。

**ただし、この2層を入れても「Automation host自身が同一UIDでワーカーに晒されている」層は閉じない。** deadloop ADR-0015が言う「別のOS identity」は依然として未解決であり、この推奨は敵対的ワーカーに対する完全な封じ込めを主張しない。

**先に手を付けるべき既存の危険**: 現ユーザーが`docker`グループに属したままrootfulデーモンが動いている。これは正式レビュー以前に、今日のdeadloop Worker・Qoral割当ワーカーがホストrootを取得できることを意味する。

## 8. 新しい独立した判断チケットにすべき具体的質問

1. **ワーカーからのDockerソケット到達を、本番ホストでどう塞ぐか。** 選択肢は (a) ホストをrootless Dockerへ移行、(b) ユーザーを`docker`グループから外す、(c) ワーカーのmount namespaceで`/var/run/docker.sock`を隠すだけに留める。(c)は隔離層が無いワーカー（現状の通常Worker）には効かない。
2. **正式レビュー実行ワークスペースの供給形態を、linked worktreeではなく何にするか。** 独立クローンか、依存閉包のエクスポートか。5章の実測により、この2つ以外は「元リポジトリ非公開」と両立しない。
3. **ネットワーク許可リストを本番保証に含めるか、当面「宣言のみ・強制なし」と明示するか。** 含めるなら、cgroup-BPFかフィルタリングプロキシかの選択と、追加ソフトウェア導入の可否が付随する。
4. **資源証明に載せる「実行中の強制の観測」を何にするか。** 候補: `/proc/<pid>/ns/*`のinode、`/proc/<pid>/status`の`Seccomp`/`NoNewPrivs`、cgroupパスと`cgroup.controllers`、mountinfoのダイジェスト。systemdが静かに無効化する以上、設定値の複製は証明にならない。
5. **可視ペイン要求（Pions ADR-0005）と隔離をどう両立させるか。** `--scope`＋bwrapでTTYを保つか、transient `.service`にして可視性を諦め別の観測手段にするか。
6. **「アクセス遮断」の定義に外部資源の資格情報失効を含めるか。** kernel機構は外部資源を遮断しないので、含めるなら資源アダプターの契約に失効操作が必要になる。
7. **deadloop/Qoralの既存Workerにもこの隔離を適用するか、正式レビューワーカーだけに限定するか。** 限定する場合、両ホストの既存の信頼モデル（ADR-0015、Qoralのaccidental-misuse guard）は変更しないという判断を明文化する必要がある。

## 9. 未確定事項

- **`IPAddressAllow=`/`IPAddressDeny=`/`SocketBindDeny=`/`RestrictNetworkInterfaces=`が、systemdのper-user managerで実際にBPFフックとしてattachされ強制されるか。** 上流manは`IPAccounting=`についてのみ「システムサービス限定」と明記し、他については「環境によっては無効で効果なし」としか書いていない。実測には transient unit の起動が必要なため本調査では行っていない。
- **rootless Dockerへ移行した場合の観測品質と制約。** 前提条件は満たしているが、移行は環境変更のため未検証。
- **Pi / Claude / Codex といったエージェントCLIが、bwrapのmount namespace内で正常動作するか。** `$HOME`、設定ディレクトリ、キャッシュ、資格情報の置き場所、`--new-session`によるTTY切り離しの影響は未検証。特に`--new-session`は対話型CLIの挙動を変えうる。
- **継承fdの扱い。** Herdrペインから起動する以上、ペインのTTYと親プロセスが開いているfdが渡る。どのfdを閉じるべきかは未整理。
- **bwrap内でのgit実行に必要な最小bind集合。** 独立クローン方式にした場合でも、`/usr`、`/etc`（`gitconfig`、証明書）、ロケール、一時ディレクトリの要件は未確定。
- **凍結（`cgroup.freeze`）を「実効的なアクセス遮断」として認めるか。** 上流は凍結中でも致命シグナルで殺せるとしており、凍結は解放ではなく一時停止である。Pionsの状態語彙のどこに置くかは未決。
- **auditdを有効化して監査証跡を取るか。** 現在`inactive`。有効化はホスト全体への変更であり、判断が必要。
