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

# 対話 REPL
node packages/cli/dist/familiar.js chat

# サーバ単体起動(デスクトップ等の外部クライアント用)
node packages/cli/dist/familiar.js serve --port 46210
```

設定は `~/.familiar/config.yaml`。トークン等の秘密情報は `~/.familiar/*.token` ファイルか環境変数で与え、リポジトリや設定ファイルに直書きしない。

## 構成

```
packages/
  protocol/   RPC・イベント・データ型の共通定義(全クライアントで共有)
  core/       エージェントループ・ツール・プロバイダ・セッションストア
  server/     JSON-RPC over HTTP+WebSocket デーモン
  cli/        familiar コマンド(TUI/REPL・headless)
  desktop/    Electron シェル(M4 で実装)
docs/spec/    詳細仕様
```

## ロードマップ

| Phase | 内容 |
|---|---|
| M1 (現在) | agent loop + 基本ツール(read/write/edit/glob/grep/bash) + セッション永続化 + CLI |
| M2 | provider 拡張(Google など)・fallback・plan モード・権限ゲート強化 |
| M3 | memory + skills + background self-review + write_approval |
| M4 | curator + Desktop α |
| M5 | MCP / LSP / hooks・プラグイン / cron |
| M6 | v1.0(プロファイル多段エージェント等は検討) |

詳細は `docs/spec/` を参照。

## ライセンス

未定(決定時に追記)。
