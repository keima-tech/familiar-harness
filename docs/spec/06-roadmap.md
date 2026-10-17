# 06 — ロードマップ

ステータス: 確定 / 最終更新: 2026-10-17

| Phase | 内容 | 状態 |
|---|---|---|
| M0 | spec fix / リポジトリ初期化 | 完了 |
| M1 | agent loop + 基本ツール(read/write/edit/glob/grep/bash) + SQLite セッション + CLI(run -p / chat / serve / sessions / model list / init / doctor) + mock provider スモーク | 完了 |
| **M2** | **Google provider・fallback 連鎖・plan モード・動的承認 RPC(permission.request/respond + CLI リモートモード)・webfetch/websearch/todo/task・worktree コマンド** | **完了 ✅** |
| **M3** | **memory + skills + background self-review + write_approval(自己改善ループ第1版)** — staging/CAS・usage 統計・lint・`familiar memory|skills` コマンド・`improvement.staged`/`memory.truncation` イベント ✅(compaction 要約(aux)は簡易 drop 版のまま、要約版は M4 へ繰り越し) | **完了 ✅** |
| M3 | memory + skills + background self-review + write_approval(自己改善ループ第1版) ✅ |
| M4 | compaction 要約(aux)・curator(Phase1 自動遷移 + opt-in 統合 + ledger/snapshot + scheduler)・Web UI(`familiar serve` が同一ポートで静的配信)・**Desktop α(Electron シェル: serve を spawn/検出して Web UI を読み込む)** ✅(electron-builder によるインストーラは M6) |
| M5 | **MCP(stdio 動的ツール・依存ゼロ実装)・hooks(session_start / pre|post_tool_use / turn_complete)・cron 定期実行(serve 内スケジューラ・boot 実行も可)・task 並列化(同一メッセージ内の複数 task を同時実行)** ✅ — LSP と独立プラグイン API は M6 へ繰り越し(v1 製品スコープで hooks + MCP が実用プラグイン面を担う) |
| M6 | v1.0: プロファイル(SOUL.md 多段)、**配布: electron-builder によるインストーラ(Windows: NSIS / Linux: deb・AppImage)**、テスト拡充(e2e)、docs | 未着手 |

## デスクトップ配布の正式要件(2026-10-17 ユーザー確定)

- 最終形は **インストーラ形式のデスクトップアプリ**(Windows / Linux 双対応)。
- パッケージング: electron-builder(Windows: NSIS、Linux: deb / AppImage)。コード署名は未定。
- Desktop は薄クライアント(`familiar serve` RPC)以免責のため InProcess で `familiar serve` をサイレント起動して接続(全自動)。
- Web UI は Desktop と同一の型を流用した SPA(`familiar serve` から配信、port 46210)。

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
