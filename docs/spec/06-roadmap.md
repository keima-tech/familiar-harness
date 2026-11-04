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

## v0.1.0 の実装メモ(2026-10-17、OpenCode Desktop 風 UI)

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

## v0.1.0 の実装メモ②(2026-10-17 後半、GUI 利便性)

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

## v0.1.0 の実装メモ③(2026-10-17 深夜、設定モーダル + Tab 切替)

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

## v0.1.0 の実装メモ④(2026-10-17 夜、i18n + プロバイダー手動設定)

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

## v0.1.0 の実装メモ⑤(2026-10-17 深夜、リモートアクセスの認証)

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

## v0.1.0 の実装メモ⑥(2026-10-17 深夜、プロバイダー設定の操作性)

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
## v0.1.0 の実装メモ⑦(2026-10-17 深夜、設定コントロールのプルダウン化)

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
## v0.1.0 の実装メモ⑧(2026-10-17 深夜、モデル選択のプルダウン化と表示名)

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
## v0.1.0 の実装メモ⑨(2026-10-17 深夜、過程の可視化・コピー・tok/s・モデルピッカー)

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
## v0.1.0 の実装メモ⑩(2026-10-17 深夜、モデルピッカーの修正)

- **`[hidden]` が効かない CSS バグ**: `#model-pop { display: flex }` や
  `.mp-row { display: flex }` は UA スタシートの `[hidden] { display: none }` より
  優先度が高く、**ポップオーバーが閉じない・検索で絞り込めない**という 2 つの症状に
  表れていた。`[hidden] { display: none !important; }` をグローバルに追加して解消。
- **未設定プロバイダーを候補から除外**: `isProviderUsable()`(mock / キー不要
  エンドポイント / API キー解決済みのみ表示)。新規セッションパネルのプロバイダー
  一覧も同じ。全滅する場合は従来どおり全件表示にフォールバック。
- **`describeAuthSource` の修正**: `auth.env: "none"`(キー不要プロバイダの既定)が
  `source: "env:none"` と誤報告されていた。`"none"` に正規化(UI は旧サーバとの
  互換のため `"env:none"` もキー不要として扱う)。
- **`models.list` のエラー表示**: RPC は throw ではなく `{models:[], error}` を
  返す形なので、ピッカー側で `error` フィールドを見て「一覧取得失敗」注記を出すようにした。
## v0.1.0 の実装メモ⑪(2026-10-17 深夜、既定モデルの任意化・コピー UX・SSH 手順)

- **既定モデルを設定必須から解除**: プロバイダー設定フォームから「既定モデル」入力を
  削除。エンドポイントだけ登録し、モデルは composer のピッカーで選ぶ運用に寄せる。
  保存ペイロードに `default_model` を含めないので**既存値は保持される**(サーバは
  undefined 時 patch しない)。ピッカーの「プロバイダーの既定」行は
  `providerHasDefaultModel()`(mock / default_model / cfg.default_model のいずれか)が
  真のときだけ表示。新規セッションパネルのセレクトも同じ条件で、既定が無い場合は
  先頭モデルをプリセレクト。
- **コピーのフィードバックをアイコン化**: 回答末の ⧉ を押すと右下トーストではなく
  ボタン自体が ✓(成功・緑)/ ✕(失敗・赤)に変わって 1.2 秒で戻る。
- **README**: 「リモートアクセス(SSH トンネル)」節を追加(`ssh -L
  46210:127.0.0.1:46210`、`?token=`、LAN 直公開はトークン必須・公網は TLS 推奨)。
## v0.1.0 の実装メモ⑫(2026-10-17 深夜、ピッカーの既定行削除・caret 残りの修正)

- composer のモデルピッカーから **「プロバイダーの既定」行を削除**(モデルは一覧から
  選ぶ運用に統一。新規セッションパネル側の既定オプションは従来どおり)。
- **回答後も四角のカーソルが点滅し続けるバグ**: ストリーミング用の `.caret` を
  turn 終了時に除去していなかった。liveBubble で caret を entry に保持し、
  ①次のステップのバブル作成時 ②turn.end ③turn.error で除去するようにした。
## v0.1.0 の実装メモ⑬(2026-10-18、+ の即時作成・cwd 編集・アイコン化)

- **外観設定から「OpenCode のように」の文言を削除**。
- **「+」は即時セッション作成**: プロバイダー/モデル選択パネル(`#new-session-panel`)
  を廃止し、`session.create {}`(設定の既定)で即作成 → 開く。モデル変更是
  composer のピッカーで行う。作成失敗時はトーストで理由を表示。
- **作業フォルダー(cwd)をチャットヘッダーから変更可能に**: `session.update` に
  `cwd` を追加(store の patch にも)。存在するディレクトリのみ許可(それ以外は
  RPC error)。ヘッダーに `📁 <フォルダー名>` チップ(ツールチップに全パス)を
  表示し、クリック → プロンプト → 更新。
- **コードブロックの copy ボタンをアイコン化**(copy → ⧉、成功 ✓ / 失敗 ✕ が
  1.2 秒で戻る)。回答末のフッターと同じ挙動に揃えた。
- **md レンダラのユニットテストをリポジトリへ恒久化**: `packages/server/scripts/md-test.mjs`
  (`npm run mdtest`、29 アサーション)。/tmp 版が消失したため。
## v0.1.0 の実装メモ⑭(2026-10-18、cwd サジェスト・ネイティブ選択・設定アイコン移動)

- **作業フォルダー変更をモーダル化**: `window.prompt` をやめ、`#cwd-overlay`
  モーダルに。入力に応じて新 RPC **`fs.dirs`**(指定ディレクトリのサブディレクトリ
  を列挙、`~` 展開対応・隠し除外)で**存在するフォルダーをサジェスト**。行クリックで
  掘り下げ、Enter / 「設定」で `session.update {cwd}`。
- **ネイティブなフォルダー選択(デスクトップのみ)**: Electron に `preload.js` を追加し
  `window.familiarDesktop.pickDirectory()`(ipcMain → `dialog.showOpenDialog`
  openDirectory)を公開。UI は関数が存在するときだけ「📁 参照…」ボタンを出す
  (ブラウザ版は出ない)。`files` に `preload.js` を追加。
- **設定アイコンを左下へ**: トップバーの ⚙ をサイドバー下部 `side-foot`
  (インボックス/ステータスと同じ列)の「⚙ 設定」ボタンへ移動。
## v0.1.0 の実装メモ⑮(2026-10-18、削除確認の i18n・ドロワー起動の移設)

- **セッション削除の確認ダイアログを i18n 化**: `window.confirm` の英語固定文を
  `del.confirm` 辞書キーに(ja: 「セッション「{0}」を削除しますか? …」/ en 従来文)。
- **承認インボックス / ステータスの起動ボタンをトップバーへ**: 左下 side-foot から
  `✎`(承認、バッジ付き)と `ⓘ`(ステータス)のアイコンボタンとして右上に移動。
  side-foot は「⚙ 設定」のみに。ドロワー本体とワイヤリング(id)は不変。
## v0.1.0 の実装メモ⑯(2026-10-18、cwd モーダル余白・スラッシュコマンド・Skills UI)

- **cwd モーダルの余白を整理**: 基底 `.modal` の固定高さ(min(600px, 84vh))と
  padding ゼロが原因で窮屈に見えていた。`.cwd-modal` は `height: auto` +
  padding 18px + gap 12px に。
- **スラッシュコマンド(OpenCode 互換)**: 入力欄が `/` で始まるとコマンド候補
  (`#cmd-pop`)を出す。Enter で先頭候補を実行、Escape で閉じる。実装: /new /model
  /plan /build /export /retry /settings /search。
- **設定 > 拡張機能に「スキル (Skills)」カード**: 既存 `skills.list` RPC を表示。
  名前・説明・使用回数・本文文字数。スキルは chat で依頼(skill_manage)または
  ~/.familiar/skills/<名前>/SKILL.md 手動で追加できる。
- 比較で残る今後候補: ツール行の diff 表示、todo パネル(todo.list RPC 未実装)、
  @ ファイル補完、メッセージ時刻表示。
## v0.1.0 の実装メモ⑰(2026-10-18、提案改善の実装:diff・todo・@補完・時刻)

