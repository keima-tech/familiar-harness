<div align="center">

# Familiar Harness

セルフホスト型のコーディングエージェント。1 つのコアエンジンに TUI・Web UI・デスクトップアプリ。
**MIT** · Node.js 24+ · Linux / Windows / macOS

[English README](README.md)

</div>

---

## これは何か

Familiar はモデルをツールループ(read/write/edit、bash、glob/grep、MCP サーバ、サブエージェント)で動かし、セッションを SQLite に保存します。`familiar serve` はそのコアをデーモン(JSON-RPC over HTTP + WebSocket)として公開し、TUI・ブラウザ UI・デスクトップアプリはそのクライアントです。どれかで開いたセッションは、他のフロントからも同じ状態で見えます。

各ターンの後、別のエージェントがそのターンをレビューし、長く効く教訓を提案します。提案は staging され、承認したときだけ反映されます。

## クイックスタート

Node.js 24+ が必要です。

```bash
# Linux / macOS
curl -fsSL https://example.invalid:3000/owner/familiar-harness/raw/branch/main/install.sh | sh
```

```bash
familiar            # フルスクリーン TUI
familiar run -p "このリポジトリの TODO を列挙して"
familiar serve      # Web UI + JSON-RPC(http://127.0.0.1:46210)
familiar demo       # 自己改善ループのオフライン実演(API キー不要)
```

API キーが未設定なら、実際に呼べる最初のプロバイダ(既定では Ollama などの keyless なローカル端点)を使います。固定したい場合は `~/.familiar/config.yaml` に書きます。

TUI 内では `Ctrl+P` がコマンドパレット、`/models` がプロバイダ/モデル選択、`Tab` が plan/build、`Esc` が実行中ターンの停止、`/help` が一覧です。

## 自己改善ループ

1. ターンが終わる。
2. レビュアーエージェントが内容を読み、**memory**(毎回ロードする価値のある事実)か **skill**(必要時にだけロードする手続き)を提案する。
3. 提案は staging される(`familiar memory pending` / `familiar skills pending`)。`familiar memory approve <id>` / `familiar skills approve <id>` で初めて反映される。
4. 次のターンのプロンプトには承認済み memory が入り、skill はタスクが一致したときにロードされる。

curator が未使用の skill を `active → stale → archived` と遷移させ、すべての変更を ledger に追記し、統合の前に skill ツリーの snapshot を取ります(`familiar curator rollback <id>`)。`familiar demo` はこの一連の流れを、使い捨てのホームディレクトリでオフライン実行します。

## 機能

- **承認。** 危険なツール呼び出しは承認アダプタを通ります。`--plan` は読み取り専用ツールに制限します。マシンを消し得るコマンドは承認の有無にかかわらず拒否します。
- **プロバイダ。** OpenAI 互換 API(OpenAI、OpenRouter、NVIDIA、vLLM、llama.cpp など)、Anthropic、keyless なローカル端点。
- **フロントエンド。** フルスクリーン TUI。Web UI はセッション一覧、モデル選択、diff カード、権限モード、コンテキストゲージ、ファイルプレビュー(画像・音声・動画・PDF・Markdown・CSV/JSON・Word/Excel/PowerPoint)。デスクトップアプリは deb / AppImage / NSIS。
- **リモートマシン。** SSH プロキシは相手側に何もインストールせずに bash とファイル系ツールを実行します(MCP サーバ・言語サーバも同様)。相手先でデーモンを起動し、アプリをそこへ向けることもできます。
- **コンテキストとコスト。** ターン毎のトークン内訳、USD 概算、トークン予算ガード、大きいツール結果の圧縮。
- **オフィス文書。** 追加依存なしで Word / Excel / PowerPoint を生成。
- **小さい構成。** `yaml` + `ws`、保存は Node 内蔵の `node:sqlite`。ネイティブモジュールなし。

## インストール

### インストーラ(Linux / macOS)

```bash
curl -fsSL https://example.invalid:3000/owner/familiar-harness/raw/branch/main/install.sh | sh
```

