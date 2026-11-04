# 05 — 設定リファレンス(~/.familiar/config.yaml)

ステータス: 確定 / 最終更新: 2026-10-17

初回起動時にテンプレートを自動生成する(`familiar init`; 存在時は上書きしない)。
シークレットをこのファイルに書かないこと(ファイル参照 or 環境変数)。

```yaml
version: 1

default_provider: openai      # ollama / anthropic / openrouter ...
default_model: "gpt-6.1-sol"  # provider 別の未指定時に使用(e.g. ollama: qwen2.5-coder:3b)

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }
  google:                    # M2+: Gemini の OpenAI 互換エンドポイント
    kind: openai_compatible
    base_url: https://generativelanguage.googleapis.com/v1beta/openai
    auth: { env: GEMINI_API_KEY }
    models: [gemini-2.5-flash, gemini-2.5-pro]   # 静態リスト(ネットワーク照会回避)
    default_model: gemini-2.5-flash
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: none
  anthropic:
    kind: anthropic
    base_url: https://api.anthropic.com/v1
    auth: { env: ANTHROPIC_API_KEY }
  openrouter:
    kind: openai_compatible
    base_url: https://openrouter.ai/api/v1
    auth: { env: OPENROUTER_API_KEY }
  nvidia:
    kind: openai_compatible
    base_url: https://integrate.api.nvidia.com/v1
    auth: { env: NVIDIA_API_KEY }
  # NOTE: kind: mock は mock プロバイダ実装(smoke テスト用)として残るが、
  # 既定の組み込みプロバイダ一覧には含まれない。使うなら以下を明示:
  # mock:
  #   kind: mock

# 推論エフォート(v1.1):
#   config.yaml のキーではなくセッション層の値。session.create / session.update の
#   `effort` (low | medium | high / null=プロバイダ既定) を設定し、turn 単位では
#   session.send の effort で上書きできる。
#   写像: openai_compatible → body.reasoning_effort / anthropic → thinking.budget_tokens。
#   CLI: familiar run --effort low|medium|high / chat TUI: /effort low|medium|high|off
#   GUI: composer の「既定 ▾」チップ(chip.effort)。

# M2: fallback 連鎖(主プロバイダがストリーム開始前に失敗したら順に試す)
fallback:
  - "ollama/qwen2.5-coder:3b"

# 副タスク用モデルスロット(M3 以降)。未設定なら主対話モデルを使用
auxiliary:
  # curator:   { provider: openrouter, model: google/gemini-3-flash }
  # reviewer:  { provider: ollama, model: lfm2.5:latest }

# M3: 自己改善
memory:
  write_approval: true      # false で memory_manage が直接反映
  max_prompt_chars: 4000    # 注入合計上限(超過は新しめ順カット + memory.truncation)
skills:
  write_approval: true
  include_global: true     # ~/.agents/skills 等の共有 skills を読み取り専用で併読(既定 true)
  paths: []                # 追加で読むディレクトリ(先頭から順に。同名は familiar 側優先)
self_review:
  enabled: true             # turn 完了後に reviewer(aux) を起動して staging 提案


profiles: {}               # name → { system_prompt_file } (M2)

permissions:
  bash:
    mode: allow            # allow(既定)=ask/deny 以外は承認なしで実行 / ask=旧来の毎回承認
    allow:                 # 先頭一致 or 正規表現文字列(高速パス)
      - "^git (status|diff|log|show)"
      - "^node --version"
      - "^npm (run|test)"
    ask:                   # 承認が必要なパターン(破壊的・外部送信系)
      - "\\brm\\s+(-[a-zA-Z]+\\s+)*-[a-zA-Z]*[rR]"   # rm -r / -rf
      - "^\\s*(sudo|doas)\\b"
      - "\\bgit\\s+(push\\b.*--force|reset\\s+--hard|clean\\s+-[a-zA-Z]*f)"
      - "\\b(curl|wget)\\b[^|;]*(\\s-d\\s|--data|\\s-F\\s|--form|--upload-file)"
    deny:                  # 無条件ブロック(--yolo でも不可)
      - ">\\s*/dev/(sd|nvme|mmcblk)"     # デバイスへの上書き
      # 既定の deny には加えて、rm の /・/*・システムディレクトリそのもの(/etc 等)・
      # ~・$HOME・Windows ドライブルート、--no-preserve-root、find / -delete /
      # -exec rm、dd of=/dev/sd*、mkfs(デバイス)が入る(承認でも実行不可)
    max_timeout_ms: 600000
  files:
    bounds: cwd            # cwd | unrestricted(write/edit の系団・制限)
  webfetch:                # M2
    allow_domains: []      # ワイルドカード可(*)
    deny_domains:          # 既定で内部アドレスを拒否(SSRF 対策)
      - localhost
      - 127.*.N.1          # 実装は 127.* / ::1 / 10.* / 192.168.* / 172.16-31.* / 169.254.* を包含
  websearch:               # M2
    provider: searxng
    base_url: ""           # 例: http://127.0.0.1:8080 (未設定なら websearch ツールはエラー+ヒント)
context:
  token_soft_limit: 0      # 絶対トークン上限で圧縮をかけたい場合のみ(0 = 無効)
  keep_last: 10            # compaction で残す直近メッセージ数
  compaction:              # M4: 上限超過時の挙動
    mode: summarize        # summarize=aux 補正機(auxiliary.compactor 未設定ならメインモデル・失敗時 drop にフォールバック) / drop=伏字無しで削除
    ratio: 0.9             # モデルのコンテキストウィンドウの 90% で圧縮を発動
  max_turn_steps: 100      # 1 ターンのステップ上限。25 ステップの窓を超えても
                           # turn.continuing を出して自動継続し、この値で打ち切る
                           # (打ち切り時は turn.ceiling + 「続けて」で再開)
# 圧縮の判定は「直前ターンの実測 promptTokens」(履歴に保存)と文字数推定の大きい方を使う。
# モデルのウィンドウは models.list の結果から学習(GUI が取得済みなら即利用、未取得なら背景で取得)。

server:
  port: 46210
  bind: 127.0.0.1
  # M2 実装済み: 設定すると /rpc・/ws・UI がすべて Bearer トークンを要求する。
  # トークン本体はこのファイルに書かず、familiar token --write で
  # ~/.familiar/server.token (0600) に保存してここへ参照を書く。
  # auth_token_file: ~/.familiar/server.token

sessions:
  # store は固定で node:sqlite (`~/.familiar/state.db`)

# --- M3 以降(実装済み) ---
memory:
  write_approval: true          # 既定 ON(v1)
  max_prompt_chars: 4000        # 注入上限(実装上のキー)
skills:
  write_approval: true
  include_global: true          # ~/.agents/skills 等の共有 skills を読み取り専用で併読
  paths: []                     # 追加で読むディレクトリ(先頭から順に。同名は familiar 側優先)
self_review:
  enabled: true                 # turn 直後の reviewer
curator:
  enabled: true
  interval_hours: 168
  min_idle_hours: 2
  stale_after_days: 14
  archive_after_days: 30
  consolidate: false            # Phase-2 LLM 統合(opt-in・提案は staging 経由)

# auxiliary スロット(実装): curator / reviewer / compactor
#   reviewer 未設定 → セッションモデル / compactor 未設定 → セッションモデル /
#   curator 未設定 → default_provider
auxiliary:
  # reviewer:  { provider: ollama, model: lfm2.5:latest }
  # compactor: { provider: ollama, model: lfm2.5:latest }
  # curator:   { provider: openrouter, model: google/gemini-3-flash }

# --- M5 ---
mcp:
  servers:
    # fs: { command: npx, args: ["-y", "@modelcontextprotocol/server-filesystem", /data], read_only: true }
    #     SSH プロキシセッション用に起動コマンドを上書きする場合:
    #     remote: { command: /home/me/bin/mcp-fs, args: ["/srv/data"] }
hooks:
  # post_tool_use:
  #   - node ~/.familiar/hooks/audit.js
cron:
  jobs:
    # - { name: daily-report, every_minutes: 1440, prompt: "…" }
#   every_minutes: 0 は起動時に 1 回実行 / cron の risky 操作は即時 deny

# --- M6 ---
# SOUL.md 多段ペルソナ(設定キーではなくファイル群・読める順にすべて注入):
#   1. ~/.familiar/SOUL.md                       … 全セッション共通(最も弱い)
#   2. profiles.<p>.system_prompt_file
#      | ~/.familiar/profiles/<p>/SOUL.md        … プロファイル個別(--profile で選択)
#   3. <cwd>/.familiar/SOUL.md                   … プロジェクト固有(最も強い)
# 注入見出しは順に "# Persona instructions" / "# Profile instructions" / "# Project persona"。
lsp:
  servers:
    # typescript: { command: typescript-language-server, args: ["--stdio"], extensions: [ts, tsx, js, jsx] }
    # mock:       { command: node, args: ["mock-lsp-server.mjs"], extensions: [txt], timeout_ms: 5000 }
    # SSH プロキシセッション用の上書き: remote: { command: /path/on/host/typescript-language-server }

# アップロード添付の保持日数(0 で自動削除を無効化。セッション削除時は常に消去)
# uploads:
#   retention_days: 30

# 実行時上書き(優先: settings.json > config.yaml)
#   ~/.familiar/settings.json: { "memory_write_approval": bool, "skills_write_approval": bool }
```

