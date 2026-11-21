<div align="center">

# Familiar Harness

セルフホスト型のコーディングエージェント。TUI・Web UI・デスクトップアプリが 1 つのコアを共有します。
**MIT** · Node.js 24+ · Linux / Windows / macOS

[English README](README.md)

</div>

---

## Familiar とは

Familiar は、モデルをツールループ(read/write/edit、bash、glob/grep、MCP サーバ、サブエージェント)で動かし、セッションを SQLite に保存するエージェントです。`familiar serve` はコアをデーモン(JSON-RPC over HTTP + WebSocket)として公開し、TUI・ブラウザ UI・デスクトップアプリはそのクライアントとして動きます。どこで開いたセッションも、ほかのフロントエンドから同じ状態で続けられます。

ターンが終わるたびに別のエージェントが内容をレビューし、次回以降に活かせる知見を提案します。提案はいったん保留され、承認したものだけが反映されます。

## はじめかた

Node.js 24+ が必要です。

```bash
# Linux / macOS
curl -fsSL https://github.com/keima-tech/familiar-harness/raw/main/install.sh | sh
```

```bash
familiar            # フルスクリーン TUI
familiar run -p "このリポジトリの TODO を列挙して"   # 1 回だけ実行して終了
familiar serve      # Web UI と JSON-RPC(http://127.0.0.1:46210)
familiar demo       # 自己改善の流れをオフラインで実演(API キー不要)
```

API キーを設定していない場合は、実際に呼び出せる最初のプロバイダを使います(既定では Ollama など、キー不要のローカル環境)。固定したいときは `~/.familiar/config.yaml` に指定します。

TUI の主な操作: `Ctrl+P` コマンドパレット、`/models` プロバイダとモデルの選択、`Tab` plan / build の切り替え、`Esc` 実行中のターンを停止、`/help` ヘルプ。

## 自己改善のしくみ

1. ターンが終わる。
2. レビュアーエージェントが内容を読み、次回以降に活かせる **memory**(毎回読み込む価値のある事実)か **skill**(必要なときだけ読み込む手順)を提案する。
3. 提案はいったん保留される(`familiar memory pending` / `familiar skills pending`)。`familiar memory approve <id>` / `familiar skills approve <id>` で承認したものだけが反映される。
4. 次のターンから、承認済みの memory がプロンプトに含まれる。skill はタスクに合致したときに読み込まれる。

curator は使われなくなった skill を `active → stale → archived` と整理し、変更をすべて ledger に記録します。統合の前には skill ツリーのスナップショットを残します(`familiar curator rollback <id>`)。`familiar demo` を使うと、この一連の流れを一時的なホームディレクトリでオフライン試せます。

## 主な機能

- **承認フロー。** 危険なツール呼び出しは承認アダプタを通ります。`--plan` を付けると読み取り専用のツールだけに制限されます。マシンを壊しかねないコマンドは、承認の有無にかかわらず実行しません。
- **プロバイダ。** OpenAI 互換 API(OpenAI、OpenRouter、NVIDIA、vLLM、llama.cpp など)、Anthropic、キー不要のローカル環境に対応しています。
- **フロントエンド。** フルスクリーン TUI のほか、セッション一覧・モデル選択・diff カード・権限モード・コンテキストゲージ・ファイルプレビュー(画像・音声・動画・PDF・Markdown・CSV/JSON・Word/Excel/PowerPoint)を備えた Web UI、deb / AppImage / NSIS で配布するデスクトップアプリがあります。
- **リモートマシン。** SSH プロキシを使うと、接続先に何もインストールせずに bash とファイル操作を実行できます(MCP サーバや言語サーバも同様)。接続先でデーモンを起動し、アプリをそこに向けることもできます。
- **コンテキストとコスト。** ターンごとのトークン内訳、USD での概算コスト、トークン予算の上限、大きくなったツール結果の圧縮に対応しています。
- **Office 文書。** Word / Excel / PowerPoint を追加の依存なしで生成できます。
- **依存の少なさ。** 実行時の依存は `yaml` と `ws` のみ。保存には Node 内蔵の `node:sqlite` を使い、ネイティブモジュールはありません。

## インストール

### インストーラ(Linux / macOS)

