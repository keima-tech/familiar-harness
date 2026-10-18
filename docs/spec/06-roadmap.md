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
  1 回だけ外して再送し失敗させる。halogen 実機で turn.end に
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
  halogen=524288、ollama LFM2.5=131072 を実機確認。
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
