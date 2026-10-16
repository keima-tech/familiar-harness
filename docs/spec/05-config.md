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

server:
  port: 46210
  bind: 127.0.0.1
  # auth_token_file: ~/.familiar/server.token   (M2)

sessions:
  # store は固定で node:sqlite (`~/.familiar/state.db`)

# --- M3 以降 ---
memory:
  enabled: true
  write_approval: true          # 既定 ON(v1)
  namespaces: [user, project]   # user= ~/.familiar/memories, project= <cwd>/.familiar/memory
skills:
  enabled: true
  write_approval: true
curator:
  enabled: true
  interval_hours: 168
  min_idle_hours: 2
  stale_after_days: 14
  archive_after_days: 30
  consolidate: false
  prune_builtins: false
display:
  memory_notifications: true    # 自己改善の書き込み通知を表示
```

## 上書き順序(優先度 高→低)

1. CLI 引数
2. `~/.familiar/config.yaml`
3. 内蔵デフォルト

検証は起動時(パース失敗で明示エラー)。未知キーは警告のみ(前方互換)。

## シークレット解決(`resolveAuthSecret`)

優先順: `auth.api_key`(即値;設定共有に向かないので非推奨)→ `auth.api_key_file` → `auth.env`。
`~` 展開対応。解決不能で provider 使用時のみエラー。(トークンはメモリ上のみで保持)