```bash
curl -fsSL https://github.com/keima-tech/familiar-harness/raw/main/install.sh | sh
```

`~/.local/lib/familiar` にインストールし、`~/.local/bin/familiar` から実行できるようにします(保存先は `FAMILIAR_INSTALL_DIR` / `FAMILIAR_BIN_DIR` で変更できます)。バージョンを指定する場合は `curl … | sh -s -- 0.1.0` のように渡します。

### ソースから(全プラットフォーム)

```bash
git clone https://github.com/keima-tech/familiar-harness.git
cd familiar-harness
npm install
npm run build
cd packages/cli && npm link   # `familiar` が PATH に入る
```

Windows では、ソースからのインストールか下記のデスクトップ版を使ってください。

### デスクトップアプリ

ビルド済みのバイナリを各 [リリース](https://github.com/keima-tech/familiar-harness/releases) に添付しています:
`familiar-<version>-linux-amd64.deb`、`familiar-<version>-linux-x86_64.AppImage`、
`familiar-<version>-win-x64.exe`(NSIS)、`familiar-<version>-win-x64-portable.exe`。

```bash
npm run -w packages/desktop pack:linux   # deb + AppImage
npm run -w packages/desktop pack:win     # NSIS(Linux でクロスビルドする場合は wine が必要)
```

### 更新とアンインストール

`familiar update` は最新のリリース tarball を取得して入れ替えます(`--check` を付けると確認のみ)。GitHub Releases を参照し、GitHub でまだ公開していない間はプロジェクトの Forgejo をフォールバックとして使います。ソースから使っている場合は `git pull && npm run build` です。

```bash
# インストーラで入れた場合のアンインストール
systemctl --user disable --now familiar-serve 2>/dev/null
rm -f ~/.config/systemd/user/familiar-serve.service && systemctl --user daemon-reload
rm -rf ~/.local/lib/familiar ~/.local/bin/familiar
rm -rf ~/.familiar      # 任意: 設定・セッション・memory/skills・保存したキー
```

デスクトップ版は AppImage / portable exe を削除するか、パッケージマネージャでアンインストールしてください。

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

- シークレットは `api_key` → `api_key_file` → `env` の順で解決します。GUI で入力したキーは `~/.familiar/secrets/<provider>.key`(パーミッション 0600)に保存され、設定ファイルからはそのファイルを参照します。
- bash は、破壊的または情報漏えいの恐れがあると判断したときだけ確認します(`permissions.bash.ask`)。マシンを壊しかねないコマンドは、モードにかかわらず実行しません。
- リモートホスト、SSH プロキシ / familiar-server モード、トンネル、トークンの設定は [docs/spec/05-config.md](docs/spec/05-config.md) にまとめてあります。

## ドキュメント

| | |
|---|---|
| [概要](docs/spec/00-overview.md) | 目的と範囲 |
| [アーキテクチャ](docs/spec/01-architecture.md) | パッケージ構成、1 ターンの流れ、永続化 |
| [プロトコル](docs/spec/02-protocol.md) | JSON-RPC のメソッドとイベント |
| [ツール](docs/spec/03-tools.md) | ツール一覧と承認ルール |
| [自己改善](docs/spec/04-self-improvement.md) | memory・skills・curator |
| [設定](docs/spec/05-config.md) | 設定リファレンス |
| [比較](docs/comparison.md) | 他のハーネスとの違い(日付入り) |
| [ロードマップ](docs/spec/06-roadmap.md) | 実装履歴とメモ |

仕様書は日本語、コードと CLI は英語です。

## 開発

```bash
npm install
npm run build       # tsc -b(project references)
npm run typecheck
npm run smoke       # mock プロバイダを使ったヘッドレス E2E(ネットワーク不要)
npm run mdtest      # markdown レンダラのフィクスチャ
```

`familiar serve` はビルド済みの `packages/*/dist` を読み続けるため、コードを変更したら再起動してください(Web UI の静的アセットは自動で再読み込みされます)。

メンテナ向け: `scripts/release.sh --publish` で tarball とデスクトップ版をビルドして Forgejo に公開します。`GITHUB_TOKEN`(または `--github`)を指定すると、同じアセットを GitHub Releases にもミラーします。

## ライセンス

[MIT](LICENSE)
