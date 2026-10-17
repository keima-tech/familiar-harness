# 06 — ロードマップ

ステータス: 確定 / 最終更新: 2026-10-17

| Phase | 内容 | 状態 |
|---|---|---|
| M0 | spec fix / リポジトリ初期化 | 完了 |
| M1 | agent loop + 基本ツール(read/write/edit/glob/grep/bash) + SQLite セッション + CLI(run -p / chat / serve / sessions / model list / init / doctor) + mock provider スモーク | 完了 |
| **M2** | **Google provider・fallback 連鎖・plan モード・動的承認 RPC(permission.request/respond + CLI リモートモード)・webfetch/websearch/todo/task・worktree コマンド・Bearer トークン認証(`server.auth_token_file`)** | **完了 ✅** |
| **M3** | **memory + skills + background self-review + write_approval(自己改善ループ第1版)** — staging/CAS・usage 統計・lint・`familiar memory|skills` コマンド・`improvement.staged`/`memory.truncation` イベント ✅(compaction 要約(aux)は簡易 drop 版のまま、要約版は M4 へ繰り越し) | **完了 ✅** |
| M3 | memory + skills + background self-review + write_approval(自己改善ループ第1版) ✅ |
| M4 | compaction 要約(aux)・curator(Phase1 自動遷移 + opt-in 統合 + ledger/snapshot + scheduler)・Web UI(`familiar serve` が同一ポートで静的配信)・**Desktop α(Electron シェル: serve を spawn/検出して Web UI を読み込む)** ✅(electron-builder によるインストーラは M6) |
| M5 | **MCP(stdio 動的ツール・依存ゼロ実装)・hooks(session_start / pre|post_tool_use / turn_complete)・cron 定期実行(serve 内スケジューラ・boot 実行も可)・task 並列化(同一メッセージ内の複数 task を同時実行)** ✅ — LSP と独立プラグイン API は M6 へ繰り越し(v1 製品スコープで hooks + MCP が実用プラグイン面を担う) |
| M6 | v1.0: **プロファイル(SOUL.md 多段: global / profile / project)** ✅・**LSP `lsp_diagnostics`(依存ゼロ stdio クライアント)** ✅・**Web UI v1.0(session 削除・provider/model/profile ピッカー・curator/MCP/cron ステータスドロワー)** ✅・**配布: electron-builder によるインストーラ** ✅(deb・AppImage は本機でビルド実証 / NSIS 設定込み・Windows でのビルド検証は要 Windows 製機)・テスト拡充(smoke N: SOUL 多段 / O: LSP / session.delete e2e) ✅・docs ✅ | **完了 ✅(独立プラグイン API のみ継続課題)** |

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

## M6 の実装メモ(2026-10-17)

- **SOUL.md 多段**: 設定キーではなく 3 層のファイル(`~/.familiar/SOUL.md` →
  `~/.familiar/profiles/<p>/SOUL.md`(or `profiles.<p>.system_prompt_file`)→ `<cwd>/.familiar/SOUL.md`)。
  CLI `--profile` フラグは v1.0 で実装済み(run / chat の session.create に渡る)。smoke N で担保。
- **LSP**: 依存ゼロの stdio LSP クライアント(Content-Length JSON-RPC)。
  publishDiagnostics 待ち方式のため、pull 型のみのサーバ(未対応)は future work。
  規模の大きい tsserver 等での長時間安定性は実運用での観察対象。
- **electron-builder**: Linux deb + AppImage は実環境でビルド成功(アーティファクト
  `packages/desktop/release/familiar-1.0.0-linux-{amd64,x86_64}`)。**NSIS は設定のみ** —
  ビルド自体は Windows 製機で `npm run -w packages/desktop pack:win` を実行する必要がある。
  electron のバージョンは electron-builder が厳密指定を要求するため **固定** (`38.8.6`)。
  extraResources は electron-builder の既定フィルタがルート直下の `node_modules` を
  除外するため、packages と node_modules を 2 つの FileSet に分けて投入している。
- **継続課題**: 独立プラグイン API(hooks + MCP 以外の拡張点)は v1.1 以降の課題として残す。

## v1.1 の実装メモ(2026-10-17、OpenCode Desktop 風 UI)

- **`session.update` RPC**(server): `title` / `provider` / `model` / `profile`(null で解除)を
  部分更新。provider 変更時に model が無指定なら default model フォールバックは create と同一。
  store 側は `SqliteSessionStore.updateSession`(動的 SET)。
