<div align="center">

# Familiar Harness

クライアント/サーバ型のオープンなエージェントハーネス。フルスクリーンのターミナル UI・Web UI・デスクトップアプリが**同一のコアエンジン**を共有します。
**MIT ライセンス**、Node.js 24+(Linux / Windows / macOS)で動作します。

[English](README.md) · **日本語**

</div>

---

<a id="日本語"></a>

## 日本語

[English](#english) · **日本語**

### Familiar Harness とは?

`familiar serve` がエージェントコアをデーモン化し(JSON-RPC over HTTP+WebSocket)、フルスクリーン TUI の CLI・Web UI・Electron デスクトップアプリが**同一のコアエンジン**を共有します。`serve` が生きていれば CLI は自動で RPC 接続に切り替わり、セッションはサーバ側の SQLite に永続化されます。

### なぜ Familiar なのか?

ほとんどのハーネスは「モデルに包んだチャット画面」です。Familiar は、複製が難しい 3 点を中心に設計されています — しかも **コマンド 1 つで実際に体験できます**。

```bash
familiar demo        # オフライン・API キー不要・約 60 秒
```

| | 実際に何が変わるか |
|---|---|
| **エージェントが自らを改善する(ただし人が承認する)** | 各ターン後に**別のレビュアーエージェント**がそのターンを読み、恒久的に効く教訓を提案します — **memory**(常時ロードする事実)か **skills**(必要な時にだけ読む手続き)。**何もしないまま書き込むことは決してありません**。提案は staging され、人が承認します(`familiar memory pending` / `familiar skills pending`)。**curator** が skill ストアの衛生を管理し(未使用 → stale → archive、任意の LLM 統合)、ledger と snapshot を残すので、**暗黙に消えるものはありません**。 |
| **1 つのコア・3 つのフロント** | `familiar serve` がエージェントをデーモンとして動かし、TUI・ブラウザ UI・デスクトップアプリは**同じエンジン・同じ SQLite 履歴**の薄いクライアントです。どのフロントから同じセッションを開いても同じ状態を見られます。 |
| **実行のマシンが別にあり得る** | **SSH プロキシモード**は bash/read/write/edit/glob/grep を SSH 越しに**相手側に何もインストールせずに**実行します(MCP サーバや言語サーバーも SSH 越しに起動)。**familiar-server モード**は相手先でデーモンを起動し、ウィンドウをそちらへ切り替えます。 |

`familiar demo` はこの一連の流れ(ターン → staging された提案 → 承認 → 次のターンへの継承 → skill の提案)を、使い捨てのホームと mock プロバイダで実行し、最後に同じセッションをデーモンが JSON-RPC で配信しているところまで見せます。

その他、控えめだが効く違い:

- **コンテキストとコストが見えます。** ターン毎のトークン内訳(system / tools / history)、USD 概算、トークン予算ガード、大きいツール結果の圧縮(全文はハンドルで保持)、未設定コネクタのツール非表示(実測で 31 → 17 ツール、1 ターンあたりツール定義が約 34% 減)。
- **オフィス文書が主役です。** 追加依存なしで Word / Excel / PowerPoint を生成(登録済みテンプレートのデザインも継承できます)、画像・音声・動画・PDF・Markdown・CSV・JSON・office をプレビュー。
- **依存が小さく、監査できます。** `yaml` + `ws` のみ、保存は Node 内蔵の `node:sqlite`(ネイティブ依存なし)、MIT ライセンス、セルフホスト配布、アカウント不要。
- **Windows / Linux は afterthought ではなく前提です。**

### 特徴

- **client/server 分離** — 1 つのコア、3 つのフロントエンド。
- **プロバイダ抽象** — OpenAI 互換 API(OpenAI / OpenRouter / NVIDIA / vLLM / llama.cpp 等)・Anthropic・キーレスのローカルエンドポイント(Ollama、LAN 内 LLM サーバ)。既定プロバイダに認証情報が無い場合、呼び出し可能なプロバイダへ自動フォールバックするため、ローカルモデルで `familiar chat` がそのまま動きます。
- **フルスクリーン TUI** — スプラッシュ+外枠なしレイアウト、`/models`・`/sessions` ピッカー、bracketed paste、CJK IME 対応カーソル、TUI 内ツール承認(`y/N`)、Esc でターン中断、tok/s 表示、モデル別コンテキスト長表示。
- **Web UI** — `familiar serve` が配信(既定 `http://127.0.0.1:46210`):セッション一覧(フォルダ折り畳み)、provider/model ピッカー、権限モード(Plan / 承認を求める / 編集を許可 / フルアクセス)、音声入力、コンテキストゲージ、tok/s、diff カード、**ファイルプレビュー(画像/音声/動画/PDF/Markdown/CSV/JSON/Word/Excel/PowerPoint)**(ファイルは右クリックで 開く / 名前を変更 / 削除 / パスをコピー / コンテキストに追加)、設定。
- **ツール群** — read/write/edit、**office_create(Word / Excel / PowerPoint を生成。登録したテンプレートのデザインを継承可)**、glob/grep、bash、webfetch/websearch、todo、サブエージェント `task`(並列)、git worktree、MCP サーバ(stdio・ホットロード)。
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

- 各 [Release](https://example.invalid:3000/owner/familiar-harness/releases) にバイナリを同梱:
  `familiar-<version>-linux-amd64.deb` / `familiar-<version>-linux-x86_64.AppImage`、
  Windows は NSIS インストーラ `familiar-<version>-win-x64.exe`、または
  `familiar-<version>-win-x64-portable.exe`(ダウンロードしてそのまま実行、インストール不要)。
- 自前でビルドする場合:

```bash
npm run -w packages/desktop pack:linux   # deb + AppImage
npm run -w packages/desktop pack:win     # NSIS(Linux でクロスビルドする場合は wine が必要)
```

### アップデート

- **リリース版(ワンライナーで導入)**: `familiar update` — Forgejo の最新 Release を確認し、`familiar-*.tar.gz` をダウンロードしてインストール先を入れ替えます(`--check` でドライラン、`--forgejo` / `--repo` で接続先変更)。自己署名証明書のインスタンスでは検証をスキップする再試行が行われます(警告表示。`FAMILIAR_TLS_STRICT=1` で中止)。
- **ソースから**: `git pull && npm run build`。

### アンインストール

**curl インストーラの場合:**

```bash
# 自動起動した WebUI サービスを停止(systemd ユーザーユニット)
systemctl --user disable --now familiar-serve 2>/dev/null
rm -f ~/.config/systemd/user/familiar-serve.service
systemctl --user daemon-reload 2>/dev/null

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

**デスクトップアプリ:** AppImage はファイルを削除。deb は `sudo apt remove familiar-harness`。Windows の portable 版は exe を削除、NSIS 版は「アプリ設定」からアンインストールしてください。

### クイックスタート

```bash
# 差別化ポイントを 60 秒で体験(オフライン・API キー不要)
familiar demo

# フルスクリーン TUI — `familiar chat` と同じ
familiar

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
- bash は破壊的・情報送信系(`permissions.bash.ask`: `rm -rf`、`sudo`、`curl -d`、強制 push など)以外は承認なしで実行します。ただし**マシン全体を消し得るもの**(`rm -rf /`、システムディレクトリそのものの `rm -rf /etc`、`rm -rf ~`、Windows ドライブルート、`--no-preserve-root`、`find / -delete`、デバイスへの `dd`/`mkfs`/リダイレクト)は承認でも実行できない無条件ブロックです。旧来の「毎回承認」に戻すには `permissions.bash.mode: ask`。
- モデル名は移り変わりが速いため、プロバイダのモデル一覧(TUI の `/models`、または `curl $BASE_URL/models`)で最新を確認してください。
- 詳細は [docs/spec/05-config.md](docs/spec/05-config.md)。

### リモートアクセス

`familiar serve` は既定で `127.0.0.1` のみにバインドするため、ルータのポート開放は不要です。別 PC からは SSH トンネルを使います:

```bash
ssh -L 46210:127.0.0.1:46210 ユーザー名@サーバーIP
# 手元のブラウザで http://localhost:46210
```

LAN に直接公開する場合のみ `familiar serve --bind 0.0.0.0` を使い、**必ずトークン認証(`familiar token --write`)を設定**。公網にさらす場合は TLS リバースプロキシを挟んでください。

**デスクトップアプリ:** 「設定 → 接続」で SSH ホストを登録(秘密情報なし。ホスト/ユーザー/ポート/秘密鍵パス+接続方式)。新規セッションダイアログの「実行先」から選べます。

- **familiar サーバ方式** — そのマシンで `familiar serve` を SSH 経由で起動(鍵/ssh-agent 前提・ホスト鍵検証は厳格)し、空きローカルポートを転送してウィンドウごとリモートに切り替えます。リモート側にも同じバージョンの Familiar と `known_hosts` の登録が必要です。「ローカルに戻る」で復帰します。
- **SSH プロキシ方式** — リモートには何もインストールしません。セッションはローカルのまま、`bash`/`read`/`write`/`edit`/`glob`/`grep` だけを ssh でリモート実行します(Linux/macOS は ControlMaster で多重化)。リモートのフォルダーはダイアログから閲覧でき、非画像ファイルをドロップするとリモートへアップロードして `@パス` で参照します(セッション削除で消去、残りは `uploads.retention_days` で自動整理)。MCP サーバーと言語サーバーもリモートで起動します(ホスト側に別のバイナリが必要な場合は各サーバーの `remote: { command, args }` で上書き)。

デスクトップアプリ無しのブラウザ(WebUI)でも同じプロファイルが「設定 → 接続」に表示されます。プロキシはブラウザからそのまま実行でき、familiar サーバ方式はサーバ側がトンネルを張ってブラウザをリモート UI へ切り替えます(戻るは capability エンドポイントでトンネルを閉じる、閉じ忘れは 12 時間で自動終了、待ち受けは `server.bind` に追従)。

ホスト鍵は厳格検証です。初回は接続フォームの「🔑 ホスト鍵を確認…」でフィンガープリントを確認して `known_hosts` へ登録してください(変更された鍵は自動登録しません)。

認証は既定で鍵/ssh-agent、または接続プロファイル単位で**パスワード**を選べます(リモート側の変更・インストールは不要)。パスワードは `~/.familiar/secrets/ssh-<hash>.pass`(0600)に保存し、ssh へは `SSH_ASKPASS` 経由で渡します(argv・ログ・セッション DB には残りません)。失敗が続くとそのホストへの接続を 60 秒間自動で止め、サーバ側のレート制限(fail2ban 等)を誘発しないようにします。

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
