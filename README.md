<div align="center">

# Familiar Harness

A client/server agent harness with a terminal UI, a Web UI and a desktop app sharing one core engine.
Inspired by OpenCode, HermEs Agent and Claude Code — **MIT licensed**, runs on Node.js 24+ (Linux / Windows / macOS).

**English** · [日本語](#日本語)

</div>

---

<a id="english"></a>

## English

### What is Familiar Harness?

`familiar serve` runs the agent core as a daemon (JSON-RPC over HTTP + WebSocket). The CLI with its OpenCode-style TUI, the Web UI, and the Electron desktop app are all thin clients of that same core — start a CLI while `serve` is alive and it attaches to it automatically.

### Highlights

- **Client/server separation** — one core engine, three frontends; sessions persist server-side in SQLite.
- **Provider abstraction** — OpenAI-compatible APIs (OpenAI / OpenRouter / NVIDIA / vLLM / llama.cpp …), Anthropic, and keyless local endpoints (Ollama, LAN LLM servers). If the configured default provider has no credentials, Familiar falls back to the first usable one automatically, so `familiar chat` works out of the box with a local model.
- **OpenCode-style TUI** — splash + frameless layout, `/models` and `/sessions` pickers, bracketed paste, CJK-IME friendly caret, in-TUI tool approvals (`y/N`), Esc to stop a turn, tok/s readouts, context sizes per model.
- **Web UI** — served by `familiar serve` (default `http://127.0.0.1:46210`): sessions, provider/model pickers, context gauge, tok/s, diff cards, settings.
- **Agent toolset** — read/write/edit, glob/grep, bash, webfetch/websearch, todos, sub-agent `task` (parallel), git worktrees, MCP servers (stdio, hot-loaded).
- **Self-improvement loop** — persistent memory, `SKILL.md` procedures with a curator (usage stats, staleness, archival), background self-review, and staged writes with human approval.
- **Safety** — every risky tool call goes through an approval adapter; `plan` mode restricts tools to read-only; secrets live in env vars or `~/.familiar/secrets/*.key`, never in config files.
- **Windows + Linux first-class** (paths, shell resolution, PowerShell support); desktop installers via electron-builder (deb / AppImage / NSIS).

### Install

Requirements: **Node.js ≥ 24** (`node --version` to check).

**Linux / macOS — one-liner** (downloads the latest release tarball, no npm needed):

```bash
curl -fsSL https://example.invalid:3000/owner/familiar-harness/raw/branch/main/install.sh | sh
```

- Installs to `~/.local/lib/familiar` and symlinks `~/.local/bin/familiar` (both overridable via `FAMILIAR_INSTALL_DIR` / `FAMILIAR_BIN_DIR`).
- The installer reads the Forgejo instance from `FAMILIAR_FORGEJO` (default `https://example.invalid:3000`) and repo from `FAMILIAR_REPO` (default `owner/familiar-harness`).
- A specific version: pass it as the first argument (`curl ... | sh -s -- 0.1.0`).

**From source (any platform):**

```bash
git clone https://example.invalid:3000/owner/familiar-harness.git
cd familiar-harness
npm install
npm run build
cd packages/cli && npm link   # puts `familiar` on your PATH
```

**Desktop app (Electron):**

```bash
npm run -w packages/desktop pack:linux   # deb + AppImage
npm run -w packages/desktop pack:win     # NSIS (run on Windows)
```

### Uninstall

**curl installer:**

```bash
rm -rf ~/.local/lib/familiar      # the application
rm -f ~/.local/bin/familiar       # the symlink
rm -rf ~/.familiar                # optional — also deletes config, session history,
                               # memory/skills and stored API keys (~/.familiar/secrets)
```

**From source (`npm link`):**

```bash
cd familiar-harness/packages/cli
npm unlink                     # removes the global `familiar` symlink
# then delete the repository checkout if you no longer need it
```

**Desktop app:** delete the AppImage file, or `sudo apt remove familiar-desktop` (deb). Windows: uninstall "Familiar Harness" from the Apps settings.

### Quick start

```bash
# full-screen TUI (opencode-style)
familiar chat

# one-shot, headless
familiar run -p "List the TODOs in this repo"

# plan mode (read-only tools)
familiar run -p "Draft an implementation plan for feature X" --plan

# pick a provider/model explicitly
familiar run -p "hi" --provider ollama --model qwen2.5-coder:3b

# Web UI + API daemon (http://127.0.0.1:46210)
familiar serve
```

In the TUI: `Ctrl+P` opens the command palette, `/models` picks provider/model, `Tab` toggles Build/Plan, `Esc` stops a running turn, `/help` lists everything.

With no API keys configured, Familiar automatically defaults to the first provider that can actually be called — a keyless local endpoint (Ollama, LAN LLM server) — so `familiar chat` works out of the box with a local model. Set `default_provider` in the config to pin it.

### Configuration

`~/.familiar/config.yaml` — providers, defaults, server settings:

```yaml
version: 1

# Optional: pin the default. When omitted, Familiar picks the first provider
# that can actually be called (key present, or keyless local endpoint).
default_provider: openai
default_model: gpt-6.1-sol

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }      # never put tokens in this file
    default_model: gpt-6.1-sol
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: { env: none }
    default_model: qwen2.5-coder:3b
```

- Secrets resolve as `api_key` → `api_key_file` → `env`; API keys set through the GUI are stored as `~/.familiar/secrets/<provider>.key` (0600) and referenced by file.
- `stream_options: false` on a provider disables the `include_usage` request (some compat servers reject it; Familiar retries without it automatically).
- Model names move fast — check your provider's model list (`/models` in the TUI, or `curl $BASE_URL/models`).
- Full reference: [docs/spec/05-config.md](docs/spec/05-config.md).

### Remote access

`familiar serve` binds to `127.0.0.1` by default — no port forwarding needed on your router. From another machine use an SSH tunnel:

```bash
ssh -L 46210:127.0.0.1:46210 user@server
# then open http://localhost:46210 locally
```

For LAN-only exposure use `familiar serve --bind 0.0.0.0` **together with** token auth (`familiar token --write`); put a TLS reverse proxy in front for anything public.

### Architecture

```
packages/
  protocol/   shared RPC + event/data types
  core/       agent loop, tools, providers, session store (UI-agnostic)
  server/     JSON-RPC over HTTP+WebSocket daemon + static Web UI
  cli/        familiar command (TUI, REPL, headless run, serve)
  desktop/    Electron shell for the same core
docs/spec/    detailed specs (architecture, protocol, tools, config, roadmap)
```

### Development

```bash
npm install
npm run build       # tsc -b (project references)
npm run typecheck
npm run smoke       # headless end-to-end with a mock provider (no network)
npm run mdtest      # markdown renderer fixtures
```

`familiar serve` keeps running the built `packages/*/dist` — restart it after code changes (static Web UI assets reload without a restart).

### Releasing (maintainers)

```bash
scripts/release.sh              # build + pack familiar-vX.Y.Z.tar.gz (dry run)
FORGEJO_TOKEN=... scripts/release.sh --publish   # create the release + upload
```

### License

[MIT](LICENSE)

---

<a id="日本語"></a>

## 日本語

[English](#english) · **日本語**

### Familiar Harness とは?

`familiar serve` がエージェントコアをデーモン化し(JSON-RPC over HTTP+WebSocket)、OpenCode 風 TUI の CLI・Web UI・Electron デスクトップアプリが**同一のコアエンジン**を共有します。`serve` が生きていれば CLI は自動で RPC 接続に切り替わり、セッションはサーバ側の SQLite に永続化されます。

### 特徴

- **client/server 分離** — 1 つのコア、3 つのフロントエンド。
- **プロバイダ抽象** — OpenAI 互換 API(OpenAI / OpenRouter / NVIDIA / vLLM / llama.cpp 等)・Anthropic・キーレスのローカルエンドポイント(Ollama、LAN 内 LLM サーバ)。既定プロバイダに認証情報が無い場合、呼び出し可能なプロバイダへ自動フォールバックするため、ローカルモデルで `familiar chat` がそのまま動きます。
- **OpenCode 風 TUI** — スプラッシュ+外枠なしレイアウト、`/models`・`/sessions` ピッカー、bracketed paste、CJK IME 対応カーソル、TUI 内ツール承認(`y/N`)、Esc でターン中断、tok/s 表示、モデル別コンテキスト長表示。
- **Web UI** — `familiar serve` が配信(既定 `http://127.0.0.1:46210`):セッション一覧、provider/model ピッカー、コンテキストゲージ、tok/s、diff カード、設定。
- **ツール群** — read/write/edit、glob/grep、bash、webfetch/websearch、todo、サブエージェント `task`(並列)、git worktree、MCP サーバ(stdio・ホットロード)。
- **自己改善ループ** — 永続 memory、`SKILL.md` 手続き+curator(使用統計・staleness・archival)、バックグラウンド自己レビュー、staging された書き込みの人間承認。
- **安全性** — 危険なツール呼び出しは必ず承認アダプタ経由。`plan` モードは読み取り専用ツールに制限。秘密情報は環境変数か `~/.familiar/secrets/*.key` に保存し、設定ファイルに直書きしない。
- **Windows + Linux 両対応**(パス・シェル解決・PowerShell 対応)。デスクトップは electron-builder でインストーラ配布(deb / AppImage / NSIS)。

### インストール

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

### アンインストール

**curl インストーラの場合:**

```bash
rm -rf ~/.local/lib/familiar      # アプリ本体
rm -f ~/.local/bin/familiar       # シンボリックリンク
rm -rf ~/.familiar                # 任意 — 設定・セッション履歴・memory/skills・
                               # 保存済み API キー(~/.familiar/secrets)も削除される
```

**ソースから(npm link)の場合:**

```bash
cd familiar-harness/packages/cli
npm unlink                     # グローバルの `familiar` シンボリックリンクを削除
# リポジトリ自体も不要なら checkout を削除
```

**デスクトップアプリ:** AppImage はファイルを削除。deb は `sudo apt remove familiar-desktop`。Windows は「アプリ設定」から Familiar Harness をアンインストールしてください。

### クイックスタート

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

API キー未設定でも、Familiar は実際に呼び出せる最初のプロバイダ(キーレスのローカルエンドポイント — Ollama や LAN 内 LLM サーバ)を自動既定にします。固定したい場合は config の `default_provider` を指定してください。

### 設定

`~/.familiar/config.yaml`:

```yaml
version: 1

# 省略可。省略時は「実際に呼び出せる」最初のプロバイダ
# (キーがある / キーレスのローカルエンドポイント)が既定になります。
default_provider: openai
default_model: gpt-6.1-sol

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }      # トークンはこのファイルに直書きしない
    default_model: gpt-6.1-sol
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: { env: none }
    default_model: qwen2.5-coder:3b
```

- 秘密情報は `api_key` → `api_key_file` → `env` の順で解決。GUI から設定した API キーは `~/.familiar/secrets/<provider>.key`(0600)に保存され、設定ファイルにはファイル参照のみ書かれます。
- `stream_options: false` で usage 取得要求(`include_usage`)を無効化(拒否する互換サーバ向け。Familiar は 400/422 時に自動で外して再試行します)。
- モデル名は移り変わりが速いため、プロバイダのモデル一覧(TUI の `/models`、または `curl $BASE_URL/models`)で最新を確認してください。
- 詳細は [docs/spec/05-config.md](docs/spec/05-config.md)。

### リモートアクセス

`familiar serve` は既定で `127.0.0.1` のみにバインドするため、ルータのポート開放は不要です。別 PC からは SSH トンネルを使います:

```bash
ssh -L 46210:127.0.0.1:46210 ユーザー名@サーバーIP
# 手元のブラウザで http://localhost:46210
```

LAN に直接公開する場合のみ `familiar serve --bind 0.0.0.0` を使い、**必ずトークン認証(`familiar token --write`)を設定**。公網にさらす場合は TLS リバースプロキシを挟んでください。

### 構成

```
packages/
  protocol/   RPC・イベント・データ型の共通定義
  core/       エージェントループ・ツール・プロバイダ・セッションストア(UI 非依存)
  server/     JSON-RPC over HTTP+WebSocket デーモン + 静的 Web UI
  cli/        familiar コマンド(TUI / REPL / headless run / serve)
  desktop/    同一コアを使う Electron シェル
docs/spec/    詳細仕様(アーキテクチャ・プロトコル・ツール・設定・ロードマップ)
```

### 開発

```bash
npm install
npm run build       # tsc -b(project references)
npm run typecheck
npm run smoke       # mock プロバイダで headless E2E(ネットワーク不要)
npm run mdtest      # markdown レンダラのフィクスチャテスト
```

`familiar serve` はビルド済み `packages/*/dist` を常駐実行するため、**コード変更(git pull 含む)は再起動まで反映されません**。Web UI の静的ファイルのみ再読み込みで反映されます。デスクトップは起動時に生存中のサーバ(46210〜46212)を再利用するため、`unknown method: ...` エラーの多くは古い serve が残っているのが原因です(アプリ完全終了 → `pkill -f "familiar.js serve"` → 再起動)。

### リリース(メンテナ向け)

```bash
scripts/release.sh                                # ビルド + tarball 生成(ドライラン)
FORGEJO_TOKEN=... scripts/release.sh --publish    # Forgejo Release 作成 + アップロード
```

### ライセンス

[MIT](LICENSE)