- **Web UI を OpenCode Desktop 仕様に刷新**(`packages/server/public/`):
  - メッセージ: user=右寄せバブル / assistant=ベアテキスト(吹き出し廃止) /
    ツール呼び出しは **番号付き 1 行ツール行**(`1 read path ✓ 0.3s`)でクリック展開。
  - composer: 角丸カード内に `+`(新規)/ **Build|Plan モードチップ**(`session.send` の
    `plan` に マップ)/ **モデルチップ**(provider+model を `session.update` で永続化、
    未作成なら次回 create に引き継ぎ)/ 円形送信ボタン。
  - topbar: トークン使用量チップ(turn.end の加算・表示専用)、**⋯ メニュー**
    (Rename=タイトルインライン編集 / Export as Markdown=クライアント側生成 DL / Delete)、
    **トランスクリプト検索**(Ctrl+F、クライアント側フィルタ)。
  - markdown・コードコピーボタン・折り畳み・トーストは v1.0 rich UI から継続。
- **CLI リッチ化(diff 描画・スピナー・TTY TUI)** は本筋の設計が要るため別工程
  (roadmap v1.1 以降で検討)。RPC/イベントには影響なし。
- **ツール結果の画像表示**: 現行ツール群はテキスト出力のみのため未対応(画像ツール追加時に)。

## v1.1 の実装メモ②(2026-10-17 後半、GUI 利便性)