## 上書き順序(優先度 高→低)

1. CLI 引数
2. `~/.familiar/config.yaml`
3. 内蔵デフォルト

検証は起動時(パース失敗で明示エラー)。未知キーは警告のみ(前方互換)。

## シークレット解決(`resolveAuthSecret`)

優先順: `auth.api_key`(即値;設定共有に向かないので非推奨)→ `auth.api_key_file` → `auth.env`。
`~` 展開対応。解決不能で provider 使用時のみエラー。(トークンはメモリ上のみで保持)

---

## リモートアクセス(他のマシンから familiar serve に接続)

既定は `127.0.0.1` バインドなので LAN からは届きません。他の Windows マシンから使うには:

```bash
# 1) トークンを発行・保存し config に有効化(サーバ側)
familiar token --write

# 2) バインドを開く(config.yaml; 特定 IP に絞るのが安全)
server:
  bind: 0.0.0.0        # または LAN の固定 IP

# 3) ポートを許可(サーバ側・管理者 PowerShell、プライベートネットのみ)
New-NetFirewallRule -DisplayName "familiar serve" -Direction Inbound -Protocol TCP -LocalPort 46210 -Action Allow -Profile Private

# 4) クライアントは http://<サーバのLAN-IP>:46210/?token=<トークン> をブラウザで開く
#    CLI の場合: familiar --server http://<LAN-IP>:46210   (トークンは config から自動付与)
```