`~/.local/lib/familiar` に展開し、`~/.local/bin/familiar` にシンボリックリンクを作ります(どちらも `FAMILIAR_INSTALL_DIR` / `FAMILIAR_BIN_DIR` で変更可)。バージョン指定は `curl … | sh -s -- 0.1.0`。

### ソースから(全プラットフォーム)

```bash
git clone https://example.invalid:3000/owner/familiar-harness.git
cd familiar-harness
npm install
npm run build
cd packages/cli && npm link   # `familiar` が PATH に入る
```

Windows ではソースからのインストール、または下記のデスクトップ版を使います。

### デスクトップアプリ

各 [release](https://example.invalid:3000/owner/familiar-harness/releases) にバイナリがあります:
`familiar-<version>-linux-amd64.deb`、`familiar-<version>-linux-x86_64.AppImage`、
`familiar-<version>-win-x64.exe`(NSIS)、`familiar-<version>-win-x64-portable.exe`。

```bash
npm run -w packages/desktop pack:linux   # deb + AppImage
npm run -w packages/desktop pack:win     # NSIS(Linux でクロスビルドする場合は wine が必要)
```

### 更新と削除

`familiar update` が最新のリリース tarball を取得して差し替えます(`--check` で確認のみ)。checkout から使う場合は `git pull && npm run build`。

```bash
# インストーラで入れた場合の削除
systemctl --user disable --now familiar-serve 2>/dev/null
rm -f ~/.config/systemd/user/familiar-serve.service && systemctl --user daemon-reload
rm -rf ~/.local/lib/familiar ~/.local/bin/familiar
rm -rf ~/.familiar      # 任意: 設定・セッション・memory/skills・保存済みキー
```

デスクトップ版は AppImage / portable exe を削除するか、パッケージマネージャでアンインストールします。

## 設定

`~/.familiar/config.yaml` にプロバイダ、既定値、サーバ設定を書きます:

```yaml
version: 1
default_provider: openai
default_model: gpt-6.1-sol

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }      # トークンはこのファイルに書かない
    default_model: gpt-6.1-sol
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: { env: none }
    default_model: qwen2.5-coder:3b
```

- シークレットは `api_key` → `api_key_file` → `env` の順で解決します。GUI から設定したキーは `~/.familiar/secrets/<provider>.key`(0600)に保存し、ファイル参照になります。
- bash は破壊的・情報漏えいの疑いがあるときだけ確認します(`permissions.bash.ask`)。マシンを消し得るコマンドはモードにかかわらず拒否します。
- リモートホスト、SSH プロキシ / familiar-server モード、トンネル、トークンは [docs/spec/05-config.md](docs/spec/05-config.md) にまとめてあります。

## ドキュメント

| | |
|---|---|
| [overview](docs/spec/00-overview.md) | 目的と範囲 |
| [architecture](docs/spec/01-architecture.md) | パッケージ構成、1 ターンの流れ、永続化 |
| [protocol](docs/spec/02-protocol.md) | JSON-RPC のメソッドとイベント |
| [tools](docs/spec/03-tools.md) | ツール一覧と承認ルール |
| [self-improvement](docs/spec/04-self-improvement.md) | memory・skills・curator |
| [config](docs/spec/05-config.md) | 設定リファレンス |
| [comparison](docs/comparison.md) | 他のハーネスとの違い(日付入り) |
| [roadmap](docs/spec/06-roadmap.md) | 実装履歴とメモ |

仕様書は日本語、コードと CLI は英語です。

## 開発

```bash
npm install
npm run build       # tsc -b(project references)
npm run typecheck
npm run smoke       # mock プロバイダでヘッドレス E2E(ネットワーク不要)
npm run mdtest      # markdown レンダラのフィクスチャ
```

`familiar serve` はビルド済みの `packages/*/dist` を動かし続けるので、コード変更後は再起動してください(Web UI の静的資産は自動で再読込されます)。

## ライセンス

[MIT](LICENSE)