- **⚙ 設定ドロワー**: 配色(ライト/ダーク/**システム** — matchMedia 追従)・
  **テーマ 10 種 × light/dark = 20 パレット**(Tokyon Night / Catppuccin / Nord /
  Dracula / Rosé Pine / Kanagawa / Everforest / Gruvbox / Solarized / One Dark)。
  カラーパレットは JS が `:root` の CSS 変数に書込む方式(stylesheet の既定値 =
  Tokyo Night dark が JS 起動前のフォールバック)。選択は localStorage
  (`familiar.theme` / `familiar.mode`)。
- **provider カタログ**(設定内・読取専用): `config.get` の sanitized 値から
  kind / default_model / api key 解決状態を表示。設定変更は CLI 側 config.yaml。
- **セッション一覧の右クリックメニュー**: リネーム(openSession 後に topbar タイトルを
  インライン編集)/ Export / Delete。`#ctx-menu` は fixed + viewport 内にクランプ、
  外側クリック・スクロール・Esc で閉じる。
- **composer の popover 修正**: `.pop.up`(bottom 起点の上開き)で下見切れを解消。
  **「＋」メニュー**: ファイル添付(隠し file input — Electron は `file.path` を取得し
  `@<path>` を挿入)/ `@ `(コンテキスト)/ `! `(シェル実行依頼)挿入。
- **コンテキスト使用量リング**(topbar): 直近 turn の promptTokens ≒ コンテキスト
  現在値 × `models.list` の contextTokens → SVG リング + % 表示(不明時は
  トークン数 or —)。クリックで **session info ドロワー**(セッション情報・メッセージ
  カウント・コンテキスト使用率・this visit のトークン・raw メッセージ一覧)。
  旧 usage chip(gauge に統合)は削除。

## v1.1 の実装メモ③(2026-10-17 深夜、設定モーダル + Tab 切替)

- **Tab で Build/Plan 切替**: keydown をグローバルで捕捉(入力系別要素内は除外、
  `#input`/body は有効)。ON/OFF は設定で切替可(OpenCode の Tab 切替踏襲)。
- **設定は中央モーダル化**: 左ナビ + 右ペイン(OpenCode デスクトップの設定画面準拠)。
  セクションは 一般 / 外観 / トランスクリプト / ショートカット / プロバイダー /
  拡張機能 / システム。Esc・背景クリック・✕ で閉じる。
- **UI preferences(`familiar.prefs`)**
  - 送信キー(Enter 送信 ⇄ Ctrl+Enter 送信)、Tab 切替、自動スクロール、
    ツール行既定展開、UI フォントサイズ(--fs)、トランスクリプト幅(--content-w)
  - デスクトップ通知(turn 完了時 = OpenCode tui の attention 相当。非フォーカス時
    のみ通知の下設定、初回有効時に Notification.requestPermission)。
- **テーマ 13 種 × light/dark = 26 パレット**: OpenCode docs の built-in themes に
  併せて **Ayu / Matrix / Catppuccin Macchiato** を追加(既存 10 种 + 3)。
- **右クリックメニューの幅バグ修正**: `.pop` 側 `right: 0` が fixed 要素に効いて
  左右全域に伸びていたため `#ctx-menu { right: auto; width: max-content;
  max-width: 280px }` に。
- 参照元: opencode.ai/docs/themes, /docs/config(theme 一覧・attention・
  keybinds・default agent 等の語彙)。Hermes Agent のリポジトリは本ワークスペース
  外のため未参照(参照指示があれば取り込み可)。

## v1.1 の実装メモ④(2026-10-17 夜、i18n + プロバイダー手動設定)

- **i18n(ja 既定 / en)**: 表示文字列を `STR` 辞書 + `t(key, ...args)` に集約し、
  静的 HTML は `data-i18n` / `data-i18n-ph` / `data-i18n-title`、動的ラベル
  (チップ・composer placeholder・送信ボタンの title)は `applyI18n()` で反映。
  切替は 設定 > 一般 > 言語。保存先は localStorage `familiar.lang`。
- **テーマ 14 種**: Oxocarbon を追加(OpenCode 準拠リスト + Ayu/Matrix/Macchiato)。
- **Hermes Agent 参照**(https://github.com/NousResearch/hermes-agent): 既存
  対応済みの対応は personality=profile / skills / memory / curator=cron /
  `hermes model`=モデルチップ / `/usage`=コンテキストリング。今回は
  **直前の操作を再実行(↻ ボタン = `/retry` 相当)** を追加。
- **設定 > プロバイダーで手動設定**: 新 RPC `config.provider.set` で
  kind / base_url / default_model / API キーを編集・追加。キーは
  `~/.familiar/secrets/<name>.key` (0600) にのみ書き込み、config.yaml には
  `api_key_file` 参照を追記(インライン秘密情報は残さない)。書き込み後は
  インメモリ config を更新して `ProviderRegistry.invalidate()` で
  **再起動なしで即時反映**。応答は秘匿値を含まない要約のみ。
- **+ ボタン**: 枠線をなくし控えめに + 外側クリックで閉じないバグを修正
  (`closeAllPops()` に `plus-pop` が欠落していた)。
- **虫眼鏡・歯車アイコン**: 16→18px・パディング拡大で視認性を向上。
- smoke シナリオ I に provider.set の HTTP e2e(永続化・秘匿・入力検証)を追加。

## v1.1 の実装メモ⑤(2026-10-17 深夜、リモートアクセスの認証)

- **`server.auth_token_file` を実装(M2 設計の実現)**: 設定すると `/rpc`・`/ws`・
  UI 静的ファイルがすべて Bearer トークンを要求(`/healthz` のみ開放)。
  照合は `crypto.timingSafeEqual`、値は非ログ、ファイルが読めない場合は fail-closed。
- **`familiar token [--write|--clear]`**: トークン発行・`~/.familiar/server.token`(0600)
  への保存と config への `auth_token_file` 設定を一括で行う。
- **UI**: `?token=` → sessionStorage に保持 → `Authorization: Bearer` と `/ws?token=`
  (アドレスバーには残さない)。トークンなしで 401 になった場合は専用ヒントを表示。
- **デスクトップ**: `/healthz` の `tokenFile` からローカルでトークンを読み、
  `?token=` 付きで UI を開くため設定変更でデスクトップが壊れない。
- **CLI リモートモード**: `--server` 使用時に `Authorization` を自動付与。
- `familiar serve --bind ADDR` フラグ追加(config の `server.bind` を上書き)。
- spec 01 §7 / 05(リモートアクセス手順: トークン + ファイアウォール + SSH トンネル)更新。
- 副産物の修正: リモートモードで `RemoteFamiliarClient.close()` がソケットを実際に閉じておらず
  `familiar run --server …` が turn.end 後に終了しない既存バグを修正(LAN 利用時に直結)。

## v1.1 の実装メモ⑥(2026-10-17 深夜、プロバイダー設定の操作性)

- **エンドポイント指定 → モデル一覧**: 新 RPC `models.probe`(kind / base_url /
  api_key を渡すと、**未保存の**設定に対してその場で `/models` を照会)。
  設定 > プロバイダーのフォームは「モデル一覧を取得」ボタン + URL/種類/キーの
  入力からデバウンス自動取得。取得結果はクリックで既定モデルに採用。
  - プローブは config を複製して一時プロバイダを作るだけなので**保存もキャッシュも
    しない**(キーは応答に含めない)。到達できない場合は URL 付きエラーを返す。
- **listModels のエラー劣化を修正**: openai-compatible / anthropic が
  `/models` 失敗を握りつぶして `[]` を返していたため「モデルなし」と区別できず
  設定失敗の原因が分からなかった。例外を再送出し、RPC 層の error に出るようにした
  (既存の `models.list` は error フィールドを返す挙動のまま)。
- **設定モーダルのエラー可視化**: 失敗時に右下トーストが出るが、設定モーダルの
  `backdrop-filter: blur(2px)` がトースト(z-index 50 < モーダル 70)を**ぼかして
  いた**。トーストを z-index 90 に引き上げてくっきり表示し、さらにプロバイダー
  フォーム内にも `.form-error` のインラインエラーを併記(モーダル内なので確実に読める)。
## v1.1 の実装メモ⑦(2026-10-17 深夜、設定コントロールのプルダウン化)

- 設定モーダルの複数選択コントロール(**言語 / 配色 / UI フォントサイズ /
  トランスクリプト幅**)を並んだボタン(セグメント)から **ネイティブ `<select>`
  のプルダウン**に変更(`selectControl()` ヘルパー、`.select-control` /
  `.select-row` スタイル)。二値の項目(Enter で送信・自動スクロール等)は
  従来どおりスイッチ。
- `html[data-mode]` に `color-scheme` を設定し、ダークテーマ時にプルダウンの
  開いた一覧やスクロールバーが OS 側でもダークで出るようにした。
- 補足: `unknown method: models.probe` が出た場合は **起動中の `familiar serve`
  が古いビルド**。デスクトップは起動時に生存中サーバを再利用するため、
  デスクトップ終了 → 残った serve プロセス確認 → 再起動で解消する。
## v1.1 の実装メモ⑧(2026-10-17 深夜、モデル選択のプルダウン化と表示名)

- **チャット入力欄のモデル選択をプルダウン化**: composer のモデルポップオーバー
  (`#mp-model`) と新規セッションパネル (`#ns-model`) を free-text + datalist から
  ネイティブ `<select>` に変更(`fillModelSelect()` 共通化)。先頭に
  「プロバイダーの既定」(value="")、続いて `models.list` の結果。
  プロバイダ切替時は既定に戻し、セッション中のモデルが一覧に無い場合のみ
  その値を選択肢として追加する。プロバイダ到達不可なら「既定」のみの選択肢。
- **設定画面への導線**: モデルポップオーバーと新規セッションパネルに
  「プロバイダー設定…」リンク(`.link-left`)を追加。`openSettingsModal("providers")`
  で設定モーダルをプロバイダー節から開く。
- **モード名称は Build / Plan に**: 日本語文字列でも 構築/計画 を使わず
  `Build` / `Plan` のまま表示する(説明文は日本語のまま)。
- **アプリ名を "Familiar Harness" に**: ブラウザタブタイトル・サイドバーのロゴ・
  Electron のウィンドウ title / productName。
## v1.1 の実装メモ⑨(2026-10-17 深夜、過程の可視化・コピー・tok/s・モデルピッカー)

- **思考過程の可視化**: プロバイダの reasoning チャンクを新イベント
  `reasoning.delta`(protocol/events.ts)としてループが送出し、assistant メッセージの
  `meta.reasoning` に永続化。UI はストリーミング中は展開した「💭 思考」ブロック
  (`details.thinking`)を回答の上に表示し、turn 終了時に折り畳む。
  永続トランスクリプトでも折り畳みで再表示できる。mock プロバイダも
  `mock-thinking:` を出すようにし smoke で WS 配信・永続化の両方を検証。
- **回答フッター + コピー**: 各 assistant メッセージの下に `.msg-foot`
  (コピーアイコン ⧉ + `Build · provider/model · 秒 · tok/s`)。ライブの turn では
  turn.end で最後のバブルに付与、永続分はモデル名付き。従来の hover 時 copy ボタンは廃止。
- **出力速度**: turn.end の usage.completionTokens と経過秒から **tok/s** を算出し、
  turn 完了ラベルとフッターに表示。
- **モデルピッカー刷新**: composer のモデルチップのポップオーバーを
  **検索付きリスト**に変更(イメージ: OpenCode)。プロバイダ別にグループ化、
  各グループ先頭に「プロバイダーの既定」、モデル行はクリック即適用、現選択は ✓、
  コンテキスト長はバッジ表示、到達不可プロバイダは注記。下部「⚙ モデルを管理」で
  設定 > プロバイダーへ。各プロバイダの models.list は並列・逐次反映。