**ポート開放を避ける方法(推奨)**: SSH トンネルなら loopback のまま使えます。

```powershell
# クライアント側
ssh -L 46210:127.0.0.1:46210 <user>@<server-host>
# その後 http://127.0.0.1:46210/  (トークンなしでよい)
```

トークンなしで `bind` を `0.0.0.0` に開けると、到達できる人が任意のシェルコマンドを実行できます
(ファイル読み書き・削除・全セッション閲覧・承認操作)。信頼できるネットワーク以外では必ず
`auth_token_file` を設定してください。通信は平文 HTTP/WS です。

### クライアント側のトークン指定

- `familiar --server http://<host>:<port>` は config の `server.auth_token_file` を読んで
  `Authorization: Bearer` を自動付与します。**サーバとホームディレクトリを共有しない
  LAN クライアントでは**、環境変数 `FAMILIAR_SERVER_TOKEN=<トークン>` を使えます
  (サーバ側とは別マシンでもよい)。ファイルが無い場合は警告のみで続行し、
  サーバが 401 を返します(サーバ側は fail-closed)。

### デスクトップアプリの SSH 接続(自動トンネル)

デスクトップ版は「設定 → 接続」で登録した SSH ホストへワンクリックで切り替えられます
(新規セッションダイアログの「実行先」からも選択可)。仕組み:

