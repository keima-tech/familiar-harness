# Familiar

クライアント/サーバ型のオープンなエージェントハーネス。ターミナル UI・Web UI・デスクトップアプリが**同一のコアエンジン**を共有します。
OpenCode・HermEs Agent・Claude Code を参考に設計。**MIT ライセンス**、Node.js 24+(Linux / Windows / macOS)で動作します。

英語版 README は [README.md](README.md) にあります。

## 特徴

- **client/server 分離** — `familiar serve` がエージェントコアをデーモン化(JSON-RPC over HTTP+WebSocket)。CLI / Web UI / デスクトップは薄いクライアントで、`serve` が生きていれば CLI は自動で RPC 接続に切り替わります。
- **プロバイダ抽象** — OpenAI 互換 API(OpenAI / OpenRouter / NVIDIA / vLLM / llama.cpp 等)・Anthropic・キーレスのローカルエンドポイント(Ollama、LAN 内サーバ)。既定プロバイダに認証情報が無い場合、呼び出し可能なプロバイダへ自動フォールバックします。
- **OpenCode 風 TUI** — スプラッシュ+外枠なしレイアウト、`/models`・`/sessions` ピッカー、bracketed paste、CJK IME 対応カーソル、TUI 内ツール承認(`y/N`)、Esc でターン中断、tok/s 表示。
- **Web UI** — `familiar serve` が配信(既定 `http://127.0.0.1:46210`):セッション一覧、provider/model ピッカー、コンテキストゲージ、tok/s、diff カード。
- **ツール群** — read/write/edit、glob/grep、bash、webfetch/websearch、todo、サブエージェント `task`(並列)、git worktree、MCP サーバ(stdio・ホットロード)。
- **自己改善ループ** — 永続 memory、`SKILL.md` 手続き+curator(使用統計・staleness・archival)、バックグラウンド自己レビュー、staging された書き込みの人間承認。
- **安全性** — 危険なツール呼び出しは必ず承認アダプタ経由。`plan` モードは読み取り専用ツイルに制限。秘密情報は環境変数か `~/.familiar/secrets/*.key` に保存し、設定ファイルに直書きしない。
- **Windows + Linux 両対応**(パス・シェル解決・PowerShell対応)。デスクトップは electron-builder でインストーラ配布(deb / AppImage / NSIS)。

## インストール

要件:**Node.js ≥ 24**(`node --version` で確認)。

**Linux / macOS — ワンライナー**(最新リリースの tarball を取得。npm 不要):

```bash
curl -fsSL https://example.invalid:3000/owner/familiar-harness/raw/branch/main/install.sh | sh
```

- `~/.local/lib/familiar` へ展開し、`~/.local/bin/familiar` にシンボリックリンクを作成(`FAMILIAR_INSTALL_DIR` / `FAMILIAR_BIN_DIR` で変更可)。
- 接続先 Forgejo は `FAMILIAR_FORGEJO`(既定 `https://example.invalid:3000`)・リポジトリは `FAMILIAR_REPO`(既定 `owner/familiar-harness`)で変更できます。
- バージョン指定:`curl ... | sh -s -- 0.1.0` のように引数で渡します。

**ソースから(全プラットフォーム):**

```bash
git clone https://example.invalid:3000/owner/familiar-harness.git
cd familiar-harness
npm install
npm run build
cd packages/cli && npm link   # `familiar` コマンドを PATH に登録
```

**デスクトップアプリ(Electron):**

```bash
npm run -w packages/desktop pack:linux   # deb + AppImage
npm run -w packages/desktop pack:win     # NSIS(Windows 上で実行)
```

## クイックスタート

```bash
# フルスクリーン TUI(opencode 風)
familiar chat

# ワンショット実行(ヘッドレス)
familiar run -p "このリポジトリの TODO を列挙して"

# 計画モード(読み取り専用ツール)
familiar run -p "新機能の実装計画を出して" --plan

# プロバイダ/モデルを明示
familiar run -p "hi" --provider ollama --model qwen2.5-coder:3b

# Web UI + API デーモン(http://127.0.0.1:46210)
familiar serve
```

