# Familiar

クライアント/サーバ型のオープンなエージェントハーネス。
OpenCode・Hermes Agent・Claude Code を参考に設計し、**CLI とデスクトップアプリが同一のコアエンジンを共有する**構成を目指します。

## 特徴(計画)

- **client/server 分離**: `familiar-server`(エージェントコア)をデーモン化し、CLI / Desktop は両方薄いクライアントとして接続(JSON-RPC + ストリーミング)
- **プロバイダ抽象**: OpenAI 互換 API(OpenAI / OpenRouter / Ollama / LM Studio 等)・Anthropic・mock(テスト用)。fallback + aux(副タスク)モデル分離
- **自己改善ループ**(Hermes Agent 方式を移植):
  - memory: 常時コンテキストに載る小さな事実
  - skills: 関連時のみロードする手続き(SKILL.md、`skill_manage`、リンタ)
  - background self-review: ターン毎に内省し memory/skill への書き込み案を生成
  - write_approval: 全書き込みを staging して人間が承認(既定 ON)
  - curator: スキルの使用統計・staleness・archival・統合をバックグラウンドで保守
- **Windows / Linux 両対応**を全マイルストーンの前提として設計

## クイックスタート(開発)

```bash
npm install
npm run build

# ヘッドレス実行(mock プロバイダ、ネットワーク不要)
node packages/cli/dist/familiar.js run -p "hello" --provider mock

# ローカル LLM(Ollama)で実行
node packages/cli/dist/familiar.js run -p "ファイル一覧を教えて" --provider ollama --model qwen2.5-coder:3b -y

# 計画モード(読み取り専用ツールで設計だけ行う)
node packages/cli/dist/familiar.js run -p "新機能の実装計画を出して" --plan

# 対話 REPL
node packages/cli/dist/familiar.js chat

# サーバ単体起動(デスクトップ等の外部クライアント用)
node packages/cli/dist/familiar.js serve --port 46210

# 別ターミナルの CLI は、serve が生きていれば自動で RPC 経由に接続(リモートモード)
node packages/cli/dist/familiar.js run -p "ping" --json

# git worktree の作成・一覧・削除
node packages/cli/dist/familiar.js worktree add my-feature
```

設定は `~/.familiar/config.yaml`。トークン等の秘密情報は `~/.familiar/*.token` ファイルか環境変数で与え、リポジトリや設定ファイルに直書きしない。

M2 で利用できる周辺機能: `webfetch` / `websearch`(要 SearXNG 設定)/ セッション todo / `task`(サブエージェント委任)。`familiar serve` では承認要求が `permission.request` イベントとして WS に流れ、クライアントの `permission.respond` で続行/拒否する。

## 構成

```
packages/
  protocol/   RPC・イベント・データ型の共通定義(全クライアントで共有)
  core/       エージェントループ・ツール・プロバイダ・セッションストア
  server/     JSON-RPC over HTTP+WebSocket デーモン
  cli/        familiar コマンド(TUI/REPL・headless)
  desktop/    Electron シェル(M4 で実装・インストーラ形式で配布)
docs/spec/    詳細仕様
```

## ロードマップ

| Phase | 内容 |
|---|---|
| M1 | agent loop + 基本ツール(read/write/edit/glob/grep/bash) + セッション永続化 + CLI ✅ |
| M2 | Google provider・fallback 連鎖・plan モード・動的承認 RPC・CLI リモート接続・webfetch/websearch/todo/task・worktree ✅ |
| M3 | memory + skills + background self-review + write_approval ✅ |
| M4 (現在) | compaction 要約・curator・Web UI(`familiar serve` 静的配信)・Desktop α(Electron) ✅ |
| M5 | MCP / LSP / hooks・プラグイン / cron |
| M6 | v1.0(配布: electron-builder によるインストーラ。Windows: NSIS / Linux: deb・AppImage) |

詳細は `docs/spec/` を参照。

## ライセンス

未定(決定時に追記)。