1. `ssh`(鍵/ssh-agent 前提で `BatchMode=yes`、ホスト鍵検証は既定どおり厳格)でリモートの
   `familiar serve --port 0 --bind 127.0.0.1 --print-ready --token-file <一時ファイル>` を起動。
   トークンは desktop が生成し、SSH の **stdin 経由**でリモートの 0600 一時ファイルに書く
   (argv・環境変数・ログには残らない)。
2. ready 行(`FAMILIAR_READY {json}`)から実ポートを受け取り、2 本目の SSH セッション
   (`-N -L`)でローカルの空きポートをリモート loopback に転送する。
3. ウィンドウを `http://127.0.0.1:<local>/` に切り替え、`?token=…&remote=1&new=1&cwd=…` を渡す。
   リモート UI はそのホストのセッション一覧を表示し、新規セッションダイアログを cwd 付きで開く。
4. 「ローカルに戻る」で両方の ssh を終了し、ローカルの `familiar serve` へ戻る。

- 接続プロファイルは `~/.familiar/desktop.json`(0600、秘密情報なし)。ホスト名・ユーザー・
  ポート・秘密鍵パス・リモートの `familiar` パスのみ保存します。
- リモート UI から接続の追加・編集・削除・接続テストは**できません**(ローカル UI のみ)。
  リモート側に公開されるのは「現在接続中のホスト」と「ローカルに戻る」だけです。
- 作業フォルダーに `~/…` を指定すると、リモートサーバのホームに展開されます。
- `--token-file` / `--print-ready` はこの用途のための機械可読起動オプションです。
- リモートは POSIX シェル(Linux/macOS)前提。ホスト鍵は事前に `known_hosts` に登録しておく
  必要があります。`familiar` が PATH に無い場合はプロファイルの「リモートの familiar パス」で
  絶対パスを指定(未検出時は `~/.local/bin/familiar` / `/usr/local/bin/familiar` も探索)。
- 非画像ファイルのドラッグ&ドロップは**リモートへアップロード**され(下記)、
  `@<リモートパス>` としてプロンプトに入ります。画像はそのまま添付できます。

#### SSH プロキシ方式(リモートに何もインストールしない)

接続プロファイルの「接続方式」で **SSH プロキシ** を選ぶと、リモートには familiar を
入れず、ローカルの `familiar serve` のままツール実行だけを `ssh` で行います
(Claude Code デスクトップの SSH 接続と同じ考え方)。

- `bash` / `read` / `write` / `edit` / `glob` / `grep` はセッションの ssh バックエンド
  (`packages/core/src/exec/`)経由でリモートの POSIX シェル上で実行されます。
  ツール呼び出しごとに `ssh` を起動しますが、Linux/macOS クライアントは
  ControlMaster(`~/.familiar` ではなく `$TMPDIR/familiar-ssh-mux`)で接続を多重化します。
- セッションはローカルに保存され(`session.remote` に ssh 先を記録)、GUI の
  セッションメタに `ssh: user@host` と表示されます。`task` サブエージェントにも継承されます。
- ファイル関連 RPC(`fs.list` / `fs.read` / `fs.preview` / `fs.dirs` / `fs.suggest` /
  `fs.upload`)は `session` を渡すと同じバックエンドを通ります。セッション作成前の
  リモートフォルダー閲覧は `ssh` パラメータで行います。
- **非画像ファイルの添付**: `fs.upload` がリモートの
  `<ホーム>/.familiar/uploads/<session-id>/` へ書き込み、`@<リモートパス>` を挿入します
  (familiar サーバ方式でも同じ RPC を使うため、リモート側のホームに保存されます)。
- **MCP / LSP もリモートで実行**: proxy セッションでは `mcp.servers` の各サーバーと
  `lsp.servers` の言語サーバーを **ssh 経由の stdio** で起動します(子プロセスが ssh
  クライアントになり、その stdio がリモート側プロセスの stdio になる)。ローカルとは
  別のコマンドが必要な場合は、各サーバーの `remote: { command, args, env, cwd }` で
  上書きしてください(MCP は env/cwd も指定可、LSP は command/args/cwd)。リモートに
  コマンドが無い場合、そのサーバーは起動失敗として記録されるだけです。ローカル専用の
  MCP サーバーが混ざらないよう、ローカルの `mcp__*` ツールは proxy セッションには
  広告されません。`mcp.status` は `session` を渡すとそのホストのサーバーを返します。