TUI 操作:`Ctrl+P` コマンドパレット / `/models` モデル選択 / `Tab` Build⇔Plan / `Esc` ターン中断 / `/help` 一覧。

API キー未設定でも、Familiar は実際に呼び出せる最初のプロバイダ(キーレスのローカルエンドポイント — Ollama や LAN 内 LLM サーバ)を自動既定にするため、ローカルモデルで `familiar chat` がそのまま動きます。固定したい場合は config の `default_provider` を指定してください。

## 設定

`~/.familiar/config.yaml`:

```yaml
version: 1

# 省略可。省略時は「実際に呼び出せる」最初のプロバイダ
# (キーがある / キーレスのローカルエンドポイント)が既定になります。
default_provider: openai
default_model: gpt-5.2

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }      # トークンはこのファイルに直書きしない
    default_model: gpt-5.2
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: { env: none }
    default_model: qwen2.5-coder:3b
```

- 秘密情報は `api_key` → `api_key_file` → `env` の順で解決。GUI から設定した API キーは `~/.familiar/secrets/<provider>.key`(0600)に保存され、設定ファイルにはファイル参照のみ書かれます。
- `stream_options: false` で usage 取得要求(`include_usage`)を無効化(拒否する互換サーバ向け。Familiar は 400/422 時に自動で外して再試行します)。
- 詳細は [docs/spec/05-config.md](docs/spec/05-config.md)。

## リモートアクセス

`familiar serve` は既定で `127.0.0.1` のみにバインドするため、ルータのポート開放は不要です。別 PC からは SSH トンネルを使います:

```bash
ssh -L 46210:127.0.0.1:46210 ユーザー名@サーバーIP
# 手元のブラウザで http://localhost:46210
```

LAN に直接公開する場合のみ `familiar serve --bind 0.0.0.0` を使い、**必ずトークン認証(`familiar token --write`)を設定**。公網にさらす場合は TLS リバースプロキシを挟んでください。

## サーバの再起動(変更を反映するには)

`familiar serve` はビルド済み `packages/*/dist` を常駐実行するため、**コア・サーバ側のコード変更(git pull 含む)は再起動まで反映されません**。Web UI の静的ファイル(`packages/server/public/`)だけは再読み込みのみで反映されます。

```bash
npm run build
pkill -f "familiar.js serve"
familiar serve --port 46210
```

デスクトップ(Electron)は起動時に生存中のサーバ(46210〜46212)を**再利用**するため、アプリ再起動だけでは古い serve を使い続けます。`unknown method: ...` エラーの多くはこれが原因です。アプリを完全に終了 → `pgrep -af "familiar.js serve"` で確認 → 残っていれば `pkill -f "familiar.js serve"` → 再起動。

Windows PowerShell の場合:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*familiar.js serve*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

## 構成

```
packages/
  protocol/   RPC・イベント・データ型の共通定義
  core/       エージェントループ・ツール・プロバイダ・セッションストア(UI 非依存)
  server/     JSON-RPC over HTTP+WebSocket デーモン + 静的 Web UI
  cli/        familiar コマンド(TUI / REPL / headless run / serve)
  desktop/    同一コアを使う Electron シェル
docs/spec/    詳細仕様(アーキテクチャ・プロトコル・ツール・設定・ロードマップ)
```

## 開発

```bash
npm install
npm run build       # tsc -b(project references)
npm run typecheck
npm run smoke       # mock プロバイダで headless E2E(ネットワーク不要)
npm run mdtest      # markdown レンダラのフィクスチャテスト
```

## リリース(メンテナ向け)

```bash
scripts/release.sh                                # ビルド + tarball 生成(ドライラン)
FORGEJO_TOKEN=... scripts/release.sh --publish    # Forgejo Release 作成 + アップロード
```

## ライセンス

[MIT](LICENSE)