- **ツール行の diff 表示(edit / write)**: `ToolOutput` に `diff?` を追加し、edit は
  置換前後の unified diff(LCS・コンテキスト 3 行・最大 120 行で打ち切り、
  巨大入力は -old/+new ペアに劣化)、write は既存内容との差分(新規なら全 + 行)を
  生成(`tools/diff.ts`)。diff は tool.result イベントとツールメッセージの
  `meta.diff` の両方に載り、UI は緑/赤の色分けブロック(`.tc-diff`)で描画。
  smoke は mock の `@edit <path> <old> => <new>` ディレクティブで e2e 検証。
- **todo パネル**: 新 RPC `todo.list {id}`(SessionTodoStore)。トップバーに
  ☑ ボタン + 進行中バッジ、専用ドロワー(○/◐/● と打ち消し線)。turn 終了時に
  バッジ更新。
- **@ ファイル補完**: 新 RPC `fs.suggest {prefix, cwd}`(ディレクトリ優先・20 件・
  `~` 展開・cwd 相対対応)。composer の末尾 @ トークンで候補表示、**Tab または
  クリックで確定**(Enter は通常どおり送信)。スラッシュコマンドと同ポップを使い
  分け。
- **メッセージ時刻**: assistant フッターの末尾に hh:mm(ライブは turn 完了時刻、
  永続メッセージは createdAt)。
## v0.1.0 の実装メモ⑱(2026-10-18 夜、CLI/TUI リッチ化)

roadmap の「CLI リッチ化(diff 描画・スピナー・スラッシュコマンド)」を実装:

- **スピナー + 経過秒**: `Spinner`(TTY/NO_COLOR 判定、10 フレーム `⠋⠙…`)。
  テキスト/ツール出力の前後で一時消去(`\r\x1b[2K`)してストリームと分離。
- **diff 描画**: `tool.result` の `diff` を ANSI 色付き(green/red/cyan hunk、
  最大 40 行)でツール行の直下に表示。
- **番号付きツール行**: GUI と同じく `⏺ 1 edit: …`。**turn サマリー**: turn.end で
  `✓ 4.2s · ↑1k ↓210 tok (50 tok/s)` を表示(mock も usage chunk を出すようにし
  たため tok/s が常時検証できる)。
- **思考(reasoning.delta)表示**: `💭 thinking…` に続けて dim ストリーム。
- **REPL スラッシュコマンド拡張**: `/retry`(直前メッセージ再送)/ `/todo` /
  `/cwd <path>`(session.update)/ `/export [file]`(markdown ダンプ)/ `/clear`、
  `/model` はセッション作り直しではなく `session.update` で反映。
- **入力の逐次化**: readline の line をキューイングし、turn 中のコマンドや
  再送が並走しないよう drain ループで直列処理(パイプ入力でも順序が保たれる)。
## v0.1.0 の実装メモ⑲(2026-10-18 深夜、`familiar` で TUI・CJK 太字・Markdown 表)

- **`familiar`(引数なし)で REPL を起動**: TTY なら cmdChat を直接開く(パイプ/CI は
  従来どおり USAGE を表示)。USAGE の先頭にも明記。
- **CJK の太字違和感を解消**: フォントスタックが Latin(Segoe UI)と CJK(游ゴシック
  等)で別ファミリーになり、bold の太さが混在していた。**CJK 対応ファミリーを先頭**に
  した単一スタックへ変更(`Hiragino Sans → Yu Gothic UI → Noto Sans CJK JP → …`)。
  `strong/b` は `font-weight: 600` + `font-synthesis-weight: none`(疑似ボールド禁止)。
  `setLang` は `<html lang>` も同期。
- **GFM テーブル対応**: md レンダラに表(ヘッダ + 区切り行検出、`:--` アラインメント、
  外側パイプ任意、セル内の HTML エスケープ/インライン md)を追加。CSS は罫線 +
  ゼブラ + 横スクロール。mdtest を 36 アサーションに拡充。
- 思考ヘッダの絵文字(💭)を `◌` に変更(環境によって豆腐になるため)。
## v0.1.0 の実装メモ⑳(2026-10-18 未明、TUI 本格リッチ化)

- **ターミナル Markdown レンダラ**(`cli/src/ui/markdown.ts`): 見出し、箇条書き/
  番号付きリスト、引用(│)、水平線、インライン装飾(**太字**/*斜体*/`code`/リンク)、
  **罫線付きコードブロック**(言語ラベル付き)、**CJK 幅対応の罫線テーブル**、
  行単位ストリーミング対応。CJK 直後の *斜体* も解釈(GUI 側の正規表現も同様に緩和)。
- **REPL の chrome**: 起動バナー(◍ Familiar Harness + バージョン + cwd + model +
  session)、プロンプト `build ❯`(plan 中は plan)、セッション作成行、
  `/help` に Tab 補完のヒント。`--version`/`-V` の既存バグ(dist から
  ../../package.json を読んで 0.0.0)も修正。
- ツール行は `⏺ 2  edit · src/foo.ts` → `✓ 12ms`(失敗は ✗ + 理由)、diff は
  2 スペースインデントで色付き表示。turn サマリーは
  `✓ 4.2s · ↑1k ↓210 tok · 50 tok/s`。
- `familiar`(引数なし)で TTY なら REPL 起動(前回実装)+ 非 TTY は USAGE。
## v0.1.0 の実装メモ㉑(2026-10-18、OpenCode 風フルスクリーン TUI)

- `packages/cli/src/ui/tui.ts` を新規実装(依存ゼロ・生 ANSI)。代替スクリーン +
  外側の角丸ボーダー枠(上辺にタイトル+モデル、下辺にモード/モデル/トークン統計)、
  スクロール可能なトランスクリプト、下段 1 行エディタ(+反転カーソル)、
  動作中はスピナー + 経過秒。行差分描画で変更行のみ再出力。
- `familiar`(TTY)/ `familiar chat`(TTY)がこの TUI を起動。パイプ/CI は従来の
  行 REPL、`--line` で強制。入力は readline を使わず自前デコーダ
  (UTF-8 StringDecoder + 不完全 ESC 保持、マウスホイール SGR 1006 揃い)。
- transcript はブロック列(user=`❯`、assistant=TermMarkdown、thinking=`◌`、
  tool=`● name · arg ✓ ms` + diff、info=システム出力)。スクロール中は
  ビューポートをアンカー固定し、End で追従。
- ツール行・diff・ターン統計は行 REPL と共通のヘルパ
  (toolCallDetail / renderDiff / ThinkingFilter)を再利用。
- GUI: プロバイダ設定行は名前(+既定バッジ)だけに簡素化。コンポーザの「＋」の
  アクセント漏れを修正(.menu-wrap 再構成により直子セレクタが外れていた)。
  サイドバー「＋」もゴースト化。