- **添付の後始末**: アップロードはセッション削除時に `<ホーム>/.familiar/uploads/<session>` を
  丸ごと削除します。ローカル側に残った古いファイルは `uploads.retention_days`(既定 30、
  0 で無効)で serve 起動時+6 時間ごとに自動削除されます。
- **ホスト鍵**: 接続は `StrictHostKeyChecking=yes` のため、初回はホスト鍵の登録が必要です。
  「設定 → 接続」の「🔑 ホスト鍵を確認…」が `ssh-keyscan` で鍵を取得して SHA256
  フィンガープリントを表示し、「この鍵を登録」で `~/.ssh/known_hosts` に追記します。
  **既存エントリと異なる鍵が返った場合は自動登録を拒否**します(侵害・再構築の検知)。
  ホスト名で接続する場合はその名前で登録してください(known_hosts は名前単位)。
  手動なら `ssh <host>` を一度実行して yes、または
  `ssh-keyscan <host> >> ~/.ssh/known_hosts` でも同じです。
- **認証**: 既定は鍵/ssh-agent です(`BatchMode`)。リモートに何も置かずに使いたい場合は
  接続プロファイルの「認証方式」を **パスワード** にすると、パスワードだけで接続できます
  (Claude Code デスクトップと同じ「相手側を触らない」運用)。
  - パスワードは `<familiar home>/secrets/ssh-<hash>.pass`(0600、プロバイダキーと同じ場所)に
    保存し、ssh には `SSH_ASKPASS`(一時ヘルパーがファイルを読む)経由で渡します。argv・
    環境変数・ログ・セッション DB には残りません。`NumberOfPasswordPrompts=1` で
    1 回だけ試行します(レート制限対策)。
  - 保存したくない場合は「保存したパスワードを削除」で消せます(鍵と併用も可: まず鍵を
    試し、無ければパスワード)。
  - WebUI 自体は平文 HTTP のため、パスワード入力は信頼できるネットワークでのみ行ってください。
  - 鍵を使う場合は `ssh-keygen -t ed25519` と `ssh-copy-id <user>@<host>` で配置します。
- 制約: リモートに POSIX シェルが必要です(`find` / `stat` / `base64` / `wc` を使用)。
  作業フォルダーは絶対パスで指定してください(`~` はリモートのホームに展開されます)。

#### WebUI(ブラウザ)からの接続

デスクトップアプリを使わずブラウザで `familiar serve` を開いている場合も、同じ接続
プロファイル(`~/.familiar/desktop.json` を共有)で SSH 接続できます。

- **プロファイル管理**: 「設定 → 接続」で一覧・追加・編集・削除・接続テスト(サーバ側
  RPC `conn.list/save/delete/test`)。テストは ssh で `$HOME`・hostname・`familiar` の有無を
  確認する軽量プローブです(リモートに familiar が無くても proxy のテストは通ります)。
- **SSH プロキシ方式**: そのまま利用できます(セッション作成時にサーバが ssh を実行)。
- **familiar サーバ方式**: サーバ側がトンネルを張り、`conn.connect` が `{url, token, stop}`
  を返します。WebUI はその URL(`?token=…&remote=1&stop=…&local=…`)へ遷移してリモート UI
  を表示します。
  - トンネルの待ち受けはサーバの `server.bind` に合わせます(`0.0.0.0` なら LAN の
    ブラウザからも到達可能、`127.0.0.1` なら同一マシンのブラウザのみ)。
  - リモート UI の「ローカルに戻る」は `GET /tunnel/stop?stop=<capability>` でトンネルを
    閉じてからローカルへ戻ります(推測不能な一時 ID のみを渡し、ローカルのトークンは
    リモート側に渡しません)。閉じ忘れは 12 時間の TTL で自動終了します。
  - ローカル UI に戻ると「設定 → 接続」に接続中のトンネルが表示され、手動で切断できます。
