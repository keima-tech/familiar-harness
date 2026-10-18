# 05 — 設定リファレンス(~/.familiar/config.yaml)

ステータス: 確定 / 最終更新: 2026-10-17

初回起動時にテンプレートを自動生成する(`familiar init`; 存在時は上書きしない)。
シークレットをこのファイルに書かないこと(ファイル参照 or 環境変数)。

```yaml
version: 1

default_provider: openai      # ollama / anthropic / openrouter / mock / ...
default_model: "gpt-5.2"      # provider 別の未指定時に使用(e.g. ollama: qwen2.5-coder:3b)

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
  mock:
    kind: mock

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
self_review:
  enabled: true             # turn 完了後に reviewer(aux) を起動して staging 提案


profiles: {}               # name → { system_prompt_file } (M2)

permissions:
  bash:
    allow:                 # 先頭一致 or 正規表現文字列
      - "^git (status|diff|log|show)"
      - "^node --version"
      - "^npm (run|test)"
    deny:
      - "^sudo"
      - "rm -rf"
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
  token_soft_limit: 81920  # 推定(chars/4)超過で compaction ガード発動
  keep_last: 10            # compaction で残す直近メッセージ数
  compaction:              # M4: 上限超過時の挙動
    mode: summarize        # summarize=aux 補正機(auxiliary.compactor 未設定ならメインモデル・失敗時 drop にフォールバック) / drop=伏字無しで削除

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
