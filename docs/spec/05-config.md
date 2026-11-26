# 05 — 設定リファレンス(~/.familiar/config.yaml)

ステータス: 確定 / 最終更新: 2026-11-23

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
      # ここに書いたリストは組み込みと union(追加のみ)。1つ足しても既定の保護は消えない。
    max_timeout_ms: 600000
  files:
    bounds: cwd            # cwd | unrestricted。cwd はセッションフォルダ内の
                           # 読み書きを自由、外側をゲートする
    read: ask              # ask | allow | deny。bounds 外の read/glob/grep の扱い
                           # (ask=承認、allow=素通し、deny=常時ブロック)。
                           # 外側への write/edit は従来どおり approveWrite が承認
  webfetch:                # M2
    allow_domains: []      # ワイルドカード可(*)
    deny_domains:          # 既定で内部アドレスを拒否(SSRF 対策)
      - localhost
      - 127.*.N.1          # 実装は 127.* / ::1 / 10.* / 192.168.* / 172.16-31.* / 169.254.* を包含
  websearch:               # M2
    provider: duckduckgo   # 既定。API キー・追加設定なしで利用可
    base_url: ""           # SearXNG 利用時のみ。例: http://127.0.0.1:8080
                           # provider: searxng で base_url 空ならエラー+ヒント。
                           # 「設定 → Web検索」からも変更可。
                           # 手編集で不正な値の場合は起動時に警告し DuckDuckGo へ戻す。
budget:                    # トークン予算ガード(全 0 = 無効)
  max_tokens_per_session: 0 # 1 セッションの上限(例 2000000)
  max_tokens_per_day: 0     # 1 日(UTC)合計の上限(例 10000000)
  warn_ratio: 0.8           # 上限の何割で警告イベントを出すか(0 で無効)
  enforce: false            # true: 上限超過後の新規ターンを拒否
pricing:                   # ターン毎のコスト概算(USD / 100万トークン)。キーは
                           # "provider/model" → "provider" → "model" の順で一致
  "openai/gpt-6.1-sol": { input: 1.25, output: 10 }   # 例
privacy:
  local_only: false        # true: 非ローカル provider への送信を拒否
                           # (mock / localhost / 127.0.0.1 / ::1 / *.local のみ許可)
context:
  token_soft_limit: 0      # 絶対トークン上限で圧縮をかけたい場合のみ(0 = 無効)
  keep_last: 10            # compaction で残す直近メッセージ数
  compaction:              # M4: 上限超過時の挙動
    mode: summarize        # summarize=aux 補正機(auxiliary.compactor 未設定ならメインモデル・失敗時 drop にフォールバック) / drop=伏字無しで削除
    ratio: 0.9             # モデルのコンテキストウィンドウの 90% で圧縮を発動
  tool_result:             # 大きいツール結果の圧縮(OpenHuman の RLM 相当)
    threshold_chars: 12000 # これより長い結果を head/tail ダイジェスト+handle に置換(0=無効)
    head_chars: 3000       # 先頭を残す文字数
    tail_chars: 1500       # 末尾を残す文字数
    # 全文は session DB に保存され、モデルは result_read(handle, offset, limit) /
    # result_search(handle, pattern) で必要な断片だけ取得する(捨てない)
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
  ranking: relevance            # relevance=現在の指示との関連度→新しい順 / recent=新しい順のみ
                                # 関連度はキーワード重なり(英数字語 + CJK 2-gram)で採点
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
#   3. <cwd>/.familiar/SOUL.md                   … プロジェクト固有(ペルソナ内で最も強い)
# 注入見出しは順に "# Persona instructions" / "# Profile instructions" / "# Project persona"。
# MEMORY.md(ユーザー所有・手動編集。エージェントは自動書き込みしない):
#   ~/.familiar/MEMORY.md        … 全セッションの毎ターンに注入
#   <cwd>/.familiar/MEMORY.md    … その cwd のセッションのみ(後勝ち)
# JSON の memory store(承認制・関連度ランキング付き)とは別に併用する。
# ペルソナ層より後に注入され、JSON memory より後ろ(最終勝ち)になる。
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

## プロバイダーのブランドマーク表示

Web UI / Desktop のプロバイダー選択では、設定画面の「接続済み」「接続候補」、composer の
モデル選択ピッカーの provider グループ見出し、選択中の model チップにブランドマークを表示する。
provider 名・model 名はマークと併記し、装飾用の SVG 自体はスクリーンリーダーから隠す。

- 既知の組み込み ID は `openai` / `anthropic` / `google` / `nvidia` / `openrouter` / `ollama`。
  各ブランド形状を 24×24 のローカル埋め込み SVG path として保持する。
- 判定優先順位は「既知 ID」→「実効エンドポイント」→「中立フォールバック」とする。
  既知 ID はユーザーが明示した provider 名なので、`base_url` が変更されても ID を優先する。
- 独自 ID の実効エンドポイントは、設定された `base_url` を使う。`base_url` 未指定時は
  kind の既定 URL (`openai_compatible` = `https://api.openai.com/v1`、
  `anthropic` = `https://api.anthropic.com/v1`) を使う。
- 実効エンドポイントが既知のホスト
  (`api.openai.com` / `api.anthropic.com` / `generativelanguage.googleapis.com` /
  `integrate.api.nvidia.com` / `openrouter.ai`) に一致する場合は、そのブランドとして表示する。
  ローカル Ollama は `localhost` / `127.0.0.1` / `::1` のポート `11434` を判定する。