- 新規組み込みプロバイダ **nvidia**(OpenAI互換、
  https://integrate.api.nvidia.com/v1、認証は環境変数 NVIDIA_API_KEY)。

## v0.1.0 の実装メモ㉒(2026-10-18、TUI 操作性・GUI 中断/添付/エフォート・プロバイダ設定)

- **TUI 起動バナー**: ブロック文字で "FAMILIAR / HARNESS" を太字シアンで
  描画する `showBanner()`(依存ゼロの自前 5 段フォント)を transcript 先頭に
  追加。サブタイトルに `/ コマンド · Tab → build/plan` のヒントを併記。
- **スラッシュコマンド候補 + Tab 補完**: エディタ先頭トークンに前方一致する
  `TUI_COMMANDS` カタログをフロート表示(ビューポート下段にオーバーレイ・行差分
  はそのまま)。`↑/↓` で選択移動(wrap)、`Tab`/`↵` で受理。引数が要るコマンド
  (`/session` `/model` `/effort` `/cwd` `/export`)は `name ` を入れて待機、
  不要コマンド(`/help` `/clear` 等)はそのまま実行。
- **Tab で Build/Plan 切替**: 候補ポップが閉じているときの Tab は
  `onModeToggle` コールバックがモードを反転し、ステータスバーと info に通知。
- **マウスクリック選択**: SGR 1006 の押下イベント(`<0;c;rM`)を解析して
  `tui.click(row, col)` へ。候補行のクリック=選択(引数コマンドは補完、
  即実行系はそのまま実行)。
- **GUI 中断ボタン**: `session.abort` RPC を新設(AgentServer が実行中 turn を
  AbortController で管理)。ループは provider API 呼び出しを abort し
  `turn.aborted` イベント(protocol 新型)を出して正常応答
  `{ aborted: true }` を返す(turn.error は出ない)。`#send` が実行中
  「■ 停止」に変化(タイトル/CSS `.stop`)。
- **GUI ドラッグ&ドロップ添付**: composer への drop で `attachFiles()` が
  `@path ` を挿入(最大 8 件)。Electron 38 では `webUtils.getPathForFile` を
  preload 経由で使用(File.path は廃止済み)。ページ遷移防止のため
  document 級の dragover/drop を preventDefault。
- **推論エフォート**: `SessionRecord.effort`(low|medium|high|null)を追加
  (sessions テーブルは実行時 ALTER TABLE マイグレーション)。
  openai_compatible → `reasoning_effort`、anthropic → `thinking.budget_tokens`
  (4096/10240/16384 + max_tokens 余盛)に写像。session.create/update/send で
  受け、CLI は `--effort` と `/effort`、GUI は `#effort-chip`(既定/low/medium/
  high ポップオーバー)。
- **mock プロバイダを既定から除去**: `DEFAULT_CONFIG.providers` と
  テンプレートから `mock` を削除(既定は openai)。`kind: "mock"` 自体は
  smoke テストのため維持。GUI の認証済み判定から mock 特例を除去。
- **GUI プロバイダ設定の再構成**: 「接続済みプロバイダー」(認証解決済み or
  キー不要)を折りたたみカードで列挙し、「接続候補」は内蔵カタログ
  (OpenAI / Anthropic / Gemini / NVIDIA / OpenRouter / Ollama 未接続分)+
  キー未解決のカスタム設定を `＋ 接続` ボタン(フォームを事前入力で開く)
  で提示。カード行にブランド色ドットを追加。

## v0.1.0 の実装メモ㉓(2026-10-18、TUI OpenCode 風全面改修・/models ポップアップ)

- **スプラッシュ wordmark**: 中央に大型ブロック文字 "familiar harness"
  を配置(`harness` は hi 側バイト色の 2 トーン)。幅 61 未満は "familiar"、
  28 未満では描画しない。会話開始後(トランスクリプト有)はロゴを消して
  フロー表示へ切替(先頭行に ▲ 遺留マーカー)。高さ 12 未満でもロゴ省略。
- **OpenCode 風レイアウト**: 外枠ボーダーを撤廃。下部固定は
  [パッド行] プロンプトパネル(丸角・左アクセントバー)メタ行
  (`Build · model provider`)の下に下線行(`╹`)+ヒント行。box 幅は
  `min(75, w-4)` で中央。ヒントは opencode 同文言
  `tab switch agent / ctrl+p commands`(busy 時は左に spinner+秒)。
  cwd は $HOME を `~` 表記し、長い時は右側を残して省略。
- **解析済み色パレット**: opencode v2 テーマ(blue #7699fe = Build、
  purple #a383e2 = Plan)を ANSI 256 に写像。`sgr()` はスパン毎に bg を
  再宣言し、`panelRow()` が全幅の bg パッドで埋める(bg 側に細線を出さない)。
- **`/models` モデルピッカー**: `/model` は隠し alias に降格し、
  正式コマンドは `/models`(引数なし = ポップアップ)。Enter で
  `Select model` ダイアログ(タイトル行+esc)を開き、`models.list` を
  provider 毎に逐次取得して進行充填(`setModelGroups` は group.provider で
  正規化)。行は `┃` 選択バー+`●` 現行マーク+ctx(k/M)列、provider は
  節見出し。↑/↓/Home/End/PgUp/PgDn/クリック(SGR 1006 押下)/Esc/Enter。
  Esc は editor クリア、選択は `onModelPick` → `session.update`。
- **コマンドパレット統合**: `/` 入力と ctrl+p(0x10)の両方が候補
  ポップアップ(部分一致フィルタ、空マッチで閉じる)。Tab は argless を
  即実行・needsArg は補完待ち。ポップアップ有 Tab=受理、ない Tab=
  onModeToggle(Build/Plan 切替、toast 通知)。ポップアップ中のヒント行は
  `enter select / esc close` に切替。
- **単独 ESC の曖昧さ解消**: チャンク末尾の bare ESC は 40ms 待って
  後続が来なければ escape キーとして処理(alt キー接頭との両立)。
  クリックは header 行を click 無効、wheel はポップ中 moveMenu ±1、
  非ポップは scroll ±3。
- **line REPL も `/models`**: 引数あり直接設定・引数なし一覧表示。
  `/help` 文言も追随。TUI の info は `(送信なし)` 開始でスプラッシュ面を
  空に保ち、重要な通知は toast(下線行 2.6 秒)へ集約。
## v0.1.0 の実装メモ㉔(2026-10-18、TUI 第二弾:セッション切替・中断・ペースト)

- **/sessions セッションピッカー**: TUI で `/sessions`(引数なし)を
  モデルピッカー同型のダイアログに。行は `┃ ● <title  id8>
  <model provider> … <reltime>`。● は現在セッション(setSessionInfo の
  新フィールド sessionId で判定)。入力中の文字で id/title/provider/model/
  cwd の部分一致フィルタ^H(^H=空クエリで開く)。選択は `onSessionPick` →
  `session.get` で履歴込み取替え + toast。line REPL は従来の list 表示を維持。
- **esc で turn 中断**: ストリーミング中に Esc を押すと
  `onAbortTurn` → `session.abort`(㉒)。フッタヒントは busy 時
  `esc stop / ctrl+p commands` に切替。`turn.aborted` イベントは
  トランスクリプトに `■ stopped` ブロック+`stopped` toast。
- **bracketed paste(2004)**: start で `\x1b[?2004h`、stop で `\x1b[?2004l`。
  onData は `ESC[200~…ESC[201~` を状態機械で抽出(マーカーがチャンク境界
  で分断されても復元)。ペースト本文はキーストローク復号を通さずエディタへ
  単一行化(\n・\t→空白、8000 字上限)して挿入。
- **ダイアログの空クエリ開始**: モデル/セッション両ピッカーは
  open 時に editor をクリア(直前のテキストがフィルタとして残らない)。
- **ポップアップ外クリック**: SGR クリック行が popupRowAt に存在しない場合
  (トランスクリプト・フッタ等)opencode 同様ダイアログを閉じる。
- **/rename <title>**: `session.update {title}`。パレットは needsArg 補完
  (`/rename `まで入れて待機)。実 PTY で パレット受理→入力→toast まで検証。
- **ターミナルタイトル**: OSC 0 (`\x1b]0;familiar — <session title|~cwd>BEL`)
  を start 時と title/cwd 変更時に更新。

## v0.1.0 の実装メモ㉕(2026-10-18、TUI 承認フロー・IME カーソル・usage/tok/s)

- **TUI ネイティブ・ツール承認**: フルスクリーン TUI では
  `CliApprovalAdapter`(readline)が alt-screen と同じ stdin を奪い合い、
  最初のターンでツール承認が来ると描画が乱れ入力不能になる不具合を修正。
  `TuiApprovalAdapter` を追加(`ui/approvals.ts`)し、cmdTui は TUI を
  openRunTransport より先に構築して渡す(第 6 引数 `approval` で上書き、
  既定は従来の readline アダプタ)。パネルのエディタ行に
  `approve bash: <summary>? (y/N)` を表示(summary が既に
  `<tool>:` で始まる場合は接頭辞を畳む)、ヒント行は `y approve / n deny`。
  承認待ち中は y=承認 / n・Esc=拒否、他キーは無視し入力には混入しない。
  実 PTY E2E(mock `@bash`)で 出現→n 拒否でターン完走→
  再出現→y 承認でツール実行→後続会話 を検証。
- **IME 変換窓の位置**: カーソル非表示(`?25l`)だと CJK IME の候補窓が
  画面隅に寄るため、`?25l` を廃止。毎フレーム実カーソルをエディタの
  キャレット位置(`row = h-bottomHeight + (slim?1:2)`, `col = bx+3+可視幅`)
  に置き、`DECSCUSR 6`(固定バー)を start で要求、stop で `0 q` 復帰。
  疑似ブロックカーソル(INV)は実カーソルと二重になるため撤去。
- **usage 既定取得(openai_compatible)**: `stream_options.include_usage`
  を既定で送る(`stream_options: false` で無効化、ollama は DEFAULT_CONFIG
  で false のまま)。400/422 で `stream_options` が原因の拒否の場合は
  1 回だけ外して再送し失敗させる。実機の llama.cpp 互換サーバで turn.end に
  usage が乗ることを確認(これが GUI の tok/s 非表示の原因)。
- **GUI の tok/s 概算**: usage が取れない場合、ターン内ストリーム文字列から
  `estimateTokens`(CJK≈1字/トークン、その他≈4字/トークン)で概算し
  `↓≈N tok (≈M tok/s)` を表示。usage がある場合は従来どおり実測値。
- **reasoning ブロックの閉鎖表示**: ストリーム終了後も
  `◌ thinking…` のままだったのを、closeStreams で `done` を立て
  `· thinking…` に切替(回転中/終了の区別が付く)。

## v0.1.0 の実装メモ㉖(2026-10-19、既定モデルの自動フォールバック・コンテキスト長)

- **既定プロバイダの自動フォールバック**: 新規設定は
  DEFAULT_CONFIG 由来の openai/gpt-5.2 が既定になり、API キーが無いと
  何も動かなかった。`loadConfig` で ユーザーが明示指定していない場合
  (yaml にも CLI 上書きにも無い)に限り、呼び出し可能な
  (`providerCallable`: 秘密鍵が解決できる / `env: none` / auth 未設定で
  http:// のローカルエンドポイント)プロバイダへ既定を差し替える。
  優先順は ①ユーザー追加プロバイダ(ビルトイン以外)→②ビルトイン、
  同 tier 内は キーレス > キー付き、どちらも default_model が要る。
  実効既定は config.get 経由で GUI/TUI にもそのまま反映。
  warn 一行(`default provider "openai" has no usable credentials —
  defaulting to ...`)を出すので、意図通りに戻すには
  default_provider/default_model を書けばよい。
- **コンテキスト長の取得**: openai_compatible の listModels は id しか
  見ておらず、GUI のコンテキストゲージ/セッション情報が
  「(不明)」になっていた。`context_length` / `context_tokens` /
  `max_model_len` / `meta.n_ctx(_train)` を吸って contextTokens へ。
  さらに Ollama は /v1/models にコンテキストが無いため、ローカル
  (http://)エンドポイントのみ 8 モデルまで上限で /api/show を
  best-effort 参照(qwen2.context_length 等のサフィックス一致)。
  ローカル llama.cpp 互換サーバ=524288、ollama モデル=131072 を実機確認。
- **/models の画面ノイズ**: ピッカーを開くと各プロバイダの
  `models.list failed ... HTTP 401` が stderr に流れ alt-screen を
  上書きしていた(実害なし・見苦しい)。openai-compatible/anthropic の
  listModels から log.warn を除去(RPC の error フィールドで十分。
  ピッカー内には `provider · unavailable` +理由が既に出る)。

## v0.1.0 の実装メモ㉗(2026-10-19、公開準備:README 二言語化・CLI インストーラ)

- **README 二言語**: README.md(英語・公開用の主ドキュメント)+ README.ja.md
  (日本語・運用ノウハウやサーバ再起動手順を含む)。AGENTS.md の
  UI 文字列ポリシーも更新。旧 README の「特徴(計画)」を実装済み
  事実ベースに書き直し、インストール/クイックスタート/設定例/
  リモートアクセス/アーキテクチャ/開発/リリース手順を整理。
- **ライセンス**: MIT(LICENSE 追加、全 package.json を version 0.1.0 +
  license: MIT)。
- **CLI 配布**:
  - `install.sh`(リポジトリ直下、raw 配布): Forgejo API で最新
    Release の `familiar-*.tar.gz` を取得 → `~/.local/lib/familiar` へ展開 →
    `~/.local/bin/familiar` に symlink。Node ≥ 24 を事前チェック、jq 不要の
    JSON パース(tr -d 空白 → grep)、`FAMILIAR_FORGEJO` / `FAMILIAR_REPO` /
    `FAMILIAR_INSTALL_DIR` / `FAMILIAR_BIN_DIR` で上書き可、バージョン引数対応。
    ローカル HTTP モックで E2E 検証済み(展開→symlink→`familiar --version`
    →`familiar serve` の Web UI 200)。
  - `scripts/release.sh`: ビルド → ステージング(packages/*/dist +
    server/public + package.json/lock + README/LICENSE/install.sh)→
    `npm ci --omit=dev`(実行時依存は yaml・ws のみ)→ ステージ CLI の
    `--version` 冒煙 → tarball(≈500KB)。`--publish` で Forgejo Release
    作成+アセット添付(FORGEJO_TOKEN / FORGEJO_TOKEN_FILE)。
  - `npm i -g git+URL` は npm の制約(workspaces+git 依存で prepare 内
    の入れ子 install が失敗)のため非対応。ソースからは
    `git clone && npm install && npm run build && cd packages/cli && npm link`
    を案内(実機確認済み)。

## v0.1.0 の実装メモ㉘(2026-10-19、リリース調整)

- **README 単一ファイル化**: README.md + README.ja.md を統合し、冒頭の
  アンカー(`#english` / `#日本語`)で切替る単一ドキュメントに。
  タイトルを「Familiar Harness」に変更(desktop の productName と統一)。
  両言語に**アンインストール手順**を追加(curl 版は
  `~/.local/lib/familiar` + symlink + 任意で `~/.familiar`(設定・履歴・
  secrets を消す注意書き)、npm link 版は `npm unlink`、デスクトップは
  AppImage 削除 / `apt remove familiar-desktop` / Windows のアプリ設定)。
  release.sh のステージングから README.ja.md を除外。
- **既定モデルの現行化**: OpenAI 既定 `gpt-5.2`(提供終了)を
  `gpt-6.1-sol` に更新(DEFAULT_CONFIG・CONFIG_TEMPLATE・README・
  docs/spec/05-config.md)。例に「モデル名は流動的 — /models で要確認」
  の注記を追加。

## v0.1.0 の実装メモ㉙(2026-10-19、familiar update・ベア familiar の周知)

- **`familiar update`**: install.sh 由来のインストール(~/.local/lib/familiar/
  packages/... レイアウトを realpath で判定)向けセルフアップデート。
  Forgejo Release API で familiar-*.tar.gz を持つ最新リリースを semver 降順
  (API の順序に依存しない)で解決 → バージョン比較(同値/旧は
  up-to-date で終了)→ ダウンロード(tmp)→ tar 展開(同一 FS 上の
  ステージング)→ ステージの完全性・package.json バージョン一致チェック →
  rename スワップ(失敗時は旧ツリーへ復元)→ chmod 755(best-effort)。
  `--check` でドライラン、`--forgejo` / `--repo` で接続先変更。
  自己署名証明書(自前 Forgejo)では Node fetch が失敗するため、
  CERT 系エラー時に限り検証スキップの https 再試行にフォールバック
  (警告表示。NODE_EXTRA_CA_CERTS 推奨、FAMILIAR_TLS_STRICT=1 で無効化)。
  モック Forgejo HTTP サーバで 0.1.0→0.1.1 の E2E 検証済み
  (スワップ後 --version・残骸なし・--check up-to-date・serve 200)。
- **ベア `familiar` = TUI** は既存実装(㉒)だが README のクイックスタートを
  `familiar` 先頭に変更し、`familiar chat` は同等コマンドとして明記。
  install.sh の完了メッセージも `familiar` 起点に。
- README 両言語に「アップデート」節を追加。

## v0.1.0 の実装メモ㉚(2026-10-19、Release へのデスクトップ同梱・冪等パブリッシュ)

- **scripts/release.sh 拡張**: `--publish` で CLI tarball に加え
  electron-builder 製 deb + AppImage を既定でビルド/添付
  (`--desktop` でドライラン時もビルド、`--no-desktop` で除外)。
  リリース作成はタグ既存時に GET /releases/tags/{tag} でリリースを
  再利用、同名アセットは削除してから再アップロードする冪等パブリッシュ。
  jq 不在環境向けに JSON フィールド抽出は node ワンライナーで処理。
- **バージョン運用**: update コマンド実装(㉙)は v0.1.1 として一時発行
  したが、初回リリースは v0.1.0 のままにする方針のため、
  旧 Release v0.1.0/v0.1.1 とタグを削除し、現行 HEAD から
  デスクトップ同梱で v0.1.0 を再発行する。

## v0.1.0 の実装メモ㉛(2026-10-19、Windows portable 同梱・release.sh --attach)

- **Windows portable exe**: Linux から `electron-builder --win portable` は
  wine 不要でビルド可能(アンインストーラ生成を行わないため)。
  NSIS はアンインストーラ生成に wine を使うため ENOENT。
  `build.win.signAndEditExecutable: false` で rcedit/signtool をスキップ
  (インストール後の exe は素の Electron アイコン)。portable exe
  (familiar-0.1.0-win-x64-portable.exe ≈ 85MB、サーバ同梱 stage/familiar 込み)
  を v0.1.0 Release に添付。
- **release.sh --attach FILE**: 追加アセットを冪等に添付するオプション
  (同名アセットは削除して再アップロード)。409 時の既存リリース再利用と
  組み合わせて再発行が安全。
- README 両言語: Release 添付バイナリ(deb/AppImage/win portable)の案内、
  アンインストール手順に portable 版を追記。

## v0.1.0 の実装メモ㉜(2026-10-19、NSIS インストーラ同梱)

- ユーザー環境に wine64(10.0)導入により、Linux からの NSIS クロスビルドが
  完走(electron-builder はアンインストーラ生成のためビルド済み
  インストーラを wine で 2 回実行する)。`familiar-0.1.0-win-x64.exe`
  (≈95MB・PE32/NSIS)を v0.1.0 Release に追加添付し、アセットは
  tarball + deb + AppImage + win NSIS + win portable の 5 点構成。
  なお `signAndEditExecutable: false` は維持(rcedit/signtool を使わない —
  カスタムアイコン未設定のため実用上の差はなし)。
- README 両言語の Release バイナリ一覧に NSIS インストーラを追記。

## v0.1.0 の実装メモ㉝(2026-10-19、GUI:フォルダ別セッション一覧・コンテキストペイン・新規作成モーダル)

- **セッション一覧のフォルダ別グループ化(Claude デスクトップ風)**:
  sidebar を cwd でグループ化し、`▸ 📁 <basename> <件数>` の折りたたみ
  ヘッダ行を追加。折りたたみ状態は localStorage(`familiar.folderFolds`)に
  永続化。グループは最新セッションの新しい順、中も新しい順。
  フィルタ時は一致するグループを自動展開し、一致なしグループは隠す。
- **コンテキスト使用量ペイン**: composer のエフォートチップ左横に
  リングゲージアイコン(#ctx-btn)を追加。クリックでポップオーバー
  (#ctx-pop)を開閉し、大きなリング+使用/上限/残り+model/provider+
  説明ノートを表示。updateContextGauge がトップバー gauge と
  composer ゲージ/ペインの両方を更新(未取得時は contextWindowFor を
  非同期取得してから再描画)。closeAllPops に ctx-pop を追加。
- **新規セッション モーダル(中央フォルダ選択)**: 「+」と /new を
  即時作成からモーダル(`#new-session-overlay`)に変更。中央に最近の
  作業フォルダ(recent cwd をセッション数付きで dedup・新しい順)を
  一覧表示、入力すると fs.dirs でサジェスト。行クリックで選択(✓)、
  Enter/作成で `session.create { cwd }`。Electron では 📁 参照ダイアログ
  も使用可。選択未指定時はエラー表示。
- **検証**: Electron+CDP の実 UI テスト(/tmp/opencode/gui-test.mjs)
  23 項目 — グループ化・件数・折りたたみ/展開・localStorage 永続化・
  リング %・ペイン開閉と数値・モーダル表示/選択/作成/自動クローズ。
  過去テスト実行の残留 serve がポート 46210 を占有しセッションが
  蓄積する問題があるため、テストは起動時に残留 serve を掃除。

## v0.1.0 の実装メモ㉝(2026-10-19、アプリアイコン・ファビコン)

- ユーザー制作のアイコン 2 種(ワードマーク入り/なし)を組み込み。
  PIL で中心スクエア+角丸マスク(半径 15.5%)を適用し透過 RGBA 化:
  - `packages/desktop/build/icon.png`(512)+ `icon.ico`(16-256 多解像度)
    + `build/icons/<n>.png` — electron-builder が deb/AppImage/NSIS/
    rcedit に自動適用。`win.signExecutable: false`(署名のみスキップ、
    rcedit によるアイコン/バージョン情報は wine で適用)。
  - `public/favicon.ico`(16/32/48)+ `icon-32/192/512.png` +
    `brand.png`(ワードマーク版)。http-transport の静的ホワイトリストに
    追加。index.html に favicon/apple-touch-icon リンク、
    sidebar ロゴを ◍ テキストから img に置換、設定モーダルヘッダに
    brand.png を表示。
- 検証: favicon/icon-32/brand が 200(image/x-icon, image/png)で配信、
  GUI テスト 23 項目再合格、リリース資産 5 点を冪等差し替え。

## v0.1.0 の実装メモ㉞(2026-10-19、デスクトップからのアップデート)

- **デスクトップ シェルのセルフアップデート**: main.js に update モジュール
  を追加(Forgejo Release API → プラットフォーム別アセット解決 →
  semver 比較)。起動 4 秒後 + 6 時間ごとに自動チェック
  (FAMILIAR_FORGEJO / FAMILIAR_REPO で接続先変更、dev チェックアウトは
  自動チェック対象外)。
- **トップバーの ⬇**: 更新があるとき top-actions の先頭に下矢印アイコン
  (点滅)を表示。クリックで適用:
  - Linux(抽出済み AppImage レイアウト): 新しい AppImage を
    ダウンロード → `--appimage-extract`(FUSE 不要)→ レイアウト検査 →
    rename スワップ(失敗時は旧ツリーへ復元)→ ↻ ボタンに変化。
  - Windows: NSIS インストーラを %TEMP% にダウンロード → ↻ で
    インストーラ起動 + アプリ終了。
  - ↻ クリックで `app.relaunch()` + 再起動適用。
- preload に `checkForUpdate / applyUpdate / restartApp / onUpdateStatus`
  を公開。UI は preloader 経由の IPC イベントで状態遷移
  (available → downloading → applied)。エラーは toast で表示し ⬇ は
  残存。⋯ メニューに「アップデートを確認」を追加(手動チェック)。
- **検証**: モック Forgejo で実フロー E2E 9 項目(⬇ 表示→tooltip の
  バージョン→クリック→スワップ完了→↻→インストールツリーの入れ替わり・
  残骸なし・UI アセット同梱)。開発チェックアウトは `FAMILIAR_INSTALL_ROOT`
  環境変数でレイアウトを注入してテスト可能。

## v0.1.0 の実装メモ㉟(2026-10-19、デスクトップ通知:ターン完了・承認)

- 既存の turn 完了通知(maybeNotify・設定トグル・既定 OFF)を拡張し、
  **通知を既定 ON**(notifyOnlyUnfocused は既定 true:フォーカス中は完了
  通知を抑制)。ブラウザでは boot 時に Notification.permission が
  default なら要求。
- **承認リクエストでも通知**(showApproval → urgent:true —
  フォーカスの有無に関わらず出る。ツール+概要を本文に)。turn.error でも
  通知(urgent)。
- **Electron は main プロセス経由**: preload に `notify` を追加し、
  main の `app:notify` ハンドラが Electron Notification(アイコン付き・
  クリックでウィンドウ復帰)+ タスクバーフラッシュ(flashFrame)。
  通知デーモン不在の環境では flash のみ。ブラウザは従来どおり
  Web Notification API。
- **検証**: Electron+CDP で 6 項目 — 既定 ON・renderer→main IPC 到達
  (main の stdout ログでアサート)・承認 dock 描画+緊急通知・
  turn.end イベント経路の通知。xvfb ではウィンドウにフォーカスがある
  ため非緊急通知はフォーカスゲートで抑制される点も確認(仕様どおり)。

## v0.1.0 の実装メモ㊱(2026-10-26、SSH 接続先でセッションを実行)

- **デスクトップの SSH 接続先**: 「設定 → 接続」でホスト/ユーザー/ポート/
  秘密鍵ファイル/リモート familiar パスを登録(`~/.familiar/desktop.json` 0600・
  秘密情報なし)。新規セッションモーダルに「実行先」リスト(このマシン +
  各プロファイル + 追加ショートカット)を追加。SSH を選ぶとセッションは
  リモートで実行され、ウィンドウごとリモート UI へ切り替わる。
- **接続方式(方式 A)**: 1 本目の SSH で
  `familiar serve --port 0 --bind 127.0.0.1 --print-ready --token-file <tmp>` を
  起動。トークンは desktop が生成し **SSH の stdin 経由**でリモートの 0600
  一時ファイルへ書く(argv/環境変数/ログ/プロファイルに残らない)。ready 行
  (`FAMILIAR_READY {json}`)から実ポートを得て、2 本目の `ssh -N -L` でローカルの
  空きポートをリモート loopback へ転送。`BatchMode=yes`(鍵/ssh-agent のみ)、
  `StrictHostKeyChecking=yes`、`ExitOnForwardFailure=yes`。リモートは
  POSIX シェル(Linux/macOS)前提。
- **引き継ぎ**: 切替 URL は `?token=…&remote=1&conn=<id>&host=…&new=1&cwd=…`。
  リモート UI は新規セッションダイアログを cwd 付きで自動オープン(空欄時は
  リモート home)。`session.create` は `~` を**サーバ側**ホームへ展開。
  `/healthz` に `hostname` / `platform` / `home` を追加。
- **セキュリティ**: preload の接続系 IPC はローカル origin のみ
  (`conn:save/delete/connect/test`、ネイティブピッカー、`shell:openPath`、
  更新適用)。リモート UI に許すのは `conn:list`(現在の接続のみ・他ホストは
  非公開)と `conn:disconnect`(ローカルへ戻る)。ナビゲーション/リダイレクトは
  信頼 origin に固定し、他 origin はブラウザへ渡す。
- **UI**: トップバーにリモートバッジ(`SSH: host`)、切断時バナー+
  「ローカルに戻る」。リモート時はネイティブフォルダ選択・「外部アプリで開く」・
  更新チェック・非画像 `@path` 添付を無効化(画像添付は可)。リモートの接続設定は
  読み取り専用。i18n は JA/EN 両対応(EN モード CJK ゼロ)。
- **検証**: `packages/desktop/scripts/ssh-e2e.mjs`(`npm run -w packages/desktop
  e2e:ssh`)— 偽 ssh(`FAMILIAR_SSH_BIN`。`-L` を実 TCP 転送、リモートコマンドを
  ローカル実行)で sshd 不要。25 項目: 設定フォーム保存・desktop.json 0600・
  実行先リスト・接続→リモート UI 切替・cwd プリフィル・リモートでの
  セッション作成と write ツールの着地・state.db の分離・origin ガード 3 種・
  ローカル復帰・一時ディレクトリ掃除・EN 文字列。typecheck / smoke も通過。

## v0.1.0 の実装メモ㊲(2026-10-26、SSH プロキシ実行・非画像添付のリモート転送)

- **SSH プロキシ方式**: リモートに familiar を入れず、ローカルの `familiar serve` のまま
  ツール実行だけを `ssh` で行う接続方式を追加(Claude Code デスクトップの SSH 接続と
  同じ考え方)。接続プロファイルに `mode: "serve" | "proxy"` を追加(既定 serve)。
- **実行バックエンド抽象化**(`packages/core/src/exec/`): `ExecBackend`
  (exec/readFile/writeFile/mkdirp/exists/stat/listDir/walk/statMany/readMany/home)を
  導入し、`LocalBackend`(従来の node fs + child_process そのまま)と
  `SshBackend`(system ssh。`sh -c` へ単一 argv、read は `head -c`、write は stdin の
  `cat >`、一覧/走査/stat は POSIX シェルスクリプト、バッチ読みは base64)を実装。
  Linux/macOS は ControlMaster/ControlPersist で多重化、Windows は都度接続。
  ツール側は `ctx.backend` 経由に統一(`bash`/`read`/`write`/`edit`/`glob`/`grep`)。
  パス演算はバックエンドの flavor を使うため、Windows クライアント→Linux リモートでも
  POSIX パスが壊れない。
- **セッション**: `SessionRecord.remote`(`{host,user,port,identityFile}`)を追加し
  sqlite に `remote` 列を追加マイグレーション。`session.create` は `ssh` パラメータで
  絶対パスのリモート cwd を受け付け、`task` サブエージェントが継承。システムプロンプトに
  リモート実行の注記を追加(当初 `lsp_diagnostics` は無効化 → ㊳ でリモート実行に対応)。
- **RPC**: `fs.list/read/preview/dirs/suggest` が `session`(または `ssh`)で
  バックエンドを切り替え。新規 `fs.upload`(base64→バックエンドへ書き込み)。
- **非画像添付**: ドロップ/添付した非画像ファイルを `fs.upload` で
  リモートの `<ホーム>/.familiar/uploads/<session-id>/` へ転送し、`@<リモートパス>` を
  挿入(familiar サーバ方式でも同じ経路でリモート側ホームに保存)。最大 20MB(クライアント
  側は 15MB でガード)。画像は従来どおり base64 でモデルへ。
- **UI**: 接続フォームに「接続方式」、実行先リストのバッジ(familiar サーバ / SSH プロキシ)、
  プロキシ選択時は新規セッションダイアログでリモートフォルダーを閲覧(`fs.dirs` + ssh)、
  作成はローカルのまま `session.create`。セッションメタに `ssh: user@host`。
  作業フォルダーダイアログはリモートで `~` 展開+絶対パス必須。EN/JA 対応。
- **検証**: `packages/desktop/scripts/ssh-e2e.mjs` を 39 項目に拡張 — プロキシプロファイル
  保存、リモートフォルダー閲覧、ローカル UI のままセッション作成、meta 表示、
  `@write` がリモート cwd に着地、`fs.read`/`fs.suggest` のバックエンド追従、
  非画像アップロード(プロキシ+familiar サーバ両方式)、EN 文字列。
  エンジン単体(偽 ssh + ローカル serve)でも 14 項目確認。typecheck / smoke 通過。

## v0.1.0 の実装メモ㊳(2026-10-26、MCP/LSP のリモート実行・添付の自動掃除)

- **stdio プロセスのリモート起動**: `sshStdioSpec(target, command, args, {env,cwd})`
  (packages/core/src/exec/ssh.ts)を追加。子プロセスが ssh クライアントになり、その
  stdio がリモート側プロセスの stdio になる(MCP / 言語サーバーを無改造で遠隔実行)。
  base 引数は `sshArgs()` に共通化。
- **MCP**: `McpHub(cfg, { remote })` は各サーバーを ssh 経由で起動。サーバーは
  シェルではなく stdio スペックで spawn する(`McpClient` に spawnSpec を追加)。
  `mcp.servers.<name>.remote: { command, args, env, cwd }` で上書き可能。
  AgentServer は ssh 先ごとに hub をキャッシュし、`session.send` で
  `extraTools`(リモートツール)+ `excludeToolPrefix: "mcp__"`(ローカル MCP の除外)を
  渡す。`task` サブエージェントにも継承。`mcp.status` は `session` 付きで呼ぶと
  そのホストの状態を返す(GUI の拡張機能セクションは現在のセッションを渡す)。
  ついでに **既存バグ修正**: MCP コマンドが存在しない場合に `stdin.write` の EPIPE が
  未処理例外となり serve ごと落ちていた(コマンド不在の設定で再現)→ stdin の
  error ハンドラと writable チェックで「起動失敗として記録」に変更。
- **LSP**: `LspTransport`(spawnSpec / uriFor / readText)を導入し、`LspClient` は
  ファイル内容を transport 経由で取得、URI は ssh では posix で生成。ssh 先ごとに
  `getSshLspHub(config, target, backend)` をキャッシュ(`disposeSshLspHubs`)。
  `lsp.servers.<name>.remote: { command, args, cwd }` で上書き可能。
  `lsp_diagnostics` は proxy セッションでリモートの言語サーバーを使う。
- **添付の自動掃除**: `ExecBackend.removeTree` を追加し、`session.delete` で
  `<ホーム>/.familiar/uploads/<session>` を削除。serve は `startUploadPruner()`
  (起動時+6 時間ごと)でローカルの古い添付を削除。保持日数は
  `uploads.retention_days`(既定 30、0 で無効)。
- **テスト**: mock プロバイダに `@dump-prompt-tools`(広告ツール一覧)を追加。
  ssh-e2e を 45 項目に拡張 — 偽 ssh の PATH/HOME をリモート専用にし、
  `mcp-home-mock`($HOME をツール名にする MCP)と言語サーバー shim がリモート PATH に
  しか無い状態で、proxy セッションが `mcp__remote__where_remote_home` を広告し
  `lsp_diagnostics` が MOCK001 を返すこと、ローカルセッションは当該 MCP を
  広告しないこと、セッション削除でリモート添付が消えることを検証。
  typecheck / smoke 通過。

## v0.1.0 の実装メモ㊴(2026-10-26、WebUI からの SSH 接続(サーバ側でプロファイル/トンネル管理))

- **サーバ側モジュール** `packages/server/src/ssh-connections.ts`: プロファイル
  (`~/.familiar/desktop.json` を**デスクトップと共有**、0600・秘密情報なし)、
  軽量プローブ(`$HOME`/hostname/platform/`familiar --version` の有無)、
  リモート serve + トンネル + トークン受け渡し(desktop/ssh.js の同等実装)。
  トンネルの待ち受けは `server.bind` に追従(`0.0.0.0` は LAN からも到達可能)。
- **RPC**: `conn.list`(connections + current)/ `conn.save` / `conn.delete` /
  `conn.test`(id か profile。proxy は familiar 不要のプローブ)/ `conn.connect`
  (url/token/stop/host/hostname を返す)/ `conn.disconnect` / `conn.status`。
- **capability stop**: `GET /tunnel/stop?stop=<32hex>` を認証不要・CORS 可で追加し、
  リモート UI からトンネルを閉じられるように(ローカルのベアラトークンは
  リモート側へ渡さない)。閉じ忘れは 12 時間 TTL(`FAMILIAR_TUNNEL_TTL_MS` で上書き可)で
  自動切断。ローカル UI は `conn.status` で接続中トンネルを表示・手動切断できる。
- **WebUI**: 接続 API を `connApi()` に集約し、preload が無ければ RPC 実装
  (`rpcConnApi`)にフォールバック。ブラウザからプロファイル管理・プロキシセッション
  作成・familiar サーバ方式のトンネル遷移(`?token…&remote=1&stop=…&local=…`)が可能。
  リモート UI の「ローカルに戻る」は stop エンドポイント→ローカルへ遷移。
  デスクトップの proxy プロファイルの「接続テスト」はサーバのプローブへ委譲
  (リモートに familiar が無くても検証できる)。
- **テスト**: ssh-e2e を **58 項目**に拡張 — デスクトップ保存プロファイルをサーバ RPC が
  読めること、RPC での保存/プローブ、サーバ側トンネルの healthz 到達・conn.status・
  capability stop での切断、ブラウザ用トンネル URL(remote/stop/local 付き)が
  リモート UI を返すこと、`connApiOverride` で preload 無し経路(実行先リスト→
  プロキシセッション作成)を通すこと。typecheck / smoke 通過。

## v0.1.0 の実装メモ㊵(2026-10-27、ホスト鍵の確認・登録 UI と PATH 堅牢化)

- **ホスト鍵の確認と登録**: 初回接続が `StrictHostKeyChecking=yes` で失敗する問題に対し、
  `conn.hostkey`(`ssh-keyscan` → SHA256 フィンガープリント、`FAMILIAR_SSH_KEYSCAN_BIN` で
  差し替え可)と `conn.trusthost`(検証済み行を `~/.ssh/known_hosts` へ追記、
  `FAMILIAR_SSH_KNOWN_HOSTS` で上書き可)を追加。**既存と異なる鍵は自動登録を拒否**し、
  同一鍵はスキップ。デスクトップは `conn:hostkey`/`conn:trusthost` としてサーバ RPC に
  委譲。接続フォームに「🔑 ホスト鍵を確認…」→ fingerprint 一覧 → 「この鍵を登録」を追加し、
  接続テストがホスト鍵エラーなら自動でパネルを開く。パスワード認証は対象外である旨と
  `ssh-keygen`/`ssh-copy-id` の案内もエラー時に表示。
- **exec の PATH 堅牢化**: 停止した AppImage の FUSE マウント(`/tmp/.mount_*`)が PATH に
  残ると exec が ENOTCONN を返し、node の spawn が PATH 探索の途中で例外になる
  (ssh が見つからない・ビルドが silent に死ぬ等)。`resolveExecutable()`
  (packages/core/src/exec/resolve.ts)で `fs.existsSync` による探索に切り替え、
  core/server/desktop の ssh・ssh-keyscan 起動を全て絶対パス化。
- **テスト**: ssh-e2e を **67 項目**に拡張 — 偽 `ssh-keyscan` でスキャン/SHA256/0600 追記/
  再登録スキップ/鍵変更の拒否/`[host]:port` 表記/デスクトップ委譲/設定フォームからの
  確認と登録。テストハーネスは死んだマウントを含む PATH を除去して起動。
  typecheck / smoke 通過。

## v0.1.0 の実装メモ㊶(2026-10-27、パスワード認証(SSH_ASKPASS)と失敗バックオフ)

- **背景**: 「リモートに何も置かず、鍵も配らずに接続したい」(Claude Code デスクトップと
  同じ運用)。対象ホストは password 認証を提供していたが、鍵が未配布のため Permission
  denied、さらに連打で sshd/fail2ban のレート制限(kex リセット)を誘発していた。
- **パスワード認証**: `packages/core/src/exec/ssh-auth.ts`
  - 秘密は `<familiar home>/secrets/ssh-<sha256(user@host:port)[0:16]>.pass`(0600)。
  - ssh へは `SSH_ASKPASS`(0700 の一時ヘルパーが `$FAMILIAR_ASKPASS_FILE` を cat)+
    `SSH_ASKPASS_REQUIRE=force` で渡す。パスワードは argv/環境/ログ/state.db に残らない。
  - パスワード対象では `BatchMode=yes` を外し `NumberOfPasswordPrompts=1` +
    `PreferredAuthentications=publickey,password` を付与(鍵優先・1 回試行)。
  - `sshArgs`/`sshStdioSpec`(MCP・LSP の ssh 起動)に自動反映。
- **プロファイル**: `auth: "key" | "password"` を追加。`conn.save` は `password`(文字列=保存、
  null=削除)を受け付け、`conn.list` は `hasPassword` を返す(秘密は返さない)。
  プロファイル削除で秘密も削除。WebUI フォームに「認証方式」+ パスワード欄 + 削除ボタン +
  保存先の説明を追加。デスクトップは保存/削除/テスト/一覧をサーバ RPC に委譲し、
  自前トンネルにも askpass を実装。
- **失敗バックオフ**: 同一ホストへの ssh が認証/ホスト鍵/リセットで失敗したら 60 秒間
  接続試行を停止(`sshCooldownError`/`noteSshOutcome`)。コアの SshBackend・サーバの
  プローブ/トンネルで共有。UI は「paused connection attempts…」+ 対処ヒントを表示。
  フォルダー閲覧の debounce も 700ms にし、per-keystroke の ssh を止めた。
- **テスト**: ssh-e2e を **81 項目**に拡張 — 偽 ssh がパスワード(askpass ファイル)を検証。
  秘密 0600・askpass ヘルパー出力・削除、RPC 保存と hasPassword、鍵なし接続、
  秘密のハッシュ配置、**プロファイル/state.db に平文が残らない**、パスワード経由の
  セッションで write ツール、誤パスワードのエラー、認証/リセットのバックオフ、
  設定フォームからの保存。typecheck / smoke 通過。

## v0.1.0 の実装メモ㊺(2026-11-04、「反応がなくなる」調査と自動継続)

- **「一定時間経過すると反応しない」の実測原因**: 大きな履歴のセッション(実測 19 万
  トークン)は、モデルサーバの prefix キャッシュが冷えている間の prefill に
  **134 秒**かかる(同一セッションの 2 回目以降は 1.5 秒。小さいセッションは 9 秒)。
  ユーザーが待ちきれず停止→再送を繰り返すと毎回 prefill がやり直しになり、
  「無反応」に見え続ける。実データでは 5 連続の送信がすべて abort され、
  アシスタント応答が 1 つも残っていなかった(abort は debug ログで不可視だった)。
- **改善**:
  - 送信直後の「受信しました」バブルに、**25 秒待っても最初のトークンが来ない場合は
    「まだ応答を待っています…(しばらくぶり・大きな履歴では数分かかることがある)」**の
    説明を追加。経過秒は従来どおり表示。
  - **abort を info ログ化**(session id + 先頭 60 文字)。静かに消えたターンを後から追える。
  - **停止したターンにワンクリック「再実行」ボタン**を追加(トップバーの停止表示の隣)。
- **途中で止まる問題**: `maxSteps=25` の窓で打ち切られ、**何も言わずツール結果で
  途切れる**ことが原因(1e513789 の全 31 ターン中 9 ターンが最終発言なしで終了。
  「続けて」はこの再開操作だった)。改善:
  - ループは 25 ステップの窓を超えると `turn.continuing` イベントを出して
    **自動継続**。上限は `context.max_turn_steps`(既定 100)。
  - 上限到達時は `turn.ceiling` イベント + 「(上限に達しました。「続けて」で再開)」の
    マーカーを履歴に残し、UI にワンクリックの「▶ 続けて」ボタンを表示(無言で
    止まらない)。
  - モデルが **未完了 TODO を残したまま質問せずに終了**した場合も、システム
    ノートで自動継続(最大 2 回/ターン、末尾が疑問文なら継続しない)。
  - mock プロバイダに `@repeat <n>`(n 連続ツール呼び出し)を追加し、smoke に
    シナリオ R(窓超えの自動継続 / 上限マーカー)を追加。ssh-e2e は 107 項目に
    (自動継続と上限のノート、停止後の再実行ボタン、長時間待ちの説明)。

## v0.1.0 の実装メモ㊹(2026-11-01、デスクトップのアプリアイコン)

- **症状**: Linux(展開した AppImage を `AppRun` で起動)でタスクバーに汎用の歯車アイコン。
- **原因(実測)**: (a) Wayland の app_id は Electron が `package.json` の `desktopName`
  (無ければ `{app.name}.desktop`、app.name は productName が無いため `@familiar/desktop`)から
  作り、ユーザーの `familiar-harness.desktop` と不一致 → KDE が .desktop に紐付けできない。
  (b) パッケージに `build/icon.png` が含まれず `BrowserWindow({ icon })` が未指定のため
  `_NET_WM_ICON` も空(X11 のフォールバックも効かない)。
- **修正**: `desktopName: "familiar-harness.desktop"`(Wayland app_id = familiar-harness →
  `familiar-harness.desktop` と一致)、`extraResources` で `resources/icon.png` を同梱して
  `resolveWindowIcon()`(resources → dev build → repo public の順)を `BrowserWindow({ icon })`
  に渡す、`linux.syncDesktopName: true` で生成 .desktop 名を desktopName に同期。
  X11 の WM_CLASS は `app.name` のままだが `_NET_WM_ICON` でアイコン表示される。
- **確認**: linux-unpacked を Xvfb で起動し `_NET_WM_ICON` に 512x512 データが入ること、
  パッケージ内 package.json に desktopName が残ること、AppImage 内 .desktop が
  `familiar-harness.desktop`(StartupWMClass=familiar-harness)になることを実測。Windows は
  exe に `build/icon.ico` が埋め込まれていることを確認(従来から表示される)。

## v0.1.0 の実装メモ㊸(2026-10-30、全削除の無条件ブロック・重複送信の修正・受信表示)

- **ファイルシステム全削除を deny に格上げ**: `rm` の対象が `/`・`/*`・システム
  ディレクトリ(`/etc` 等)そのもの・`~` / `$HOME`・Windows ドライブルート、
  `--no-preserve-root`、`find / -delete` / `find ... -exec rm`、`dd of=/dev/sd*`
  などを `permissions.bash.deny` に追加。**承認でも `--yolo` でも実行不可**。
  深いサブパス(`/home/user/work/x` 等)は従来どおり ask(承認で実行可)。
  初期 config テンプレートも 3 層(mode/allow/ask/deny)を案内する形に更新。
- **重複送信の原因と修正(実データで確認)**: 「already running ならキューに積んで
  ターン終了後に送る」フォールバックが、**実行中と同じ本文の再送**(Enter の重複・
  再読込したタブ・/retry)でも再送してしまい、エージェントが同じ依頼を 2 回受信して
  いた(サーバログの拒否 09:46:38 / 10:20:06 と、その直後の自動再送を DB で確認)。
  修正: `session.send` の拒否エラーに**実行中メッセージ本文**(`error.data.runningText`)
  を同梱し、クライアントは本文一致なら破棄(「同じ内容がすでに実行中です」)。
  `turn.start` イベントと `session.get` にも実行中本文を追加し、別クライアントからの
  同一文再送もクライアント側で弾く。異なる本文は従来どおりキュー(可視チップ)。
- **Enter の挙動修正**: デプロイ版は動作中の Enter が `composerAction` 経由で
  **ターンを停止**していた(設計意図と逆)。Enter は常に送信(動作中はキュー)、
  停止は ■ ボタンのみに変更。
- **「受信しました」表示**: 送信直後〜最初のトークンまで、ユーザーのメッセージ直下に
  アニメーションドット +「受信しました — 応答を生成しています」+ 経過秒を表示
  (最初の delta / ツール実行で消える)。トップバーは `実行中… Ns` とアクセント色に。
- **実行中状態の共有**: `session.get`/`session.list` が `running`/`runningStartedAt`/
  `runningText` を返し、再読込・別クライアントでも実行中を復元(送信が「無反応」に
  見える問題の解消)。サイドバーにも実行中ドット。
- **テスト**: mock プロバイダに `@hold <ms>`(ターンを開いたまま待機)を追加。
  smoke に承認判定表 28 ケース、ssh-e2e に「同一文はキューに積まない/セッションに
  届かない」「別文は 1 回だけ届く」「受信表示の出現と消滅」「Enter でキュー」を追加。

## v0.1.0 の実装メモ㊷(2026-10-30、UI 改善・承認緩和・利用量/圧縮の修正)

- **空状態**: 送信後に「まだメッセージがありません」が残る問題を修正(ライブ追記で
  `.empty-state` を削除)。文言は「このセッションで何をお手伝いしますか?」に変更。
- **ロゴ**: トップバーの `◍` と空状態のグリフを `icon-32/192.png` の img に置換。
- **bash 承認の 3 層化**: `deny`(無条件ブロック)/`ask`(承認)/`allow`(承認なし)とし、
  `permissions.bash.mode: allow` を既定に。破壊的・外部送信系(`rm -rf`、`sudo`、
  `curl -d`、`git push --force`、`docker prune`、`systemctl stop` 等)は ask、
  復旧不能な `> /dev/sd*`・デバイスへの `mkfs` のみ deny。**`rm -rf` は承認すれば実行可**。
  承認ダイアログには判定理由(一致したパターン)を表示。`mode: ask` で旧挙動。
- **セッション一覧の実行先区別**: グループキーを `target|cwd` に変更し、
  見出しにバッジ(`💻 ローカル` / `🖥 user@host`)を表示。検索は host も対象、
  新規セッションの「最近のフォルダー」はローカルセッションのみに。
- **動作中の追加指示(キュー)**: 入力欄を常時編集可にし、動作中の Enter は
  「送信待ち」チップに積んでターン終了後に自動送信。任意で ⚡(実行中のターンを停止して
  即送信)。**「already running」(他端末/他タブがターン実行中)は失敗にせず**、
  そのターンの終了を待って送信するよう変更。
- **利用量表示の修正**: `turn.end` の usage は全ステップの合算だったため
  マルチステップのターンで 200% 超の誤表示になっていた(実測: 直前ステップ 95,494 tok
  に対し合算 842 万)。`Usage.contextTokens`(最終ステップの prompt)を追加して
  ゲージはこれを表示、合算は `totalPromptTokens` として保持。100% 超は赤表示+
  「次のターンで自動的に圧縮されます」。
- **コンパクション(90%)**: 発動判定に**直前ターンの実測 promptTokens**(履歴の
  meta.usage)を併用し、`context.compaction.ratio: 0.9`(既定)で**モデルのコンテキスト
  ウィンドウの 90%** に達したら圧縮。`token_soft_limit` は絶対上限(既定 0 = 無効)に変更、
  ウィンドウ未取得時は 128k にフォールバック。モデルウィンドウは `models.list` の結果を
  サーバがキャッシュ(GUI 取得済みなら即利用、未取得なら背景取得)。
  ※従来は文字数推定(chars/4)のみで、日本語では実トークンの 1/3〜1/4 に過小評価され
  実測 95k でも推定 40k で発動しない状態だった。
- **コードブロックのコピー**: `wireCodeButtons` は履歴描画時のみ配線されていたため、
  **ストリーミング中のライブ更新とファイルプレビューでは無反応**だった。document への
  イベント委譲に変更し、どこでも動作。Electron では `familiarDesktop.writeClipboard`
  (clipboard.writeText)を使用(平文 HTTP の LAN では Clipboard API が使えないため)。
  失敗時はトーストで案内、`show all`/`collapse` も i18n 化。
- **テスト**: smoke に承認 3 層のシナリオ Q(safe=自動/rm -rf=承認/--yolo で実行/
  mkfs はハードブロック)を追加。ssh-e2e を **95 項目**に拡張(空状態の消滅、
  実行先バッジで 2 グループ、キュー投入とドレイン、ライブなコードブロックのコピー)。
  typecheck / smoke / e2e 通過。
