# 06 — ロードマップ

ステータス: 確定 / 最終更新: 2026-10-17

| Phase | 内容 | 状態 |
|---|---|---|
| M0 | spec fix / リポジトリ初期化 | 完了 |
| **M1** | **agent loop + 基本ツール(read/write/edit/glob/grep/bash) + SQLite セッション + CLI(run -p / chat / serve / sessions / model list / init / doctor) + mock provider スモーク** | **実装中** |
| M2 | provider 拡張(Google)・fallback 連鎖・plan モード・権限ゲート強化(動的承認 RPC)・CLI→サーバ自動接続・worktree 対応・webfetch/websearch/todo/task | 未着手 |
| M3 | memory + skills + background self-review + write_approval(自己改善ループ第1版)・compaction 要約(aux) | 未着手 |
| M4 | curator(自動遷移 + opt-in consolidation) + Desktop α(Electron・承認 Inbox・ツール diff 表示) | 未着手 |
| M5 | MCP / LSP / hooks・プラグイン / cron・定期実行 | 未着手 |
| M6 | v1.0: プロファイル(SOUL.md 多段)、配布(npm/バイナリ)、テスト拡充(e2e)、docs | 未着手 |

## M1 の完了条件(DoD)

- [x] `npm run build` / `typecheck` が成功
- [x] `npm run smoke`(mock provider, tool 呼出し含む)が通る
- [x] Ollama ローカルモデルでの手動 e2e(run -p で read ツール使用)
- [x] Windows 上のビルドは M4 前に検証(CI 追加は M2)

## 技術的リスクと対策

| リスク | 対策 |
|---|---|
| node:sqlite の実験的 API 変更 | SessionStore インターフェースを分離(差し替え可能) |
| SSE パース差異(openai/anthropic/ollama) | プロバイダ単位のテスト fixture + mock provider |
| node-pty 未使用(M1) | bash 工具はコマンド完了型のみ。PTY 必要な用途は M2 検討 |
| Desktop の Linux IME | Electron 選定で回避(Tauri 可否は M4 再評価) |