- ID と実効エンドポイントの両方から判定できないカスタム provider は、名称先頭文字の中立的な
  モノグラムへフォールバックする。provider 名の表示は変更しない。
- マークはアプリへローカル埋め込みし、CDN や外部 API を参照しない。path data は
  Simple Icons (CC0 1.0) 由来のブランド形状であり、各ブランド商標の権利は各提供者に帰属する。
- 回帰テストは、既知 ID、独自 ID + 実効エンドポイント、不明 provider のフォールバックを
  DOM 非依存の単体テストで検証し、Electron の実 DOM テストで設定画面・モデル選択 UI・
  選択中 model チップへの描画とアクセシビリティ属性を検証する。

## 設定画面のスキル／コネクタ構成

設定画面のナビゲーションは、機能ごとに独立した項目として管理する。

- **スキル**: `skills.list` / `skills.view` / `skills.save` / `skills.delete` による
  スキルの一覧・作成・編集・削除・一括削除を管理する。Familiar 管理外ルートの
  スキルは従来どおり読み取り専用で、選択・編集・削除の対象にしない。
- **コネクタ**: 外部サービス(Gmail / Calendar、GitHub、GitLab、Backlog、Notion、Slack、
  Microsoft Teams、Discord、Jira、Confluence、Redmine)の接続設定に加えて、
  **MCP サーバー**と **LSP サーバー**を管理する。
  - MCP は `mcp.status` で現在のセッションに対応するサーバーの状態・公開ツール数・
    再接続回数・最終成功時刻を表示し、`mcp.restart` で再接続する。SSH プロキシ
    セッションでは接続先ホストの状態を表示する。追加・編集・削除は GUI の
    `mcp.servers.set` / `mcp.servers.delete` から行い、config.yaml へ永続化したうえで
    稼働中の MCP ハブを再構築して即時反映する。
  - LSP はサニタイズ済み `config.get` の `lsp.servers` を表示する。有効／無効と
    対象の拡張子を一覧し、`lsp.servers.set` / `lsp.servers.delete` で追加・編集・
    削除できる。LSP ハブは設定の変更を検出して再構築する。
- **Web検索**: `permissions.websearch` の provider / SearXNG エンドポイントを編集する
  独立した設定項目(DuckDuckGo が既定)。「権限」には bash ポリシーのみを残す。
- **メモリ**: `~/.familiar/MEMORY.md` を設定画面から編集する。決定事項・前提を
  人間が管理するファイルで、エージェントは自動更新しない(毎ターン注入)。
- 旧 **拡張機能** 項目は、内容を上記2項目へ移設したため廃止する。スキル作成完了の
  メッセージから「拡張機能」への案内も、それぞれ「設定 → スキル」へ更新する。

MCP / LSP と外部サービスの設定は、同じ「コネクタ」画面に連続して表示する。ただし
MCP / LSP は共通の枠と「サーバー」見出しでまとめた専用セクションとし、外部サービスは
別見出しの「外部サービス」セクションに分けて表示する。すべての外部サービスカードは
`services` グループに含め、`servers` グループへ混在させない。外部サービスカードの見出しは
GitHub / GitLab / Jira などの公式表記(大小文字の混在)を保持し、CSS で強制大文字化しない。
MCP / LSP の状態取得は外部サービスの
フォームと独立して実行し、MCP の起動確認が遅延しても Gmail / GitHub 等の接続設定を
表示・操作できるようにする。サーバー名が長い場合は狭い画面でも折り返し、再接続ボタンが
枠外へ押し出されないようにする。ナビゲーション項目は `skills` と `connectors` の ID を持ち、
UI テストや回帰テストは表示文言ではなくこの ID、および枠の `servers` / `services` ID を
基準に判定する。構造判定は ID を基準とし、文言の同期は別途テキストアサートで検証する。

サーバー設定の編集フォームでは、MCP は名前・コマンド・引数・環境変数・タイムアウト・
読み取り専用／無効フラグ、LSP は名前・コマンド・引数・拡張子・タイムアウト・無効フラグを
扱う。`remote` 上書きと `cwd` は GUI では編集せず、保存時にディスク上の既存値を保持する
(詳細設定は config.yaml で編集する)。`config.get` は MCP / LSP の `env` 値も
`"***"` へマスクし、GUI がその値をそのまま保存した場合は元の値を保持する。
シークレット値を API 応答やログへ出力してはならない。GUI のチェック解除や入力クリアは
明示的な `false` / `[]` / `null` として送り、config.yaml から該当キーを削除する
(マージで古い値が残らないようにする)。SSH プロキシ用の MCP ハブはホストごとに
設定スナップショットを保持し、設定変更後の次回アクセスで再構築する。

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
  `fs.upload` / `fs.rename` / `fs.delete`)は `session` を渡すと同じバックエンドを通ります。
  `fs.rename` は同一ディレクトリ内の改名のみ(区切り文字を含む名前は拒否、既存先は上書き
  しない)、`fs.delete` は再帰削除で、どちらもファイルシステムのルートとホームを保護します。
  `fs.preview` は
  画像/音声/動画/PDF/Markdown/テキストに加え、**CSV/TSV(表)・JSON(整形)・
  Office(docx/xlsx/pptx を OOXML から抽出)** のプレビューを返します。セッション作成前の
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
