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

## サーバの再起動(変更を反映するには)

`familiar serve` はビルド済み `packages/*/dist` を常駐実行するため、**コア・サーバ側のコード変更(git pull 含む)は再起動するまで反映されない**。UI の静的ファイル(`packages/server/public/` の HTML/CSS/JS)だけの変更は、ブラウザ(またはデスクトップ)の**再読み込みのみ**で反映され、再起動は不要です。

反映の手順:

```bash
npm run build          # tsc -b で packages/*/dist を更新
```

**`familiar serve` を手動起動している場合**

```bash
# 起動中ターミナルで Ctrl+C してから、または:
pkill -f "familiar.js serve"
node packages/cli/dist/familiar.js serve --port 46210
```

**デスクトップ(Electron)を利用している場合**

デスクトップは起動時に生存中のサーバ(ポート 46210〜46212)を**再利用**するため、アプリの再起動だけでは古い serve プロセスを使い続けてしまう点に注意。`unknown method: ...` のようなエラーは、たいていこの「古い serve が残っている」状態が原因。

1. デスクトップアプリを完全に終了
2. 残っている serve プロセスを確認・停止:
   ```bash
   pgrep -af "familiar.js serve"      # 一覧
   pkill -f "familiar.js serve"       # 残っていれば停止
   ```
3. デスクトップを再起動(新しい `dist` で serve が spawn される)

Windows の PowerShell では `pkill` の代わりに次で該当プロセスを停止できる(またはタスクマネージャで `node` / `electron` を終了):

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*familiar.js serve*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

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
| M4 | compaction 要約・curator・Web UI(`familiar serve` 静的配信)・Desktop α(Electron) ✅ |
| M5 | MCP(stdio 動的ツール)・hooks・cron 定期実行・task 並列化 ✅ |
| M6 (**v1.0**) | SOUL.md 多段プロファイル・LSP `lsp_diagnostics`・Web UI v1.0(セッション削除・provider/model/profile ピッカー・ステータスドロワー)・electron-builder インストーラ(deb / AppImage 実装済み・NSIS 設定込み)・smoke N/O ✅ |

デスクトップのインストーラは `npm run -w packages/desktop pack:linux`(deb + AppImage) /
`pack:win`(NSIS・Windows 製機で実行)でビルドできます。

詳細は `docs/spec/` を参照。

## ライセンス

未定(決定時に追記)。
