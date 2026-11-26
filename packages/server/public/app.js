/* Familiar web UI (v1.0, rich) — vanilla JS, no build step.
 * Talks to the same RPC surface as the CLI/desktop:
 *   POST /rpc  JSON-RPC         WS /ws  shared event stream
 * Features: markdown assistant messages (safe renderer), collapsible tool
 * cards, session filter + delete, provider/model/profile picker, approomatic
 * approval dock + inbox, status drawer, toasts, turn timer + token usage.
 */
"use strict";

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

/** Desktop SSH handoff: the shell loads this page as
 *   /?token=…&remote=1&conn=<id>&host=<hostname>[&new=1&cwd=…]
 * Read the launch flags *before* the token handler strips the query string. */
const bootQuery = new URLSearchParams(location.search);
const remoteBoot = {
  isRemote: bootQuery.get("remote") === "1",
  connId: bootQuery.get("conn") ?? "",
  host: bootQuery.get("host") ?? "",
  wantNewSession: bootQuery.get("new") === "1",
  cwd: bootQuery.get("cwd") ?? "",
  /** browser-initiated tunnel (WebUI, no desktop shell): capability stop id */
  stop: bootQuery.get("stop") ?? "",
  /** …and the local UI origin to return to */
  local: bootQuery.get("local") ?? "",
};

/** M2 server auth: the token arrives once via ?token= and is kept in
 * sessionStorage so the address bar/history never carries it. */
let serverToken = "";
try {
  serverToken = sessionStorage.getItem("familiar.token") ?? "";
} catch { /* storage unavailable */ }
{
  const q = new URLSearchParams(location.search).get("token");
  if (q) {
    serverToken = q;
    try { sessionStorage.setItem("familiar.token", q); } catch { /* ignore */ }
    history.replaceState(null, "", location.pathname);
  }
}

/** crypto.randomUUID() only exists in secure contexts (https / localhost).
 * Plain-http LAN access falls back to a getRandomValues-based UUID v4. */
function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function rpc(method, params = {}) {
  const headers = { "Content-Type": "application/json" };
  if (serverToken) headers["Authorization"] = `Bearer ${serverToken}`;
  const res = await fetch("/rpc", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: uuid(), method, params }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showAuthHint();
    throw new Error("unauthorized");
  }
  if (body.error) {
    const err = new Error(body.error.message ?? JSON.stringify(body.error));
    err.code = body.error.code;
    if (body.error.data !== undefined) err.data = body.error.data;
    throw err;
  }
  return body.result;
}

/** Rendered when the server requires a bearer token we do not have. */
function showAuthHint() {
  const tr = $("#transcript");
  if (tr.querySelector(".auth-hint")) return;
  tr.innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty-state auth-hint";
  div.innerHTML = `
    <div class="glyph">🔒</div>
    <h3>${esc(t("auth.required"))}</h3>
    <div class="hint">${esc(t("auth.hint"))}</div>`;
}

// ---------------------------------------------------------------------------
// i18n — ja is the default and canonical locale; en is switchable in settings
// ---------------------------------------------------------------------------
const STR = {
  ja: {
    "side.newSession": "新規セッション",
    "side.filterPh": "セッションを絞り込み…  (Ctrl+K)",
    "side.foldAll": "すべてのフォルダーを折りたたむ",
    "side.unfoldAll": "すべてのフォルダーを展開する",
    "side.settings": "設定",
    "tabs.close": "タブを閉じる",
    "top.inbox": "承認インボックス",
    "top.status": "ステータス",
    "del.confirm": "セッション「{0}」を削除しますか? この操作は元に戻せません",
    "none": "(なし)",
    "top.noSession": "セッションなし",
    "top.gaugeTitle": "コンテキスト使用量 — クリックでセッション情報",
    "top.gaugeNoTurn": "コンテキスト使用量 — 次のターン送信後に表示",
    "side.noFolder": "フォルダーなし",
    "side.local": "ローカル",
    "queue.title": "送信待ち ({0})",
    "queue.cancel": "この送信待ちを取り消す",
    "queue.sendNow": "今すぐ送信(実行中のターンを停止)",
    "queue.waiting": "実行中のため待機中",
    "queue.queued": "送信待ちに追加しました ({0})",
    "turn.received": "受信しました — 応答を生成しています",
    "turn.longWait": "まだ応答を待っています… しばらくぶり・大きな履歴のセッションでは、最初の応答に数分かかることがあります",
    "turn.noteSteps": "↻ ステップ上限に達したため自動継続します ({0}/{1})",
    "turn.noteTodos": "↻ 未完了のTODOがあるため自動継続します ({0}/{1})",
    "turn.noteCeiling": "ステップ上限({0})に達しました — 続行するには「続けて」",
    "turn.noteCompaction": "コンテキストを圧縮しました（古い {0} 件を要約/削除、直近 {1} 件を保持）",
    "turn.noteCompactionForced": "プロバイダがプロンプト長を拒否したため、圧縮して再試行しました（{0} 件削除）",
    "turn.retryNow": "再実行",
    "turn.continueNow": "続けて",
    "turn.continueWord": "続けて",
    "turn.working": "実行中… {0}",
    "toast.dupRunning": "同じ内容がすでに実行中です(重複送信はしません)",
    "side.running": "実行中",
    "queue.otherDevice": "他の端末でターンが実行中です — 送信待ちに追加しました",
    "composer.phBusy": "追加の指示を入力(実行中のターンに取り込まれます)",
    "usage.overNote": "コンテキストウィンドウを超えています — 次のターンで自動的に圧縮されます",
    "msg.copyFailed": "コピーできませんでした — テキストを選択してコピーしてください",
    "code.showAll": "すべて表示",
    "code.collapse": "折りたたむ",
    "chip.ctx": "コンテキスト使用量",
    "update.available": "アップデートがあります — v{0}(⬇ から適用)",
    "update.downloading": "アップデートをダウンロード中…",
    "update.applied": "v{0} を適用しました — ↻ で再起動してください",
    "update.restartTitle": "再起動して v{0} を適用",
    "update.uptodate": "最新です (v{0})",
    "update.failed": "アップデートに失敗しました: {0}",
    "update.cliHint": "ブラウザ版の更新は `familiar update` で実行できます",
    "update.remoteHint": "SSH 接続中はリモート側で `familiar update` を実行してください",
    "menu.updateCheck": "アップデートを確認",
    "top.files": "ファイル",
    "pane.ctx": "コンテキスト",
    "set.colorTheme": "カラーテーマ",
    "set.colorThemeDesc": "アクセントの配色プリセット",
    "set.fontFamily": "フォント",
    "set.fontFamilyDesc": "UI 全体のフォント(等幅エリアを除く)",
    "font.system": "システム既定",
    "font.gothic": "ゴシック体",
    "font.serif": "明朝体",
    "font.mono": "等幅",
    "set.about": "このアプリについて",
    "set.systemStats": "システム状態",
    "set.version": "バージョン",
    "set.developer": "開発者",
    "conn.title": "コネクタ",
    "conn.desc": "外部サービスとの接続設定。保存すると AI がコネクタツール経由で利用できます。",
    "conn.serverGroupTitle": "サーバー",
    "conn.serverGroupDesc": "MCP / LSP サーバーの接続状態と設定",
    "conn.externalGroupTitle": "外部サービス",
    "conn.externalGroupDesc": "Gmail / GitHub などの外部サービスに接続します。",
    "conn.baseUrl": "ベース URL (例: https://example.atlassian.net)",
    "conn.email": "メールアドレス",
    "conn.token": "API トークン",
    "conn.apiKey": "API キー",
    "conn.save": "保存",
    "conn.test": "接続テスト",
    "conn.saved": "保存しました",
    "conn.googleDesc": "OAuth 同意後に Gmail とカレンダーを読み取れます。redirect URI として http://<このサーバ>:46210/oauth/callback を Google Cloud のクライアントに登録してください",
    "conn.googleAuth": "Google と連携",
    "conn.googleAuthHint": "Google の同意画面で許可すると自動で戻ります",
    "conn.delete": "削除",
    "conn.ok": "接続OK",
    "skills.newName": "スキル名 (例: deploy-check)",
    "skills.create": "新規作成",
    "skills.save": "保存",
    "skills.saved": "スキルを保存しました: {0}",
    "skills.loading": "読み込み中…",
    "skills.pendingToast": "AI がスキル作成を提案しています({0}件)",
    "skills.suggestTitle": "AI がスキルの作成を提案しています",
    "skills.approveCreate": "承認して作成",
    "skills.rejectShort": "却下",
    "skills.createdMsg": "スキルを作成しました — 設定 → スキル で編集できます",
    "skills.rejectedMsg": "提案を却下しました",
    "skills.dismiss": "閉じる",
    "skills.dismissTitle": "このカードを閉じます",
    "skills.partialResult": "{0} 件成功 / {1} 件失敗: {2}",
    "skills.stale": "適用不可 — 対象のスキルが提案後に変更されています",
    "skills.staleShort": "適用不可(対象が変更済み)",
    "skills.delete": "削除",
    "skills.cancel": "キャンセル",
    "skills.deleteConfirm": "スキル「{0}」を削除しますか?\n(アーカイブへ移動されるので元に戻せます)",
    "skills.deleted": "スキルを削除しました: {0}",
    "skills.filterPh": "スキルを絞り込み…",
    "skills.selectAll": "すべて選択/解除",
    "skills.filterEmpty": "一致するスキルがありません",
    "skills.deleteSelected": "選択を削除 ({0})",
    "skills.deleteSelectedConfirm": "選択した {0} 件のスキルを削除しますか?\n(アーカイブへ移動されるので元に戻せます)",
    "skills.deletedBulk": "{0} 件のスキルを削除しました",
    "notify.skillSuggest": "Familiar Harness — スキル作成の提案",
    "pane.files": "ファイル",
    "skills.edit": "スキルの編集",
    "files.loading": "読み込み中…",
    "files.loadFailed": "読み込めませんでした: {0}",
    "files.refresh": "再読み込み",
    "files.empty": "(空のフォルダー)",
    "files.back": "一覧に戻る",
    "files.truncated": "先頭 256KB のみ表示",
    "files.preview": "プレビュー",
    "files.source": "ソース",
    "files.openExternal": "外部アプリで開く",
    "files.binary": "バイナリファイルです({0})— プレビューできません",
    "files.tooLarge": "ファイルが大きすぎるためプレビューできません({0})— 外部アプリで開いてください",
    "files.csvRows": "{0} 行 × {1} 列",
    "files.sheet": "シート: {0}",
    "files.slide": "スライド {0}",
    "files.docxEmpty": "(内容がありません)",
    "fmenu.open": "開く",
    "fmenu.openApp": "アプリ内で開く",
    "fmenu.openOs": "既定のアプリで開く",
    "fmenu.openFolder": "フォルダを開く",
    "fmenu.copyPath": "パスをコピー",
    "fmenu.copyRel": "相対パスをコピー",
    "fmenu.addContext": "コンテキストに追加",
    "fmenu.copied": "パスをコピーしました",
    "fmenu.copyFailed": "コピーできませんでした",
    "fmenu.rename": "名前を変更…",
    "fmenu.renameTitle": "名前を変更",
    "fmenu.renameOk": "変更",
    "fmenu.renameFailed": "名前を変更できませんでした: {0}",
    "fmenu.delete": "削除…",
    "fmenu.deleteConfirm": "「{0}」を削除しますか?(元に戻せません)",
    "fmenu.renamed": "名前を変更しました",
    "fmenu.deleted": "削除しました",
    "fmenu.deleteFailed": "削除できませんでした: {0}",
    "tpl.intro": "Word / Excel / PowerPoint のテンプレートを登録すると、office_create がそのデザイン(スタイル・テーマ・レイアウト・用紙設定)を引き継いでファイルを作成します。",
    "tpl.add": "テンプレートを追加",
    "tpl.empty": "まだテンプレートが登録されていません",
    "tpl.delete": "削除",
    "tpl.confirm": "テンプレート「{0}」を削除しますか?",
    "tpl.deleted": "削除しました",
    "tpl.added": "テンプレート「{0}」を登録しました",
    "tpl.importFailed": "登録できませんでした: {0}",
    "tpl.how": "使い方: office_create に template: \"<名前>\" を渡します。「default」という名前で登録すると、指定なしで自動的に使われます。",
    "files.copyMd": "Markdown でコピー",
    "files.copied": "コピーしました",
    "notify.approvalTitle": "Familiar Harness — 承認が必要",
    "notify.turnDone": "Familiar Harness — ターン完了",
    "notify.turnFailed": "Familiar Harness — ターン失敗",
    "notify.turnFailed": "ターンがエラーで終了",
    "ctx.used": "使用",
    "ctx.window": "上限",
    "ctx.free": "残り",
    "ctx.noteNoTurn": "最初のターン送信後に表示されます(毎ターン全文を再送するため、直前のプロンプト=現在のコンテキスト)",
    "ctx.noteNoWindow": "このモデルの上限コンテキストは未取得です(モデル一覧から取得できませんでした)",
    "ctx.noteHint": "{0} / {1} tok を使用",
    "ctx.noteEstimated": "履歴から推定した値(≈)です。ターン実行後に実測値へ更新されます。",
    "ctx.assumed": "(既定)",
    "ctx.breakdownTitle": "プロンプト内訳",
    "ctx.system": "システム",
    "ctx.tools": "ツール定義",
    "ctx.history": "会話履歴",
    "ctx.toolResults": "ツール結果",
    "ns.title": "新規セッション",
    "ns.search": "フォルダーを検索・入力… (例: ~/work)",
    "ns.pickFolder": "作業フォルダーを選択",
    "ns.create": "作成",
    "ns.noRecent": "最近のフォルダーはまだありません — 上に入力してください",
    "ns.noMatch": "一致するフォルダーがありません",
    "ns.sessions": "{0} セッション",
    "ns.errNoFolder": "作業フォルダーを選択するか入力してください",
    "ns.target": "実行先",
    "ns.localMachine": "このマシン",
    "ns.localHint": "このコンピューターで実行",
    "ns.addSsh": "SSH サーバを追加…",
    "ns.addSshHint": "設定 → 接続 でホストを登録",
    "ns.connect": "接続",
    "ns.connecting": "接続中…",
    "ns.connectFailed": "接続できませんでした: {0}",
    "ns.remoteCwd": "リモートの作業フォルダー (任意)",
    "ns.remoteHint": "接続後、リモート側のフォルダーを選べます。空欄ならホームディレクトリから始まります。",
    "ns.serveBadge": "familiar サーバ",
    "ns.proxyBadge": "SSH プロキシ",
    "ns.proxyHint": "このフォルダーでリモートのセッションを作成します。~ はホームに展開され、work のような相対名もホーム基準で解決されます(入力に合わせて候補を表示)",
    "ns.resolvedTo": "使用されるパス: {0}",
    "ns.remoteSuggestions": "フォルダーの候補 ({0})",
    "ns.noFolderHere": "このフォルダーにはサブフォルダーがありません",
    "ns.retry": "再試行",
    "set.uiBuild": "UI ビルド",
    "ns.creating": "作成中…",
    "top.search": "トランスクリプト内検索 (Ctrl+F)",
    "top.sessionActions": "セッション操作",
    "top.sessions": "セッション一覧",
    "menu.rename": "名前を変更…",
    "menu.export": "Markdown で出力",
    "menu.delete": "セッションを削除…",
    "menu.deleteShort": "削除…",
    "search.ph": "トランスクリプトを検索…",
    "search.close": "検索を閉じる",
    "composer.plus": "添付・追加",
    "composer.retry": "直前の操作を再実行",
    "toast.noRetry": "再実行するメッセージがありません",
    "plus.file": "📎 ファイルを添付…",
    "plus.ctx": "＠ コンテキスト追加",
    "plus.shell": "❯ シェルコマンド",
    "chip.mode": "権限モード",
    "chip.model": "セッションのモデル",
    "mode.plan": "Plan",
    "mode.planDesc": "読み取り専用。編集やコマンドは実行しません",
    "mode.ask": "承認を求める",
    "mode.askDesc": "設定で許可されていない編集やコマンドの前に確認します",
    "mode.edit": "編集を許可",
    "mode.editDesc": "ファイルの編集と操作を承認し、それ以外は確認します",
    "mode.yolo": "フルアクセス",
    "mode.yoloDesc": "編集やコマンドの前に確認しません",
    "mic.start": "音声入力を開始",
    "mic.stop": "音声入力を停止",
    "mic.unsupported": "この環境では音声入力を使えません(デスクトップアプリでは未対応。ブラウザ版 Web UI でご利用ください)",
    "mic.denied": "マイクの使用が許可されませんでした",
    "chip.modelLabel": "モデル",
    "mp.search": "モデルを検索…",
    "mp.manage": "モデルを管理",
    "mp.unreachable": "一覧取得失敗",
    "msg.copy": "回答をコピー",
    "msg.thinking": "思考",
    "send.enter": "送信 (Enter)",
    "send.ctrlEnter": "送信 (Ctrl+Enter)",
    "send.stop": "停止",
    "composer.phEnter": "何でも聞いてください (Enter で送信 / Shift+Enter で改行)",
    "composer.phCtrl": "何でも聞いてください (Ctrl+Enter で送信 / Enter で改行)",
    "composer.phMobile": "何でも聞いてください (Enter で改行 / ↑ で送信)",
    "drawer.inbox": "承認インボックス",
    "drawer.status": "システム状態",
    "drawer.info": "セッション情報",
    "settings.title": "設定",
    "settings.close": "閉じる (Esc)",
    "nav.general": "一般",
    "todo.progress": "タスク: {0}/{1} 完了",
    "nav.appearance": "外観",
    "nav.transcript": "トランスクリプト",
    "nav.shortcuts": "ショートカット",
    "nav.providers": "プロバイダー",
    "nav.skills": "スキル",
    "nav.templates": "テンプレート",
    "nav.connectors": "コネクタ",
    "nav.connections": "接続",
    "nav.cron": "Cron",
    "nav.approvals": "権限",
    "nav.websearch": "Web検索",
    "nav.memory": "メモリ",
    "nav.system": "このアプリについて",
    "perm.desc": "bash コマンドの allow/ask/deny ポリシーを編集できます。組み込みの保護パターンは常に union されます。下のテスターで判定を確認できます。",
    "perm.mode": "既定モード",
    "perm.modeHint": "allow=一致しない限り実行 / ask=毎回承認",
    "perm.modeAllow": "allow(自動実行)",
    "perm.modeAsk": "ask(毎回承認)",
    "perm.allow": "allow(承認なしで実行するパターン)",
    "perm.ask": "ask(承認が必要なパターン)",
    "perm.deny": "deny(常にブロック)",
    "perm.save": "保存",
    "perm.saved": "権限ポリシーを保存しました",
    "perm.saveFailed": "保存できませんでした: {0}",
    "perm.loadFailed": "読み込めませんでした: {0}",
    "perm.testTitle": "ルールテスタ",
    "perm.testPh": "例: rm -rf /tmp/x",
    "perm.test": "判定",
    "perm.testFailed": "判定できませんでした: {0}",
    "perm.decision.allow": "許可(承認なしで実行)",
    "perm.decision.ask": "承認が必要",
    "perm.decision.deny": "ブロック",
    "perm.webDesc": "DuckDuckGo は設定不要で利用できます。SearXNG を使う場合は、ご自身で用意したインスタンスの URL を設定してください。",
    "perm.webProvider": "検索バックエンド",
    "perm.webProviderHint": "duckduckgo=設定不要 / searxng=下のエンドポイントが必要",
    "perm.webDdg": "DuckDuckGo (既定)",
    "perm.webSearxng": "SearXNG (セルフホスト)",
    "perm.webUrl": "SearXNG エンドポイント",
    "perm.webUrlPh": "http://127.0.0.1:8080",
    "perm.webUrlHint": "http(s) で始まる URL。DuckDuckGo 選択時は保存時にクリアされます。",
    "perm.webSave": "Web 検索設定を保存",
    "perm.webSaved": "Web 検索設定を保存しました",
    "perm.webLoadFailed": "Web 検索設定を読み込めませんでした: {0}",
    "perm.webBadUrl": "エンドポイントは http:// または https:// で始めてください",
    "perm.webNeedUrl": "SearXNG を利用する場合はエンドポイントを入力してください(ご自身でインスタンスを用意してください)",
    "mem.desc": "ここに書いた決定事項や前提は、すべてのセッションで毎ターン読み込まれます。エージェントはこのファイルを自動変更しません。",
    "mem.path": "保存先: {0}",
    "mem.projectHint": "プロジェクト固有の内容は <cwd>/.familiar/MEMORY.md に書くと、そのフォルダのセッションだけに読み込まれます。",
    "mem.save": "MEMORY.md を保存",
    "mem.saved": "MEMORY.md を保存しました",
    "mem.saveFailed": "保存できませんでした: {0}",
    "mem.loadFailed": "読み込めませんでした: {0}",
    "cron.desc": "config の cron.jobs で定義したスケジュール実行。ここから手動実行・一時停止できます。",
    "cron.empty": "スケジュールされたジョブはありません",
    "cron.once": "起動時に1回",
    "cron.every": "{0} 分ごと",
    "cron.run": "今すぐ実行",
    "cron.ran": "{0} を実行しました",
    "cron.failed": "失敗しました: {0}",
    "cron.pause": "一時停止",
    "cron.resume": "再開",
    "cron.enabled": "有効",
    "cron.paused": "一時停止中",
    "remote.back": "ローカルに戻る",
    "remote.badge": "SSH: {0}",
    "remote.badgeTitle": "SSH 接続中: {0} — クリックで接続設定",
    "remote.lost": "SSH 接続が切れました: {0}",
    "remote.current": "現在の接続",
    "remote.readOnly": "リモート接続の設定はローカル側でのみ変更できます。",
    "ssh.title": "SSH 接続",
    "ssh.desc": "SSH ホストを登録します。familiar サーバ方式はリモートで familiar serve を起動してトンネル接続、SSH プロキシ方式はリモートに何も入れずツール呼び出しだけを ssh で実行します。認証は鍵または ssh-agent です。",
    "ssh.mode": "接続方式",
    "ssh.modeServe": "familiar サーバを起動 (要インストール)",
    "ssh.modeProxy": "SSH プロキシ (インストール不要)",
    "ssh.name": "表示名",
    "ssh.host": "ホスト (例: build.example.com)",
    "ssh.user": "ユーザー (任意)",
    "ssh.port": "ポート",
    "ssh.key": "秘密鍵ファイル (任意)",
    "ssh.remoteBin": "リモートの familiar パス (任意)",
    "ssh.save": "保存",
    "ssh.edit": "編集",
    "ssh.addSsh": "SSH 接続を追加",
    "ssh.delete": "削除",
    "ssh.connect": "接続",
    "ssh.test": "接続テスト",
    "ssh.testing": "テスト中…",
    "ssh.testOk": "✓ {0} ({1} / familiar {2})",
    "ssh.testFail": "✗ {0}",
    "ssh.saved": "保存しました",
    "ssh.deleted": "削除しました: {0}",
    "ssh.deleteConfirm": "接続「{0}」を削除しますか?",
    "ssh.none": "SSH サーバはまだ登録されていません",
    "ssh.errHost": "ホストを入力してください",
    "ssh.hostKeyBtn": "🔑 ホスト鍵を確認…",
    "ssh.hostKeyTitle": "ホスト鍵の確認と登録",
    "ssh.hostKeyDesc": "フィンガープリントを確認して「この鍵を登録」を押すと {0} に追記します。",
    "ssh.hostKeyNone": "ホスト鍵を取得できませんでした (ssh-keyscan)",
    "ssh.hostKeyRegister": "この鍵を登録",
    "ssh.hostKeyAdded": "known_hosts に登録しました (新規 {0} / 既存 {1})",
    "ssh.authHint": "公開鍵認証が拒否されました。このマシンに鍵が無い場合は ssh-keygen -t ed25519 で作成し、ssh-copy-id <user>@<host> で配置してください (ssh-agent でも可)。",
    "ssh.netHint": "接続がリセット/拒否されました。サーバ側のレート制限(fail2ban 等)や一時的な負荷の可能性があります。数分おいて再試行してください。",
    "ssh.rateHint": "短時間に失敗が続いたため、しばらく接続を控えています(レート制限対策)。原因(鍵の登録/ホスト鍵)を直して約1分後に再試行してください。",
    "ssh.hostKeyHint": "ホスト鍵が未登録です。「🔑 ホスト鍵を確認…」から登録してください。",
    "ssh.authMode": "認証方式",
    "ssh.authKey": "鍵 / ssh-agent",
    "ssh.authPassword": "パスワード",
    "ssh.password": "パスワード",
    "ssh.passwordSaved": "保存済み(変更する場合のみ入力)",
    "ssh.passwordClear": "保存したパスワードを削除",
    "ssh.passwordHint": "パスワードは ~/.familiar/secrets/ssh-*.pass (0600) に保存され、ssh には SSH_ASKPASS 経由で渡します。LAN 内は HTTP のため、信頼できるネットワークでのみ使用してください。",
    "ssh.passwordFirst": "パスワードを入力してから「接続テスト」を押すと、自動で保存して試行します。",
    "ssh.deleteFailed": "削除できませんでした(プロファイルが見つかりません)",
    "ssh.desktopOnly": "SSH 接続はデスクトップアプリでのみ利用できます。",
    "ssh.connectFail": "接続に失敗しました: {0}",
    "ssh.current": "接続中: {0}",
    "conn.googleTitle": "Google (Gmail / カレンダー)",
    "conn.googleClientId": "OAuth クライアント ID",
    "conn.googleClientSecret": "OAuth クライアント シークレット",
    "conn.calendar": "カレンダー",
    "conn.gitlabBase": "ベース URL (既定: https://gitlab.com)",
    "conn.backlogBase": "スペース URL (例: https://xxx.backlog.jp)",
    "conn.teamsToken": "アクセストークン (Graph)",
    "tool.args": "引数",
    "tool.result": "結果",
    "tool.running": "実行中…",
    "tool.details": "詳細",
    "tool.error": "エラー",
    "transcript.empty": "セッション未選択",
    "session.empty": "空のセッション",
    "toast.titleEdit": "タイトルは上部バーで編集できます(Enter で確定)",
    "toast.deleteFailed": "削除に失敗しました: {0}",
    "toast.renamed": "名前を変更しました",
    "toast.renameFailed": "名前変更に失敗しました: {0}",
    "toast.noExport": "出力するセッションがありません",
    "toast.exportFailed": "出力に失敗しました: {0}",
    "toast.exported": "Markdown に出力しました",
    "toast.approved": "承認しました",
    "toast.denied": "拒否しました",
    "toast.approvalFailed": "承認処理に失敗しました: {0}",
    "toast.inboxUnavailable": "インボックスを取得できません: {0}",
    "toast.configUnavailable": "config を取得できません: {0}",
    "toast.nextSession": "次のセッションで {0} を使用します",
    "toast.modelSet": "モデルを切替: {0}",
    "toast.modelFailed": "モデル変更に失敗しました: {0}",
    "toast.createFailed": "セッション作成に失敗しました: {0}",
    "toast.sendFailed": "送信に失敗しました: {0}",
    "toast.attached": "添付しました: {0}",
    "sessions.noMatch": "一致するセッションがありません",
    "attach.remove": "添付を削除",
    "attach.limit": "添付できる画像は最大 {0} 枚です",
    "attach.tooLarge": "画像が大きすぎます(最大 5MB): {0}",
    "attach.added": "画像を {0} 枚添付しました",
    "toast.dropAttach": "ドロップで添付しました: {0}",
    "toast.attachFailed": "添付ファイルのパスを取得できませんでした: {0}",
    "attach.remotePath": "SSH 接続中はローカルのファイルパスを参照できません(画像はそのまま添付できます)",
    "attach.uploaded": "アップロードしました: {0}",
    "attach.uploadFailed": "アップロードに失敗しました: {0}",
    "attach.remoteNoSession": "先にセッションを作成してください",
    "attach.fileTooLarge": "ファイルが大きすぎます (最大 {0}MB): {1}",
    "toast.stopRequested": "停止を要求しました…",
    "toast.steered": "実行中のターンに取り込みました",
    "toast.steerFallback": "ターンが終了していたため新規に送信します",
    "toast.effortSet": "エフォート: {0}",
    "toast.effortNext": "エフォート: {0} (次のセッションから適用)",
    "chip.effort": "推論エフォート",
    "effort.default": "既定",
    "effort.defaultDesc": "モデル側の既定エフォートを使用",
    "effort.lowDesc": "低 (速い)",
    "effort.mediumDesc": "中 (標準)",
    "effort.highDesc": "高 (じっくり)",
    "prov.connected": "接続済みプロバイダー",
    "prov.noneConnected": "接続済みのプロバイダーはありません",
    "prov.candidates": "接続候補",
    "prov.connect": "＋ 接続",
    "prov.mock": "mock (テスト用)",
    "toast.shellHint": "「!」で始めるとシェルコマンドの実行をエージェントに依頼します",
    "toast.notifDenied": "通知の許可が得られませんでした",
    "toast.theme": "テーマ: {0}",
    "toast.appearanceReset": "外観設定をリセットしました",
    "toast.saved": "保存しました",
    "toast.saveFailed": "保存に失敗しました: {0}",
    "toast.providerSaved": "プロバイダー設定を保存しました: {0}",
    "turn.done": "✓ 完了 ({0})",
    "turn.thinking": "考えています…",
    "turn.stopped": "⏹ 停止しました",
    "taskDone": "タスクが完了しました",
    "auth.required": "トークン認証が必要です",
    "auth.hint": "このサーバーはBearerトークンを要求しています。 familiar token --write で発行し、URL に ?token=... を付けて開き直してください。",
    "home.title": "このセッションで何をお手伝いしますか?",
    "home.hint": "何でも聞いてください — ファイルの読み取り・コマンド実行・コード編集ができます。",
    "approval.needed": "承認が必要: {0}",
    "approval.approve": "承認",
    "approval.deny": "拒否",
    "approval.denyShort": "差戻し",
    "inbox.empty": "承認待ちはありません — すべて反映済み ✓",
    "stat.enabled": "有効",
    "stat.disabled": "無効",
    "stat.paused": "一時停止",
    "stat.state": "状態",
    "stat.lastRun": "前回実行",
    "stat.nextDue": "次回",
    "stat.stale": "未整理スキル",
    "stat.archived": "アーカイブ",
    "stat.snapshots": "スナップショット",
    "stat.consolidation": "統合",
    "stat.running": "実行中",
    "stat.stopped": "停止中",
    "stat.noServers": "サーバー未設定",
    "stat.noJobs": "ジョブなし",
    "stat.everyMinutes": "{0}分ごと",
    "info.session": "セッション",
    "info.title": "タイトル",
    "info.id": "ID",
    "info.providerModel": "プロバイダー / モデル",
    "info.profile": "プロファイル",
    "info.cwd": "作業ディレクトリ",
    "info.created": "作成",
    "info.updated": "更新",
    "info.messages": "メッセージ",
    "info.user": "ユーザー",
    "info.assistant": "アシスタント",
    "info.toolCalls": "ツール呼び出し",
    "info.total": "合計",
    "info.context": "コンテキスト",
    "info.currentContext": "現在のコンテキスト",
    "info.contextWindow": "コンテキスト上限",
    "info.usage": "使用率",
    "info.usageVisit": "使用量 (この訪問)",
    "info.input": "入力",
    "info.output": "出力",
    "info.rawMessages": "生メッセージ",
    "info.notMeasured": "(未計測)",
    "info.unknown": "(不明)",
    "set.general": "一般",
    "set.inputSend": "送信と入力",
    "set.enterSend": "Enter で送信",
    "set.enterSendDesc": "オン: Enter で送信・Shift+Enter で改行 / オフ: Ctrl+Enter で送信・Enter で改行",
    "set.tabToggle": "Tab でモード切替",
    "set.tabToggleDesc": "Plan ⇔ 直前の権限モード(既定: 編集を許可)を Tab キーで切り替えます(メッセージ入力中も有効)",
    "set.notify": "通知",
    "set.notifyDesc": "turn 完了時にデスクトップ通知を送ります(推奨: ウィンドウが非フォーカス時のみ)",
    "set.notifyTitle": "デスクトップ通知",
    "set.notifyHint": "初回有効時に通知の許可を求めます",
    "set.notifyUnsupported": "この環境では利用できません",
    "set.notifyUnfocused": "非フォーカス時のみ通知",
    "set.notifyUnfocusedDesc": "familiar ウィンドウが前面のときは通知しない",
    "set.lang": "言語",
    "set.langDesc": "インターフェースの表示言語",
    "set.appearance": "配色",
    "set.appearanceDesc": "システム / ライト / ダーク に従います",
    "set.colors": "配色",
    "set.light": "ライト",
    "set.dark": "ダーク",
    "set.system": "システム",
    "set.display": "表示",
    "set.fontSize": "UI フォントサイズ",
    "set.fontSizeDesc": "インターフェース全体の文字サイズ",
    "set.width": "トランスクリプト幅",
    "set.widthDesc": "会話本文の最大幅",
    "size.s": "小",
    "size.m": "標準",
    "size.l": "大",
    "size.xl": "特大",
    "size.normal": "通常",
    "size.wide": "広",
    "size.full": "全幅",
    "set.reset": "外観設定をリセット",
    "set.transcriptSec": "トランスクリプト",
    "set.autoscroll": "自動スクロール",
    "set.autoscrollDesc": "ストリーミング中に最下部へ追従(上に読み戻している間は停止)",
    "set.toolsExpanded": "ツール行を既定で展開",
    "set.toolsExpandedDesc": "ツール呼び出しの引数と結果を最初から表示します",
    "set.shortcutsSec": "ショートカット",
    "sc.tab": "Plan ⇔ 直前の権限モードを切替",
    "sc.enter": "メッセージ送信",
    "sc.enterNL": "改行(Enter 送信オフ時)",
    "sc.shiftEnter": "改行",
    "sc.ctrlEnterSend": "メッセージ送信",
    "sc.ctrlEnterNL": "改行",
    "sc.k": "セッション検索へフォーカス",
    "sc.f": "トランスクリプト内検索",
    "sc.esc": "メニュー / 検索 / モーダル / ドロワーを閉じる",
    "set.providers": "プロバイダー",
    "set.providersDesc": "API キー・エンドポイント・既定モデルはここから直接設定できます。キーは secrets/<name>.key (0600) に保存され、設定は config.yaml に追記されます。",
    "prov.kind": "種類",
    "prov.endpoint": "エンドポイント",
    "prov.endpointPh": "https://api.openai.com/v1",
    "prov.apiKey": "API キー",
    "prov.keySet": "設定済み(変更する場合のみ入力)",
    "prov.keyUnset": "未設定",
    "prov.keyEnv": "env 参照 ({0})",
    "prov.clearKey": "保存済みキーを削除",
    "prov.save": "保存",
    "prov.cancel": "キャンセル",
    "prov.add": "＋ 新しいプロバイダー",
    "prov.name": "名前",
    "prov.namePh": "例: my-openai",
    "prov.badName": "プロバイダー名は英数字で入力してください",
    "prov.fetchModels": "モデル一覧を取得",
    "prov.probeNeedsUrl": "エンドポイントを入力してください",
    "prov.probing": "取得中…",
    "prov.probeEmpty": "モデルが見つかりませんでした",
    "prov.probeOk": "{0} 件のモデル",
    "ns.modelDefault": "プロバイダーの既定",
    "cwd.title": "作業フォルダーを変更",
    "cwd.browse": "📁 参照…",
    "cwd.ok": "設定",
    "cwd.cancel": "キャンセル",
    "cwd.noMatch": "一致するフォルダーがありません",
    "cmd.new": "新しいセッション",
    "cmd.model": "モデルを選択",
    "cmd.plan": "Plan モードへ切替(読み取り専用)",
    "cmd.ask": "編集とコマンドの前に確認する",
    "cmd.edit": "ファイル編集を許可(それ以外は確認)",
    "cmd.yolo": "フルアクセス — 確認しない",
    "cmd.export": "Markdown で出力",
    "cmd.retry": "直前のターンを再実行",
    "cmd.compact": "コンテキストを圧縮",
    "cmd.undo": "直前の変更を取り消し",
    "compact.noSession": "セッションがありません",
    "compact.busy": "実行中のため圧縮できません（停止してから行ってください）",
    "compact.done": "コンテキストを圧縮しました（{0} 件削除 / {1} 件保持）",
    "compact.nothing": "圧縮するものがありません",
    "compact.failed": "圧縮できませんでした: {0}",
    "undo.noSession": "セッションがありません",
    "undo.busy": "実行中のため取り消せません（停止してから行ってください）",
    "undo.done": "直前のターンの変更を取り消しました（{0} 件のファイル）",
    "undo.nothing": "取り消す変更がありません",
    "undo.failed": "取り消せませんでした: {0}",
    "budget.scopeSession": "セッション",
    "budget.scopeDay": "本日",
    "budget.near": "{0}のトークン予算が上限に近づいています（{1}/{2} トークン, {3}%）",
    "budget.exceeded": "{0}のトークン予算を超過しました（{1}/{2} トークン, {3}%）",
    "cmd.settings": "設定を開く",
    "cmd.search": "トランスクリプト内検索",
    "cmd.find": "全セッションを検索",
    "cmd.import": "トランスクリプトを取り込み",
    "import.done": "取り込みました（{0} 件のメッセージ）",
    "import.failed": "取り込めませんでした: {0}",
    "find.title": "全セッション検索",
    "find.placeholder": "検索語を入力…",
    "find.none": "一致するメッセージがありません",
    "find.untitled": "(無題)",
    "find.failed": "検索できませんでした: {0}",
    "top.todo": "タスク (todo)",
    "drawer.todo": "タスク (todo)",
    "todo.empty": "タスクはありません。エージェントに「TODO: ...」形式で依頼するとここに表示されます",
    "todo.pending": "未着手",
    "todo.in_progress": "進行中",
    "todo.done": "完了",
    "tool.diff": "変更差分",
    "toast.cwdSet": "作業フォルダー: {0}",
    "toast.cwdAbsolute": "リモートのフォルダーは絶対パスで指定してください",
    "toast.cwdFailed": "フォルダーを変更できませんでした: {0}",
    "prov.badUrl": "エンドポイントは http:// か https:// で始めてください",
    "prov.default": "既定",
    "prov.keyOk": "キー ✓",
    "prov.keyMissing": "キー未設定",
    "prov.none": "(なし)",
    "ext.mcp": "MCP サーバー",
    "ext.mcpDesc": "mcp.status より(n. = そのサーバーの公開ツール数)。追加・編集・削除はこの画面から行えます(詳細は config.yaml の mcp.servers)。",
    "ext.reconnect": "再接続",
    "ext.reconnected": "{0} を再接続しました",
    "ext.reconnectFailed": "再接続できませんでした: {0}",
    "ext.reconnects": "{0} 回再接続",
    "ext.lastOk": "最終OK {0}",
    "ext.lsp": "LSP サーバー",
    "ext.skills": "スキル (Skills)",
    "ext.skillsDesc": "~/.familiar/skills/<名前>/SKILL.md。チャットで「〜するスキルを作って」と依頼すると skill_manage ツールが提案を作り、承認後に有効になります。",
    "ext.noSkills": "スキルはまだありません",
    "ext.skillUses": "使用 {0} 回 · {1} 文字",
    "ext.skillReadOnly": "読取専用",
    "ext.skillExternalNote": "外部ルート（{0}）のスキルです。読み取り専用のため、Familiar からは編集も削除もできません。",
    "skills.close": "閉じる",
    "ext.lspDesc": "lsp_diagnostics が使用する言語サーバー。追加・編集・削除はこの画面から行えます(詳細は config.yaml の lsp.servers)。",
    "ext.enabled": "有効",
    "ext.disabled": "無効",
    "ext.tools": "{0} ツール",
    "srv.addMcp": "MCP サーバーを追加",
    "srv.addLsp": "LSP サーバーを追加",
    "srv.edit": "編集",
    "srv.delete": "削除",
    "srv.name": "名前",
    "srv.namePh": "例: filesystem",
    "srv.command": "コマンド",
    "srv.commandPh": "例: npx (1 行で入力)",
    "srv.args": "引数(1 行につき 1 つ)",
    "srv.extensions": "対象拡張子(カンマ・空白区切り)",
    "srv.env": "環境変数(1 行につき KEY=VALUE)",
    "srv.timeout": "タイムアウト(ms・省略可)",
    "srv.readOnly": "読み取り専用ツール",
    "srv.disabled": "無効",
    "srv.advancedNote": "remote 上書きと cwd はこの画面では編集しません(保存時に既存値を保持)。",
    "srv.save": "保存",
    "srv.cancel": "キャンセル",
    "srv.saved": "{0} を保存しました",
    "srv.deleted": "{0} を削除しました",
    "srv.saveFailed": "保存できませんでした: {0}",
    "srv.deleteFailed": "削除できませんでした: {0}",
    "srv.loadFailed": "設定を読み込めませんでした: {0}",
    "srv.deleteConfirm": "サーバー「{0}」を設定から削除しますか?",
    "srv.badName": "名前は英数字で始め、英数字・._- のみ使用してください",
    "srv.badCommand": "コマンドは 1 行で入力してください",
    "srv.badEnv": "環境変数は KEY=VALUE の形式で入力してください",
    "srv.badExtensions": "対象拡張子を 1 つ以上入力してください",
    "srv.badTimeout": "タイムアウトは 100〜600000 ms で入力してください",
    "sys.desc": "カレーター(自己改善 cron)とスケジューラの現在状態。詳細はステータスドロワー、設定は config.yaml です。",
  },
  en: {
    "side.newSession": "New session",
    "side.filterPh": "filter sessions…  (Ctrl+K)",
    "side.foldAll": "collapse all folders",
    "side.unfoldAll": "expand all folders",
    "side.settings": "Settings",
    "tabs.close": "close tab",
    "top.inbox": "approvals",
    "top.status": "status",
    "del.confirm": "delete session \"{0}\"? this cannot be undone",
    "none": "(none)",
    "top.noSession": "no session",
    "top.gaugeTitle": "context usage — click for session info",
    "top.gaugeNoTurn": "context usage — shown after the next turn is sent",
    "side.noFolder": "no folder",
    "side.local": "local",
    "queue.title": "Queued ({0})",
    "queue.cancel": "Cancel this queued message",
    "queue.sendNow": "Send now (stops the running turn)",
    "queue.waiting": "waiting for the running turn",
    "queue.queued": "queued ({0})",
    "turn.received": "received — generating a reply",
    "turn.longWait": "still waiting for the model… the first reply of an idle or very large session can take a few minutes",
    "turn.noteSteps": "↻ auto-continued past the step window ({0}/{1})",
    "turn.noteTodos": "↻ continuing automatically — TODOs still open ({0}/{1})",
    "turn.noteCeiling": "step ceiling ({0}) reached — reply “continue” to resume",
    "turn.noteCompaction": "compacted the context (summarized/dropped {0} older messages, kept the last {1})",
    "turn.noteCompactionForced": "the provider rejected the prompt as too long — compacted and retried ({0} dropped)",
    "turn.retryNow": "retry",
    "turn.continueNow": "continue",
    "turn.continueWord": "continue",
    "turn.working": "working… {0}",
    "toast.dupRunning": "the same instruction is already running (not sent twice)",
    "side.running": "running",
    "queue.otherDevice": "A turn is already running in another client — queued instead",
    "composer.phBusy": "type to steer the running turn (read at the next step)",
    "usage.overNote": "Over the context window — the next turn compacts automatically",
    "msg.copyFailed": "Copy failed — select the text and copy it manually",
    "code.showAll": "show all",
    "code.collapse": "collapse",
    "chip.ctx": "context usage",
    "update.available": "Update available — v{0} (apply from ⬇)",
    "update.downloading": "Downloading the update…",
    "update.applied": "v{0} applied — press ↻ to restart",
    "update.restartTitle": "Restart to apply v{0}",
    "update.uptodate": "Up to date (v{0})",
    "update.failed": "Update failed: {0}",
    "update.cliHint": "Browser builds update via `familiar update`",
    "update.remoteHint": "Connected over SSH — run `familiar update` on the remote host",
    "menu.updateCheck": "Check for updates",
    "top.files": "files",
    "pane.ctx": "context",
    "set.colorTheme": "color theme",
    "set.colorThemeDesc": "accent palette preset",
    "set.fontFamily": "font",
    "set.fontFamilyDesc": "UI-wide font (mono areas excluded)",
    "font.system": "System default",
    "font.gothic": "Sans (Gothic)",
    "font.serif": "Serif (Mincho)",
    "font.mono": "Monospace",
    "set.about": "About this app",
    "set.systemStats": "system status",
    "set.version": "version",
    "set.developer": "developer",
    "conn.title": "connectors",
    "conn.desc": "Connect external services — once saved, the AI can use them through connector tools.",
    "conn.serverGroupTitle": "Servers",
    "conn.serverGroupDesc": "Connection status and configuration for MCP and LSP servers",
    "conn.externalGroupTitle": "External services",
    "conn.externalGroupDesc": "Connect to external services such as Gmail and GitHub.",
    "conn.baseUrl": "base URL (e.g. https://example.atlassian.net)",
    "conn.email": "email",
    "conn.token": "API token",
    "conn.apiKey": "API key",
    "conn.save": "save",
    "conn.test": "test connection",
    "conn.saved": "saved",
    "conn.googleDesc": "after the OAuth consent, Gmail and Calendar can be read. Register http://<server>:46210/oauth/callback as the redirect URI of your Google Cloud client",
    "conn.googleAuth": "link Google",
    "conn.googleAuthHint": "approve in the Google window — it returns automatically",
    "conn.delete": "delete",
    "conn.ok": "connected",
    "skills.newName": "skill name (e.g. deploy-check)",
    "skills.create": "create",
    "skills.save": "save",
    "skills.saved": "skill saved: {0}",
    "skills.loading": "loading…",
    "skills.pendingToast": "the AI staged {0} skill proposal(s)",
    "skills.suggestTitle": "The AI suggests creating a skill",
    "skills.approveCreate": "approve & create",
    "skills.rejectShort": "dismiss",
    "skills.createdMsg": "skill created — edit it in Settings → Skills",
    "skills.rejectedMsg": "proposal dismissed",
    "skills.dismiss": "Dismiss",
    "skills.dismissTitle": "close this card",
    "skills.partialResult": "{0} succeeded / {1} failed: {2}",
    "skills.stale": "cannot apply — the target skill changed after this proposal was staged",
    "skills.staleShort": "stale (target changed)",
    "skills.delete": "Delete",
    "skills.cancel": "Cancel",
    "skills.deleteConfirm": "Delete the skill \"{0}\"?\n(It is moved to the archive and can be restored.)",
    "skills.deleted": "skill deleted: {0}",
    "skills.filterPh": "filter skills…",
    "skills.selectAll": "select all / none",
    "skills.filterEmpty": "no skills match",
    "skills.deleteSelected": "delete selected ({0})",
    "skills.deleteSelectedConfirm": "Delete {0} selected skills?\n(they move to the archive, so this is reversible)",
    "skills.deletedBulk": "deleted {0} skills",
    "notify.skillSuggest": "Familiar Harness — skill proposal",
    "pane.files": "files",
    "skills.edit": "edit skills",
    "files.loading": "loading…",
    "files.loadFailed": "cannot load: {0}",
    "files.refresh": "refresh",
    "files.empty": "(empty folder)",
    "files.back": "back to the list",
    "files.truncated": "first 256 KB shown",
    "files.preview": "preview",
    "files.source": "source",
    "files.openExternal": "open with the OS default app",
    "files.binary": "binary file ({0}) — cannot preview",
    "files.tooLarge": "too large to preview ({0}) — open it externally",
    "files.csvRows": "{0} rows × {1} columns",
    "files.sheet": "sheet: {0}",
    "files.slide": "slide {0}",
    "files.docxEmpty": "(no content)",
    "fmenu.open": "Open",
    "fmenu.openApp": "Open in app",
    "fmenu.openOs": "Open with OS default app",
    "fmenu.openFolder": "Open folder",
    "fmenu.copyPath": "Copy path",
    "fmenu.copyRel": "Copy relative path",
    "fmenu.addContext": "Add to context",
    "fmenu.copied": "Path copied",
    "fmenu.copyFailed": "Could not copy",
    "fmenu.rename": "Rename…",
    "fmenu.renameTitle": "Rename",
    "fmenu.renameOk": "Rename",
    "fmenu.renameFailed": "Rename failed: {0}",
    "fmenu.delete": "Delete…",
    "fmenu.deleteConfirm": "Delete \"{0}\"? (cannot be undone)",
    "fmenu.renamed": "Renamed",
    "fmenu.deleted": "Deleted",
    "fmenu.deleteFailed": "Delete failed: {0}",
    "tpl.intro": "Register Word / Excel / PowerPoint templates and office_create will follow their design (styles, theme, layouts, page setup).",
    "tpl.add": "Add a template",
    "tpl.empty": "no templates registered yet",
    "tpl.delete": "delete",
    "tpl.confirm": "Delete the template \"{0}\"?",
    "tpl.deleted": "deleted",
    "tpl.added": "registered the template \"{0}\"",
    "tpl.importFailed": "could not register: {0}",
    "tpl.how": "Usage: pass template: \"<name>\" to office_create. A template named \"default\" is used automatically.",
    "files.copyMd": "copy as Markdown",
    "files.copied": "copied",
    "notify.approvalTitle": "Familiar Harness — approval needed",
    "notify.turnDone": "Familiar Harness — turn completed",
    "notify.turnFailed": "Familiar Harness — turn failed",
    "notify.turnFailed": "turn failed",
    "ctx.used": "used",
    "ctx.window": "window",
    "ctx.free": "free",
    "ctx.noteNoTurn": "Shown after the first turn is sent (each turn re-sends the full context, so the last prompt = the current context)",
    "ctx.noteNoWindow": "This model's context window is unknown (not exposed by the model list)",
    "ctx.noteEstimated": "Estimated from the stored history (≈); updated with the real value after a turn runs.",
    "ctx.assumed": "(default)",
    "ctx.breakdownTitle": "Prompt composition",
    "ctx.system": "System",
    "ctx.tools": "Tool schemas",
    "ctx.history": "History",
    "ctx.toolResults": "Tool results",
    "ctx.noteHint": "{0} / {1} tok used",
    "ns.title": "New session",
    "ns.search": "search or type a folder… (e.g. ~/work)",
    "ns.pickFolder": "Pick a working folder",
    "ns.create": "Create",
    "ns.noRecent": "No recent folders yet — type a path above",
    "ns.noMatch": "No matching folders",
    "ns.sessions": "{0} sessions",
    "ns.errNoFolder": "Pick or type a working folder first",
    "ns.target": "Runs on",
    "ns.localMachine": "This machine",
    "ns.localHint": "run on this computer",
    "ns.addSsh": "Add an SSH server…",
    "ns.addSshHint": "register a host in Settings → Connections",
    "ns.connect": "Connect",
    "ns.connecting": "Connecting…",
    "ns.connectFailed": "Could not connect: {0}",
    "ns.remoteCwd": "remote working folder (optional)",
    "ns.remoteHint": "You can pick a remote folder after connecting. Leave empty to start in the remote home directory.",
    "ns.serveBadge": "familiar server",
    "ns.proxyBadge": "SSH proxy",
    "ns.proxyHint": "Create a remote session in this folder. ~ expands to the remote home and bare names like work resolve there too (folders are suggested as you type).",
    "ns.resolvedTo": "will use: {0}",
    "ns.remoteSuggestions": "Folder suggestions ({0})",
    "ns.noFolderHere": "this folder has no subfolders",
    "ns.retry": "Retry",
    "set.uiBuild": "UI build",
    "ns.creating": "Creating…",
    "top.search": "search in transcript (Ctrl+F)",
    "top.sessionActions": "session actions",
    "top.sessions": "sessions",
    "menu.rename": "Rename…",
    "menu.export": "Export as Markdown",
    "menu.delete": "Delete session…",
    "menu.deleteShort": "Delete…",
    "search.ph": "search in transcript…",
    "search.close": "close search",
    "composer.plus": "attach / add",
    "composer.retry": "retry the last turn",
    "toast.noRetry": "nothing to retry",
    "plus.file": "📎 Attach from file…",
    "plus.ctx": "＠ Add context",
    "plus.shell": "❯ Shell command",
    "chip.mode": "permission mode",
    "chip.model": "model for this session",
    "mode.plan": "Plan",
    "mode.planDesc": "read-only — never edits or runs commands",
    "mode.ask": "Ask before acting",
    "mode.askDesc": "ask before edits and commands that the config does not allow",
    "mode.edit": "Allow edits",
    "mode.editDesc": "approve file edits and operations; ask for everything else",
    "mode.yolo": "Full access",
    "mode.yoloDesc": "never ask before edits or commands",
    "mic.start": "start voice input",
    "mic.stop": "stop voice input",
    "mic.unsupported": "voice input is not available here (the desktop app has no speech service; use the browser Web UI)",
    "mic.denied": "microphone permission was denied",
    "chip.modelLabel": "model",
    "mp.search": "Search models…",
    "mp.manage": "Manage models",
    "mp.unreachable": "unreachable",
    "msg.copy": "Copy answer",
    "msg.thinking": "Thinking",
    "send.enter": "send (Enter)",
    "send.ctrlEnter": "send (Ctrl+Enter)",
    "send.stop": "Stop",
    "composer.phEnter": "Ask anything… (Enter to send / Shift+Enter for a new line)",
    "composer.phCtrl": "Ask anything… (Ctrl+Enter to send / Enter for a new line)",
    "composer.phMobile": "Ask anything… (Enter for a new line / tap ↑ to send)",
    "drawer.inbox": "approval inbox",
    "drawer.status": "system status",
    "drawer.info": "session info",
    "settings.title": "Settings",
    "settings.close": "close (Esc)",
    "nav.general": "General",
    "todo.progress": "tasks: {0}/{1} done",
    "nav.appearance": "Appearance",
    "nav.transcript": "Transcript",
    "nav.shortcuts": "Shortcuts",
    "nav.providers": "Providers",
    "nav.skills": "Skills",
    "nav.templates": "Templates",
    "nav.connectors": "Connectors",
    "nav.connections": "Connections",
    "nav.cron": "Cron",
    "nav.approvals": "Permissions",
    "nav.websearch": "Web search",
    "nav.memory": "Memory",
    "nav.system": "About",
    "perm.desc": "Edit the bash allow/ask/deny policy. Built-in guards are always unioned in. Use the tester below to check a command.",
    "perm.mode": "Default mode",
    "perm.modeHint": "allow = run unless matched / ask = approve every command",
    "perm.modeAllow": "allow (auto-run)",
    "perm.modeAsk": "ask (approve each)",
    "perm.allow": "allow (run without approval)",
    "perm.ask": "ask (needs approval)",
    "perm.deny": "deny (always blocked)",
    "perm.save": "Save",
    "perm.saved": "permission policy saved",
    "perm.saveFailed": "save failed: {0}",
    "perm.loadFailed": "load failed: {0}",
    "perm.testTitle": "Rule tester",
    "perm.testPh": "e.g. rm -rf /tmp/x",
    "perm.test": "Test",
    "perm.testFailed": "test failed: {0}",
    "perm.decision.allow": "allowed (runs without approval)",
    "perm.decision.ask": "needs approval",
    "perm.decision.deny": "blocked",
    "perm.webDesc": "DuckDuckGo works with no setup. To use SearXNG, set the URL of your own instance below.",
    "perm.webProvider": "Search backend",
    "perm.webProviderHint": "duckduckgo = no setup / searxng = endpoint required",
    "perm.webDdg": "DuckDuckGo (default)",
    "perm.webSearxng": "SearXNG (self-hosted)",
    "perm.webUrl": "SearXNG endpoint",
    "perm.webUrlPh": "http://127.0.0.1:8080",
    "perm.webUrlHint": "Must start with http(s). Cleared when DuckDuckGo is selected.",
    "perm.webSave": "Save web search settings",
    "perm.webSaved": "web search settings saved",
    "perm.webLoadFailed": "could not load web search settings: {0}",
    "perm.webBadUrl": "endpoint must start with http:// or https://",
    "perm.webNeedUrl": "enter an endpoint to use SearXNG (prepare your own instance)",
    "mem.desc": "Decisions and premises written here are loaded every turn in every session. The agent never rewrites this file automatically.",
    "mem.path": "Saved at: {0}",
    "mem.projectHint": "Project-specific notes in <cwd>/.familiar/MEMORY.md are loaded only for sessions in that folder.",
    "mem.save": "Save MEMORY.md",
    "mem.saved": "MEMORY.md saved",
    "mem.saveFailed": "could not save: {0}",
    "mem.loadFailed": "could not load: {0}",
    "cron.desc": "Scheduled runs from cron.jobs in config. Run now or pause from here.",
    "cron.empty": "no scheduled jobs",
    "cron.once": "once at boot",
    "cron.every": "every {0}m",
    "cron.run": "Run now",
    "cron.ran": "ran {0}",
    "cron.failed": "failed: {0}",
    "cron.pause": "Pause",
    "cron.resume": "Resume",
    "cron.enabled": "enabled",
    "cron.paused": "paused",
    "remote.back": "Back to local",
    "remote.badge": "SSH: {0}",
    "remote.badgeTitle": "Connected over SSH: {0} — click for connection settings",
    "remote.lost": "SSH connection lost: {0}",
    "remote.current": "Current connection",
    "remote.readOnly": "Remote connection settings can only be changed on the local machine.",
    "ssh.title": "SSH connections",
    "ssh.desc": "Register SSH hosts. The familiar-server mode starts `familiar serve` on the host through a tunnel; the SSH-proxy mode installs nothing remotely and runs each tool call over ssh. Authentication uses keys or ssh-agent.",
    "ssh.mode": "Connection mode",
    "ssh.modeServe": "run familiar serve (install required)",
    "ssh.modeProxy": "SSH proxy (nothing to install)",
    "ssh.name": "Display name",
    "ssh.host": "Host (e.g. build.example.com)",
    "ssh.user": "User (optional)",
    "ssh.port": "Port",
    "ssh.key": "Identity file (optional)",
    "ssh.remoteBin": "Remote familiar path (optional)",
    "ssh.save": "Save",
    "ssh.edit": "Edit",
    "ssh.addSsh": "Add an SSH connection",
    "ssh.delete": "Delete",
    "ssh.connect": "Connect",
    "ssh.test": "Test connection",
    "ssh.testing": "Testing…",
    "ssh.testOk": "✓ {0} ({1} / familiar {2})",
    "ssh.testFail": "✗ {0}",
    "ssh.saved": "Saved",
    "ssh.deleted": "Deleted: {0}",
    "ssh.deleteConfirm": "Delete the connection \"{0}\"?",
    "ssh.none": "No SSH servers registered yet",
    "ssh.errHost": "Enter a host",
    "ssh.hostKeyBtn": "🔑 Check host key…",
    "ssh.hostKeyTitle": "Verify and trust the host key",
    "ssh.hostKeyDesc": "Check the fingerprints and press Trust to append them to {0}.",
    "ssh.hostKeyNone": "No host key received (ssh-keyscan)",
    "ssh.hostKeyRegister": "Trust these keys",
    "ssh.hostKeyAdded": "Added to known_hosts (new {0} / already present {1})",
    "ssh.authHint": "Public-key auth was refused. If this machine has no key, create one with ssh-keygen -t ed25519 and copy it with ssh-copy-id <user>@<host> (ssh-agent works too).",
    "ssh.netHint": "The connection was reset/refused — the server may be rate-limiting (fail2ban etc.) or briefly overloaded. Retry in a few minutes.",
    "ssh.rateHint": "Recent failures paused connection attempts (rate-limit protection). Fix the cause (key authorization / host key) and retry in about a minute.",
    "ssh.hostKeyHint": "Host key not registered — use “🔑 Check host key…” to add it.",
    "ssh.authMode": "Authentication",
    "ssh.authKey": "Key / ssh-agent",
    "ssh.authPassword": "Password",
    "ssh.password": "Password",
    "ssh.passwordSaved": "saved (type only to change)",
    "ssh.passwordClear": "Delete the saved password",
    "ssh.passwordHint": "The password is stored in ~/.familiar/secrets/ssh-*.pass (0600) and given to ssh through SSH_ASKPASS. The WebUI itself is plain HTTP — use it only on trusted networks.",
    "ssh.passwordFirst": "Type the password and press Test — it is saved automatically first.",
    "ssh.deleteFailed": "could not delete (profile not found)",
    "ssh.desktopOnly": "SSH connections are available in the desktop app only.",
    "ssh.connectFail": "Connection failed: {0}",
    "ssh.current": "Connected: {0}",
    "conn.googleTitle": "Google (Gmail / Calendar)",
    "conn.googleClientId": "OAuth client ID",
    "conn.googleClientSecret": "OAuth client secret",
    "conn.calendar": "Calendar",
    "conn.gitlabBase": "base URL (default: https://gitlab.com)",
    "conn.backlogBase": "space URL (e.g. https://xxx.backlog.jp)",
    "conn.teamsToken": "access token (Graph)",
    "tool.args": "arguments",
    "tool.result": "result",
    "tool.running": "running…",
    "tool.details": "details",
    "tool.error": "error",
    "transcript.empty": "no session",
    "session.empty": "empty session",
    "toast.titleEdit": "edit the title in the topbar, Enter to save",
    "toast.deleteFailed": "delete failed: {0}",
    "toast.renamed": "renamed",
    "toast.renameFailed": "rename failed: {0}",
    "toast.noExport": "no session to export",
    "toast.exportFailed": "export failed: {0}",
    "toast.exported": "exported as markdown",
    "toast.approved": "approved",
    "toast.denied": "denied",
    "toast.approvalFailed": "approval failed: {0}",
    "toast.inboxUnavailable": "inbox unavailable: {0}",
    "toast.configUnavailable": "config unavailable: {0}",
    "toast.nextSession": "next session will use {0}",
    "toast.modelSet": "model set to {0}",
    "toast.modelFailed": "model change failed: {0}",
    "toast.createFailed": "session.create failed: {0}",
    "toast.sendFailed": "send failed: {0}",
    "toast.attached": "attached: {0}",
    "sessions.noMatch": "no matching sessions",
    "attach.remove": "remove attachment",
    "attach.limit": "at most {0} images per message",
    "attach.tooLarge": "image too large (max 5MB): {0}",
    "attach.added": "attached {0} image(s)",
    "toast.dropAttach": "attached via drop: {0}",
    "toast.attachFailed": "could not resolve a file path: {0}",
    "attach.remotePath": "Local file paths are not available while connected over SSH (images still attach normally)",
    "attach.uploaded": "Uploaded: {0}",
    "attach.uploadFailed": "Upload failed: {0}",
    "attach.remoteNoSession": "open a session first",
    "attach.fileTooLarge": "file too large (max {0}MB): {1}",
    "toast.stopRequested": "stop requested…",
    "toast.steered": "sent into the running turn",
    "toast.steerFallback": "the turn had ended — sent as a new turn",
    "toast.effortSet": "effort: {0}",
    "toast.effortNext": "effort: {0} (applies from the next session)",
    "chip.effort": "reasoning effort",
    "effort.default": "default",
    "effort.defaultDesc": "use the model's default effort",
    "effort.lowDesc": "low (faster)",
    "effort.mediumDesc": "medium (balanced)",
    "effort.highDesc": "high (thorough)",
    "prov.connected": "Connected providers",
    "prov.noneConnected": "no connected providers yet",
    "prov.candidates": "Candidates",
    "prov.connect": "＋ connect",
    "prov.mock": "mock (tests only)",
    "toast.shellHint": "start with \"!\" to ask the agent to run a shell command",
    "toast.notifDenied": "notification permission denied",
    "toast.theme": "theme: {0}",
    "toast.appearanceReset": "appearance reset",
    "toast.saved": "saved",
    "toast.saveFailed": "save failed: {0}",
    "toast.providerSaved": "provider settings saved: {0}",
    "turn.done": "✓ done ({0})",
    "turn.thinking": "thinking…",
    "turn.stopped": "⏹ stopped",
    "taskDone": "Task completed",
    "auth.required": "Token authentication required",
    "auth.hint": "This server requires a bearer token. Generate one with `familiar token --write` and reopen the URL with ?token=...",
    "home.title": "What can I help you with in this session?",
    "home.hint": "Ask anything — familiar can read files, run commands, and edit code in this workspace.",
    "approval.needed": "approval needed: {0}",
    "approval.approve": "Approve",
    "approval.deny": "Deny",
    "approval.denyShort": "Reject",
    "inbox.empty": "no staged writes — all clear ✓",
    "stat.enabled": "enabled",
    "stat.disabled": "disabled",
    "stat.paused": "paused",
    "stat.state": "state",
    "stat.lastRun": "last run",
    "stat.nextDue": "next due",
    "stat.stale": "stale skills",
    "stat.archived": "archived",
    "stat.snapshots": "snapshots",
    "stat.consolidation": "consolidation",
    "stat.running": "running",
    "stat.stopped": "stopped",
    "stat.noServers": "no servers configured",
    "stat.noJobs": "no jobs",
    "stat.everyMinutes": "every {0} min",
    "info.session": "session",
    "info.title": "title",
    "info.id": "id",
    "info.providerModel": "provider / model",
    "info.profile": "profile",
    "info.cwd": "cwd",
    "info.created": "created",
    "info.updated": "updated",
    "info.messages": "messages",
    "info.user": "user",
    "info.assistant": "assistant",
    "info.toolCalls": "tool calls",
    "info.total": "total",
    "info.context": "context",
    "info.currentContext": "current context",
    "info.contextWindow": "context window",
    "info.usage": "usage",
    "info.usageVisit": "usage (this visit)",
    "info.input": "input",
    "info.output": "output",
    "info.rawMessages": "raw messages",
    "info.notMeasured": "(not measured yet)",
    "info.unknown": "(unknown)",
    "set.general": "General",
    "set.inputSend": "Sending & input",
    "set.enterSend": "Send with Enter",
    "set.enterSendDesc": "On: Enter sends, Shift+Enter inserts a newline. Off: Ctrl+Enter sends, Enter inserts a newline.",
    "set.tabToggle": "Toggle mode with Tab",
    "set.tabToggleDesc": "Toggle Plan and the previous permission mode (default: Allow edits) with the Tab key (also while typing)",
    "set.notify": "Notifications",
    "set.notifyDesc": "Desktop notification when a turn completes (recommended: only while unfocused)",
    "set.notifyTitle": "Desktop notifications",
    "set.notifyHint": "asks for permission when first enabled",
    "set.notifyUnsupported": "not available in this environment",
    "set.notifyUnfocused": "Notify only when unfocused",
    "set.notifyUnfocusedDesc": "don't notify while the familiar window is focused",
    "set.lang": "Language",
    "set.langDesc": "interface language",
    "set.appearance": "Appearance",
    "set.appearanceDesc": "follows system / light / dark",
    "set.colors": "Colors",
    "set.light": "Light",
    "set.dark": "Dark",
    "set.system": "System",
    "set.display": "Display",
    "set.fontSize": "UI font size",
    "set.fontSizeDesc": "overall interface text size",
    "set.width": "Transcript width",
    "set.widthDesc": "maximum content width",
    "size.s": "S",
    "size.m": "M",
    "size.l": "L",
    "size.xl": "XL",
    "size.normal": "Normal",
    "size.wide": "Wide",
    "size.full": "Full",
    "set.reset": "Reset appearance",
    "set.transcriptSec": "Transcript",
    "set.autoscroll": "Auto-scroll",
    "set.autoscrollDesc": "stick to the bottom while streaming (pauses while scrolled up)",
    "set.toolsExpanded": "Expand tool rows by default",
    "set.toolsExpandedDesc": "show tool arguments and results from the start",
    "set.shortcutsSec": "Shortcuts",
    "sc.tab": "toggle Plan / previous permission mode",
    "sc.enter": "send message",
    "sc.enterNL": "newline (Enter-to-send off)",
    "sc.shiftEnter": "new line",
    "sc.ctrlEnterSend": "send message",
    "sc.ctrlEnterNL": "newline",
    "sc.k": "focus session filter",
    "sc.f": "search in transcript",
    "sc.esc": "close menus / search / modal / drawers",
    "set.providers": "Providers",
    "set.providersDesc": "API keys, endpoints and default models can be set directly here. Keys are stored in secrets/<name>.key (0600); settings are appended to config.yaml.",
    "prov.kind": "kind",
    "prov.endpoint": "endpoint",
    "prov.endpointPh": "https://api.openai.com/v1",
    "prov.apiKey": "API key",
    "prov.keySet": "set (enter only to change)",
    "prov.keyUnset": "not set",
    "prov.keyEnv": "env reference ({0})",
    "prov.clearKey": "remove stored key",
    "prov.save": "Save",
    "prov.cancel": "Cancel",
    "prov.add": "＋ new provider",
    "prov.name": "name",
    "prov.namePh": "e.g. my-openai",
    "prov.badName": "provider name must be alphanumeric",
    "prov.fetchModels": "Fetch model list",
    "prov.probeNeedsUrl": "enter an endpoint first",
    "prov.probing": "fetching…",
    "prov.probeEmpty": "no models found",
    "prov.probeOk": "{0} model(s)",
    "ns.modelDefault": "provider default",
    "cwd.title": "Change working folder",
    "cwd.browse": "📁 Browse…",
    "cwd.ok": "Set",
    "cwd.cancel": "Cancel",
    "cwd.noMatch": "no matching folders",
    "cmd.new": "new session",
    "cmd.model": "pick a model",
    "cmd.plan": "switch to Plan mode (read-only)",
    "cmd.ask": "ask before edits and commands",
    "cmd.edit": "allow file edits; ask for the rest",
    "cmd.yolo": "full access — never ask",
    "cmd.export": "export as markdown",
    "cmd.retry": "retry the last turn",
    "cmd.compact": "compact the context",
    "cmd.undo": "revert the last turn's changes",
    "compact.noSession": "no session",
    "compact.busy": "a turn is running — stop it before compacting",
    "compact.done": "compacted the context ({0} dropped / {1} kept)",
    "compact.nothing": "nothing to compact",
    "compact.failed": "compaction failed: {0}",
    "undo.noSession": "no session",
    "undo.busy": "a turn is running — stop it before undoing",
    "undo.done": "reverted the last turn's changes ({0} file(s))",
    "undo.nothing": "nothing to undo",
    "undo.failed": "undo failed: {0}",
    "budget.scopeSession": "session",
    "budget.scopeDay": "daily",
    "budget.near": "{0} token budget is near its limit ({1}/{2} tokens, {3}%)",
    "budget.exceeded": "{0} token budget exceeded ({1}/{2} tokens, {3}%)",
    "cmd.settings": "open settings",
    "cmd.search": "search the transcript",
    "cmd.find": "search all sessions",
    "cmd.import": "import a transcript",
    "import.done": "imported {0} message(s)",
    "import.failed": "import failed: {0}",
    "find.title": "Search all sessions",
    "find.placeholder": "type to search…",
    "find.none": "no matching messages",
    "find.untitled": "(untitled)",
    "find.failed": "search failed: {0}",
    "top.todo": "tasks (todo)",
    "drawer.todo": "tasks (todo)",
    "todo.empty": "no tasks yet — ask the agent with a \"TODO: …\" list and it shows up here",
    "todo.pending": "pending",
    "todo.in_progress": "in progress",
    "todo.done": "done",
    "tool.diff": "changes",
    "toast.cwdSet": "working folder: {0}",
    "toast.cwdAbsolute": "remote folders need an absolute path",
    "toast.cwdFailed": "could not change folder: {0}",
    "prov.badUrl": "endpoint must start with http:// or https://",
    "prov.default": "default",
    "prov.keyOk": "key ✓",
    "prov.keyMissing": "key missing",
    "prov.none": "(none)",
    "ext.mcp": "MCP servers",
    "ext.mcpDesc": "from mcp.status (n. = tools exposed by that server). Add, edit and remove servers here (advanced: config.yaml [mcp.servers]).",
    "ext.reconnect": "Reconnect",
    "ext.reconnected": "reconnected {0}",
    "ext.reconnectFailed": "reconnect failed: {0}",
    "ext.reconnects": "{0} reconnect(s)",
    "ext.lastOk": "last ok {0}",
    "ext.lsp": "LSP servers",
    "ext.skills": "Skills",
    "ext.skillsDesc": "~/.familiar/skills/<name>/SKILL.md. Ask in chat to create one — the skill_manage tool stages a proposal that activates after approval.",
    "ext.noSkills": "no skills yet",
    "ext.skillUses": "used {0}× · {1} chars",
    "ext.skillReadOnly": "read-only",
    "ext.skillExternalNote": "Skill from an external root ({0}) — read-only: it cannot be edited or deleted from Familiar.",
    "skills.close": "Close",
    "ext.lspDesc": "language servers used by lsp_diagnostics. Add, edit and remove servers here (advanced: config.yaml [lsp.servers]).",
    "ext.enabled": "enabled",
    "ext.disabled": "disabled",
    "ext.tools": "{0} tools",
    "srv.addMcp": "Add MCP server",
    "srv.addLsp": "Add LSP server",
    "srv.edit": "Edit",
    "srv.delete": "Delete",
    "srv.name": "Name",
    "srv.namePh": "e.g. filesystem",
    "srv.command": "Command",
    "srv.commandPh": "e.g. npx (single line)",
    "srv.args": "Arguments (one per line)",
    "srv.extensions": "Extensions (comma or space separated)",
    "srv.env": "Environment (one KEY=VALUE per line)",
    "srv.timeout": "Timeout (ms, optional)",
    "srv.readOnly": "Read-only tools",
    "srv.disabled": "Disabled",
    "srv.advancedNote": "remote overrides and cwd are not edited here (saved values are preserved).",
    "srv.save": "Save",
    "srv.cancel": "Cancel",
    "srv.saved": "saved {0}",
    "srv.deleted": "deleted {0}",
    "srv.saveFailed": "could not save: {0}",
    "srv.deleteFailed": "could not delete: {0}",
    "srv.loadFailed": "could not load settings: {0}",
    "srv.deleteConfirm": "Remove server \"{0}\" from the configuration?",
    "srv.badName": "Name must start alphanumeric and contain only letters, digits, ., _ or -",
    "srv.badCommand": "Command must be a single line",
    "srv.badEnv": "Environment entries must be KEY=VALUE",
    "srv.badExtensions": "Enter at least one extension",
    "srv.badTimeout": "Timeout must be between 100 and 600000 ms",
    "sys.desc": "Curator (self-improvement cron) and scheduler state. See the status drawer for details; configure in config.yaml.",
  },
};

let lang = "ja";
try {
  lang = localStorage.getItem("familiar.lang") === "en" ? "en" : "ja";
} catch { /* storage unavailable */ }

/** Translate a key, optionally interpolating {0}, {1}… */
function t(key, ...args) {
  const dict = STR[lang] ?? STR.ja;
  let s = dict[key] ?? STR.ja[key] ?? key;
  args.forEach((a, i) => {
    s = s.split(`{${i}}`).join(String(a));
  });
  return s;
}

/** Persist and apply the interface language. */
function setLang(value) {
  lang = value === "en" ? "en" : "ja";
  document.documentElement.lang = lang;
  try { localStorage.setItem("familiar.lang", lang); } catch { /* ignore */ }
  applyI18n();
  // String built by JS renderers baked t() in at render time — re-render them
  // now so nothing stays in the old language until an unrelated interaction.
  rerenderLocalizedChrome();
}

/**
 * Re-render the JS-built chrome whose text is set with t() at render time
 * (the static shell is handled by applyI18n through data-i18n attributes).
 * Called on a language change; guarded so it is safe before boot finishes.
 */
function rerenderLocalizedChrome() {
  const settings = $("#settings-overlay");
  if (settings && !settings.hidden) {
    renderSettingsNav();
    renderSettingsSection(settingsSection);
  }
  if ($("#sessions")) renderSessions();
  renderTabs();
  void refreshTodoProgress();
  const rp = $("#rightpane");
  if (rp && !rp.hidden) {
    const tab = activePaneTab();
    if (tab) showPane(tab);
  }
}

/**
 * Apply strings to static HTML (data-i18n / -ph / -title) plus the
 * JS-managed labels that can't be attributes (chips, placeholder that
 * depends on prefs, composer, drawer state strings).
 */
function applyI18n() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset["i18n"]);
  }
  for (const el of document.querySelectorAll("[data-i18n-ph]")) {
    el.placeholder = t(el.dataset["i18nPh"]);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset["i18nTitle"]);
  }
  // dynamic labels
  applyComposerPlaceholder();
  refreshSendButton();
  $("#session-title").textContent = state.currentSession
    ? state.currentSession.title
    : t("top.noSession");
  renderModeChip();
  renderEffortChip();
  if (state.modelChipDefault) {
    $("#model-chip").textContent = `${t("chip.modelLabel")} ▾`;
  }
}

/** Phones/tablets (touch + narrow): the on-screen Enter key inserts a newline
 *  and the ↑ button sends, so the send-key preference does not apply there. */
function mobileComposer() {
  try {
    return (
      window.matchMedia("(pointer: coarse)").matches &&
      window.matchMedia("(max-width: 900px)").matches
    );
  } catch {
    return false;
  }
}

/** Composer placeholder reflects the send-key preference (or the mobile hint). */
function applyComposerPlaceholder() {
  $("#input").placeholder = state.busy
    ? t("composer.phBusy")
    : mobileComposer()
      ? t("composer.phMobile")
      : prefs.sendWithEnter
        ? t("composer.phEnter")
        : t("composer.phCtrl");
}

// ---- md-render (pure, DOM-free; kept contiguous for headless unit tests) ----
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** Inline markup: code spans → bold → italic → links. Input is raw text. */
function mdInline(src) {
  let t = escapeHtml(src);
  const codeSpans = [];
  t = t.replace(/`([^`\n]+)`/g, (_m, c) => {
    codeSpans.push(`<code>${c}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt, url) =>
    `<a href="${url}" target="_blank" rel="noreferrer noopener">${txt}</a>`);
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] ?? "");
  return t;
}

/** Separator row of a GFM table: only dashes/colons/pipes, at least one pipe. */
function isTableSeparator(line) {
  if (!line.includes("|") || !line.includes("-")) return false;
  return /^\s*\|?[\s:|-]*\|[\s:|-]*\|?\s*$/.test(line);
}

/** Split "| a | b |" into trimmed cells. */
function splitTableRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/** Alignment for a separator cell (:--- left, ---: right, :--: center). */
function tableAlign(cell) {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "";
}

/** One fenced code block; long blocks render collapsed (expandable). */
function codeBlockHtml(code, lang) {
  const lineCount = code.split("\n").length;
  const head =
    (lang ? `<span class="lang">${escapeHtml(lang)}</span>` : "") +
    `<button class="code-copy" type="button" title="copy">⧉</button>` +
    (lineCount > 16 ? `<button class="code-expand" type="button">show all</button>` : "");
  const cls = lineCount > 16 ? " collapsed" : "";
  return (
    `<div class="codeblock${cls}">` +
    `<div class="code-head">${head}</div>` +
    `<pre><code>${escapeHtml(code)}</code></pre>` +
    `</div>`
  );
}

/**
 * Minimal safe markdown: headings, hr, blockquote, ul/ol lists, fenced code,
 * paragraphs (soft-break joined). No raw-HTML passthrough — everything that
 * is not a produced tag escapes.
 */
function mdRender(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let listType = null;
  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map(mdInline).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      flushPara();
      flushList();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // consuming fence closer (or EOF)
      out.push(codeBlockHtml(buf.join("\n"), fence[1] ?? ""));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min((heading[1] ?? "").length + 2, 5);
      out.push(`<h${level}>${mdInline(heading[2] ?? "")}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr>");
      i += 1;
      continue;
    }
    // GFM table: | a | b |  followed by | --- | --- |
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      flushPara();
      flushList();
      const head = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1] ?? "").map(tableAlign);
      i += 2;
      const rows = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(splitTableRow(lines[i] ?? ""));
        i += 1;
      }
      const cell = (tag, text, idx) => {
        const a = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "";
        return `<${tag}${a}>${mdInline(text)}</${tag}>`;
      };
      const thead = head.map((h, idx) => cell("th", h, idx)).join("");
      const tbody = rows
        .map((r) => `<tr>${r.map((c, idx) => cell("td", c, idx)).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      out.push(`<blockquote>${mdInline(quote[1] ?? "")}</blockquote>`);
      i += 1;
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? "ul" : "ol";
      if (listType !== want) {
        flushList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${mdInline((ul ?? ol)[1] ?? "")}</li>`);
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      i += 1;
      continue;
    }
    flushList();
    para.push(line);
    i += 1;
  }
  flushPara();
  flushList();
  return out.join("");
}
// ---- end md-render ----

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function relTime(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function copyText(text) {
  // Electron: the shell writes to the OS clipboard directly (works even when
  // the page is plain http:// on a LAN address, where navigator.clipboard is
  // unavailable)
  try {
    if (typeof window.familiarDesktop?.writeClipboard === "function") {
      if (await window.familiarDesktop.writeClipboard(text)) return true;
    }
  } catch { /* fall through to the web APIs */ }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function toast(msg, kind = "info") {
  const box = $("#toasts");
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = msg;
  node.addEventListener("click", () => node.remove());
  box.appendChild(node);
  setTimeout(() => node.remove(), 4500);
}

// ---------------------------------------------------------------------------
// app state
// ---------------------------------------------------------------------------
const state = {
  sessions: [],
  sessionId: null,
  currentSession: null,
  busy: false,
  pendingEvents: new Map(), // sessionId -> partial assistant render state
  pendingBubble: null, // "received" placeholder shown until the first token
  runningTextBySession: new Map(), // sessionId -> instruction being processed
  pendingToolCards: [], // live tool.call cards awaiting their result
  pendingAttachments: [], // images waiting in the composer (multimodal send)
  busySessionId: null, // session whose turn is running (busy is global, turns are not)
  /** after this long without a first token, explain the likely cause */
  pendingHintMs: 25_000,
  turnStartedAt: null,
  turnTimer: null,
  lastElapsed: null,
  /** live assistant bubbles of the running turn (thinking collapse + footer). */
  turnBubbles: [],
  mode: "edit", // "plan" | "ask" | "edit" | "yolo" — permission mode, sent per turn
  lastEditMode: "edit", // what Tab returns to when leaving plan
  /** pending provider/model/effort change before the next turn (applied + persisted). */
  draft: { provider: "", model: "", effort: "" },
  /** tokens seen this browsing session, per session id (turn.end events). */
  usageBySession: {},
  /** last turn's prompt tokens per session ≈ current context size. */
  lastPromptTokensBySession: {},
  /** last prompt's token composition per session (system/tools/history/toolResults) */
  contextBySession: {},
  ctxEstimated: {},          // sessionId -> true while the gauge shows a history estimate
  modelCtxIsDefault: {},     // "provider/model" -> true when the window is the fallback
  /** cached context window sizes (provider/model → tokens|null). */
  modelCtxCache: {},
  toolCounter: 0,
  /** true while the model chip shows the localized placeholder (no selection). */
  modelChipDefault: true,
  /** last user message text, used by the retry button (Hermes /retry). */
  lastUserText: "",
  /** instructions typed while a turn runs; sent one by one after it ends */
  queue: [],
  /** sessions opened as tabs (ids); only the active folder's are shown */
  openTabs: [],
};

const ns = {
  providers: {},
  profiles: {},
  defaultProvider: null,
  defaultModel: null,
  loaded: false,
};

/** Built-in provider catalog for the settings screen (connected vs. candidates).
 * The GUI never lists a key-less placeholder as connected — a provider moves to
 * the "Connected" section once its key resolves (or it needs no key). */
// ---- provider-brand ----
/**
 * Brand marks normalized to 24x24 path data.
 * Source: Simple Icons (CC0 1.0), https://simpleicons.org/.
 * The trademarks themselves remain the property of their respective owners.
 */
const PROVIDER_MARKS = {"openai": "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z", "anthropic": "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z", "google": "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81", "nvidia": "M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z", "ollama": "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z"};

/** Additional Simple Icons mark: OpenRouter (CC0 1.0). */
PROVIDER_MARKS.openrouter = "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z";

const KNOWN_PROVIDERS = [
  { id: "openai", label: "OpenAI", kind: "openai_compatible", base_url: "https://api.openai.com/v1", color: "#10a37f", ink: "#ffffff", env: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", base_url: "https://api.anthropic.com/v1", color: "#d97757", ink: "#ffffff", env: "ANTHROPIC_API_KEY" },
  { id: "google", label: "Google Gemini", kind: "openai_compatible", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", color: "#4285f4", ink: "#ffffff", env: "GEMINI_API_KEY" },
  { id: "nvidia", label: "NVIDIA", kind: "openai_compatible", base_url: "https://integrate.api.nvidia.com/v1", color: "#76b900", ink: "#101014", env: "NVIDIA_API_KEY" },
  { id: "openrouter", label: "OpenRouter", kind: "openai_compatible", base_url: "https://openrouter.ai/api/v1", color: "#8083f2", ink: "#ffffff", env: "OPENROUTER_API_KEY" },
  { id: "ollama", label: "Ollama", kind: "openai_compatible", base_url: "http://127.0.0.1:11434/v1", color: "#e5e5e5", ink: "#151519", env: null },
];

/** Hosts that identify a known brand even when the configured provider ID is custom. */
const PROVIDER_HOSTS = [
  { host: "api.openai.com", id: "openai" },
  { host: "api.anthropic.com", id: "anthropic" },
  { host: "generativelanguage.googleapis.com", id: "google" },
  { host: "integrate.api.nvidia.com", id: "nvidia" },
  { host: "openrouter.ai", id: "openrouter" },
];

/** Endpoints used by the provider kinds when base_url is omitted. */
const PROVIDER_KIND_DEFAULTS = {
  openai_compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

/**
 * Resolve a provider's known brand. An explicit built-in ID always wins; a
 * custom ID is resolved from its effective endpoint (configured base_url, or
 * the provider kind's default endpoint when base_url is omitted).
 */
function providerKnown(name, baseUrl = "", kind = "") {
  const id = String(name ?? "").toLowerCase();
  const direct = KNOWN_PROVIDERS.find((known) => known.id === id);
  if (direct) return direct;
  const configuredUrl = String(baseUrl ?? "").trim();
  const effectiveUrl = configuredUrl || PROVIDER_KIND_DEFAULTS[String(kind ?? "")] || "";
  if (!effectiveUrl) return null;
  try {
    const url = new URL(effectiveUrl);
    const host = url.hostname.toLowerCase();
    const match = PROVIDER_HOSTS.find(
      (entry) => host === entry.host || host.endsWith(`.${entry.host}`),
    );
    if (match) return KNOWN_PROVIDERS.find((known) => known.id === match.id) ?? null;
    if (
      (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") &&
      url.port === "11434"
    ) {
      return KNOWN_PROVIDERS.find((known) => known.id === "ollama") ?? null;
    }
  } catch {
    /* incomplete custom URL: keep the neutral fallback */
  }
  return null;
}

/** Brand ID used to select a local SVG mark; null means neutral monogram. */
function providerBrandId(name, baseUrl = "", kind = "") {
  return providerKnown(name, baseUrl, kind)?.id ?? null;
}

/** Colored tile with the provider's brand mark — used in provider selectors. */
function providerTile(name, color, baseUrl = "", kind = "") {
  const known = providerKnown(name, baseUrl, kind);
  const d = known ? PROVIDER_MARKS[known.id] : undefined;
  const tileColor = known?.color ?? color;
  const ink = known?.ink ?? "#151519";
  if (d) {
    return (
      `<span class="plogo" style="background:${esc(tileColor)}">` +
      `<svg viewBox="0 0 24 24" width="13" height="13" fill="${esc(ink)}" aria-hidden="true" focusable="false"><path d="${d}"/></svg>` +
      `</span>`
    );
  }
  const mark = (String(name ?? "")[0] ?? "?").toUpperCase();
  return `<span class="plogo" style="background:${esc(tileColor)};color:${esc(ink)}" aria-hidden="true">${esc(mark)}</span>`;
}
// ---- end provider-brand ----

// ---------------------------------------------------------------------------
// appearance: 10 themes × (dark|light) palettes + light/dark/system mode
// Selected values are written to `:root` as CSS custom properties, falling
// back to the stylesheet defaults (= Tokyo Night dark) before JS loads.
// ---------------------------------------------------------------------------
// [x] themes: built on OpenCode's theme list (docs/themes) — see THEMES below
// [x] desktop notifications on turn completion (~/{attention} equivalent)
const THEMES = {
  "Tokyo Night": {
    dark: { bg: "#101014", panel: "#151519", panel2: "#1b1b21", text: "#e8e8ea", dim: "#85858e", accent: "#6c8cff", ok: "#7dc98f", warn: "#d9a35f", err: "#e46a6a", border: "#26262c", bubble: "#3948e0", hover: "#232329", codebg: "#121216" },
    light: { bg: "#e9eaf2", panel: "#f5f6fa", panel2: "#ffffff", text: "#3b4261", dim: "#8990b3", accent: "#2e7de9", ok: "#4a8a3f", warn: "#b07d1e", err: "#c6435c", border: "#d3d6e4", bubble: "#2e7de9", hover: "#dfe2ee", codebg: "#f2f3f9" },
  },
  Catppuccin: {
    dark: { bg: "#1e1e2e", panel: "#181825", panel2: "#313244", text: "#cdd6f4", dim: "#6c7086", accent: "#89b4fa", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", border: "#454758", bubble: "#585b70", hover: "#37394f", codebg: "#1d1d29" },
    light: { bg: "#eef1f6", panel: "#fbfcfe", panel2: "#ffffff", text: "#4c4f69", dim: "#8c8fa1", accent: "#1e66f5", ok: "#40a02b", warn: "#df8e1d", err: "#d20f39", border: "#ccd0da", bubble: "#1e66f5", hover: "#e4e7ef", codebg: "#f5f6fa" },
  },
  "Catppuccin Macchiato": {
    dark: { bg: "#24273a", panel: "#1e2030", panel2: "#363a4f", text: "#cad3f5", dim: "#6e738d", accent: "#8aadf4", ok: "#a6da95", warn: "#eed49f", err: "#ee99a0", border: "#494d64", bubble: "#5b6078", hover: "#3f4258", codebg: "#20212f" },
    light: { bg: "#eff1f5", panel: "#fbfcfe", panel2: "#ffffff", text: "#4c4f69", dim: "#8c8fa1", accent: "#1e66f5", ok: "#40a02b", warn: "#df8e1d", err: "#d20f39", border: "#ccd0da", bubble: "#1e66f5", hover: "#e4e7ef", codebg: "#f5f6fa" },
  },
  Ayu: {
    dark: { bg: "#0b0e14", panel: "#11151c", panel2: "#1c212c", text: "#e6e1cf", dim: "#8a9199", accent: "#ff995e", ok: "#aad94c", warn: "#ffc94c", err: "#f07178", border: "#232a3c", bubble: "#5a6b7e", hover: "#1e2430", codebg: "#0e1219" },
    light: { bg: "#fafafa", panel: "#f1f3f5", panel2: "#ffffff", text: "#57566b", dim: "#8a9199", accent: "#ff995e", ok: "#86b300", warn: "#f2ae49", err: "#e6504f", border: "#e2e5e9", bubble: "#ff995e", hover: "#eaedef", codebg: "#f5f7f8" },
  },
  Matrix: {
    dark: { bg: "#041105", panel: "#061808", panel2: "#0b2410", text: "#9de6a4", dim: "#3f7a4c", accent: "#27e879", ok: "#7dff9a", warn: "#b7e86a", err: "#ff5f5f", border: "#123f1e", bubble: "#1e7a3c", hover: "#0e2a15", codebg: "#05150a" },
    light: { bg: "#eef7ee", panel: "#f6fbf6", panel2: "#ffffff", text: "#1e3f26", dim: "#5c7c64", accent: "#128a44", ok: "#1d8a4a", warn: "#8a6d1d", err: "#b02a37", border: "#cfdecf", bubble: "#128a44", hover: "#e2f0e2", codebg: "#f2f9f2" },
  },
  Nord: {
    dark: { bg: "#2e3440", panel: "#292f3a", panel2: "#3b4252", text: "#eceff4", dim: "#77839c", accent: "#88c0d0", ok: "#a3be8c", warn: "#ebcb8b", err: "#bf616a", border: "#434c5e", bubble: "#5e81ac", hover: "#3f4a5e", codebg: "#272c36" },
    light: { bg: "#eceff4", panel: "#f6f8fa", panel2: "#ffffff", text: "#2e3440", dim: "#6b7590", accent: "#5e81ac", ok: "#56831d", warn: "#9a6f16", err: "#8c4351", border: "#d8dee9", bubble: "#5e81ac", hover: "#e2e7ef", codebg: "#f2f4f7" },
  },
  Dracula: {
    dark: { bg: "#282a36", panel: "#21222c", panel2: "#343746", text: "#f8f8f2", dim: "#6272a4", accent: "#bd93f9", ok: "#50fa7b", warn: "#f1fa8c", err: "#ff5555", border: "#44475a", bubble: "#6272a4", hover: "#3d4059", codebg: "#242634" },
    light: { bg: "#f0eff6", panel: "#faf9fc", panel2: "#ffffff", text: "#3d3a50", dim: "#7a7a96", accent: "#8a56c2", ok: "#1e9a52", warn: "#a58505", err: "#d73a49", border: "#dcdbe8", bubble: "#8a56c2", hover: "#e6e4f0", codebg: "#f5f4fa" },
  },
  "Rosé Pine": {
    dark: { bg: "#191724", panel: "#1f1d2e", panel2: "#26233a", text: "#e0def4", dim: "#908caa", accent: "#c4a7e7", ok: "#9ccfd8", warn: "#f6c177", err: "#eb6f92", border: "#403d52", bubble: "#31748f", hover: "#2a2740", codebg: "#1c1a28" },
    light: { bg: "#faf4ed", panel: "#fffaf3", panel2: "#ffffff", text: "#575279", dim: "#9893a5", accent: "#907aa9", ok: "#56949f", warn: "#ea9d34", err: "#b4637a", border: "#e0dad6", bubble: "#907aa9", hover: "#f2e9e4", codebg: "#fdf9f3" },
  },
  Kanagawa: {
    dark: { bg: "#1f1f28", panel: "#16161d", panel2: "#2a2a37", text: "#dcd7ba", dim: "#727169", accent: "#7e9cd8", ok: "#98bb6c", warn: "#ffa066", err: "#e46876", border: "#2f3139", bubble: "#2d4f67", hover: "#26262f", codebg: "#1c1c24" },
    light: { bg: "#f2ecbc", panel: "#f8f0d8", panel2: "#fdf6e3", text: "#43436a", dim: "#8b8a80", accent: "#426e9c", ok: "#5d714a", warn: "#c4754c", err: "#c14b4a", border: "#ddd6ac", bubble: "#426e9c", hover: "#e9e2b4", codebg: "#f4eed0" },
  },
  Everforest: {
    dark: { bg: "#2d352b", panel: "#262a25", panel2: "#343934", text: "#d3c6aa", dim: "#859289", accent: "#a7c080", ok: "#83b09a", warn: "#dbbc7f", err: "#e67e80", border: "#3d453c", bubble: "#5a7a6a", hover: "#31372f", codebg: "#292e28" },
    light: { bg: "#fdf6e3", panel: "#f6f1dc", panel2: "#ffffff", text: "#5c6a72", dim: "#98a49b", accent: "#8da101", ok: "#35a77c", warn: "#dfa000", err: "#f85552", border: "#e5dfc5", bubble: "#8da101", hover: "#efe9d2", codebg: "#faf5e4" },
  },
  Gruvbox: {
    dark: { bg: "#282828", panel: "#1d2021", panel2: "#3c3836", text: "#ebdbb2", dim: "#928374", accent: "#83a598", ok: "#b8bb26", warn: "#fabd2f", err: "#fb4934", border: "#504945", bubble: "#83a598", hover: "#3a3532", codebg: "#242220" },
    light: { bg: "#fbf1c7", panel: "#f6ecc6", panel2: "#ffffff", text: "#3c3836", dim: "#7c6f64", accent: "#076678", ok: "#79740e", warn: "#b57614", err: "#9d0006", border: "#d5c4a1", bubble: "#076678", hover: "#ece4b8", codebg: "#f7edc6" },
  },
  Solarized: {
    dark: { bg: "#002b36", panel: "#073642", panel2: "#0e4653", text: "#eee8d5", dim: "#657b83", accent: "#268bd2", ok: "#859900", warn: "#b58900", err: "#dc322f", border: "#0a444f", bubble: "#268bd2", hover: "#0a3e4a", codebg: "#06333f" },
    light: { bg: "#fdf6e3", panel: "#eee8d5", panel2: "#fbf4de", text: "#657b83", dim: "#93a1a1", accent: "#268bd2", ok: "#859900", warn: "#b58900", err: "#dc322f", border: "#dcd6c1", bubble: "#268bd2", hover: "#e9e1cc", codebg: "#f6efdd" },
  },
  One: {
    dark: { bg: "#282c34", panel: "#21252b", panel2: "#2f343e", text: "#d7dae0", dim: "#636d83", accent: "#61afef", ok: "#98c379", warn: "#d19a66", err: "#e06c75", border: "#3e4451", bubble: "#4c78cc", hover: "#373c46", codebg: "#232730" },
    light: { bg: "#f2f3f5", panel: "#fafbfc", panel2: "#ffffff", text: "#383a42", dim: "#82899a", accent: "#4078f2", ok: "#50a14f", warn: "#c18401", err: "#e45649", border: "#dcdfe4", bubble: "#4078f2", hover: "#e8eaed", codebg: "#f4f5f7" },
  },
  Oxocarbon: {
    dark: { bg: "#161616", panel: "#1c1c1e", panel2: "#26262b", text: "#f2f4f8", dim: "#8d8d93", accent: "#78a9ff", ok: "#42be65", warn: "#f1c21b", err: "#fa4d56", border: "#343439", bubble: "#5a66d6", hover: "#26262a", codebg: "#131316" },
    light: { bg: "#f4f4f4", panel: "#fafafa", panel2: "#ffffff", text: "#161616", dim: "#525252", accent: "#0f62fe", ok: "#24a148", warn: "#bf8b00", err: "#da1e28", border: "#d0d0d3", bubble: "#0f62fe", hover: "#e8e8ea", codebg: "#f0f0f2" },
  },
};
/** Theme tooltips — translated (the THEMES table stays locale-free). */
const THEME_DESC = {
  "Tokyo Night": { ja: "深い藍色の背景に青系アクセント。ターミナル定番のダーク配色", en: "dark navy with blue accents — the classic terminal dark" },
  Catppuccin: { ja: "柔らかいパステル調。ダーク/ライト両方", en: "soft pastels — both dark and light" },
  "Catppuccin Macchiato": { ja: "グレーがかった落ち着いたパステル調", en: "muted, grey-tinted pastels" },
  Ayu: { ja: "暖かいオレンジのアクセント", en: "warm orange accents" },
  Matrix: { ja: "緑基調のターミナル風。マトリックス風の強いダーク", en: "green terminal look — a strong Matrix-style dark" },
  Nord: { ja: "寒色系の落ち着いたブルーグレー", en: "cool, calm blue-grey" },
  Dracula: { ja: "紫系の鮮やかな定番ダーク", en: "vivid purple — the well-known dark theme" },
  "Rosé Pine": { ja: "ローズ/パープル系の上品な配色", en: "refined rose and purple palette" },
  Kanagawa: { ja: "和風の深い色調。墨と藍のダーク", en: "deep Japanese tones — ink and indigo dark" },
  Everforest: { ja: "落ち着いた森の緑系", en: "calm forest greens" },
  Gruvbox: { ja: "暖かいレトロ調のコントラスト", en: "warm retro contrast" },
  Solarized: { ja: "古典的なターミナル配色(青緑基調)", en: "classic terminal palette (teal-based)" },
  One: { ja: "Atom/VSCode 由来の定番ダーク", en: "the familiar Atom/VSCode dark" },
  Oxocarbon: { ja: "IBM Carbon 風のモノトーン+青アクセント", en: "IBM Carbon-style monochrome with blue accents" },
};


const DEFAULT_THEME = "Tokyo Night";

function currentThemeName() {
  const saved = localStorage.getItem("familiar.theme") ?? DEFAULT_THEME;
  // legacy name from before the "One Dark" → "One" rename
  return saved === "One Dark" ? "One" : saved;
}

function currentModePref() {
  return localStorage.getItem("familiar.mode") ?? "system";
}

/** Resolve the effective light/dark palette and write it onto :root. */
function applyTheme() {
  const name = THEMES[currentThemeName()] ? currentThemeName() : DEFAULT_THEME;
  const pref = currentModePref();
  const eff = pref === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : pref;
  const pal = THEMES[name][eff] ?? THEMES[name].dark;
  for (const [k, v] of Object.entries(pal)) {
    document.documentElement.style.setProperty(`--${k}`, v);
  }
  document.documentElement.dataset.theme = name;
  document.documentElement.dataset.mode = eff;
  document.documentElement.dataset.modePref = pref;
}

function setModePref(pref) {
  localStorage.setItem("familiar.mode", pref);
  applyTheme();
}

function setThemeName(name) {
  localStorage.setItem("familiar.theme", name);
  applyTheme();
}

// ---------------------------------------------------------------------------
// sessions sidebar
// ---------------------------------------------------------------------------
const FOLDER_FOLDS_KEY = "familiar.folderFolds";

function loadFolderFolds() {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDER_FOLDS_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function saveFolderFolds(folds) {
  localStorage.setItem(FOLDER_FOLDS_KEY, JSON.stringify(folds));
}

function baseName(p) {
  return (p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || (p || "");
}

function sessionLi(s) {
  const li = document.createElement("li");
  li.dataset.id = s.id;
  li.dataset.cwd = s.cwd || "";
  const title = s.title || s.id.slice(0, 8);
  const model = s.model ? "/" + s.model : "";
  const target = sessionTarget(s);
  const when = fmtTime(s.updatedAt);
  li.dataset.target = target;
  li.innerHTML =
    `<div class="row-line"><span class="t">${esc(title)}</span>` +
    (s.running ? `<span class="run-dot" title="${esc(t("side.running"))}"></span>` : "") +
    `<button class="del" data-id="${esc(s.id)}" title="delete session">✕</button></div>` +
    `<span class="when" title="${esc(when)}">${esc(relTime(s.updatedAt))} · ${esc(s.provider)}${esc(model)}${
      target === "local" ? "" : ` · ssh:${esc(target)}`
    }</span>`;
  if (s.id === state.sessionId) li.classList.add("active");
  return li;
}

/** Where a session runs: "local", or "user@host" for SSH (proxy) sessions. */
function sessionTarget(s) {
  if (!s?.remote) return "local";
  return `${s.remote.user ? `${s.remote.user}@` : ""}${s.remote.host}`;
}

async function refreshSessions() {
  state.sessions = await rpc("session.list");
  renderSessions();
  if (!state.sessionId && state.sessions.length > 0) {
    // reopen the session the user was last viewing (falls back to the newest)
    let target = state.sessions[0].id;
    try {
      const last = localStorage.getItem("familiar.lastSession");
      if (last && state.sessions.some((x) => x.id === last)) target = last;
    } catch { /* ignore */ }
    await openSession(target);
  }
}

/** Draw the sidebar from state.sessions (no RPC) — also used while filtering. */
function renderSessions() {
  const ul = $("#sessions");
  ul.innerHTML = "";
  // Claude-desktop-style grouping: one collapsible folder (cwd) section,
  // newest folder first, newest session first within the folder.
  // group by *target + folder*: the same path on the local machine and on an
  // SSH host is a different workspace and must not merge
  const groups = new Map();
  for (const s of state.sessions) {
    const target = sessionTarget(s);
    const key = `${target}|${s.cwd || ""}`;
    if (!groups.has(key)) groups.set(key, { target, cwd: s.cwd || "", list: [] });
    groups.get(key).list.push(s);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) =>
      Math.max(...b[1].list.map((x) => x.updatedAt ?? 0)) -
      Math.max(...a[1].list.map((x) => x.updatedAt ?? 0)),
  );
  const folds = loadFolderFolds();
  // while filtering, folders are always shown open: expanding to reveal a hit
  // must not overwrite the user's saved fold state
  const filtering = ($("#session-filter")?.value ?? "").trim() !== "";
  for (const [key, group] of sorted) {
    group.list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const collapsed = filtering ? false : folds[key] === true;
    const badge =
      group.target === "local"
        ? `<span class="ftarget local" title="${esc(t("side.local"))}">💻 ${esc(t("side.local"))}</span>`
        : `<span class="ftarget remote" title="ssh: ${esc(group.target)}">🖥 ${esc(group.target)}</span>`;
    const head = document.createElement("li");
    head.className = "folder-row";
    head.dataset.cwd = group.cwd;
    head.dataset.target = group.target;
    head.dataset.key = key;
    head.title = `${group.target === "local" ? t("side.local") : `ssh: ${group.target}`} — ${
      group.cwd || t("side.noFolder")
    }`;
    head.innerHTML =
      `<button class="folder-toggle" type="button">` +
      `<span class="chev">${collapsed ? "▸" : "▾"}</span>` +
      `<span class="fname">📁 ${esc(baseName(group.cwd) || t("side.noFolder"))}</span>` +
      badge +
      `<span class="fcount">${group.list.length}</span></button>`;
    ul.appendChild(head);
    if (!collapsed) {
      for (const s of group.list) ul.appendChild(sessionLi(s));
    }
  }
  renderFoldAllButton();
  applySessionFilter();
  renderTabs(); // keep tab titles / running dots in sync, prune gone sessions
}

function esc(text) {
  return escapeHtml(text);
}

function applySessionFilter() {
  const query = ($("#session-filter").value || "").trim().toLowerCase();
  let visible = 0;
  const matchesQuery = (s) => {
    if (query === "") return true;
    const hay = `${s.title ?? ""} ${s.provider ?? ""} ${s.model ?? ""} ${sessionTarget(s)}`.toLowerCase();
    return hay.includes(query);
  };
  for (const li of document.querySelectorAll("#sessions li[data-id]")) {
    const s = state.sessions.find((x) => x.id === li.dataset.id) ?? {};
    const show = matchesQuery(s);
    li.classList.toggle("filtered", !show);
    if (show) visible += 1;
  }
  // folder headers: hide when nothing inside matches; auto-expand while filtering
  for (const row of document.querySelectorAll("#sessions .folder-row")) {
    const matches = state.sessions.filter(
      (s) => (s.cwd || "") === row.dataset.cwd && sessionTarget(s) === row.dataset.target && matchesQuery(s),
    );
    row.classList.toggle("filtered", query !== "" && matches.length === 0);
  }
  let none = document.querySelector("#sessions .filter-none");
  if (query !== "" && visible === 0 && state.sessions.length > 0) {
    if (!none) {
      none = document.createElement("li");
      none.className = "filter-none";
      none.textContent = t("sessions.noMatch");
      $("#sessions").appendChild(none);
    }
  } else {
    if (none) none.remove();
  }
}

/**
 * Collapse every folder when any is open, otherwise expand them all. The
 * state is stored per "target|cwd" key so it survives a reload.
 */
function toggleAllFolds() {
  const rows = [...document.querySelectorAll("#sessions .folder-row")];
  if (rows.length === 0) return;
  const folds = loadFolderFolds();
  const anyOpen = rows.some((row) => folds[row.dataset.key] !== true);
  for (const row of rows) folds[row.dataset.key] = anyOpen;
  saveFolderFolds(folds);
  void refreshSessions();
}

/** Keep the fold-all button's icon/label in sync with the current state. */
function renderFoldAllButton() {
  const btn = $("#fold-all-btn");
  if (!btn) return;
  const rows = [...document.querySelectorAll("#sessions .folder-row")];
  const folds = loadFolderFolds();
  const anyOpen = rows.some((row) => folds[row.dataset.key] !== true);
  btn.textContent = anyOpen ? "⇕" : "⇔";
  btn.title = t(anyOpen ? "side.foldAll" : "side.unfoldAll");
}

function toggleFolderFold(row) {
  // the render key is "target|cwd": the same cwd on a local vs an SSH host is
  // a different workspace, so their folded state must not be shared
  const key = row.dataset.key || row.dataset.cwd;
  const folds = loadFolderFolds();
  folds[key] = !folds[key];
  saveFolderFolds(folds);
  void refreshSessions();
}

function ulSessionsClick() {
  $("#sessions").addEventListener("click", (ev) => {
    const fold = ev.target.closest("button.folder-toggle");
    if (fold) {
      const row = fold.closest("li.folder-row");
      if (row) toggleFolderFold(row);
      return;
    }
    const del = ev.target.closest("button.del");
    if (del) {
      void deleteSession(del.dataset.id);
      return;
    }
    const li = ev.target.closest("li");
    if (li?.dataset.id) void openSession(li.dataset.id);
  });
  // right-click menu: rename / export / delete for any session
  $("#sessions").addEventListener("contextmenu", (ev) => {
    const li = ev.target.closest("li");
    if (!li?.dataset.id) return;
    openCtxMenu(ev, li.dataset.id);
  });
  $("#ctx-menu").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const id = $("#ctx-menu").dataset.id;
    hideCtxMenu();
    if (!id) return;
    if (btn.dataset.act === "rename") {
      void openSession(id).then(() => {
        void startRename();
        toast(t("toast.titleEdit"), "info");
      });
    } else if (btn.dataset.act === "export") {
      void exportMarkdown(id);
    } else if (btn.dataset.act === "delete") {
      void deleteSession(id);
    }
  });
}

function formatTokens(n) {
  if (n === undefined || n === null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Ring gauge for the current context size (= the most recent turn's prompt
 * tokens, since every call re-sends the full context) against the model's
 * context window from models.list. Unknown values show an em-dash. */
function updateContextGauge() {
  const { used, win } = ctxNumbers();
  if (win === undefined && state.currentSession) {
    void contextWindowFor(state.currentSession.provider, state.currentSession.model).then(() => {
      renderTopbarGauge();
      renderCtxPane();
      if (activePaneTab() === "ctx") renderCtxPaneBody();
    });
  }
  renderTopbarGauge();
  renderCtxPane();
  if (activePaneTab() === "ctx") renderCtxPaneBody();
}

function ctxNumbers() {
  const used = state.lastPromptTokensBySession[state.sessionId];
  const key = `${state.currentSession?.provider}/${state.currentSession?.model}`;
  const win = state.modelCtxCache[key];
  return {
    used,
    win,
    estimated: state.ctxEstimated[state.sessionId] === true,
    assumed: state.modelCtxIsDefault[key] === true,
  };
}

/** Seed the gauge from the stored history right after a reload: the last
 * per-step usage (meta.usage.promptTokens) plus an estimate of everything
 * appended after it. Marked with ≈ until a live turn reports real usage. */
function seedContextFromHistory(sessionId, messages) {
  if (state.lastPromptTokensBySession[sessionId] !== undefined) return; // live value already known
  const visible = messages.filter((m) => m.meta?.ephemeral !== true);
  if (visible.length === 0) return;
  let base = 0;
  let idx = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    const p = visible[i]?.meta?.usage?.promptTokens;
    if (typeof p === "number" && p > 0) {
      base = p;
      idx = i;
      break;
    }
  }
  // the same assistant message carries the prompt's token composition
  const ctx = visible[idx]?.meta?.context;
  if (ctx && typeof ctx === "object") state.contextBySession[sessionId] = ctx;
  let extra = 0;
  for (let i = idx + 1; i < visible.length; i++) {
    const m = visible[i];
    extra += estimateTokens(String(m.content ?? ""));
    if (typeof m.meta?.reasoning === "string") extra += estimateTokens(m.meta.reasoning);
    if (Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) extra += estimateTokens(String(c?.arguments ?? ""));
    }
  }
  const total = base + extra;
  if (total > 0) {
    state.lastPromptTokensBySession[sessionId] = total;
    state.ctxEstimated[sessionId] = true;
  }
}

function setGaugeSvg(svg, used, win) {
  const textEl = svg.querySelector("text");
  const bar = svg.querySelector(".gauge-bar");
  if (used === undefined) {
    if (textEl) textEl.textContent = "—";
    bar.style.display = "none";
    return;
  }
  bar.style.display = "";
  if (win) {
    const ratio = used / win;
    const c = 2 * Math.PI * 8;
    bar.style.strokeDasharray = `${c}`;
    bar.style.strokeDashoffset = `${c * (1 - Math.min(1, ratio))}`;
    // the ring clamps at 100% but the number tells the truth
    if (textEl) textEl.textContent = `${Math.round(ratio * 100)}%`;
    svg.classList.toggle("over", ratio >= 1);
  } else {
    bar.style.strokeDashoffset = `${2 * Math.PI * 8 * 0.5}`;
    if (textEl) textEl.textContent = formatTokens(used);
  }
}

function renderTopbarGauge() {
  const btn = $("#ctx-gauge");
  const { used, win, estimated, assumed } = ctxNumbers();
  setGaugeSvg(btn.querySelector("svg"), used, win);
  const pctEl = $("#gauge-pct");
  if (used === undefined) {
    pctEl.textContent = "—";
    btn.classList.remove("over", "warn");
    btn.title = t("top.gaugeNoTurn");
    return;
  }
  const approx = estimated ? "≈" : "";
  const winNote = assumed ? ` ${t("ctx.assumed")}` : "";
  if (win) {
    const pct = Math.round((used / win) * 100);
    pctEl.textContent = `${pct}%`;
    // one number, three states: the ring + label turn amber at 75%, red at 100%
    btn.classList.toggle("over", used >= win);
    btn.classList.toggle("warn", used < win && used / win >= 0.75);
    btn.title =
      `${t("chip.ctx")}: ${approx}${formatTokens(used)} / ${formatTokens(win)} tok${winNote} (${pct}%)` +
      (used >= win ? ` — ${t("usage.overNote")}` : "");
  } else {
    pctEl.textContent = formatTokens(used);
    btn.classList.remove("over", "warn");
    btn.title = `${t("chip.ctx")}: ${approx}${formatTokens(used)} tok`;
  }
}

/**
 * Token composition of the last prompt (system / tool schemas / history /
 * tool results) as a labelled bar list. Returns null when nothing was measured
 * yet. Shared by the popover and the right-pane context tab.
 */
function contextBreakdownNode() {
  const c = state.contextBySession[state.sessionId];
  if (!c || typeof c !== "object") return null;
  const wrap = document.createElement("div");
  wrap.className = "ctx-breakdown-body";
  const rows = [
    ["ctx.system", c.system],
    ["ctx.tools", c.tools],
    ["ctx.history", c.history],
    ["ctx.toolResults", c.toolResults],
  ];
  const total = rows.reduce((n, [, v]) => n + (Number(v) || 0), 0) || 1;
  for (const [key, val] of rows) {
    const v = Number(val) || 0;
    const row = document.createElement("div");
    row.className = "ctx-bd-row";
    const label = document.createElement("span");
    label.className = "ctx-bd-label";
    label.textContent = t(key);
    const bar = document.createElement("span");
    bar.className = "ctx-bd-bar";
    const fill = document.createElement("span");
    fill.className = "ctx-bd-fill";
    fill.style.width = `${Math.max(v > 0 ? 2 : 0, Math.round((v / total) * 100))}%`;
    bar.appendChild(fill);
    const num = document.createElement("span");
    num.className = "ctx-bd-num";
    num.textContent = formatTokens(v);
    row.append(label, bar, num);
    wrap.appendChild(row);
  }
  return wrap;
}

/** The composer gauge + its pane (context usage details). */
function renderCtxPane() {
  const { used, win, estimated, assumed } = ctxNumbers();
  const btnSvg = $("#ctx-btn").querySelector("svg");
  const popSvg = $("#ctx-pop").querySelector("svg");
  setGaugeSvg(btnSvg, used, win);
  setGaugeSvg(popSvg, used, win);
  const approx = estimated ? "≈" : "";
  $("#ctx-used").textContent = used === undefined ? "—" : `${approx}${formatTokens(used)} tok`;
  $("#ctx-window").textContent = win
    ? `${formatTokens(win)} tok${assumed ? ` ${t("ctx.assumed")}` : ""}`
    : t("info.unknown");
  $("#ctx-free").textContent =
    used === undefined ? "—" : win ? `${approx}${formatTokens(Math.max(0, win - used))} tok` : "—";
  $("#ctx-head-pct").textContent =
    used === undefined ? "—" : win ? `${Math.round((used / win) * 100)}%` : `${formatTokens(used)} tok`;
  const s = state.currentSession;
  $("#ctx-head-model").textContent = s ? `${s.provider}/${s.model}` : "";
  const note = $("#ctx-note");
  if (used === undefined) {
    note.textContent = t("ctx.noteNoTurn");
  } else if (estimated) {
    note.textContent = t("ctx.noteEstimated");
  } else if (!win) {
    note.textContent = t("ctx.noteNoWindow");
  } else if (used >= win) {
    note.textContent = `${t("ctx.noteHint", formatTokens(used), formatTokens(win))} — ${t("usage.overNote")}`;
  } else {
    note.textContent = t("ctx.noteHint", formatTokens(used), formatTokens(win));
  }
  note.classList.toggle("over", used !== undefined && !!win && used >= win);
  const over = used !== undefined && !!win && used >= win;
  const warn = used !== undefined && !!win && !over && used / win >= 0.75;
  $("#ctx-btn").classList.toggle("over", over);
  $("#ctx-btn").classList.toggle("warn", warn);
  $("#ctx-head-pct").classList.toggle("over", over);
  $("#ctx-head-pct").classList.toggle("warn", warn);
  $("#ctx-pop").classList.toggle("over", over);
  $("#ctx-pop").classList.toggle("warn", warn);
  const bd = $("#ctx-breakdown");
  if (bd) {
    bd.innerHTML = "";
    const node = contextBreakdownNode();
    bd.hidden = !node;
    if (node) {
      const title = document.createElement("div");
      title.className = "ctx-bd-title";
      title.textContent = t("ctx.breakdownTitle");
      bd.append(title, node);
    }
  }
}

/** The context tab inside the right pane (same numbers, card layout). */
function renderCtxPaneBody() {
  const body = $("#ctx-pane-body");
  if (!body) return;
  const { used, win, estimated, assumed } = ctxNumbers();
  const s = state.currentSession;
  const approx = estimated ? "≈" : "";
  body.innerHTML = "";
  const pct = used === undefined ? null : win ? Math.round((used / win) * 100) : null;
  const ring = document.createElement("div");
  ring.className = "ctx-big";
  const R = 30, C = 2 * Math.PI * R;
  const dash = used === undefined || !win || used <= 0
    ? `0 ${C}`
    : `${C * Math.min(1, used / win)} ${C}`;
  const ringLabel = used === undefined ? "—" : win ? `${pct}%` : formatTokens(used);
  if (pct !== null) {
    ring.classList.toggle("over", pct >= 100);
    ring.classList.toggle("warn", pct < 100 && pct >= 75);
  }
  ring.innerHTML =
    `<svg viewBox="0 0 72 72" width="72" height="72">` +
    `<circle class="gauge-track" cx="36" cy="36" r="${R}"></circle>` +
    `<circle class="gauge-bar" cx="36" cy="36" r="${R}" stroke-dasharray="${dash}"></circle>` +
    `<text x="36" y="41" text-anchor="middle">${ringLabel}</text>` +
    `</svg>` +
    `<div class="ctx-big-text"><b>${esc(s ? `${s.provider}/${s.model}` : "—")}</b>` +
    `<span>${used === undefined ? t("ctx.noteNoTurn") : `${approx}${formatTokens(used)} / ${win ? formatTokens(win) : "?"} tok`}</span></div>`;
  body.appendChild(ring);
  // the ring above already carries the percentage — the card must not repeat it
  body.appendChild(sectionCard(t("chip.ctx"), [
    [t("ctx.used"), used === undefined ? t("info.unknown") : `${approx}${formatTokens(used)} tok`],
    [t("ctx.window"), win ? `${formatTokens(win)} tok${assumed ? ` ${t("ctx.assumed")}` : ""}` : t("info.unknown")],
    [t("ctx.free"), used === undefined || !win ? "—" : `${approx}${formatTokens(Math.max(0, win - used))} tok`],
    ["model", s ? `${s.provider}/${s.model}` : "—"],
  ]));
  const note = document.createElement("div");
  note.className = "ctx-note";
  if (used === undefined) note.textContent = t("ctx.noteNoTurn");
  else if (estimated) note.textContent = t("ctx.noteEstimated");
  else if (!win) note.textContent = t("ctx.noteNoWindow");
  else note.textContent = t("ctx.noteHint", formatTokens(used), formatTokens(win));
  body.appendChild(note);
  const bd = contextBreakdownNode();
  if (bd) {
    const card = sectionCard(t("ctx.breakdownTitle"), []);
    card.appendChild(bd);
    body.appendChild(card);
  }
}

const DEFAULT_CTX_TOKENS = 128_000;

async function contextWindowFor(provider, model) {
  const key = `${provider}/${model}`;
  if (!(key in state.modelCtxCache)) {
    let ctx;
    try {
      const res = await rpc("models.list", { provider });
      const list = res.models ?? [];
      const info = list.find((m) => m.id === model) ?? list.find((m) => Boolean(m.contextTokens));
      ctx = info?.contextTokens;
    } catch {
      ctx = undefined;
    }
    if (typeof ctx === "number" && ctx > 0) {
      state.modelCtxCache[key] = ctx;
      state.modelCtxIsDefault[key] = false;
    } else {
      // never leave the gauge at "unknown" — show a labeled default instead
      state.modelCtxCache[key] = DEFAULT_CTX_TOKENS;
      state.modelCtxIsDefault[key] = true;
    }
  }
  return state.modelCtxCache[key];
}

// ---------------------------------------------------------------------------
// session tabs (several sessions of the same folder, kept open side by side)
// ---------------------------------------------------------------------------
function loadOpenTabs() {
  try {
    const raw = localStorage.getItem("familiar.openTabs");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveOpenTabs() {
  try {
    localStorage.setItem("familiar.openTabs", JSON.stringify(state.openTabs.slice(-24)));
  } catch {
    /* storage unavailable */
  }
}

function sessionById(id) {
  return (
    state.sessions.find((s) => s.id === id) ??
    (state.currentSession?.id === id ? state.currentSession : undefined)
  );
}

function tabGroupKey(s) {
  return `${sessionTarget(s)}|${s.cwd || ""}`;
}

function activeGroupKey() {
  const active = sessionById(state.sessionId);
  return active ? tabGroupKey(active) : null;
}

function addOpenTab(id) {
  if (!id || state.openTabs.includes(id)) return;
  state.openTabs.push(id);
  saveOpenTabs();
}

function removeOpenTab(id) {
  const i = state.openTabs.indexOf(id);
  if (i === -1) return;
  state.openTabs.splice(i, 1);
  saveOpenTabs();
}

/** Tabs of the active session's folder, in open order. */
function currentGroupTabs() {
  const group = activeGroupKey();
  if (group === null) return [];
  return state.openTabs
    .map((id) => sessionById(id))
    .filter((s) => s && tabGroupKey(s) === group);
}

function renderTabs() {
  const bar = $("#tabs");
  if (!bar) return;
  const tabs = currentGroupTabs();
  bar.hidden = tabs.length === 0;
  bar.innerHTML = "";
  for (const s of tabs) {
    const running =
      state.runningTextBySession.has(s.id) || state.busySessionId === s.id || s.running === true;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `tab${s.id === state.sessionId ? " active" : ""}`;
    tab.setAttribute("role", "tab");
    tab.dataset.id = s.id;
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = s.title || s.id.slice(0, 8);
    title.title = s.title || s.id.slice(0, 8);
    tab.appendChild(title);
    if (running) {
      const dot = document.createElement("span");
      dot.className = "tab-run";
      tab.appendChild(dot);
    }
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "✕";
    close.title = t("tabs.close");
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeTab(s.id);
    });
    tab.appendChild(close);
    tab.addEventListener("click", () => {
      if (s.id !== state.sessionId) void openSession(s.id);
    });
    // middle-click closes the tab (suppress the autoscroll cursor first)
    tab.addEventListener("mousedown", (ev) => {
      if (ev.button === 1) ev.preventDefault();
    });
    tab.addEventListener("auxclick", (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        closeTab(s.id);
      }
    });
    bar.appendChild(tab);
  }
}

function closeTab(id) {
  const wasActive = id === state.sessionId;
  const group = activeGroupKey();
  removeOpenTab(id);
  if (!wasActive) {
    renderTabs();
    return;
  }
  // the active tab closed: fall back to the last remaining tab of the folder
  const remaining = state.openTabs
    .map((tid) => sessionById(tid))
    .filter((s) => s && group !== null && tabGroupKey(s) === group);
  const next = remaining[remaining.length - 1];
  if (next) void openSession(next.id);
  else renderTabs();
}

async function openSession(id) {
  state.sessionId = id;
  addOpenTab(id);
  state.pendingEvents.delete(id);
  for (const li of document.querySelectorAll("#sessions li")) {
    li.classList.toggle("active", li.dataset.id === id);
  }
  try { localStorage.setItem("familiar.lastSession", id); } catch { /* ignore */ }
  const data = await rpc("session.get", { id });
  // a slower response must not overwrite the session the user picked next
  if (state.sessionId !== id) return;
  const s = data.session;
  state.currentSession = s;
  // keep the tab machinery working for a session that is not in the list yet
  // (e.g. one just created): make sure it is addressable by id
  if (!state.sessions.some((x) => x.id === s.id)) state.sessions.push(s);
  $("#session-title").textContent = s.title || s.id.slice(0, 8);
  const bits = [s.provider];
  if (s.model) bits.push(s.model);
  if (s.profile) bits.push(`profile: ${s.profile}`);
  if (s.remote) {
    bits.push(`ssh: ${s.remote.user ? `${s.remote.user}@` : ""}${s.remote.host}`);
  }
  $("#session-meta").textContent = bits.join(" · ");
  renderSessionCwd(s);
  renderModelChip();
  renderEffortChip();
  void refreshTodoProgress();
  seedContextFromHistory(id, data.messages ?? []);
  updateContextGauge();
  closeAllPops();
  renderTranscript(data.messages ?? []);
  applyTranscriptFilter();
  // a turn may already be live (started before a reload, or by another
  // client) — reflect it instead of looking idle
  if (data.running === true) {
    if (typeof data.runningStartedAt === "number") state.turnStartedAt = data.runningStartedAt;
    if (typeof data.runningText === "string") state.runningTextBySession.set(id, data.runningText);
    state.busySessionId = id;
    setBusy(true);
    showPendingBubble(id);
  } else {
    state.runningTextBySession.delete(id);
  }
  // the Files pane is keyed by session — drop the stale tree when visible
  if (activePaneTab() === "files") {
    filesSessionKey = null;
    void renderFilesTab();
  }
  renderTabs();
}

/** Header chip showing the session's working folder (click to change). */
function renderSessionCwd(s) {
  const btn = $("#edit-cwd");
  if (!btn) return;
  const cwd = s?.cwd ?? "";
  btn.hidden = !cwd || !state.sessionId;
  if (!cwd) { btn.textContent = ""; return; }
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
  btn.textContent = `📁 ${base}`;
  btn.title = cwd;
}

// ---- working-folder modal (type-to-suggest + native browse on desktop) ----
let cwdSuggestTimer = null;

function openCwdModal() {
  const s = state.currentSession;
  if (!s) return;
  const input = $("#cwd-input");
  input.value = s.cwd ?? "";
  const errBox = $("#cwd-overlay .form-error");
  errBox.hidden = true;
  errBox.textContent = "";
  // native folder dialog is only available inside the Electron shell and
  // only when the local machine is the one running the tools
  $("#cwd-browse").hidden = remoteBoot.isRemote || typeof window.familiarDesktop?.pickDirectory !== "function";
  $("#cwd-overlay").hidden = false;
  void refreshCwdSuggest();
  input.focus();
  input.select();
}

function closeCwdModal() {
  $("#cwd-overlay").hidden = true;
}

/** Split the input into the directory to list and the name prefix to filter. */
function cwdQueryParts(v) {
  const t = v.trim();
  if (t === "") return { dir: "", prefix: "" };
  const m = t.match(/^(.*[\\/])([^\\/]*)$/);
  if (m) return { dir: m[1], prefix: m[2] ?? "" };
  return { dir: "", prefix: t }; // bare word: suggest under the home dir
}

async function refreshCwdSuggest() {
  const box = $("#cwd-suggest");
  const { dir, prefix } = cwdQueryParts($("#cwd-input").value);
  let res;
  try {
    res = await rpc("fs.dirs", { path: dir, ...(state.sessionId ? { session: state.sessionId } : {}) });
  } catch {
    box.innerHTML = "";
    return;
  }
  const q = prefix.toLowerCase();
  const base = (d) => d.split(/[\\/]/).pop() ?? d;
  const items = (res.dirs ?? []).filter((d) => base(d).toLowerCase().startsWith(q));
  box.innerHTML = "";
  if (items.length === 0) {
    box.innerHTML = `<div class="mp-note">${esc(t("cwd.noMatch"))}</div>`;
    return;
  }
  for (const d of items.slice(0, 60)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cwd-row";
    row.innerHTML = `<span class="cr-name">📁 ${esc(base(d))}</span><span class="cr-path">${esc(d)}</span>`;
    row.addEventListener("click", () => {
      const input = $("#cwd-input");
      input.value = d + (d.includes("\\") ? "\\" : "/");
      void refreshCwdSuggest();
      input.focus();
    });
    box.appendChild(row);
  }
}

async function confirmCwd() {
  const s = state.currentSession;
  let v = $("#cwd-input").value.trim();
  const errBox = $("#cwd-overlay .form-error");
  if (!s || v === "") return;
  try {
    if (s.remote) {
      // remote folders live on the ssh host: ~ and relative names resolve
      // against its home (local path math must never touch it)
      const info = await rpc("fs.dirs", { path: "", session: s.id });
      v = resolveRemotePath(v, info.home);
    }
    const updated = await rpc("session.update", { id: s.id, cwd: v });
    state.currentSession = updated;
    renderSessionCwd(updated);
    closeCwdModal();
    toast(t("toast.cwdSet", updated.cwd), "ok");
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  }
}

async function deleteSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  const label = s?.title || id.slice(0, 8);
  if (!window.confirm(t("del.confirm", label))) return;
  try {
    await rpc("session.delete", { id });
  } catch (err) {
    toast(t("toast.deleteFailed", err.message), "err");
    return;
  }
  removeOpenTab(id);
  if (state.sessionId === id) {
    state.sessionId = null;
    state.currentSession = null;
    delete state.usageBySession[id];
    delete state.lastPromptTokensBySession[id];
    updateContextGauge();
    renderModelChip();
    $("#session-title").textContent = t("top.noSession");
    $("#session-meta").textContent = "";
    $("#transcript").innerHTML = "";
  }
  await refreshSessions();
}

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------
const RESULT_CAP = 20_000;
const ARGS_CAP = 8_000;

function truncate(text, cap) {
  const s = String(text ?? "");
  return s.length > cap ? s.slice(0, cap) + `\n… (${s.length - cap} more chars)` : s;
}

function renderTranscript(messages) {
  const tr = $("#transcript");
  tr.innerHTML = "";
  state.pendingBubble = null; // the DOM node is gone with innerHTML
  state.pendingToolCards = [];
  state.toolCounter = 0;
  const visible = messages.filter((m) => m.meta?.ephemeral !== true);
  if (visible.length === 0) {
    tr.appendChild(emptyStateNode());
    return;
  }
  const cur = state.currentSession;
  const modelBits = [cur?.provider, cur?.model].filter(Boolean).join("/");
  for (const m of visible) {
    if (m.role === "user") {
      const atts = Array.isArray(m.meta?.attachments) ? m.meta.attachments : [];
      appendMessage("user", m.content, null, { attachments: atts });
    } else if (m.role === "assistant") {
      const footBits = modelBits ? [modelBits] : [];
      const clock = m.createdAt ? fmtClock(m.createdAt) : "";
      if (clock) footBits.push(clock);
      appendMessage("assistant", m.content, null, {
        reasoning: typeof m.meta?.reasoning === "string" ? m.meta.reasoning : undefined,
        footBits,
      });
    } else {
      const call = Array.isArray(m.toolCalls) ? m.toolCalls[0] : undefined;
      const duration = m.meta?.durationMs;
      appendToolCard(
        m.name ?? call?.name ?? "?",
        call?.arguments ?? "",
        m.content ?? "",
        m.meta?.isError === true ? "err" : "done",
        {
          resultLabel: t("tool.result"),
          durationMs: duration,
          ...(typeof m.meta?.diff === "string" ? { diff: m.meta.diff } : {}),
        },
      );
    }
  }
  scrollBottom(true);
}

function emptyStateNode() {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.innerHTML = `
    <div class="glyph"><img src="/icon-192.png" alt="" /></div>
    <h3>${esc(t("home.title"))}</h3>
    <div class="hint">${esc(t("home.hint"))}</div>`;
  return div;
}

/** The placeholder must not survive the first real message of a live turn. */
function dropEmptyState() {
  $("#transcript")?.querySelector(".empty-state")?.remove();
}

/** User / assistant bubbles. opts: { reasoning, footBits, foot } */
function appendMessage(role, content, toolCalls, opts = {}) {
  dropEmptyState();
  const tr = $("#transcript");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble"></div>`;
  const bubble = div.querySelector(".bubble");
  if (role === "assistant") {
    if (opts.reasoning) {
      const det = document.createElement("details");
      det.className = "thinking";
      det.innerHTML = `<summary>◌ ${esc(t("msg.thinking"))}</summary><pre class="th-text"></pre>`;
      det.querySelector(".th-text").textContent = String(opts.reasoning);
      bubble.appendChild(det);
    }
    const contentEl = document.createElement("div");
    contentEl.className = "md";
    contentEl.innerHTML = mdRender(content);
    bubble.appendChild(contentEl);
    if (opts.foot !== false) addMsgFooter(bubble, String(content ?? ""), opts.footBits);
  } else {
    const imgs = Array.isArray(opts.attachments) ? opts.attachments : [];
    if (imgs.length > 0) {
      const grid = document.createElement("div");
      grid.className = "msg-images";
      for (const a of imgs) {
        grid.appendChild(imageThumb(a));
      }
      bubble.appendChild(grid);
      if (content) {
        const txt = document.createElement("div");
        txt.className = "msg-text";
        txt.textContent = content;
        bubble.appendChild(txt);
      }
    } else {
      bubble.textContent = content ?? "";
    }
  }
  void toolCalls;
  tr.appendChild(div);
  scrollBottom();
  return bubble;
}

/** A clickable attachment thumbnail (opens the lightbox). */
function imageThumb(a) {
  const img = document.createElement("img");
  img.className = "msg-img";
  img.src = `data:${a.media_type};base64,${a.data}`;
  img.alt = a.name ?? "attachment";
  img.title = a.name ?? "";
  img.addEventListener("click", () => {
    const overlay = $("#img-overlay");
    const big = $("#img-overlay-img");
    if (!overlay || !big) return;
    big.src = img.src;
    overlay.hidden = false;
  });
  return img;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Rough token estimate for streamed text (usage unavailable): CJK ≈ 1 token per char, other ≈ 4 chars/token. */
function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u0300-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk + other / 4);
}

/** Footer under an assistant bubble: copy button + meta bits (mode · model · time · tok/s). */
function addMsgFooter(bubbleNode, raw, bits) {
  const msg = bubbleNode.closest(".msg");
  if (!msg || msg.querySelector(".msg-foot")) return;
  const foot = document.createElement("div");
  foot.className = "msg-foot";
  foot.innerHTML =
    `<button class="mf-copy" type="button" title="${esc(t("msg.copy"))}">⧉</button>` +
    (bits && bits.length ? `<span class="mf-meta">${esc(bits.join(" · "))}</span>` : "");
  msg.appendChild(foot);
  foot.querySelector(".mf-copy").addEventListener("click", (ev) => {
    const btn = ev.currentTarget;
    void copyText(raw).then((ok) => {
      btn.textContent = ok ? "✓" : "✕";
      btn.classList.toggle("copied", ok);
      btn.classList.toggle("copy-fail", !ok);
      setTimeout(() => {
        btn.textContent = "⧉";
        btn.classList.remove("copied", "copy-fail");
      }, 1200);
    });
  });
}

// ---------------------------------------------------------------------------
// transcript search (client-side, current session)
// ---------------------------------------------------------------------------
function toggleSearch(open) {
  const bar = $("#search-bar");
  const show = open !== undefined ? open : bar.hidden;
  bar.hidden = !show;
  if (show) {
    $("#transcript-search").focus();
  } else {
    $("#transcript-search").value = "";
    applyTranscriptFilter();
  }
}

function applyTranscriptFilter() {
  const q = ($("#transcript-search").value || "").trim().toLowerCase();
  const items = document.querySelectorAll("#transcript .msg, #transcript .toolwrap");
  if (q === "") {
    for (const el of items) el.classList.remove("search-hide");
    $("#search-count").textContent = "";
    return;
  }
  let n = 0;
  for (const el of items) {
    const hit = (el.textContent ?? "").toLowerCase().includes(q);
    el.classList.toggle("search-hide", !hit);
    if (hit) n += 1;
  }
  $("#search-count").textContent = `${n} match${n === 1 ? "" : "es"}`;
}

// ---------------------------------------------------------------------------
// topbar session menu (rename / export / delete)
// ---------------------------------------------------------------------------
/** Composer slash commands (OpenCode-style): type "/" to list, Enter to run. */
const COMMANDS = [
  { cmd: "/new", key: "cmd.new", run: () => openNewSessionModal() },
  { cmd: "/model", key: "cmd.model", run: () => void openModelPopover() },
  { cmd: "/plan", key: "cmd.plan", run: () => setMode("plan") },
  { cmd: "/ask", key: "cmd.ask", run: () => setMode("ask") },
  { cmd: "/edit", key: "cmd.edit", run: () => setMode("edit") },
  { cmd: "/yolo", key: "cmd.yolo", run: () => setMode("yolo") },
  { cmd: "/export", key: "cmd.export", run: () => void exportMarkdown() },
  { cmd: "/retry", key: "cmd.retry", run: () => retryLastTurn() },
  { cmd: "/compact", key: "cmd.compact", run: () => void compactContext() },
  { cmd: "/undo", key: "cmd.undo", run: () => void undoLastTurn() },
  { cmd: "/settings", key: "cmd.settings", run: () => openSettingsModal() },
  { cmd: "/search", key: "cmd.search", run: () => toggleSearch() },
  { cmd: "/find", key: "cmd.find", run: () => openFindPanel() },
  { cmd: "/import", key: "cmd.import", run: () => importTranscript() },
];

/** The trailing "@" token of the composer value, or null when absent. */
function fileToken(value) {
  const at = value.lastIndexOf("@");
  if (at === -1) return null;
  const rest = value.slice(at + 1);
  if (/\s/.test(rest)) return null;
  return rest;
}

let cmdMode = ""; // "" | "cmd" | "file" — what the composer pop currently lists

async function refreshFilePop(token) {
  const list = $("#cmd-list");
  let res;
  try {
    res = await rpc("fs.suggest", {
      prefix: token,
      cwd: state.currentSession?.cwd ?? "",
      ...(state.sessionId ? { session: state.sessionId } : {}),
    });
  } catch {
    $("#cmd-pop").hidden = true;
    return;
  }
  const items = res.items ?? [];
  list.innerHTML = "";
  $("#cmd-pop").hidden = items.length === 0;
  for (const it of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mp-row";
    row.dataset.path = it.path;
    const base = (it.path ?? "").split(/[\\/]/).pop() ?? "";
    row.innerHTML =
      `<span class="mp-name"><span class="cmd-syntax">${esc(it.dir ? "📁" : "📄")} ${esc(base)}</span>` +
      `<span class="cmd-desc">${esc(it.path)}</span></span>`;
    row.addEventListener("click", () => insertFileToken(it.path));
    list.appendChild(row);
  }
}

/** Replace the trailing @token with the chosen path. */
function insertFileToken(p) {
  const input = $("#input");
  const v = input.value;
  const at = v.lastIndexOf("@");
  if (at === -1) return;
  input.value = `${v.slice(0, at)}@${p} `;
  $("#cmd-pop").hidden = true;
  autoSize(input);
  input.focus();
}

function insertFirstFile() {
  const first = $("#cmd-list .mp-row");
  if (!first) return;
  insertFileToken(first.dataset.path ?? "");
}

/** Single entry point for the composer pop: slash commands or @file paths. */
async function updateComposerPop() {
  const v = $("#input").value;
  const token = fileToken(v);
  if (token !== null) {
    cmdMode = "file";
    await refreshFilePop(token);
    return;
  }
  cmdMode = v.startsWith("/") ? "cmd" : "";
  refreshCmdPop();
}

function matchingCommands(value) {
  const v = value.trim().toLowerCase();
  if (v === "" || v.includes(" ")) return [];
  return COMMANDS.filter((c) => c.cmd.startsWith(v));
}

function refreshCmdPop() {
  const pop = $("#cmd-pop");
  const list = $("#cmd-list");
  const items = matchingCommands($("#input").value);
  list.innerHTML = "";
  pop.hidden = items.length === 0;
  for (const c of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mp-row";
    row.dataset.cmd = c.cmd;
    row.innerHTML =
      `<span class="mp-name"><span class="cmd-syntax">${esc(c.cmd)}</span>` +
      `<span class="cmd-desc">${esc(t(c.key))}</span></span>`;
    row.addEventListener("click", () => {
      $("#cmd-pop").hidden = true;
      $("#input").value = "";
      c.run();
    });
    list.appendChild(row);
  }
}

function runFirstCommand() {
  const items = matchingCommands($("#input").value);
  if (items.length === 0) return false;
  $("#cmd-pop").hidden = true;
  $("#input").value = "";
  items[0].run();
  return true;
}

function closeAllPops() {
  for (const id of ["session-menu-pop", "mode-pop", "model-pop", "plus-pop", "effort-pop", "cmd-pop", "ctx-pop"]) {
    $(`#${id}`).hidden = true;
  }
}

function startRename() {
  const title = $("#session-title");
  if (!state.currentSession) return;
  if (title.querySelector("input")) return;
  const original = title.textContent;
  const input = document.createElement("input");
  input.value = original === t("top.noSession") ? "" : original;
  input.spellcheck = false;
  title.textContent = "";
  title.appendChild(input);
  input.focus();
  input.select();
  const commit = async () => {
    if (input.dataset.done) return;
    input.dataset.done = "1";
    const next = input.value.trim();
    if (!next || next === original) {
      title.textContent = original;
      input.remove();
      return;
    }
    title.textContent = next;
    try {
      const updated = await rpc("session.update", { id: state.sessionId, title: next });
      state.currentSession = updated;
      $("#session-title").textContent = updated.title || next;
      await refreshSessions();
      toast(t("toast.renamed"), "ok");
    } catch (err) {
      toast(t("toast.renameFailed", err.message), "err");
      title.textContent = original;
    }
    input.remove();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      void commit();
    } else if (ev.key === "Escape") {
      ev.stopPropagation();
      title.textContent = original;
    }
  });
  input.addEventListener("blur", () => void commit());
}

async function exportMarkdown(targetId = state.sessionId) {
  if (!targetId) {
    toast(t("toast.noExport"), "err");
    return;
  }
  let data;
  try {
    data = await rpc("session.get", { id: targetId });
  } catch (err) {
    toast(t("toast.exportFailed", err.message), "err");
    return;
  }
  const s = data.session;
  const lines = [
    `# ${s.title || s.id.slice(0, 8)}`,
    "",
    `_familiar · ${s.provider}${s.model ? `/${s.model}` : ""}${s.profile ? ` · profile: ${s.profile}` : ""} · ${fmtTime(s.updatedAt)}_`,
    "",
  ];
  for (const m of (data.messages ?? []).filter((x) => x.meta?.ephemeral !== true)) {
    if (m.role === "tool") {
      const call = Array.isArray(m.toolCalls) ? m.toolCalls[0] : undefined;
      const name = m.name ?? call?.name ?? "tool";
      lines.push(`> **tool · ${name}**${m.meta?.isError ? " (error)" : ""}`, "", "```", String(m.content ?? ""), "```", "");
    } else if (m.role === "assistant") {
      lines.push("## assistant", "", String(m.content ?? ""), "");
    } else {
      lines.push("## user", "", String(m.content ?? ""), "");
    }
  }
  const md = lines.join("\n");
  const slug = (s.title || "session").toLowerCase().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `familiar-${slug}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(t("toast.exported"), "ok");
}


/**
 * OpenCode-style inline tool row: "1  read  planets.txt  ✓ 0.3s" — click the
 * row to expand the full arguments + result. Live rows wait for their paired
 * tool.result event (matched by tool name). */
/** Colored diff block (edit/write results) rendered inside a tool card. */
function diffHtml(diff) {
  if (!diff) return "";
  const lines = String(diff).split("\n");
  const out = [];
  for (const ln of lines) {
    if (ln.startsWith("+") && !ln.startsWith("++")) out.push(`<span class="dl-add">${esc(ln)}</span>`);
    else if (ln.startsWith("-") && !ln.startsWith("--")) out.push(`<span class="dl-del">${esc(ln)}</span>`);
    else out.push(`<span class="dl-ctx">${esc(ln)}</span>`);
  }
  return (
    `<div class="tc-section tc-diff"><h5>${esc(t("tool.diff"))}</h5><pre>${out.join("\n")}</pre></div>`
  );
}

function appendToolCard(name, args, resultContent, status, opts = {}) {
  dropEmptyState();
  const tr = $("#transcript");
  const wrap = document.createElement("div");
  wrap.className = `toolwrap ${status === "err" ? "is-error" : status === "run" ? "is-run" : ""}`;
  const argsText = String(args ?? "");
  const preview = firstArgPreview(argsText);
  let argsPretty = null;
  try {
    const parsed = JSON.parse(argsText);
    if (parsed && typeof parsed === "object") argsPretty = JSON.stringify(parsed, null, 2);
  } catch {
    argsPretty = null;
  }
  const argsBlock = argsPretty ?? argsText;
  state.toolCounter += 1;
  const num = state.toolCounter;
  const duration = opts.durationMs !== undefined ? (opts.durationMs / 1000).toFixed(1) : "";
  const expanded = (prefs.toolsExpanded === true || opts.forceExpanded === true) && status !== "run";
  const bodyHtml = `
      ${opts.diff ? diffHtml(opts.diff) : ""}
      ${argsText !== "" ? `<div class="tc-section"><h5>${esc(t("tool.args"))}</h5><pre>${esc(truncate(argsBlock, ARGS_CAP))}</pre></div>` : ""}
      <div class="tc-section tc-result"><h5>${opts.resultLabel ?? t("tool.result")}</h5><pre>${status === "run" ? `<span class="dim">${esc(t("tool.running"))}</span>` : esc(truncate(resultContent, RESULT_CAP))}</pre></div>`;
  wrap.innerHTML = `
    <div class="toolrow">
      <span class="tn">${num}</span>
      <span class="toolname">${esc(name)}</span>
      <span class="targs">${esc(preview)}</span>
      <span class="tmeta">${esc(duration)}</span>
      <span class="tc-status"></span>
      <button class="tc-toggle ghost" type="button" title="${t("tool.details")}">▾</button>
    </div>
    <div class="tc-body" ${expanded ? "" : "hidden"}>${bodyHtml}</div>`;
  if (expanded) wrap.classList.add("open");
  const toggleBody = () => {
    const body = wrap.querySelector(".tc-body");
    body.hidden = !body.hidden;
    wrap.classList.toggle("open", !body.hidden);
  };
  wrap.querySelector(".tc-toggle").addEventListener("click", toggleBody);
  wrap.querySelector(".toolrow").addEventListener("click", toggleBody); // the whole row toggles
  tr.appendChild(wrap);
  scrollBottom();
  const entry = {
    name,
    card: wrap,
    bodyEl: wrap.querySelector(".tc-body"),
    startedAt: status === "run" ? Date.now() : undefined,
    statusEl: wrap.querySelector(".tc-status"),
    resultEl: wrap.querySelector(".tc-result pre"),
    labelEl: wrap.querySelector(".tc-result h5"),
    metaEl: wrap.querySelector(".tmeta"),
    resultFull: String(resultContent ?? ""),
  };
  if (status === "run") state.pendingToolCards.push(entry);
  return entry;
}

/** Human one-line preview from a JSON arguments blob ("path"-ish first value). */
function firstArgPreview(argsText) {
  try {
    const parsed = JSON.parse(argsText);
    if (parsed && typeof parsed === "object") {
      const vals = Object.values(parsed)
        .filter((v) => typeof v === "string" || typeof v === "number")
        .map(String);
      if (vals.length > 0) return vals.join(" ").slice(0, 72);
    }
  } catch {
    /* raw fallback below */
  }
  return argsText.replace(/\s+/g, " ").trim().slice(0, 72);
}

function completeToolCard(entry, content, isError, diff) {
  if (!entry || !entry.resultEl) return;
  if (diff && entry.bodyEl && !entry.bodyEl.querySelector(".tc-diff")) {
    entry.bodyEl.insertAdjacentHTML("afterbegin", diffHtml(diff));
  }
  entry.resultFull = String(content ?? "");
  entry.labelEl.textContent = t(isError ? "tool.error" : "tool.result");
  entry.resultEl.textContent = truncate(content, RESULT_CAP);
  entry.statusEl.textContent = isError ? "✗" : "✓";
  if (!isError) {
    const secs = entry.startedAt !== undefined ? (Date.now() - entry.startedAt) / 1000 : null;
    if (secs !== null && entry.metaEl) entry.metaEl.textContent = `${secs.toFixed(1)}s`;
  }
  entry.card.classList.remove("is-run");
  entry.card.classList.toggle("is-error", isError);
}

function scrollBottom(force = false) {
  if (!force && prefs.autoscroll === false) return;
  const tr = $("#transcript");
  const near = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 240;
  if (force || near) tr.scrollTop = tr.scrollHeight;
}

/**
 * Right under the user's message: proof the run was accepted, shown from the
 * moment we send until the first token/tool call replaces it. Without it the
 * only sign of life was the small top-bar "working…" label (easy to miss).
 */
function showPendingBubble(sessionId) {
  if (sessionId !== state.sessionId) return;
  if (state.pendingBubble) return;
  if (state.pendingEvents.get(sessionId)) return; // a live step already streams
  const wrap = document.createElement("div");
  wrap.className = "msg assistant pending-turn";
  wrap.innerHTML =
    `<div class="bubble"><span class="dots"><i></i><i></i><i></i></span>` +
    `<span class="pending-label">${esc(t("turn.received"))}</span>` +
    `<span class="pending-time"></span></div>`;
  $("#transcript").appendChild(wrap);
  dropEmptyState();
  state.pendingBubble = wrap;
  scrollBottom();
}

function hidePendingBubble() {
  if (!state.pendingBubble) return;
  state.pendingBubble.remove();
  state.pendingBubble = null;
}

/** A quiet full-width line in the transcript (auto-continue notices etc.). */
function appendTurnNote(text) {
  const tr = $("#transcript");
  if (!tr) return;
  const div = document.createElement("div");
  div.className = "turn-note";
  div.textContent = text;
  tr.appendChild(div);
  scrollBottom();
}

/** Small action button inside the top turn label (retry / continue). */
function addLabelButton(labelText, onClick, title) {
  const label = $("#turn-label");
  if (!label || label.querySelector(".label-action")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "label-action";
  btn.textContent = labelText;
  if (title) btn.title = title;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    onClick();
  });
  label.appendChild(btn);
}

// live streaming: one bubble per assistant step for the active session
function liveBubble(sessionId) {
  if (sessionId !== state.sessionId) return null;
  let entry = state.pendingEvents.get(sessionId);
  if (!entry) {
    hidePendingBubble();
    const bubble = appendMessage("assistant", "", null, { foot: false });
    bubble.innerHTML = "";
    const contentEl = document.createElement("div");
    contentEl.className = "md";
    const caret = document.createElement("span");
    caret.className = "caret";
    bubble.appendChild(contentEl);
    bubble.appendChild(caret);
    // the previous step's caret must stop blinking once a new bubble starts
    const prev = state.turnBubbles[state.turnBubbles.length - 1];
    if (prev?.caret) prev.caret.remove();
    entry = { bubble, contentEl, caret, text: "", reasoningEl: null, reasoning: "" };
    state.pendingEvents.set(sessionId, entry);
    state.turnBubbles.push(entry);
  }
  return entry;
}

/** Send button doubles as the stop button: ↑ idle / ■ while a turn runs. */
function refreshSendButton() {
  const send = $("#send");
  // one button: while a turn runs and the box is empty it is ■ (stop); with text
  // it is ↑ (send/steer). Idle it is always ↑.
  const stopMode = state.busy === true && $("#input").value.trim() === "";
  send.classList.toggle("stop", stopMode);
  send.textContent = stopMode ? "■" : (send.dataset.iconIdle ?? "↑");
  send.title = stopMode
    ? t("send.stop")
    : prefs.sendWithEnter
      ? t("send.enter")
      : t("send.ctrlEnter");
}

/** Abort the running turn of the current session. */
async function stopTurn() {
  const target = state.busySessionId ?? state.sessionId;
  if (!state.busy || !target) return;
  try {
    toast(t("toast.stopRequested"), "info");
    await rpc("session.abort", { id: target });
  } catch (err) {
    toast(t("toast.sendFailed", err.message), "err");
  }
}

function setBusy(busy) {
  state.busy = busy;
  if (!busy) state.busySessionId = null;
  $("#send").disabled = false; // always enabled: it steers/queues while busy
  $("#input").disabled = false; // always typeable: send/Enter steers while busy
  $("#turn-spinner").hidden = !busy;
  refreshSendButton();
  applyComposerPlaceholder();
  if (busy) {
    if (!state.turnStartedAt) state.turnStartedAt = Date.now();
    $("#turn-state")?.classList.add("running");
    if (state.turnTimer) clearInterval(state.turnTimer);
    state.turnTimer = setInterval(() => {
      const s = ((Date.now() - state.turnStartedAt) / 1000).toFixed(1);
      $("#turn-label").textContent = t("turn.working", `${s}s`);
      const pendingTime = state.pendingBubble?.querySelector(".pending-time");
      if (pendingTime) pendingTime.textContent = `${Math.floor(Number(s))}s`;
      // the first token of an idle/large session can take minutes (cold model
      // cache): say so instead of leaving the user guessing
      const pendingLabel = state.pendingBubble?.querySelector(".pending-label");
      if (
        pendingLabel &&
        Date.now() - state.turnStartedAt >= state.pendingHintMs &&
        pendingLabel.dataset.hinted !== "1"
      ) {
        pendingLabel.dataset.hinted = "1";
        pendingLabel.textContent = t("turn.longWait");
      }
    }, 100);
  } else {
    $("#turn-state")?.classList.remove("running");
    hidePendingBubble();
    if (state.turnTimer) {
      clearInterval(state.turnTimer);
      state.turnTimer = null;
    }
    if (state.turnStartedAt) {
      const s = ((Date.now() - state.turnStartedAt) / 1000).toFixed(1);
      state.lastElapsed = s;
      state.turnStartedAt = null;
      setTurnEndLabel(t("turn.done", `${s}s`));
    } else {
      $("#turn-label").textContent = "";
    }
    // instructions typed during the turn go out now (one at a time)
    window.setTimeout(() => drainQueue(), 0);
  }
}

/** Pending instructions rendered above the composer. */
function renderQueueStrip() {
  const strip = $("#queue-strip");
  if (!strip) return;
  strip.innerHTML = "";
  strip.hidden = state.queue.length === 0;
  state.queue.forEach((item, idx) => {
    const chip = document.createElement("div");
    chip.className = "queue-chip";
    chip.title = item.text;
    const text = document.createElement("span");
    text.className = "q-text";
    text.textContent = item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text;
    chip.appendChild(text);
    if (item.otherDevice) {
      const note = document.createElement("small");
      note.textContent = t("queue.waiting");
      chip.appendChild(note);
    }
    const sendNow = document.createElement("button");
    sendNow.type = "button";
    sendNow.className = "ghost";
    sendNow.textContent = "⚡";
    sendNow.title = t("queue.sendNow");
    sendNow.addEventListener("click", () => interruptQueued(idx));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "✕";
    del.title = t("queue.cancel");
    del.addEventListener("click", () => {
      state.queue.splice(idx, 1);
      renderQueueStrip();
    });
    chip.append(sendNow, del);
    strip.appendChild(chip);
  });
}

function enqueueMessage(text, atts, opts = {}) {
  state.queue.push({ text, atts, ...(opts.otherDevice ? { otherDevice: true } : {}) });
  renderQueueStrip();
  toast(t(opts.otherDevice ? "queue.otherDevice" : "queue.queued", String(state.queue.length)), "info");
}

/** Send the next queued instruction once nothing is running. */
function drainQueue() {
  if (state.busy || state.queue.length === 0) return;
  const item = state.queue.shift();
  renderQueueStrip();
  void sendTurn(item.text, item.atts ?? []);
}

/** ⚡ on a queued chip: stop the running turn, then send this one first. */
function interruptQueued(idx) {
  const item = state.queue[idx];
  if (!item) return;
  state.queue.splice(idx, 1);
  state.queue.unshift(item);
  renderQueueStrip();
  void stopTurn(); // turn.aborted/end releases busy → drainQueue()
}

const TURN_LABEL_TTL = 10_000;
let turnLabelTimer = null;

function setTurnEndLabel(text) {
  $("#turn-label").textContent = text;
  if (turnLabelTimer) clearTimeout(turnLabelTimer);
  turnLabelTimer = setTimeout(() => {
    $("#turn-label").textContent = "";
  }, TURN_LABEL_TTL);
}

// ---------------------------------------------------------------------------
// events (WS)
// ---------------------------------------------------------------------------
function connectEvents() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const suffix = serverToken ? `?token=${encodeURIComponent(serverToken)}` : "";
  const ws = new WebSocket(`${proto}://${location.host}/ws${suffix}`);
  // error + close both fire for one failed socket — retry exactly once or the
  // reconnects double with every failure (and every event is handled N times)
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    setTimeout(connectEvents, 1500);
  };
  ws.addEventListener("close", retry);
  ws.addEventListener("error", retry);
  ws.addEventListener("message", (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (frame.type !== "event") return;
    // one bad render must not break the rest of the event stream
    try {
      onEvent(frame.sessionId, frame.event);
    } catch (err) {
      console.warn("[familiar] event render failed:", frame.event?.type, err);
    }
  });
}

function onEvent(sessionId, e) {
  if (sessionId === "" && (e.type === "permission.request" || e.type === "permission.resolved")) {
    if (e.type === "permission.request") {
      showApproval(e);
    } else {
      const node = document.querySelector(`#approval-dock .dock[data-request-id="${CSS.escape(e.requestId ?? "")}"]`);
      if (node) node.remove();
      if (document.querySelector("#approval-dock").children.length === 0) $("#turn-label").textContent = "";
    }
    return;
  }
  // was this turn started from here? a turn another client owns must not offer
  // "retry" later (state.lastUserText would belong to a different request)
  const oursTurn = state.busySessionId === sessionId;
  // busy is global but turns are per session: release it even when the turn
  // belongs to a session we are no longer looking at (otherwise wedged forever)
  if (e.type === "turn.end" || e.type === "turn.error" || e.type === "turn.aborted") {
    state.runningTextBySession.delete(sessionId);
  }
  if (
    state.busySessionId === sessionId &&
    (e.type === "turn.end" || e.type === "turn.error" || e.type === "turn.aborted")
  ) {
    setBusy(false);
  }
  // (never fall through to a blanket setBusy(false): a turn.end for a session
  // we merely happen to be viewing must not release someone else's turn)
  if (sessionId !== state.sessionId) return;

  switch (e.type) {
    case "turn.start":
      state.turnBubbles = [];
      setBusy(true);
      state.busySessionId = sessionId;
      if (typeof e.text === "string") state.runningTextBySession.set(sessionId, e.text);
      showPendingBubble(sessionId);
      void refreshSessions(); // sidebar running dot
      break;
    case "message.start":
      state.pendingEvents.delete(sessionId);
      break;
    case "text.delta": {
      const live = liveBubble(sessionId);
      if (live) {
        live.text += e.text;
        live.contentEl.innerHTML = mdRender(live.text);
        scrollBottom();
      }
      break;
    }
    case "reasoning.delta": {
      const live = liveBubble(sessionId);
      if (live) {
        if (!live.reasoningEl) {
          const det = document.createElement("details");
          det.className = "thinking"; // collapsed by default — the user opens it
          det.innerHTML = `<summary>◌ ${esc(t("msg.thinking"))}</summary><pre class="th-text"></pre>`;
          live.bubble.insertBefore(det, live.contentEl);
          live.reasoningEl = det.querySelector(".th-text");
          live.thinkingSummary = det.querySelector("summary");
          live.thinkingEl = det;
        }
        live.reasoning += e.text;
        live.reasoningEl.textContent = live.reasoning;
        if (live.thinkingSummary) {
          live.thinkingSummary.textContent = `◌ ${esc(t("msg.thinking"))} (${live.reasoning.length})`;
        }
        scrollBottom();
      }
      break;
    }
    case "tool.call": {
      state.pendingEvents.delete(sessionId);
      hidePendingBubble();
      appendToolCard(e.toolCall.name, e.toolCall.arguments ?? "", "", "run");
      break;
    }
    case "tool.result": {
      // pair with the last pending card of the same tool name (falls back to
      // the oldest pending card — parallel same-name results are rare)
      let idx = -1;
      for (let i = state.pendingToolCards.length - 1; i >= 0; i--) {
        if (state.pendingToolCards[i]?.name === e.name) {
          idx = i;
          break;
        }
      }
      if (idx < 0) idx = state.pendingToolCards.length > 0 ? 0 : -1;
      const entry = idx >= 0 ? state.pendingToolCards.splice(idx, 1)[0] : null;
      if (entry) {
        completeToolCard(entry, e.content ?? "", e.isError === true, e.diff);
      }
      break;
    }
    case "turn.end": {
      const u = e.usage ?? {};
      const rec = state.usageBySession[sessionId] ?? { prompt: 0, completion: 0 };
      rec.prompt += u.totalPromptTokens ?? u.promptTokens ?? 0;
      rec.completion += u.completionTokens ?? 0;
      state.usageBySession[sessionId] = rec;
      // contextTokens is the LAST step's prompt (the real context size);
      // promptTokens on older servers is the turn total — prefer contextTokens
      const ctxTokens = u.contextTokens ?? u.promptTokens;
      if (ctxTokens !== undefined) {
        state.lastPromptTokensBySession[sessionId] = ctxTokens;
        delete state.ctxEstimated[sessionId]; // real value — drop the ≈ marker
      }
      if (e.context) state.contextBySession[sessionId] = e.context;
      const secs = parseFloat(state.lastElapsed ?? "") || 0;
      const hasUsage = ctxTokens !== undefined;
      let completion = u.completionTokens ?? 0;
      if (!hasUsage) {
        // provider gave no usage (e.g. stream_options rejected): estimate from
        // the streamed text so the speed readout still works
        const all = state.turnBubbles.map((b) => b.text ?? "").join("");
        completion = estimateTokens(all);
      }
      const tps = secs > 0 && completion > 0 ? Math.round(completion / secs) : 0;
      const approx = hasUsage ? "" : "≈";
      const costStr =
        typeof u.costUsd === "number" && u.costUsd > 0 ? ` · $${u.costUsd.toFixed(4)}` : "";
      const toks = hasUsage
        ? ` · ↑${u.promptTokens} ↓${u.completionTokens ?? 0} tok${tps ? ` (${tps} tok/s)` : ""}${costStr}`
        : completion > 0
          ? ` · ↓${approx}${completion} tok${tps ? ` (${approx}${tps} tok/s)` : ""}${costStr}`
          : "";
      setTurnEndLabel(t("turn.done", `${state.lastElapsed ?? ""}${toks}`));
      // collapse thinking blocks, stop carets; footer on the last bubble
      for (const b of state.turnBubbles) {
        if (b.thinkingEl) {
          b.thinkingEl.open = false;
          const sum = b.thinkingEl.querySelector("summary");
          const len = (b.reasoning ?? "").length;
          if (sum && len > 0) sum.textContent = `✓ ${esc(t("msg.thinking"))} (${len})`;
        }
        if (b.caret) b.caret.remove();
      }
      const lastBubble = state.turnBubbles[state.turnBubbles.length - 1];
      if (lastBubble) {
        const s = state.currentSession;
        const bits = [t(`mode.${activeMode()}`)];
        const modelBits = [s?.provider, s?.model].filter(Boolean).join("/");
        if (modelBits) bits.push(modelBits);
        if (secs > 0) bits.push(`${secs.toFixed(1)}s`);
        if (tps) bits.push(`${approx}${tps} tok/s`);
        bits.push(fmtClock(Date.now()));
        addMsgFooter(lastBubble.bubble, lastBubble.text, bits);
      }
      state.turnBubbles = [];
      updateContextGauge();
      maybeNotify();
      void maybeSuggestSkills();
      void refreshTodoProgress();
      state.pendingEvents.delete(sessionId);
      refreshSessions();
      break;
    }
    case "turn.error":
      for (const b of state.turnBubbles) if (b.caret) b.caret.remove();
      state.turnBubbles = [];
      appendMessage("assistant", `⚠ ${e.error}`, null);
      void notifyDesktop(t("notify.turnFailed"), String(e.error ?? "").slice(0, 140), { urgent: true });
      break;
    case "turn.continuing":
      appendTurnNote(
        t(e.kind === "todos" ? "turn.noteTodos" : "turn.noteSteps", String(e.step), String(e.ceiling)),
      );
      break;
    case "turn.ceiling":
      appendTurnNote(t("turn.noteCeiling", String(e.step)));
      // one click to keep the work going, like typing 続けて
      addLabelButton(`▶ ${t("turn.continueNow")}`, () => {
        const word = t("turn.continueWord");
        if (state.busy) enqueueMessage(word, []);
        else void sendTurn(word, []);
      });
      break;
    case "turn.aborted":
      for (const b of state.turnBubbles) if (b.caret) b.caret.remove();
      state.turnBubbles = [];
      setTurnEndLabel(t("turn.stopped"));
      // a stopped turn leaves no answer: make the instruction one click away
      if (oursTurn && state.lastUserText) {
        addLabelButton(`↻ ${t("turn.retryNow")}`, () => retryLastTurn(), state.lastUserText);
      }
      refreshSessions();
      break;
    case "compaction":
      appendTurnNote(
        t(
          e.forced ? "turn.noteCompactionForced" : "turn.noteCompaction",
          String(e.dropped ?? 0),
          String(e.kept ?? 0),
        ),
      );
      break;
    case "budget.warning": {
      const pct = Math.round((e.ratio ?? 0) * 100);
      toast(
        t(
          e.exceeded ? "budget.exceeded" : "budget.near",
          e.scope === "session" ? t("budget.scopeSession") : t("budget.scopeDay"),
          String(e.used ?? 0),
          String(e.limit ?? 0),
          String(pct),
        ),
        e.exceeded ? "err" : "info",
      );
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// dynamic approvals (serve mode)
// ---------------------------------------------------------------------------
function showApproval(e) {
  $("#turn-label").textContent = t("approval.needed", e.tool);
  // approvals block the whole turn — always surface, even when focused
  void notifyDesktop(t("notify.approvalTitle"), `${e.tool}: ${e.summary ?? ""}`.trim(), { urgent: true });
  const dock = $("#approval-dock");
  const node = document.createElement("div");
  node.className = "dock";
  node.dataset.requestId = e.requestId;
  node.innerHTML = `
    <div>⚠ <b>${esc(e.tool)}</b> — ${esc(e.summary)}</div>
    <div class="detail">${esc(e.detail ?? "")}</div>
    <div class="row">
      <button data-act="approve">${esc(t("approval.approve"))}</button>
      <button class="ghost" data-act="deny">${esc(t("approval.deny"))}</button>
    </div>`;
  node
    .querySelector('button[data-act="approve"]')
    .addEventListener("click", () => respondApproval(e.requestId, true, node));
  node
    .querySelector('button[data-act="deny"]')
    .addEventListener("click", () => respondApproval(e.requestId, false, node));
  dock.appendChild(node);
}

async function respondApproval(requestId, approved, node) {
  node.remove();
  if (document.querySelector("#approval-dock").children.length === 0) $("#turn-label").textContent = "";
  try {
    await rpc("permission.respond", { requestId, approved });
    toast(t(approved ? "toast.approved" : "toast.denied"), approved ? "ok" : "info");
  } catch (err) {
    toast(t("toast.approvalFailed", err.message), "err");
  }
}

// ---------------------------------------------------------------------------
// status drawer (curator / MCP / cron)
// ---------------------------------------------------------------------------
const PANE_TABS = ["files", "ctx"];

function showPane(which) {
  $("#rightpane").hidden = false;
  for (const id of PANE_TABS) {
    $(`#${id}`).hidden = id !== which;
  }
  for (const b of document.querySelectorAll(".pane-tabs [data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === which);
  }
  localStorage.setItem("familiar.paneTab", which);
  if (which === "files") void renderFilesTab();
  if (which === "ctx") renderCtxPaneBody();
}

function activePaneTab() {
  return PANE_TABS.find((id) => !$(`#${id}`).hidden) ?? null;
}

function closePane() {
  $("#rightpane").hidden = true;
}

function togglePane() {
  if ($("#rightpane").hidden) {
    const last = localStorage.getItem("familiar.paneTab");
    showPane(PANE_TABS.includes(last) ? last : "files");
  } else {
    closePane();
  }
}

function sectionCard(title, rows, note) {
  const card = document.createElement("div");
  card.className = "card";
  const head = note ? `${esc(title)} <span class="note">${esc(note)}</span>` : esc(title);
  card.innerHTML = `<h4>${head}</h4>`;
  for (const [k, v] of rows) {
    const pair = document.createElement("div");
    pair.className = "pair";
    pair.innerHTML = `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`;
    card.appendChild(pair);
  }
  return card;
}

function sectionError(title, err) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h4>${esc(title)}</h4><div class="status-err">${esc(err.message)}</div>`;
  return card;
}

/** After a turn, nudge the user when the AI staged skill proposals:
 * an inline card in the transcript with one-click approve/reject. */
const SKILL_SUGGEST_SEEN_KEY = "familiar.skillSuggestSeen";

/** Ids already surfaced to this browser (dismissed or handled) — persisted so
 * a leftover proposal (e.g. a stale patch) does not nag on every turn. */
function skillSuggestSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SKILL_SUGGEST_SEEN_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function rememberSkillSuggest(ids) {
  const seen = skillSuggestSeen();
  for (const id of ids) seen.add(id);
  try {
    localStorage.setItem(SKILL_SUGGEST_SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    /* ignore */
  }
}

async function maybeSuggestSkills() {
  try {
    const res = await rpc("skills.pending");
    const items = res.items ?? [];
    if (items.length === 0) return;
    const seen = skillSuggestSeen();
    const fresh = items.filter((x) => !seen.has(x.id));
    if (fresh.length === 0) return;
    rememberSkillSuggest(fresh.map((x) => x.id));
    const names = fresh.map((x) => x.name ?? x.id ?? "?").join(", ");
    void notifyDesktop(t("notify.skillSuggest"), names, { urgent: false });

    // inline card in the transcript
    const tr = $("#transcript");
    const card = document.createElement("div");
    card.className = "skill-suggest";
    const body = document.createElement("div");
    body.className = "skill-suggest-body";
    body.innerHTML =
      `<div class="ss-head"><div class="ss-title">💡 ${esc(t("skills.suggestTitle"))}</div></div>` +
      fresh
        .map((x) => {
          const stale = x.stale === true;
          return (
            `<div class="ss-item${stale ? " is-stale" : ""}">` +
            `<b>${stale ? "⚠ " : ""}${esc(x.name ?? x.id ?? "?")}</b>` +
            `<span>${esc(x.description ?? "")}</span>` +
            (stale ? `<span class="ss-stale">${esc(t("skills.stale"))}</span>` : "") +
            `</div>`
          );
        })
        .join("");
    const head = body.querySelector(".ss-head");
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "ss-close";
    dismiss.textContent = "✕";
    dismiss.title = t("skills.dismissTitle");
    head.appendChild(dismiss);
    const actions = document.createElement("div");
    actions.className = "ss-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = t("skills.approveCreate");
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "ghost";
    reject.textContent = t("skills.rejectShort");
    const status = document.createElement("span");
    status.className = "ss-status";
    actions.append(approve, reject, status);
    card.append(body, actions);
    tr.appendChild(card);
    scrollBottom();
    // ✕ closes the suggestion card only; the staged proposal remains server-side
    dismiss.addEventListener("click", () => card.remove());
    // approve/reject each proposal independently so one stale item
    // (e.g. a CAS-refused patch) cannot block the rest
    const anyApprovable = fresh.some((x) => x.stale !== true);
    if (!anyApprovable) {
      approve.disabled = true;
      approve.title = t("skills.stale");
    }
    let remaining = [...fresh];
    const settle = async (verb, okMsg) => {
      approve.disabled = true;
      reject.disabled = true;
      const succeeded = [];
      const failures = [];
      for (const x of remaining) {
        if (verb === "approve" && x.stale === true) {
          // marked stale by the server (CAS mismatch): applying can only fail
          failures.push({ item: x, message: `${x.name ?? x.id}: ${t("skills.staleShort")}` });
          continue;
        }
        try {
          await rpc(`skills.${verb}`, { prefix: x.id });
          succeeded.push(x.name ?? x.id);
        } catch (err) {
          failures.push({ item: x, message: `${x.name ?? x.id}: ${err.message}` });
        }
      }
      remaining = failures.map((f) => f.item);
      if (failures.length === 0) {
        status.textContent = "✓ " + okMsg;
        status.style.color = "var(--ok)";
        approve.remove();
        reject.remove();
        dismiss.remove();
      } else {
        status.textContent =
          (succeeded.length > 0 ? "✓ " : "✗ ") +
          t("skills.partialResult", String(succeeded.length), String(failures.length), failures.map((f) => f.message).join(" / "));
        status.style.color = "var(--err)";
        approve.disabled = !remaining.some((x) => x.stale !== true); // nothing left worth approving?
        approve.title = approve.disabled ? t("skills.stale") : "";
        reject.disabled = false;
      }
    };
    approve.addEventListener("click", () => settle("approve", t("skills.createdMsg")));
    reject.addEventListener("click", () => settle("reject", t("skills.rejectedMsg")));
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// files tab: lazy tree of the session folder + in-app file viewer
// ---------------------------------------------------------------------------
let filesSessionKey = null;   // "sessionId:cwd" the tree was rendered for
let filesSelectedPath = null; // file currently open in the viewer

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Open the files tab: render the tree when the session/cwd changed. */
async function renderFilesTab() {
  const root = state.currentSession?.cwd ?? "";
  const key = `${state.sessionId}:${root}`;
  if (filesSessionKey === key) return; // DOM persists across tab switches
  filesSessionKey = key;
  filesSelectedPath = null;
  $("#files-tree").hidden = false;
  $("#files-view").hidden = true;
  const tree = $("#files-tree");
  tree.innerHTML = `<div class="files-note">${esc(t("files.loading"))}</div>`;
  tree.innerHTML = "";
  const head = document.createElement("div");
  head.className = "files-head";
  head.innerHTML = `<span class="files-root" title="${esc(root)}">📁 ${esc(baseName(root) || root)}</span>`;
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "ghost";
  refresh.textContent = "↻";
  refresh.title = t("files.refresh");
  refresh.addEventListener("click", () => {
    filesSessionKey = null;
    void renderFilesTab();
  });
  head.appendChild(refresh);
  tree.appendChild(head);
  const list = document.createElement("div");
  list.className = "files-list";
  tree.appendChild(list);
  let res;
  try {
    res = await rpc("fs.list", { path: root, ...(state.sessionId ? { session: state.sessionId } : {}) });
  } catch (err) {
    list.innerHTML = `<div class="files-note">${esc(t("files.loadFailed", err.message))}</div>`;
    return;
  }
  list.innerHTML = "";
  if (res.entries.length === 0) {
    list.innerHTML = `<div class="files-note">${esc(t("files.empty"))}</div>`;
    return;
  }
  for (const e of res.entries) {
    list.appendChild(await filesRowFor(e, 0, list));
  }
}

/** Expand a directory: fetch + fill its child container. */
async function filesExpand(dirPath, childBox, depth) {
  childBox.innerHTML = `<div class="files-note">${esc(t("files.loading"))}</div>`;
  let res;
  try {
    res = await rpc("fs.list", { path: dirPath, ...(state.sessionId ? { session: state.sessionId } : {}) });
  } catch (err) {
    childBox.innerHTML = `<div class="files-note">${esc(t("files.loadFailed", err.message))}</div>`;
    return;
  }
  childBox.innerHTML = "";
  if (res.entries.length === 0) {
    childBox.innerHTML = `<div class="files-note">${esc(t("files.empty"))}</div>`;
    return;
  }
  for (const e of res.entries) {
    childBox.appendChild(await filesRowFor(e, depth, childBox));
  }
}

async function filesRowFor(entry, depth, parentBox) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "files-row";
  row.style.paddingLeft = `${8 + depth * 13}px`;
  row.innerHTML =
    `<span class="f-ic">${entry.dir ? "📁" : "📄"}</span>` +
    `<span class="f-name">${esc(entry.name)}</span>` +
    (entry.dir
      ? `<span class="f-chev">▸</span>`
      : `<span class="f-size">${formatBytes(entry.size)}</span>`);
  row.addEventListener("contextmenu", (ev) => openFileMenu(ev, entry));
  if (entry.dir) {
    let childBox = null;
    row.addEventListener("click", async () => {
      if (childBox && childBox.isConnected) {
        childBox.remove();
        childBox = null;
        row.querySelector(".f-chev").textContent = "▸";
        return;
      }
      childBox = document.createElement("div");
      childBox.className = "files-children";
      row.after(childBox); // expand right below the clicked folder
      row.querySelector(".f-chev").textContent = "▾";
      await filesExpand(entry.path, childBox, depth + 1);
    });
  } else {
    row.addEventListener("click", () => {
      filesSelectedPath = entry.path;
      void openFileViewer(entry.path);
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// files tab: right-click menu (open / copy path / add to the composer)
// ---------------------------------------------------------------------------
let fileMenuTarget = null; // { path, dir, name } the menu currently acts on

function hideFileMenu() {
  const menu = $("#file-menu");
  if (menu) menu.hidden = true;
  hideFileSubmenu();
}

function hideFileSubmenu() {
  const sub = $("#file-submenu");
  if (sub) sub.hidden = true;
}

/** The target path relative to the session folder, when it lives underneath
 *  it — otherwise the path is returned unchanged (its own folder elsewhere). */
function relativeToCwd(p) {
  const cwd = state.currentSession?.cwd ?? "";
  if (!cwd) return p;
  const norm = (s) => s.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const base = norm(cwd);
  const full = norm(p);
  if (full === base) return ".";
  if (full.startsWith(`${base}/`)) return full.slice(base.length + 1);
  return p;
}

/** Build + place the menu for a row. The "open" submenu only offers the
 *  actions that can actually run here: the in-app viewer always works, the
 *  OS hand-off needs the desktop bridge and a local file (a remote file cannot
 *  be opened by an app on this machine). */
function openFileMenu(ev, entry) {
  ev.preventDefault();
  ev.stopPropagation();
  hideCtxMenu();
  fileMenuTarget = { path: entry.path, dir: !!entry.dir, name: entry.name };
  const menu = $("#file-menu");
  const sub = $("#file-submenu");
  hideFileSubmenu();

  const canOs =
    !remoteBoot.isRemote && typeof window.familiarDesktop?.openPath === "function";
  const acts = entry.dir
    ? (canOs ? ["openFolder"] : [])
    : ["openApp", ...(canOs ? ["openOs"] : [])];
  const openBtn = menu.querySelector('[data-act="open"]');
  openBtn.hidden = acts.length === 0;
  menu.querySelector("hr").hidden = acts.length === 0;
  sub.innerHTML = "";
  for (const act of acts) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.act = act;
    b.textContent = t(`fmenu.${act}`);
    sub.appendChild(b);
  }
  // relative copy is only meaningful while the target sits under the cwd
  menu.querySelector('[data-act="copyRel"]').hidden = relativeToCwd(entry.path) === entry.path;

  menu.hidden = false;
  const pad = 4;
  const x = Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - pad);
  const y = Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - pad);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
}

/** Fly the submenu out beside its parent item, flipping to the left when it
 *  would run off the right edge of the window. */
function showFileSubmenu() {
  const sub = $("#file-submenu");
  const openBtn = $("#file-menu")?.querySelector('[data-act="open"]');
  if (!sub || !openBtn || openBtn.hidden || sub.children.length === 0) return;
  sub.hidden = false;
  const r = openBtn.getBoundingClientRect();
  const pad = 4;
  let left = r.right + 2;
  if (left + sub.offsetWidth > window.innerWidth - pad) left = r.left - sub.offsetWidth - 2;
  let top = r.top;
  if (top + sub.offsetHeight > window.innerHeight - pad) top = window.innerHeight - sub.offsetHeight - pad;
  sub.style.left = `${Math.max(pad, left)}px`;
  sub.style.top = `${Math.max(pad, top)}px`;
}

/** Run the open action for the current target (shared by the submenu items). */
function runFileOpen(act) {
  const entry = fileMenuTarget;
  if (!entry) return;
  if (act === "openApp") {
    filesSelectedPath = entry.path;
    void openFileViewer(entry.path);
  } else if ((act === "openOs" || act === "openFolder") && window.familiarDesktop?.openPath) {
    void window.familiarDesktop.openPath(entry.path);
  }
}

function initFileMenu() {
  const menu = $("#file-menu");
  const sub = $("#file-submenu");
  if (!menu || !sub) return;
  sub.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    hideFileMenu();
    runFileOpen(act);
  });
  menu.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "open") {
      if (sub.hidden) showFileSubmenu();
      else hideFileSubmenu();
      return;
    }
    const entry = fileMenuTarget;
    hideFileMenu();
    if (!entry) return;
    if (act === "copyPath" || act === "copyRel") {
      const text = act === "copyRel" ? relativeToCwd(entry.path) : entry.path;
      void copyText(text).then((ok) =>
        toast(ok ? t("fmenu.copied") : t("fmenu.copyFailed"), ok ? "info" : "err"),
      );
    } else if (act === "addContext") {
      insertIntoComposer(`@${entry.path} `);
    } else if (act === "rename") {
      openFileRename(entry);
    } else if (act === "delete") {
      void deleteFileEntry(entry);
    }
  });
  // hovering the "open" row flies its submenu out; other rows tuck it away
  menu.addEventListener("mouseover", (ev) => {
    if (ev.target.closest('button[data-act="open"]')) showFileSubmenu();
    else hideFileSubmenu();
  });
  // rename modal
  const renameOverlay = $("#file-rename-overlay");
  $("#file-rename-ok")?.addEventListener("click", () => void commitFileRename());
  $("#file-rename-cancel")?.addEventListener("click", () => {
    renameOverlay.hidden = true;
  });
  renameOverlay?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) renameOverlay.hidden = true;
  });
  $("#file-rename-input")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      void commitFileRename();
    } else if (ev.key === "Escape") {
      ev.stopPropagation();
      renameOverlay.hidden = true;
    }
  });
}

/** Re-render the file tree from the session folder (after a rename/delete). */
function refreshFilesTree() {
  filesSessionKey = null;
  void renderFilesTab();
}

/** Rename: modal input, then fs.rename. The name is a bare base name (the
 *  server refuses separators and an existing destination). */
let fileRenameTarget = null;
function openFileRename(entry) {
  fileRenameTarget = entry;
  const overlay = $("#file-rename-overlay");
  const input = $("#file-rename-input");
  $("#file-rename-error").hidden = true;
  input.value = entry.name;
  overlay.hidden = false;
  input.focus();
  input.select();
}

async function commitFileRename() {
  const entry = fileRenameTarget;
  const overlay = $("#file-rename-overlay");
  const input = $("#file-rename-input");
  const errBox = $("#file-rename-error");
  if (!entry) {
    overlay.hidden = true;
    return;
  }
  const name = input.value.trim();
  if (name === "" || name === entry.name) {
    overlay.hidden = true;
    return;
  }
  try {
    await rpc("fs.rename", {
      path: entry.path,
      name,
      ...(state.sessionId ? { session: state.sessionId } : {}),
    });
  } catch (err) {
    errBox.textContent = t("fmenu.renameFailed", err.message);
    errBox.hidden = false;
    return; // keep the modal open so the name can be fixed
  }
  overlay.hidden = true;
  toast(t("fmenu.renamed"), "ok");
  refreshFilesTree();
}

/** Delete a file/folder (recursive) after a confirmation. */
async function deleteFileEntry(entry) {
  if (!window.confirm(t("fmenu.deleteConfirm", entry.name))) return;
  try {
    await rpc("fs.delete", {
      path: entry.path,
      ...(state.sessionId ? { session: state.sessionId } : {}),
    });
  } catch (err) {
    toast(t("fmenu.deleteFailed", err.message), "err");
    return;
  }
  toast(t("fmenu.deleted"), "ok");
  refreshFilesTree();
}

/** Simple bordered table for CSV sheets and Word tables. */
function buildTable(rows) {
  const wrap = document.createElement("div");
  wrap.className = "files-table-wrap";
  const table = document.createElement("table");
  table.className = "files-table";
  rows.forEach((cells, ri) => {
    const tr = document.createElement("tr");
    if (ri === 0) tr.className = "head";
    const list = Array.isArray(cells) ? cells : [];
    for (const cell of list) {
      const td = document.createElement(ri === 0 ? "th" : "td");
      td.textContent = String(cell ?? "");
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

/** Word document: the same block list office_create accepts. */
function renderDocxPreview(view, blocks) {
  if (blocks.length === 0) {
    const note = document.createElement("div");
    note.className = "files-note files-info";
    note.textContent = t("files.docxEmpty");
    view.appendChild(note);
    return;
  }
  const body = document.createElement("div");
  body.className = "files-doc";
  for (const b of blocks) {
    if (b?.table && b.table.length > 0) {
      body.appendChild(buildTable(b.table));
    } else if (Array.isArray(b?.bullets) && b.bullets.length > 0) {
      const ul = document.createElement("ul");
      for (const item of b.bullets) {
        const li = document.createElement("li");
        li.textContent = String(item ?? "");
        ul.appendChild(li);
      }
      body.appendChild(ul);
    } else if (b?.heading) {
      const level = Math.min(6, Math.max(1, Number(b.level) || 1));
      const h = document.createElement(`h${level + 1}`);
      h.textContent = String(b.heading);
      body.appendChild(h);
    } else if (b?.text) {
      const p = document.createElement("p");
      p.textContent = String(b.text);
      body.appendChild(p);
    }
  }
  view.appendChild(body);
}

/** Excel workbook: one table per sheet, in tab order. */
function renderXlsxPreview(view, sheets) {
  if (sheets.length === 0) {
    const note = document.createElement("div");
    note.className = "files-note files-info";
    note.textContent = t("files.docxEmpty");
    view.appendChild(note);
    return;
  }
  sheets.forEach((sheet, i) => {
    if (sheets.length > 1 || (sheet?.name && sheet.name !== "Sheet1")) {
      const head = document.createElement("div");
      head.className = "files-sheet-head";
      head.textContent = t("files.sheet", String(sheet?.name ?? i + 1));
      view.appendChild(head);
    }
    view.appendChild(buildTable(Array.isArray(sheet?.rows) ? sheet.rows : []));
  });
}

/** PowerPoint: a card per slide with its title and body. */
function renderPptxPreview(view, slides) {
  if (slides.length === 0) {
    const note = document.createElement("div");
    note.className = "files-note files-info";
    note.textContent = t("files.docxEmpty");
    view.appendChild(note);
    return;
  }
  slides.forEach((slide, i) => {
    const card = document.createElement("div");
    card.className = "files-slide";
    const num = document.createElement("div");
    num.className = "files-slide-num";
    num.textContent = t("files.slide", String(i + 1));
    card.appendChild(num);
    if (slide?.title) {
      const h = document.createElement("h3");
      h.textContent = String(slide.title);
      card.appendChild(h);
    }
    const bullets = Array.isArray(slide?.bullets) ? slide.bullets : [];
    if (bullets.length > 0) {
      const ul = document.createElement("ul");
      for (const item of bullets) {
        const li = document.createElement("li");
        li.textContent = String(item ?? "");
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }
    view.appendChild(card);
  });
}

/** In-app file preview: images / audio / video / pdf inline, markdown
 * rendered with the safe renderer, everything else as text or an info stub
 * with an "open externally" escape hatch on the desktop. */
async function openFileViewer(filePath) {
  const tree = $("#files-tree");
  const view = $("#files-view");
  view.innerHTML = `<div class="files-note">${esc(t("files.loading"))}</div>`;
  tree.hidden = true;
  view.hidden = false;
  let res;
  try {
    res = await rpc("fs.preview", { path: filePath, ...(state.sessionId ? { session: state.sessionId } : {}) });
  } catch (err) {
    view.innerHTML = `<div class="files-note">${esc(t("files.loadFailed", err.message))}</div>`;
    return;
  }
  view.innerHTML = "";

  const head = document.createElement("div");
  head.className = "files-head";
  const kindIcon =
    { image: "🖼", audio: "🎧", video: "🎬", pdf: "📄", markdown: "📝", text: "📄", binary: "📦",
      csv: "📊", json: "🧩", docx: "📘", xlsx: "📗", pptx: "📙" }[res.kind] ?? "📄";
  head.innerHTML =
    `<button type="button" class="ghost" id="files-back" title="${esc(t("files.back"))}">⬅</button>` +
    `<span class="files-root" title="${esc(res.path)}">${kindIcon} ${esc(baseName(res.path))}</span>`;
  head.querySelector("#files-back").addEventListener("click", () => {
    view.hidden = true;
    tree.hidden = false;
  });

  // desktop: open with the OS default application (local files only — a
  // remote file cannot be opened by an app on this machine)
  if (window.familiarDesktop?.openPath && !remoteBoot.isRemote) {
    const extBtn = document.createElement("button");
    extBtn.type = "button";
    extBtn.className = "ghost";
    extBtn.textContent = "↗";
    extBtn.title = t("files.openExternal");
    extBtn.addEventListener("click", () => void window.familiarDesktop.openPath(res.path));
    head.appendChild(extBtn);
  }
  view.appendChild(head);

  const sizeRow = document.createElement("div");
  sizeRow.className = "files-note";
  sizeRow.textContent = formatBytes(res.size ?? 0) + (res.truncated ? ` · ${t("files.truncated")}` : "");
  view.appendChild(sizeRow);

  if (res.tooLarge) {
    const note = document.createElement("div");
    note.className = "files-note files-info";
    note.textContent = t("files.tooLarge", formatBytes(res.size ?? 0));
    view.appendChild(note);
    return;
  }

  if (res.kind === "image") {
    const img = document.createElement("img");
    img.className = "files-img";
    img.alt = baseName(res.path);
    img.src = `data:${res.mime};base64,${res.dataBase64}`;
    view.appendChild(img);
    return;
  }
  if (res.kind === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = `data:${res.mime};base64,${res.dataBase64}`;
    view.appendChild(audio);
    return;
  }
  if (res.kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.className = "files-video";
    video.src = `data:${res.mime};base64,${res.dataBase64}`;
    view.appendChild(video);
    return;
  }
  if (res.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "files-pdf";
    frame.src = `data:application/pdf;base64,${res.dataBase64}`;
    view.appendChild(frame);
    return;
  }
  if (res.kind === "markdown") {
    let mode = "preview";
    const toolbar = document.createElement("div");
    toolbar.className = "files-md-toolbar";
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "ghost";
    previewBtn.textContent = t("files.preview");
    const rawBtn = document.createElement("button");
    rawBtn.type = "button";
    rawBtn.className = "ghost";
    rawBtn.textContent = t("files.source");
    toolbar.append(previewBtn, rawBtn);
    view.appendChild(toolbar);
    const body = document.createElement("div");
    view.appendChild(body);
    const render = () => {
      previewBtn.classList.toggle("active", mode === "preview");
      rawBtn.classList.toggle("active", mode === "raw");
      if (mode === "preview") {
        body.className = "md files-md";
        body.innerHTML = mdRender(res.content);
      } else {
        body.className = "";
        body.innerHTML = "";
        const pre = document.createElement("pre");
        pre.className = "files-pre";
        pre.textContent = res.content;
        body.appendChild(pre);
      }
    };
    previewBtn.addEventListener("click", () => { mode = "preview"; render(); });
    rawBtn.addEventListener("click", () => { mode = "raw"; render(); });
    render();
    return;
  }

  if (res.kind === "csv") {
    const rows = Array.isArray(res.rows) ? res.rows : [];
    const cols = rows.reduce((n, r) => Math.max(n, Array.isArray(r) ? r.length : 0), 0);
    const note = document.createElement("div");
    note.className = "files-note";
    note.textContent = t("files.csvRows", String(rows.length), String(cols));
    view.appendChild(note);
    view.appendChild(buildTable(rows));
    return;
  }

  if (res.kind === "json") {
    const pre = document.createElement("pre");
    pre.className = "files-pre";
    pre.textContent = res.content ?? "";
    view.appendChild(pre);
    return;
  }

  if (res.kind === "docx") {
    renderDocxPreview(view, Array.isArray(res.blocks) ? res.blocks : []);
    return;
  }

  if (res.kind === "xlsx") {
    renderXlsxPreview(view, Array.isArray(res.sheets) ? res.sheets : []);
    return;
  }

  if (res.kind === "pptx") {
    renderPptxPreview(view, Array.isArray(res.slides) ? res.slides : []);
    return;
  }

  // text (existing path) or binary info stub
  if (res.kind === "text") {
    const pre = document.createElement("pre");
    pre.className = "files-pre";
    pre.textContent = res.content;
    view.appendChild(pre);
    return;
  }
  const info = document.createElement("div");
  info.className = "files-note files-info";
  info.textContent = t("files.binary", formatBytes(res.size ?? 0));
  view.appendChild(info);
}



// ---------------------------------------------------------------------------
// UI preferences (localStorage "familiar.prefs") + settings modal
// ---------------------------------------------------------------------------
const DEFAULT_PREFS = {
  sendWithEnter: true,      // Enter=send (off: Ctrl/Cmd+Enter sends, Enter=newline)
  tabModeToggle: true,      // Tab toggles Build/Plan
  autoscroll: true,         // stick to bottom while streaming
  toolsExpanded: false,     // tool rows expanded by default
  notify: true,             // desktop notification on turn end + approvals
  notifyOnlyUnfocused: true,
  fontSize: "m",            // s | m | l | xl
  width: "normal",          // normal | wide | full
  fontFamily: "system",     // system | gothic | serif | mono
};

const FONT_SIZES = { s: "13px", m: "14px", l: "15.5px", xl: "17px" };
const FONT_FAMILIES = {
  system: 'var(--font-base)',
  gothic: '"Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif',
  serif: '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", "MS PMincho", serif',
  mono: 'ui-monospace, "Cascadia Code", "Source Han Code JP", Consolas, "Courier New", monospace',
};
const WIDTHS = { normal: "52rem", wide: "68rem", full: "92rem" };

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem("familiar.prefs") ?? "{}") ?? {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let prefs = loadPrefs();

function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  localStorage.setItem("familiar.prefs", JSON.stringify(prefs));
  applyUiPrefs();
  applyComposerPlaceholder();
  refreshSendButton();
}

function applyUiPrefs() {
  document.documentElement.style.setProperty("--fs", FONT_SIZES[prefs.fontSize] ?? "14px");
  document.documentElement.style.setProperty("--content-w", WIDTHS[prefs.width] ?? "52rem");
  document.documentElement.dataset.uiFontSize = prefs.fontSize;
  document.documentElement.dataset.uiWidth = prefs.width;
  document.body.style.fontFamily = FONT_FAMILIES[prefs.fontFamily] ?? FONT_FAMILIES.system;
}

/** Desktop notification plumbing. The Electron shell routes through the main
 * process (real desktop notification + taskbar flash); plain browsers use the
 * Web Notification API. Urgent = approvals, which bypass the focus gate. */
function notifyDesktop(title, body, { urgent = false } = {}) {
  if (!prefs.notify) return;
  if (!urgent && prefs.notifyOnlyUnfocused && document.hasFocus()) return;
  if (window.familiarDesktop?.notify) {
    window.familiarDesktop.notify({ title, body });
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, silent: false });
  } catch { /* notification API quirks */ }
}

function sessionLabel() {
  const title = $("#session-title").textContent;
  return title !== t("top.noSession") ? title : t("taskDone");
}

/** Desktop notification on turn completion (~OpenCode tui "attention"). */
function maybeNotify() {
  void notifyDesktop(t("notify.turnDone"), sessionLabel());
}

/** Dropdown control for settings rows (replaces the old segmented buttons). */
function selectControl(items, current, onChange) {
  const sel = document.createElement("select");
  sel.className = "select-control";
  for (const [label, value] of items) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

/** Settings row: label + description on the left, control on the right. */
function settingRow(label, description, control) {
  const row = document.createElement("div");
  row.className = "setting-row";
  const text = document.createElement("div");
  text.className = "setting-text";
  text.innerHTML = `<b>${esc(label)}</b><span>${esc(description)}</span>`;
  row.appendChild(text);
  row.appendChild(control);
  return row;
}

function toggleSwitch(checked, onChange) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `switch${checked ? " on" : ""}`;
  b.setAttribute("role", "switch");
  b.setAttribute("aria-checked", String(!!checked));
  b.innerHTML = `<span class="knob"></span>`;
  b.addEventListener("click", () => onChange(b));
  return b;
}

function card(title, note) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h4>${esc(title)}</h4>${note ? `<div class="note">${esc(note)}</div>` : ""}`;
  return card;
}

// --- modal shell -------------------------------------------------------------
const SETTINGS_SECTIONS = [
  { id: "general", labelKey: "nav.general", icon: "⚙" },
  { id: "appearance", labelKey: "nav.appearance", icon: "◧" },
  { id: "transcript", labelKey: "nav.transcript", icon: "▤" },
  { id: "shortcuts", labelKey: "nav.shortcuts", icon: "⌘" },
  { id: "providers", labelKey: "nav.providers", icon: "▣" },
  { id: "skills", labelKey: "nav.skills", icon: "✦" },
  { id: "templates", labelKey: "nav.templates", icon: "📄" },
  { id: "connectors", labelKey: "nav.connectors", icon: "🔗" },
  { id: "websearch", labelKey: "nav.websearch", icon: "🔍" },
  { id: "memory", labelKey: "nav.memory", icon: "🧠" },
  { id: "connections", labelKey: "nav.connections", icon: "🖥" },
  { id: "cron", labelKey: "nav.cron", icon: "⏱" },
  { id: "approvals", labelKey: "nav.approvals", icon: "🛡" },
  { id: "system", labelKey: "nav.system", icon: "◍" },
];
let settingsSection = "general";
let settingsRenderGen = 0; // guards the async section renderers against stacking

function openSettingsModal(section) {
  if (section) settingsSection = section;
  closeAllPops();
  const overlay = $("#settings-overlay");
  overlay.hidden = false;
  renderSettingsNav();
  renderSettingsSection(settingsSection);
}

function closeSettingsModal() {
  $("#settings-overlay").hidden = true;
}

function renderSettingsNav() {
  const nav = $("#settings-nav");
  nav.innerHTML = "";
  for (const s of SETTINGS_SECTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `nav-item${s.id === settingsSection ? " active" : ""}`;
    item.dataset.section = s.id;
    item.innerHTML = `<span class="ni">${esc(s.icon)}</span>${esc(t(s.labelKey))}`;
    item.addEventListener("click", () => {
      settingsSection = s.id;
      renderSettingsNav();
      renderSettingsSection(s.id);
    });
    nav.appendChild(item);
  }
}

function renderSettingsSection(id) {
  const gen = ++settingsRenderGen;
  const content = $("#settings-content");
  content.innerHTML = "";
  content.scrollTop = 0;
  const stale = () => gen !== settingsRenderGen;
  if (id === "general") renderGeneralSection(content);
  else if (id === "appearance") renderAppearanceSection(content);
  else if (id === "transcript") renderTranscriptSection(content);
  else if (id === "shortcuts") renderShortcutsSection(content);
  else if (id === "providers") void renderProvidersSection(content, stale);
  else if (id === "skills") void renderSkillsSection(content, stale);
  else if (id === "templates") void renderTemplatesSection(content, stale);
  else if (id === "connectors") void renderConnectorsSection(content, stale);
  else if (id === "websearch") void renderWebSearchSection(content, stale);
  else if (id === "memory") void renderMemorySection(content, stale);
  else if (id === "connections") void renderConnectionsSection(content, stale);
  else if (id === "cron") void renderCronSection(content, stale);
  else if (id === "approvals") void renderApprovalsSection(content, stale);
  else if (id === "system") void renderSystemSection(content, stale);
}

/** Refresh an async action's section only while it is still the active one. */
function refreshSettingsSectionIfActive(id) {
  if (settingsSection !== id) return;
  renderSettingsSection(id);
}

/** Top-bar task progress ("done/total"), hidden while there is no task list. */
async function refreshTodoProgress() {
  const el = $("#todo-progress");
  if (!el) return;
  if (!state.sessionId) {
    el.hidden = true;
    return;
  }
  try {
    const res = await rpc("todo.list", { id: state.sessionId });
    const items = res.items ?? [];
    if (items.length === 0) {
      el.hidden = true;
      return;
    }
    const done = items.filter((x) => x && x.status === "done").length;
    const active = items.filter((x) => x && x.status === "in_progress").length;
    el.hidden = false;
    el.textContent = `${done}/${items.length}`;
    el.classList.toggle("active", active > 0);
    el.title = t("todo.progress", String(done), String(items.length));
  } catch {
    el.hidden = true;
  }
}

function renderGeneralSection(content) {
  const c = card(t("set.inputSend"));
  c.appendChild(settingRow(
    t("set.enterSend"),
    t("set.enterSendDesc"),
    toggleSwitch(prefs.sendWithEnter, () => {
      savePrefs({ sendWithEnter: !prefs.sendWithEnter });
      renderSettingsSection("general");
    }),
  ));
  c.appendChild(settingRow(
    t("set.tabToggle"),
    t("set.tabToggleDesc"),
    toggleSwitch(prefs.tabModeToggle, () => {
      savePrefs({ tabModeToggle: !prefs.tabModeToggle });
      renderSettingsSection("general");
    }),
  ));
  c.appendChild(settingRow(
    t("set.lang"),
    t("set.langDesc"),
    selectControl([["日本語", "ja"], ["English", "en"]], lang, (value) => {
      setLang(value); // re-renders the settings nav + section itself
    }),
  ));
  content.appendChild(c);

  const n = card(t("set.notify"), t("set.notifyDesc"));
  const notifyEnabled = typeof Notification !== "undefined";
  n.appendChild(settingRow(
    t("set.notifyTitle"),
    notifyEnabled ? t("set.notifyHint") : t("set.notifyUnsupported"),
    toggleSwitch(prefs.notify, async () => {
      const next = !prefs.notify;
      if (next && notifyEnabled) {
        try {
          const perm = await Notification.requestPermission();
          if (perm !== "granted") {
            toast(t("toast.notifDenied"), "err");
            savePrefs({ notify: false });
            renderSettingsSection("general");
            return;
          }
        } catch { /* env without permission flow */ }
      }
      savePrefs({ notify: next });
      renderSettingsSection("general");
    }),
  ));
  n.appendChild(settingRow(
    t("set.notifyUnfocused"),
    t("set.notifyUnfocusedDesc"),
    toggleSwitch(prefs.notifyOnlyUnfocused, () => {
      savePrefs({ notifyOnlyUnfocused: !prefs.notifyOnlyUnfocused });
      renderSettingsSection("general");
    }),
  ));
  content.appendChild(n);
}

function renderAppearanceSection(content) {
  const pref = currentModePref();
  const c = card(t("set.colors"));

  // mode: three explicit buttons (light / dark / system)
  const modeRow = document.createElement("div");
  modeRow.className = "segment-row";
  for (const [label, value] of [
    [t("set.light"), "light"],
    [t("set.dark"), "dark"],
    [t("set.system"), "system"],
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `segment-btn${pref === value ? " active" : ""}`;
    b.textContent = label;
    b.addEventListener("click", () => {
      setModePref(value);
      renderSettingsSection("appearance");
    });
    modeRow.appendChild(b);
  }
  c.appendChild(modeRow);

  // color theme: pulldown (no toast — the change is immediately visible)
  // color theme: custom dropdown with per-theme color swatches (mode-aware)
  c.appendChild(settingRow(
    t("set.colorTheme"),
    t("set.colorThemeDesc"),
    themeDropdown(currentThemeName(), (value) => {
      setThemeName(value);
      renderSettingsSection("appearance");
    }),
  ));
  content.appendChild(c);

function themeDropdown(current, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "theme-dd";
  const palOf = (name) => {
    const pref = currentModePref();
    const eff = pref === "light" || pref === "dark" ? pref
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    return THEMES[name][eff] ?? THEMES[name].dark;
  };
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-dd-btn";
  const paint = (name) => {
    const pal = palOf(name);
    btn.innerHTML =
      `<span class="theme-dd-sw" style="background:${pal.bg}">` +
      `<i style="background:${pal.accent}"></i><i style="background:${pal.ok}"></i><i style="background:${pal.err}"></i>` +
      `</span><span class="theme-dd-name">${esc(name)}</span><span class="dd-arrow">▾</span>`;
    btn.title = THEME_DESC[name]?.[lang] ?? "";
  };
  paint(current);
  const list = document.createElement("div");
  list.className = "theme-dd-list";
  list.hidden = true;
  for (const name of Object.keys(THEMES)) {
    const pal = palOf(name);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `theme-dd-row${name === current ? " selected" : ""}`;
    row.title = THEME_DESC[name]?.[lang] ?? "";
    row.innerHTML =
      `<span class="theme-dd-sw" style="background:${pal.bg}">` +
      `<i style="background:${pal.accent}"></i><i style="background:${pal.ok}"></i><i style="background:${pal.err}"></i>` +
      `</span><span class="theme-dd-name">${esc(name)}</span>` +
      (name === current ? `<span class="theme-dd-check">✓</span>` : "");
    row.addEventListener("click", () => {
      list.hidden = true;
      paint(name);
      onChange(name);
    });
    list.appendChild(row);
  }
  wrap.append(btn, list);
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    list.hidden = !list.hidden;
  });
  if (!wrap.dataset.closer) {
    wrap.dataset.closer = "1";
    document.addEventListener("click", (e) => {
      const dd = wrap.querySelector(".theme-dd-list");
      if (dd && !wrap.contains(e.target)) dd.hidden = true;
    });
  }
  return wrap;
}

  const c2 = card(t("set.display"));
  // font family
  c2.appendChild(settingRow(
    t("set.fontFamily"),
    t("set.fontFamilyDesc"),
    selectControl(
      [
        [t("font.system"), "system"],
        [t("font.gothic"), "gothic"],
        [t("font.serif"), "serif"],
        [t("font.mono"), "mono"],
      ],
      prefs.fontFamily,
      (value) => {
        savePrefs({ fontFamily: value });
        renderSettingsSection("appearance");
      },
    ),
  ));
  c2.appendChild(settingRow(
    t("set.fontSize"),
    t("set.fontSizeDesc"),
    selectControl(
      [[t("size.s"), "s"], [t("size.m"), "m"], [t("size.l"), "l"], [t("size.xl"), "xl"]],
      prefs.fontSize,
      (value) => {
        savePrefs({ fontSize: value });
        renderSettingsSection("appearance");
      },
    ),
  ));
  c2.appendChild(settingRow(
    t("set.width"),
    t("set.widthDesc"),
    selectControl(
      [[t("size.normal"), "normal"], [t("size.wide"), "wide"], [t("size.full"), "full"]],
      prefs.width,
      (value) => {
        savePrefs({ width: value });
        renderSettingsSection("appearance");
      },
    ),
  ));
  const reset = document.createElement("button");
  reset.textContent = t("set.reset");
  reset.className = "ghost small";
  reset.addEventListener("click", () => {
    localStorage.removeItem("familiar.theme");
    localStorage.removeItem("familiar.mode");
    applyTheme();
    savePrefs({ fontSize: "m", width: "normal", fontFamily: "system" });
    renderSettingsSection("appearance");
    toast(t("toast.appearanceReset"), "ok");
  });
  c2.appendChild(reset);
  content.appendChild(c2);
}

function renderTranscriptSection(content) {
  const c = card(t("set.transcriptSec"));
  c.appendChild(settingRow(
    t("set.autoscroll"),
    t("set.autoscrollDesc"),
    toggleSwitch(prefs.autoscroll, () => {
      savePrefs({ autoscroll: !prefs.autoscroll });
      renderSettingsSection("transcript");
    }),
  ));
  c.appendChild(settingRow(
    t("set.toolsExpanded"),
    t("set.toolsExpandedDesc"),
    toggleSwitch(prefs.toolsExpanded, () => {
      savePrefs({ toolsExpanded: !prefs.toolsExpanded });
      renderSettingsSection("transcript");
    }),
  ));
  content.appendChild(c);
}

function renderShortcutsSection(content) {
  const rows = [
    ["Tab", t("sc.tab")],
    ["Enter", prefs.sendWithEnter ? t("sc.enter") : t("sc.enterNL")],
    ["Shift + Enter", t("sc.shiftEnter")],
    ["Ctrl + Enter", prefs.sendWithEnter ? t("sc.ctrlEnterNL") : t("sc.ctrlEnterSend")],
    ["Ctrl + K", t("sc.k")],
    ["Ctrl + F", t("sc.f")],
    ["Esc", t("sc.esc")],
  ];
  const table = document.createElement("div");
  table.className = "card";
  table.innerHTML = `<h4>${esc(t("set.shortcutsSec"))}</h4>`;
  for (const [key, desc] of rows) {
    const row = document.createElement("div");
    row.className = "kbd-row";
    row.innerHTML = `<kbd>${esc(key)}</kbd><span>${esc(desc)}</span>`;
    table.appendChild(row);
  }
  content.appendChild(table);
}

// ---------------------------------------------------------------------------
// providers — editable (kind / endpoint / default model / API key)
// ---------------------------------------------------------------------------
let providerOpen = ""; // provider name with an expanded editor; "" = none; "__new__" = blank form

/** One-line auth hint from the sanitized auth descriptor (never the value). */
function providerAuthLabel(pc) {
  const auth = pc?.auth;
  if (!auth || auth.source === "none") return "";
  if (auth.source === "env") return t("prov.keyEnv", auth.source.slice(4));
  if (auth.source === "inline") return auth.resolved ? t("prov.keyOk") : t("prov.keyMissing");
  return auth.resolved ? t("prov.keyOk") : t("prov.keyMissing");
}

/**
 * Providers worth offering in pickers: mock, endpoints that need no auth
 * (Ollama / local servers) or ones whose API key actually resolves.
 * Placeholder entries like "openai" without a key are hidden.
 */
function isProviderUsable(pc) {
  const src = pc?.auth?.source ?? "none";
  // "none" (or legacy "env:none") = key-less endpoint like Ollama;
  // anything with a resolved key (inline/file/env) is connected too.
  return (
    src === "none" || src === "env:none" || pc?.auth?.resolved === true
  );
}

/** Usable provider names (default first); falls back to all when none qualify. */
function usableProviderNames() {
  let names = Object.keys(ns.providers).filter((n) => isProviderUsable(ns.providers[n]));
  if (names.length === 0) names = Object.keys(ns.providers);
  return names.sort((a, b) =>
    a === ns.defaultProvider ? -1 : b === ns.defaultProvider ? 1 : a.localeCompare(b));
}

function providerForm(name, pc, isNew) {
  const form = document.createElement("div");
  form.className = "pform";
  const auth = pc?.auth ?? {};
  // "mock" remains a test-only kind: expose it in the kind <select> only when
  // the entry already uses it (custom/local configs)
  const mockOption = `<option value="mock">${esc(t("prov.mock"))}</option>`;
  form.innerHTML = `
    ${isNew ? `<div class="field-row"><label>${esc(t("prov.name"))}</label><input class="pf-name" type="text" spellcheck="false" placeholder="${esc(t("prov.namePh"))}" /></div>` : ""}
    <div class="field-row"><label>${esc(t("prov.kind"))}</label>
      <select class="pf-kind">
        <option value="openai_compatible">openai_compatible</option>
        <option value="anthropic">anthropic</option>
        ${pc?.kind === "mock" ? mockOption : ""}
      </select></div>
    <div class="field-row"><label>${esc(t("prov.endpoint"))}</label><input class="pf-url" type="text" spellcheck="false" placeholder="${esc(t("prov.endpointPh"))}" /></div>
    <div class="field-row"><label>${esc(t("prov.apiKey"))}</label><input class="pf-key" type="password" autocomplete="new-password" placeholder="${auth.resolved ? esc(t("prov.keySet")) : esc(t("prov.keyUnset"))}" /></div>
    <label class="pf-clear"><input type="checkbox" class="pf-clearbox" /> ${esc(t("prov.clearKey"))}</label>
    <div class="pf-probe-row">
      <button type="button" class="pf-probe ghost small">${esc(t("prov.fetchModels"))}</button>
      <span class="pf-probe-status dim"></span>
    </div>
    <div class="pf-models"></div>
    <div class="form-error" hidden></div>
    <div class="pop-actions">
      <button type="button" class="pf-save">${esc(t("prov.save"))}</button>
      <button type="button" class="ghost pf-cancel">${esc(t("prov.cancel"))}</button>
    </div>`;
  const kindSel = form.querySelector(".pf-kind");
  const urlInput = form.querySelector(".pf-url");
  const keyInput = form.querySelector(".pf-key");
  const probeBtn = form.querySelector(".pf-probe");
  const probeStatus = form.querySelector(".pf-probe-status");
  const modelsBox = form.querySelector(".pf-models");
  const errBox = form.querySelector(".form-error");
  kindSel.value = pc?.kind ?? "openai_compatible";
  urlInput.value = pc?.base_url ?? "";
  const nameInput = form.querySelector(".pf-name");
  if (nameInput) nameInput.value = name ?? "";

  /** Readable inline error (the bottom-right toast is blurred by the modal
   * backdrop, so failures must also be visible inside the dialog). */
  const setError = (msg) => {
    errBox.textContent = msg || "";
    errBox.hidden = !msg;
  };

  let probeTimer = null;
  async function probeModels() {
    const url = urlInput.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      modelsBox.innerHTML = "";
      probeStatus.textContent = t("prov.probeNeedsUrl");
      setError(t("prov.badUrl"));
      return;
    }
    setError("");
    probeStatus.textContent = t("prov.probing");
    modelsBox.innerHTML = "";
    try {
      const res = await rpc("models.probe", {
        kind: kindSel.value,
        base_url: url,
        ...(keyInput.value.trim() ? { api_key: keyInput.value.trim() } : {}),
      });
      const models = res.models ?? [];
      if (res.error) {
        probeStatus.textContent = "";
        setError(res.error);
        return;
      }
      if (models.length === 0) {
        probeStatus.textContent = t("prov.probeEmpty");
        return;
      }
      probeStatus.textContent = t("prov.probeOk", models.length);
      for (const m of models) {
        // informational only: the model is chosen in the composer picker, not here
        const row = document.createElement("div");
        row.className = "pf-modelrow";
        const ctxBits = [];
        if (m.contextTokens) ctxBits.push(`${Math.round(m.contextTokens / 1000)}k`);
        row.innerHTML = `<span class="pm-name">${esc(m.id)}</span><span class="pm-meta">${esc(ctxBits.join(" · "))}</span>`;
        modelsBox.appendChild(row);
      }
    } catch (err) {
      probeStatus.textContent = "";
      setError(err.message);
    }
  }
  probeBtn.addEventListener("click", probeModels);
  kindSel.addEventListener("change", () => {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => void probeModels(), 200);
  });
  // auto-refresh shortly after the endpoint/kind/key settles
  for (const el of [urlInput, kindSel, keyInput]) {
    el.addEventListener("input", () => {
      clearTimeout(probeTimer);
      probeTimer = setTimeout(() => void probeModels(), 800);
    });
    el.addEventListener("change", () => {
      clearTimeout(probeTimer);
      probeTimer = setTimeout(() => void probeModels(), 200);
    });
  }

  form.querySelector(".pf-cancel").addEventListener("click", () => {
    providerOpen = "";
    renderSettingsSection("providers");
  });
  form.querySelector(".pf-save").addEventListener("click", async () => {
    const finalName = isNew ? (nameInput?.value ?? "").trim() : name;
    if (!finalName) {
      setError(t("prov.badName"));
      toast(t("prov.badName"), "err");
      return;
    }
    const url = urlInput.value.trim();
    if (url !== "" && !/^https?:\/\//i.test(url)) {
      setError(t("prov.badUrl"));
      toast(t("prov.badUrl"), "err");
      return;
    }
    // default_model is intentionally not sent: the model is picked per session
    // in the composer picker (omitting the key preserves any existing value)
    const payload = {
      name: finalName,
      kind: kindSel.value,
      base_url: url,
    };
    const key = keyInput.value.trim();
    if (key !== "") payload.api_key = key;
    if (form.querySelector(".pf-clearbox").checked) payload.clear_api_key = true;
    try {
      const res = await rpc("config.provider.set", payload);
      setError("");
      toast(t("toast.providerSaved", res.provider.name), "ok");
      ns.loaded = false;
      providerOpen = "";
      await ensureNsConfig();
      renderSettingsSection("providers");
    } catch (err) {
      setError(err.message);
      toast(t("toast.saveFailed", err.message), "err");
    }
  });
  return form;
}

/** Provider settings: "Connected" providers as collapsible cards, then the
 * built-in catalog + unconfigured entries as "Candidates", each with a
 * ＋接続 button that opens the form prefilled. */
async function renderProvidersSection(content, stale = () => false) {
  // every append goes through here: a section the user navigated away
  // from while an RPC was in flight must not land in the new tab
  const put = (node) => { if (!stale()) content.appendChild(node); };
  if (!(await ensureNsConfig())) return;
    if (stale()) return;
  const names = Object.keys(ns.providers).sort((a, b) =>
    a === ns.defaultProvider ? -1 : b === ns.defaultProvider ? 1 : a.localeCompare(b));
  const connected = [];
  const candidates = [];
  for (const name of names) {
    (isProviderUsable(ns.providers[name]) ? connected : candidates).push(name);
  }

  // ---- section 1: connected ----
  const connHead = document.createElement("div");
  connHead.className = "provsec";
  connHead.innerHTML = `<b>${esc(t("prov.connected"))}</b><span>${connected.length}</span>`;
  put(connHead);
  if (connected.length === 0) {
    const empty = document.createElement("div");
    empty.className = "proempty dim";
    empty.textContent = t("prov.noneConnected");
    put(empty);
  }
  for (const name of connected) {
    const pc = ns.providers[name] ?? {};
    put(providerCard(name, pc));
  }

  // ---- section 2: candidates ----
  const candHead = document.createElement("div");
  candHead.className = "provsec";
  candHead.innerHTML = `<b>${esc(t("prov.candidates"))}</b><span>${candidates.length}</span>`;
  put(candHead);
  const candRows = new Map(); // openKey → form prefill
  // (a) configured providers whose key does not resolve yet
  for (const name of candidates) {
    const pc = ns.providers[name] ?? {};
    candRows.set(name, pc);
  }
  // (b) built-in catalog entries that are not connected
  for (const k of KNOWN_PROVIDERS) {
    if (connected.includes(k.id)) continue;
    if (candRows.has(k.id)) continue; // configured but unresolvable — keep its values
    candRows.set(k.id, { kind: k.kind, base_url: k.base_url, known: k });
  }
  const ordered = [...candRows.keys()].sort((a, b) => {
    const ka = KNOWN_PROVIDERS.findIndex((k) => k.id === a);
    const kb = KNOWN_PROVIDERS.findIndex((k) => k.id === b);
    if (ka !== -1 && kb !== -1) return ka - kb;
    if (ka !== -1) return -1;
    if (kb !== -1) return 1;
    return a.localeCompare(b);
  });
  for (const name of ordered) {
    const row = document.createElement("div");
    row.className = "provrow";
    const pc = candRows.get(name) ?? {};
    const directKnown = KNOWN_PROVIDERS.find((known) => known.id === name);
    const hint = pc.base_url ?? pc.known?.base_url ?? directKnown?.base_url ?? "";
    const kind = pc.kind ?? pc.known?.kind;
    const brand = pc.known ?? directKnown ?? providerKnown(name, pc.base_url ?? "", kind);
    const color = brand?.color ?? "#8a8a94";
    const label = directKnown?.label ?? (pc.known?.label ?? name);
    const env = pc.known?.env ?? directKnown?.env;
    const envRef = env ? ` · ${env}` : "";
    row.innerHTML =
      providerTile(name, color, hint, kind) +
      `<span class="pr-name">${esc(label)}<small class="pr-hint">${esc(hint ? hint + envRef : envRef.slice(3))}</small></span>` +
      `<button type="button" class="pconn">${esc(t("prov.connect"))}</button>`;
    row.querySelector(".pconn").addEventListener("click", () => {
      providerOpen = name;
      renderSettingsSection("providers");
    });
    if (providerOpen === name) {
      row.classList.add("open");
      const body = document.createElement("div");
      body.className = "provbody";
      body.appendChild(providerForm(name, pc, true));
      row.appendChild(body);
    }
    put(row);
  }

  // ---- custom provider (free form) ----
  if (providerOpen === "__new__") {
    const wrap = document.createElement("div");
    wrap.className = "provcard open";
    wrap.innerHTML = `<div class="provbody"></div>`;
    wrap.querySelector(".provbody").appendChild(providerForm("", null, true));
    put(wrap);
  } else {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ghost small";
    add.textContent = t("prov.add");
    add.addEventListener("click", () => {
      providerOpen = "__new__";
      renderSettingsSection("providers");
    });
    put(add);
  }
}

/** A collapsible card row for a connected provider (name + default badge). */
function providerCard(name, pc) {
  const known = providerKnown(name, pc?.base_url, pc?.kind);
  const wrap = document.createElement("div");
  wrap.className = `provcard${providerOpen === name ? " open" : ""}`;
  wrap.innerHTML = `
    <button class="provhead" type="button">
      ${providerTile(name, known?.color ?? "#8a8a94", pc?.base_url, pc?.kind)}
      <span class="pname">${esc(name)}${name === ns.defaultProvider ? `<small class="pdefault">${esc(t("prov.default"))}</small>` : ""}</span>
    </button>
    <div class="provbody" hidden></div>`;
  wrap.querySelector(".provhead").addEventListener("click", () => {
    providerOpen = providerOpen === name ? "" : name;
    renderSettingsSection("providers");
  });
  if (providerOpen === name) {
    const body = wrap.querySelector(".provbody");
    body.hidden = false;
    body.appendChild(providerForm(name, pc, false));
  }
  return wrap;
}

async function renderSkillsSection(content, stale = () => false) {
  // every append goes through here: a section the user navigated away
  // from while an RPC was in flight must not land in the new tab
  const put = (node) => { if (!stale()) content.appendChild(node); };
  // Skills (M3 self-improvement catalog)
  const skillCard = card(t("ext.skills"), t("ext.skillsDesc"));
  skillCard.dataset.section = "skills";
  put(skillCard);

  // collapsible list (open by default so inline editors are usable)
  const details = document.createElement("details");
  details.className = "skill-details";
  details.open = true;
  const summary = document.createElement("summary");
  details.appendChild(summary);
  skillCard.appendChild(details);
  const mount = document.createElement("div");
  details.appendChild(mount);

  // create-new row (its editor opens right below)
  const createRow = document.createElement("div");
  createRow.className = "skill-create";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "setting-input";
  nameInput.placeholder = t("skills.newName");
  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "ghost";
  createBtn.textContent = t("skills.create");
  createRow.append(nameInput, createBtn);
  skillCard.appendChild(createRow);

  // inline editor: appears directly below the clicked row, one at a time.
  const closeEditors = () => {
    for (const el of skillCard.querySelectorAll(".skill-editor")) el.remove();
  };
  const openEditor = async (name, anchor, isNew = false, source = "familiar") => {
    const external = source !== "familiar";
    const next = anchor.nextElementSibling;
    const wasOpen = next instanceof HTMLElement && next.classList.contains("skill-editor");
    closeEditors();
    if (wasOpen) return; // clicking the same row again closes the editor
    const editor = document.createElement("div");
    editor.className = "skill-editor";
    const editorName = document.createElement("div");
    editorName.className = "skill-editor-name";
    editorName.textContent = `SKILL.md — ${name}`;
    const editorBody = document.createElement("textarea");
    editorBody.className = "skill-editor-body";
    editorBody.rows = 14;
    editorBody.spellcheck = false;
    editorBody.readOnly = external; // external skills are view-only
    const actions = document.createElement("div");
    actions.className = "skill-editor-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = t("skills.save");
    saveBtn.hidden = external; // external skills are view-only
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost";
    cancelBtn.textContent = external ? t("skills.close") : t("skills.cancel");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ghost danger";
    delBtn.textContent = t("skills.delete");
    delBtn.hidden = isNew || external; // external (global/shared) skills are read-only
    actions.append(saveBtn, cancelBtn, delBtn);
    editor.append(editorName);
    if (external) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = t("ext.skillExternalNote", source);
      editor.appendChild(note);
    }
    editor.append(editorBody, actions);
    anchor.insertAdjacentElement("afterend", editor);
    if (isNew) {
      editorBody.value = `# ${name}\n\nWhen: \nProcedure: \n`;
      editorBody.focus();
    } else {
      editorBody.value = t("skills.loading");
      try {
        const res = await rpc("skills.view", { name });
        editorBody.value = res.body ?? "";
      } catch (err) {
        editorBody.value = "";
        editorName.textContent = `${name}: ${err.message}`;
      }
    }
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        await rpc("skills.save", { name, body: editorBody.value });
        toast(t("skills.saved", name), "ok");
        refreshSettingsSectionIfActive("skills");
      } catch (err) {
        toast(err.message, "err");
        saveBtn.disabled = false;
      }
    });
    cancelBtn.addEventListener("click", () => editor.remove());
    delBtn.addEventListener("click", async () => {
      if (!window.confirm(t("skills.deleteConfirm", name))) return;
      delBtn.disabled = true;
      try {
        await rpc("skills.delete", { name });
        toast(t("skills.deleted", name), "ok");
        refreshSettingsSectionIfActive("skills");
      } catch (err) {
        toast(err.message, "err");
        delBtn.disabled = false;
      }
    });
  };
  createBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) return;
    void openEditor(name, createRow, true);
  });

  // filter + bulk delete
  const toolbar = document.createElement("div");
  toolbar.className = "skill-toolbar";
  const filterInput = document.createElement("input");
  filterInput.type = "search";
  filterInput.className = "setting-input skill-filter";
  filterInput.placeholder = t("skills.filterPh");
  filterInput.autocomplete = "off";
  const selAllBtn = document.createElement("button");
  selAllBtn.type = "button";
  selAllBtn.className = "ghost";
  selAllBtn.textContent = t("skills.selectAll");
  const delSelBtn = document.createElement("button");
  delSelBtn.type = "button";
  delSelBtn.className = "ghost danger";
  delSelBtn.disabled = true;
  toolbar.append(filterInput, selAllBtn, delSelBtn);
  details.insertBefore(toolbar, mount);

  let allSkills = [];
  const selected = new Set();
  const filtered = () => {
    const q = filterInput.value.trim().toLowerCase();
    if (!q) return allSkills;
    return allSkills.filter((sk) => `${sk.name} ${sk.description ?? ""}`.toLowerCase().includes(q));
  };
  const updateBulk = () => {
    delSelBtn.textContent = t("skills.deleteSelected", String(selected.size));
    delSelBtn.disabled = selected.size === 0;
  };
  const renderRows = () => {
    mount.innerHTML = "";
    if (allSkills.length === 0) {
      mount.appendChild(pairRow("—", t("ext.noSkills")));
      return;
    }
    const shown = filtered();
    if (shown.length === 0) {
      mount.appendChild(pairRow("—", t("skills.filterEmpty")));
      return;
    }
    for (const sk of shown) {
      const meta = t("ext.skillUses", sk.useCount ?? 0, sk.bodyChars ?? 0);
      const source = sk.source ?? "familiar";
      const external = source !== "familiar";
      const row = document.createElement("div");
      row.className = `skill-row${external ? " skill-external" : ""}`;
      if (external) {
        // global / other-harness skill: Familiar never writes to it (no checkbox)
        const badge = document.createElement("span");
        badge.className = "skill-badge";
        badge.textContent = t("ext.skillReadOnly");
        badge.title = source;
        row.appendChild(badge);
      } else {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "skill-check";
        cb.checked = selected.has(sk.name);
        cb.title = sk.name;
        cb.addEventListener("change", () => {
          if (cb.checked) selected.add(sk.name);
          else selected.delete(sk.name);
          updateBulk();
        });
        row.appendChild(cb);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "skill-open";
      btn.innerHTML = `<b>${esc(sk.name)}</b><small>${esc(`${sk.description ?? ""}${sk.description ? " · " : ""}${meta}`)}</small>`;
      btn.addEventListener("click", () => void openEditor(sk.name, row, false, source));
      row.appendChild(btn);
      mount.appendChild(row);
    }
  };
  filterInput.addEventListener("input", renderRows);
  selAllBtn.addEventListener("click", () => {
    // only Familiar-owned skills are selectable — externals are read-only
    const shown = filtered().filter((sk) => (sk.source ?? "familiar") === "familiar");
    const allOn = shown.length > 0 && shown.every((sk) => selected.has(sk.name));
    for (const sk of shown) {
      if (allOn) selected.delete(sk.name);
      else selected.add(sk.name);
    }
    renderRows();
    updateBulk();
  });
  delSelBtn.addEventListener("click", async () => {
    const names = [...selected];
    if (names.length === 0) return;
    if (!window.confirm(t("skills.deleteSelectedConfirm", String(names.length)))) return;
    delSelBtn.disabled = true;
    let ok = 0;
    const failed = [];
    for (const name of names) {
      try {
        await rpc("skills.delete", { name });
        ok += 1;
        selected.delete(name);
      } catch {
        failed.push(name);
      }
    }
    if (failed.length === 0) toast(t("skills.deletedBulk", String(ok)), "ok");
    else toast(t("skills.partialResult", String(ok), String(failed.length), failed.join(", ")), "err");
    refreshSettingsSectionIfActive("skills");
  });

  try {
    if (stale()) return;
    const res = await rpc("skills.list");
    allSkills = res.skills ?? [];
    summary.textContent = `${t("skills.edit")} (${allSkills.length})`;
    renderRows();
    updateBulk();
  } catch (err) {
    const row = document.createElement("div");
    row.className = "status-err";
    row.textContent = err.message;
    mount.appendChild(row);
  }
}

/** Build a titled group used to separate connector kinds in Settings. */
function buildConnectorGroup(id, title, description, badge = "") {
  const group = document.createElement("section");
  group.className = "connector-group";
  group.dataset.connectorGroup = id;

  const headingId = `connector-group-${id}-title`;
  group.setAttribute("aria-labelledby", headingId);

  const head = document.createElement("header");
  head.className = "connector-group-head";
  const copy = document.createElement("div");
  copy.className = "connector-group-copy";
  const heading = document.createElement("h3");
  heading.id = headingId;
  heading.textContent = title;
  const desc = document.createElement("p");
  desc.textContent = description;
  copy.append(heading, desc);
  head.appendChild(copy);

  if (badge) {
    const tag = document.createElement("span");
    tag.className = "connector-group-badge";
    tag.textContent = badge;
    head.appendChild(tag);
  }

  const body = document.createElement("div");
  body.className = "connector-group-body";
  group.append(head, body);
  return { group, body };
}

/** Build the MCP server card used by Settings → Connectors. */
function buildMcpServersCard() {
  const mcpCard = card(t("ext.mcp"), t("ext.mcpDesc"));
  mcpCard.dataset.section = "mcp";
  return mcpCard;
}

/** Populate the MCP card without blocking other connector settings. */
async function fillMcpServersCard(mcpCard, stale = () => false) {
  if (stale()) return;
  try {
    // Status and config load together: disabled servers never spawn a client,
    // so they appear in config.get but not in mcp.status.
    const [res, cfg] = await Promise.all([
      rpc("mcp.status", state.sessionId ? { session: state.sessionId } : {}),
      rpc("config.get"),
    ]);
    if (stale()) return;

    // Proxy sessions report the SSH host's servers.
    const note = mcpCard.querySelector(".note");
    if (note) {
      note.textContent = res.remote
        ? `SSH: ${res.remote} · ${t("ext.mcpDesc")}`
        : t("ext.mcpDesc");
    }
    const byName = new Map((res.servers ?? []).map((sv) => [sv.name, sv]));
    const configured = cfg.mcp?.servers ?? {};
    const names = [...new Set([...Object.keys(configured), ...byName.keys()])];
    if (names.length === 0) {
      mcpCard.appendChild(pairRow("—", t("stat.noServers")));
    }
    for (const name of names) {
      const sv = byName.get(name);
      const conf = configured[name] ?? {};
      const info = sv
        ? `${sv.state ?? "?"} · ${t("ext.tools", (sv.tools ?? []).length)}` +
          (sv.lastOkAt ? ` · ${t("ext.lastOk", new Date(sv.lastOkAt).toLocaleTimeString())}` : "") +
          (sv.reconnects ? ` · ${t("ext.reconnects", String(sv.reconnects))}` : "") +
          (sv.error ? ` · ${sv.error}` : "")
        : `${conf.disabled === true ? t("ext.disabled") : t("ext.enabled")} · ${conf.command ?? ""}`;
      const row = document.createElement("div");
      row.className = "pair";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = name;
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = info;
      const extra = [];
      if (sv) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ghost ext-reconnect";
        btn.textContent = t("ext.reconnect");
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await rpc("mcp.restart", { name, ...(state.sessionId ? { session: state.sessionId } : {}) });
            toast(t("ext.reconnected", name), "ok");
            refreshSettingsSectionIfActive("connectors");
          } catch (err) {
            toast(t("ext.reconnectFailed", err.message), "err");
            btn.disabled = false;
          }
        });
        extra.push(btn);
      }
      row.append(k, v, srvActions("mcp", name, mcpCard, stale, extra));
      mcpCard.appendChild(row);
    }
  } catch (err) {
    if (stale()) return;
    const row = document.createElement("div");
    row.className = "status-err";
    row.textContent = err.message;
    mcpCard.appendChild(row);
  } finally {
    if (!stale()) mcpCard.appendChild(srvAddRow("mcp", mcpCard, stale));
  }
}

/** Build the LSP server card used by Settings → Connectors. */
function buildLspServersCard() {
  const lspCard = card(t("ext.lsp"), t("ext.lspDesc"));
  lspCard.dataset.section = "lsp";
  return lspCard;
}

/** Populate the LSP card without blocking other connector settings. */
async function fillLspServersCard(lspCard, stale = () => false) {
  if (stale()) return;
  try {
    const cfg = await rpc("config.get");
    if (stale()) return;
    const lsp = cfg.lsp?.servers;
    const names = lsp && typeof lsp === "object" ? Object.keys(lsp) : [];
    if (names.length === 0) {
      lspCard.appendChild(pairRow("—", t("stat.noServers")));
    }
    for (const name of names) {
      const conf = lsp[name] ?? {};
      const row = pairRow(
        name,
        `${conf.disabled ? t("ext.disabled") : t("ext.enabled")} · ${Array.isArray(conf.extensions) ? conf.extensions.join(", ") : "?"}`,
      );
      row.appendChild(srvActions("lsp", name, lspCard, stale));
      lspCard.appendChild(row);
    }
  } catch (err) {
    if (stale()) return;
    const row = document.createElement("div");
    row.className = "status-err";
    row.textContent = err.message;
    lspCard.appendChild(row);
  } finally {
    if (!stale()) lspCard.appendChild(srvAddRow("lsp", lspCard, stale));
  }
}

function pairRow(k, v) {
  const row = document.createElement("div");
  row.className = "pair";
  row.innerHTML = `<span class="k">${esc(String(k))}</span><span class="v">${esc(String(v))}</span>`;
  return row;
}

// ---------------------------------------------------------------------------
// settings → connectors → MCP/LSP server editor
// ---------------------------------------------------------------------------

function srvArgsToLines(value) {
  return Array.isArray(value) ? value.map(String).join("\n") : "";
}

function srvLinesToArgs(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function srvEnvToText(env) {
  return env && typeof env === "object"
    ? Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")
    : "";
}

function srvTextToEnv(text) {
  const env = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    const key = eq < 0 ? "" : line.slice(0, eq).trim();
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(t("srv.badEnv"));
    env[key] = line.slice(eq + 1);
  }
  return env;
}

/** Inline editor for one server; `cfg` is the sanitized config.get result. */
function serverForm(kind, name, cfg, stale) {
  const servers = (kind === "mcp" ? cfg.mcp?.servers : cfg.lsp?.servers) ?? {};
  const existing = name ? servers[name] : undefined;
  const isNew = !existing;
  const form = document.createElement("div");
  form.className = "card srv-form";
  form.dataset.section = `${kind}-form-${isNew ? "new" : name}`;
  form.innerHTML = `
    <div class="field-row"><label>${esc(t("srv.name"))}</label>
      <input class="setting-input sf-name" type="text" spellcheck="false" placeholder="${esc(t("srv.namePh"))}" ${isNew ? "" : "readonly"} /></div>
    <div class="field-row"><label>${esc(t("srv.command"))}</label>
      <input class="setting-input sf-command" type="text" spellcheck="false" placeholder="${esc(t("srv.commandPh"))}" /></div>
    <div class="field-row"><label>${esc(t("srv.args"))}</label>
      <textarea class="setting-input sf-args" rows="2" spellcheck="false"></textarea></div>
    ${kind === "mcp"
      ? `<div class="field-row"><label>${esc(t("srv.env"))}</label>
           <textarea class="setting-input sf-env" rows="2" spellcheck="false"></textarea></div>`
      : `<div class="field-row"><label>${esc(t("srv.extensions"))}</label>
           <input class="setting-input sf-ext" type="text" spellcheck="false" /></div>`}
    <div class="field-row"><label>${esc(t("srv.timeout"))}</label>
      <input class="setting-input sf-timeout" type="number" min="100" max="600000" /></div>
    <div class="sf-flags">
      ${kind === "mcp" ? `<label><input type="checkbox" class="sf-readonly" /> ${esc(t("srv.readOnly"))}</label>` : ""}
      <label><input type="checkbox" class="sf-disabled" /> ${esc(t("srv.disabled"))}</label>
    </div>
    <p class="note">${esc(t("srv.advancedNote"))}</p>
    <div class="form-error" hidden></div>
    <div class="pop-actions">
      <button type="button" class="sf-save">${esc(t("srv.save"))}</button>
      <button type="button" class="ghost sf-cancel">${esc(t("srv.cancel"))}</button>
    </div>`;

  const nameInput = form.querySelector(".sf-name");
  nameInput.value = name ?? "";
  form.querySelector(".sf-command").value = existing?.command ?? "";
  form.querySelector(".sf-args").value = srvArgsToLines(existing?.args);
  if (kind === "mcp") form.querySelector(".sf-env").value = srvEnvToText(existing?.env);
  else form.querySelector(".sf-ext").value = Array.isArray(existing?.extensions) ? existing.extensions.join(", ") : "";
  form.querySelector(".sf-timeout").value = existing?.timeout_ms ?? "";
  const readOnly = form.querySelector(".sf-readonly");
  if (readOnly) readOnly.checked = existing?.read_only === true;
  form.querySelector(".sf-disabled").checked = existing?.disabled === true;

  const errBox = form.querySelector(".form-error");
  const setError = (msg) => { errBox.textContent = msg || ""; errBox.hidden = !msg; };
  form.querySelector(".sf-cancel").addEventListener("click", () => form.remove());

  form.querySelector(".sf-save").addEventListener("click", async () => {
    const finalName = nameInput.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(finalName)) { setError(t("srv.badName")); return; }
    const command = form.querySelector(".sf-command").value.trim();
    if (!command || /[\r\n]/.test(command)) { setError(t("srv.badCommand")); return; }
    const payload = {
      name: finalName,
      command,
      args: srvLinesToArgs(form.querySelector(".sf-args").value),
    };
    const timeout = String(form.querySelector(".sf-timeout").value).trim();
    if (timeout === "") payload.timeout_ms = null; // explicit clear
    else {
      const n = Number(timeout);
      if (!Number.isFinite(n) || n < 100 || n > 600000) { setError(t("srv.badTimeout")); return; }
      payload.timeout_ms = n;
    }
    try {
      if (kind === "mcp") {
        payload.env = srvTextToEnv(form.querySelector(".sf-env").value);
        payload.read_only = readOnly?.checked === true; // explicit off when unchecked
      } else {
        const extensions = form.querySelector(".sf-ext").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        if (extensions.length === 0) { setError(t("srv.badExtensions")); return; }
        payload.extensions = extensions;
      }
    } catch (err) {
      setError(err.message);
      return;
    }
    payload.disabled = form.querySelector(".sf-disabled").checked === true;
    const saveBtn = form.querySelector(".sf-save");
    saveBtn.disabled = true;
    try {
      const result = await rpc(`${kind}.servers.set`, payload);
      if (stale()) return;
      toast(t("srv.saved", result.name ?? finalName), "ok");
      refreshSettingsSectionIfActive("connectors");
    } catch (err) {
      if (stale()) return;
      setError(err.message);
      toast(t("srv.saveFailed", err.message), "err");
      saveBtn.disabled = false;
    }
  });
  return form;
}

/** Fetch settings lazily (only when the user opens an editor) and insert it. */
async function showServerForm(kind, name, card, stale) {
  let cfg;
  try {
    cfg = await rpc("config.get");
  } catch (err) {
    if (!stale()) toast(t("srv.loadFailed", err.message), "err");
    return;
  }
  if (stale()) return;
  card.querySelectorAll(".srv-form").forEach((el) => el.remove());
  const form = serverForm(kind, name, cfg, stale);
  const addRow = card.querySelector(".srv-add-row");
  if (addRow) card.insertBefore(form, addRow);
  else card.appendChild(form);
  form.querySelector(".sf-name")?.focus();
  form.scrollIntoView({ block: "nearest" });
}

async function deleteServer(kind, name) {
  if (!window.confirm(t("srv.deleteConfirm", name))) return;
  try {
    await rpc(`${kind}.servers.delete`, { name });
    toast(t("srv.deleted", name), "ok");
    refreshSettingsSectionIfActive("connectors");
  } catch (err) {
    toast(t("srv.deleteFailed", err.message), "err");
  }
}

function srvActions(kind, name, card, stale, extra = []) {
  const wrap = document.createElement("span");
  wrap.className = "srv-actions";
  for (const button of extra) wrap.appendChild(button);
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "ghost small srv-edit";
  edit.textContent = t("srv.edit");
  edit.addEventListener("click", () => { if (!stale()) void showServerForm(kind, name, card, stale); });
  const del = document.createElement("button");
  del.type = "button";
  del.className = "ghost small srv-delete";
  del.textContent = t("srv.delete");
  del.addEventListener("click", () => { if (!stale()) void deleteServer(kind, name); });
  wrap.append(edit, del);
  return wrap;
}

function srvAddRow(kind, card, stale) {
  const row = document.createElement("div");
  row.className = "srv-add-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost small srv-add";
  btn.textContent = kind === "mcp" ? t("srv.addMcp") : t("srv.addLsp");
  btn.addEventListener("click", () => { if (!stale()) void showServerForm(kind, null, card, stale); });
  row.appendChild(btn);
  return row;
}

// ---------------------------------------------------------------------------
// settings → connections (desktop SSH bridge)
// ---------------------------------------------------------------------------
let sshEditId = null;

function sshField(label, value, placeholder = "") {
  const wrap = document.createElement("label");
  wrap.className = "ssh-field";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  input.placeholder = placeholder;
  wrap.append(span, input);
  return { wrap, input };
}

function sshSelect(label, value, options) {
  const wrap = document.createElement("label");
  wrap.className = "ssh-field";
  const span = document.createElement("span");
  span.textContent = label;
  const sel = document.createElement("select");
  sel.className = "select-control";
  for (const [text, val] of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = text;
    if (val === value) opt.selected = true;
    sel.appendChild(opt);
  }
  wrap.append(span, sel);
  return { wrap, input: sel };
}

function sshActionRow(buttons) {
  const row = document.createElement("div");
  row.className = "conn-actions";
  for (const b of buttons) row.appendChild(b);
  return row;
}

/** ssh-keyscan fingerprints + one-click trust, used by the settings form. */
async function showHostKeyPanel(target, box, statusEl) {
  const api = connApi();
  if (!api || typeof api.hostKeyScan !== "function") return;
  box.hidden = false;
  box.innerHTML = `<div class="files-note">${esc(t("skills.loading"))}</div>`;
  let scan;
  try {
    scan = await api.hostKeyScan(target);
  } catch (err) {
    box.innerHTML = `<div class="files-note">${esc(t("ssh.hostKeyNone"))} — ${esc(err?.message ?? err)}</div>`;
    return;
  }
  const keys = scan?.keys ?? [];
  if (keys.length === 0) {
    box.innerHTML = `<div class="files-note">${esc(t("ssh.hostKeyNone"))}</div>`;
    return;
  }
  box.innerHTML =
    `<div class="ns-label">${esc(t("ssh.hostKeyTitle"))}</div>` +
    `<div class="files-note">${esc(t("ssh.hostKeyDesc", scan.knownHosts ?? ""))}</div>`;
  for (const k of keys) {
    const row = document.createElement("div");
    row.className = "ssh-hostkey-row";
    row.innerHTML = `<span class="ssh-hostkey-type">${esc(k.type)}</span><code>${esc(k.fingerprint)}</code>`;
    box.appendChild(row);
  }
  const reg = document.createElement("button");
  reg.type = "button";
  reg.textContent = t("ssh.hostKeyRegister");
  reg.addEventListener("click", async () => {
    reg.disabled = true;
    try {
      const res = await api.trustHostKey({
        host: target.host,
        port: target.port,
        keys: keys.map((k) => k.line),
      });
      const msg = t("ssh.hostKeyAdded", String(res?.added ?? 0), String(res?.skipped ?? 0));
      box.insertBefore(Object.assign(document.createElement("div"), { className: "files-note", textContent: msg }), box.lastChild);
      if (statusEl) {
        statusEl.textContent = `✓ ${msg}`;
        statusEl.style.color = "var(--ok)";
      }
      toast(msg, "ok");
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (statusEl) {
        statusEl.textContent = `✗ ${msg}`;
        statusEl.style.color = "var(--err)";
      }
      reg.disabled = false;
    }
  });
  box.appendChild(sshActionRow([reg]));
}

async function renderConnectionsSection(content, stale = () => false) {
  const put = (node) => { if (!stale()) content.appendChild(node); };
  const api = connApi();

  if (remoteBoot.isRemote) {
    // Read-only: the remote page may show where it is running and the way
    // back, but never the other hosts saved on the local machine.
    await refreshConnections(true);
    if (stale()) return;
    const host = connState.current;
    const c = card(t("remote.current"), t("remote.readOnly"));
    const label = host
      ? `${host.user ? `${host.user}@` : ""}${host.host}`
      : remoteBoot.host || "SSH";
    c.appendChild(pairRow(t("ssh.host"), label));
    if (host?.hostname) c.appendChild(pairRow("hostname", host.hostname));
    if (host?.platform) c.appendChild(pairRow("platform", host.platform));
    if (host?.version) c.appendChild(pairRow(t("set.version"), host.version));
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = t("remote.back");
    back.addEventListener("click", () => void backToLocal());
    c.appendChild(sshActionRow([back]));
    put(c);
    return;
  }

  if (!api) {
    put(card(t("ssh.title"), t("ssh.desktopOnly")));
    return;
  }

  await refreshConnections(true);
  if (stale()) return;

  const result = document.createElement("span");
  result.className = "conn-result";
  const setResult = (text, ok) => {
    result.textContent = text;
    result.style.color = ok === undefined ? "var(--dim)" : ok ? "var(--ok)" : "var(--err)";
  };

  if (connState.current) {
    const cur = card(t("ssh.current", connState.current.hostname || connState.current.host));
    const label = `${connState.current.user ? `${connState.current.user}@` : ""}${connState.current.host}`;
    cur.appendChild(pairRow(t("ssh.host"), label));
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = t("remote.back");
    back.addEventListener("click", () => void backToLocal());
    cur.appendChild(sshActionRow([back]));
    put(cur);
  }

  const list = card(t("ssh.title"), t("ssh.desc"));
  if (connState.connections.length === 0) {
    const note = document.createElement("div");
    note.className = "files-note";
    note.textContent = t("ssh.none");
    list.appendChild(note);
  }
  for (const pr of connState.connections) {
    const row = document.createElement("div");
    row.className = "ssh-row";
    const modeBadge = pr.mode === "proxy" ? t("ns.proxyBadge") : t("ns.serveBadge");
    const authBadge = pr.auth === "password" ? ` · ${t("ssh.authPassword")}${pr.hasPassword ? " 🔒" : ""}` : "";
    row.innerHTML = `<div class="ssh-main"><b>${esc(pr.name)}</b><small>${esc(sshProfileLabel(pr))} · ${esc(modeBadge)}${esc(authBadge)}</small></div>`;
    const test = document.createElement("button");
    test.type = "button";
    test.className = "ghost";
    test.textContent = t("ssh.test");
    test.addEventListener("click", async () => {
      setResult(t("ssh.testing"), undefined);
      try {
        const r = await api.testConnection(pr.id);
        setResult(t("ssh.testOk", r.hostname, r.platform, r.version || "?"), true);
      } catch (err) {
        setResult(t("ssh.testFail", err?.message ?? err), false);
      }
    });
    const connect = document.createElement("button");
    connect.type = "button";
    connect.textContent = t("ssh.connect");
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      try {
        await saveTypedPassword();
        const res = await api.connectProfile(pr.id, { newSession: false });
        if (res && res.url && res.token) {
          location.href = buildTunnelUrl(res, {});
        }
      } catch (err) {
        connect.disabled = false;
        toast(t("ssh.connectFail", err?.message ?? err), "err");
      }
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ghost";
    edit.textContent = t("ssh.edit");
    edit.addEventListener("click", () => {
      sshEditId = pr.id;
      renderSettingsSection("connections");
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = t("ssh.delete");
    del.addEventListener("click", async () => {
      if (!window.confirm(t("ssh.deleteConfirm", pr.name))) return;
      try {
        const res = await api.deleteConnection(pr.id);
        if (res && res.ok === false) throw new Error(t("ssh.deleteFailed"));
        if (sshEditId === pr.id) sshEditId = null;
        toast(t("ssh.deleted", pr.name), "ok");
        renderSettingsSection("connections");
      } catch (err) {
        toast(String(err?.message ?? err), "err");
      }
    });
    row.appendChild(
      sshActionRow(pr.mode === "proxy" ? [test, edit, del] : [connect, test, edit, del]),
    );
    list.appendChild(row);
  }
  list.appendChild(result);
  put(list);

  const editing = sshEditId ? connState.connections.find((x) => x.id === sshEditId) : null;
  const form = card(editing ? `${t("ssh.edit")}: ${editing.name}` : t("ssh.addSsh"));
  const name = sshField(t("ssh.name"), editing?.name ?? "");
  const host = sshField(t("ssh.host"), editing?.host ?? "", "build.example.com");
  const user = sshField(t("ssh.user"), editing?.user ?? "");
  const port = sshField(t("ssh.port"), editing?.port ?? 22);
  const mode = sshSelect(
    t("ssh.mode"),
    editing ? (editing.mode === "proxy" ? "proxy" : "serve") : "proxy",
    [
      [t("ssh.modeServe"), "serve"],
      [t("ssh.modeProxy"), "proxy"],
    ],
  );
  const authMode = sshSelect(
    t("ssh.authMode"),
    editing ? (editing.auth === "password" ? "password" : "key") : "password",
    [
      [t("ssh.authKey"), "key"],
      [t("ssh.authPassword"), "password"],
    ],
  );
  const pw = sshField(t("ssh.password"), "", editing?.hasPassword ? t("ssh.passwordSaved") : "");
  pw.input.type = "password";
  pw.input.autocomplete = "new-password";
  pw.wrap.hidden = authMode.input.value !== "password";
  const pwNote = document.createElement("div");
  pwNote.className = "files-note";
  pwNote.textContent = t("ssh.passwordHint");
  let clearPassword = false;
  const pwClear = document.createElement("button");
  pwClear.type = "button";
  pwClear.className = "ghost";
  pwClear.textContent = t("ssh.passwordClear");
  pwClear.hidden = !editing?.hasPassword;
  pwClear.addEventListener("click", () => {
    clearPassword = true;
    pw.input.value = "";
    pw.input.placeholder = t("ssh.passwordSaved");
    pwClear.hidden = true;
  });
  const syncAuthFields = () => {
    const isPw = authMode.input.value === "password";
    pw.wrap.hidden = !isPw;
    pwNote.hidden = !isPw;
    pwClear.hidden = !isPw || !editing?.hasPassword;
  };
  authMode.input.addEventListener("change", syncAuthFields);
  const key = sshField(t("ssh.key"), editing?.identityFile ?? "", "~/.ssh/id_ed25519");
  const bin = sshField(t("ssh.remoteBin"), editing?.remoteBin ?? "", "familiar");
  form.append(name.wrap, host.wrap, user.wrap, port.wrap, mode.wrap, authMode.wrap, pw.wrap, key.wrap, bin.wrap);

  const fresult = document.createElement("span");
  fresult.className = "conn-result";
  const hostKeyBox = document.createElement("div");
  hostKeyBox.className = "ssh-hostkey";
  hostKeyBox.hidden = true;
  const draftTarget = () => ({
    host: host.input.value.trim(),
    port: Number.parseInt(port.input.value, 10) || 22,
  });
  const draft = () => ({
    ...(editing ? { id: editing.id } : {}),
    name: name.input.value.trim(),
    host: host.input.value.trim(),
    user: user.input.value.trim(),
    port: Number.parseInt(port.input.value, 10) || 22,
    mode: mode.input.value,
    auth: authMode.input.value,
    ...(pw.input.value !== "" ? { password: pw.input.value } : {}),
    ...(clearPassword ? { password: null } : {}),
    identityFile: key.input.value.trim(),
    remoteBin: bin.input.value.trim() || "familiar",
  });
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = t("ssh.save");
  save.addEventListener("click", async () => {
    if (!host.input.value.trim()) {
      fresult.textContent = t("ssh.errHost");
      fresult.style.color = "var(--err)";
      return;
    }
    try {
      await api.saveConnection(draft());
      sshEditId = null;
      toast(t("ssh.saved"), "ok");
      renderSettingsSection("connections");
    } catch (err) {
      fresult.textContent = String(err?.message ?? err);
      fresult.style.color = "var(--err)";
    }
  });
  /** The secret is read from disk, so a typed password must be saved first. */
  const saveTypedPassword = async () => {
    if (authMode.input.value === "password" && pw.input.value !== "") {
      await api.saveConnection(draft());
      pw.input.value = "";
      pw.input.placeholder = t("ssh.passwordSaved");
      pwClear.hidden = false;
    }
  };
  const testProfile = () => {
    const { password: _pw, ...rest } = draft();
    return rest;
  };
  const test = document.createElement("button");
  test.type = "button";
  test.className = "ghost";
  test.textContent = t("ssh.test");
  test.addEventListener("click", async () => {
    if (!host.input.value.trim()) {
      fresult.textContent = t("ssh.errHost");
      fresult.style.color = "var(--err)";
      return;
    }
    fresult.textContent = t("ssh.testing");
    fresult.style.color = "var(--dim)";
    try {
      await saveTypedPassword();
      const r = await api.testConnection(testProfile());
      fresult.textContent = t("ssh.testOk", r.hostname, r.platform, r.version || r.familiar || "?");
      fresult.style.color = "var(--ok)";
      hostKeyBox.hidden = true;
    } catch (err) {
      const msg = String(err?.message ?? err);
      fresult.textContent = t("ssh.testFail", msg);
      fresult.style.color = "var(--err)";
      let hint = sshErrorHint(msg);
      if (/Permission denied|publickey/i.test(msg) && authMode.input.value === "key") {
        // no key on this machine: offer the password path right here
        authMode.input.value = "password";
        syncAuthFields();
        pw.input.focus();
        hint = t("ssh.passwordFirst");
      } else if (/Permission denied|publickey/i.test(msg) && authMode.input.value === "password" && !editing?.hasPassword && pw.input.value === "") {
        hint = t("ssh.passwordFirst");
      }
      if (/host key is known|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(msg)) {
        fresult.textContent = `${t("ssh.testFail", msg)} — ${t("ssh.hostKeyHint")}`;
        void showHostKeyPanel(draftTarget(), hostKeyBox, fresult);
      } else if (hint !== "") {
        fresult.textContent = `${t("ssh.testFail", msg)} — ${hint}`;
      }
    }
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = t("skills.cancel");
  cancel.hidden = !editing;
  cancel.addEventListener("click", () => {
    sshEditId = null;
    renderSettingsSection("connections");
  });
  const hostKeyBtn = document.createElement("button");
  hostKeyBtn.type = "button";
  hostKeyBtn.className = "ghost";
  hostKeyBtn.textContent = t("ssh.hostKeyBtn");
  hostKeyBtn.addEventListener("click", () => void showHostKeyPanel(draftTarget(), hostKeyBox, fresult));
  form.appendChild(sshActionRow([save, test, cancel, hostKeyBtn, pwClear, fresult]));
  pwNote.hidden = authMode.input.value !== "password";
  if (pw.wrap.parentElement) pw.wrap.parentElement.insertBefore(pwNote, pw.wrap.nextSibling);
  form.appendChild(hostKeyBox);
  put(form);
}

/** Settings → templates: register Office files whose design office_create reuses. */
/** Settings → Memory: human-owned MEMORY.md (never written by the agent). */
async function renderMemorySection(content, stale = () => false) {
  const c = card(t("nav.memory"), t("mem.desc"));
  c.dataset.section = "memory";
  content.appendChild(c);
  let res;
  try {
    res = await rpc("memory.file.get");
  } catch (err) {
    if (stale()) return;
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = t("mem.loadFailed", err.message);
    c.appendChild(note);
    return;
  }
  if (stale()) return;
  const ta = document.createElement("textarea");
  ta.className = "mem-textarea";
  ta.rows = 14;
  ta.spellcheck = false;
  ta.value = res.content ?? "";
  c.appendChild(ta);

  const path = document.createElement("p");
  path.className = "note";
  path.textContent = t("mem.path", res.path ?? "");
  const hint = document.createElement("p");
  hint.className = "note";
  hint.textContent = t("mem.projectHint");
  c.append(path, hint);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "perm-save";
  save.textContent = t("mem.save");
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await rpc("memory.file.set", { content: ta.value });
      if (stale()) return;
      toast(t("mem.saved"), "ok");
    } catch (err) {
      if (stale()) return;
      toast(t("mem.saveFailed", err.message), "err");
    } finally {
      save.disabled = false;
    }
  });
  c.appendChild(save);
}

/** Settings → Web search: standalone section for the search backend. */
function renderWebSearchSection(content, stale = () => false) {
  const webCard = card(t("nav.websearch"), t("perm.webDesc"));
  webCard.dataset.section = "websearch";
  content.appendChild(webCard);
  void fillWebSearchCard(webCard, stale);
}

/** Web search editor for the standalone Settings → Web search section. */
async function fillWebSearchCard(webCard, stale = () => false) {
  try {
    const cfg = await rpc("config.get");
    if (stale()) return;
    const web = cfg.permissions?.websearch ?? {};
    let urlInput;
    const providerSel = selectControl(
      [[t("perm.webDdg"), "duckduckgo"], [t("perm.webSearxng"), "searxng"]],
      web.provider ?? "duckduckgo",
      () => { if (urlInput) urlInput.required = providerSel.value === "searxng"; },
    );
    webCard.appendChild(settingRow(t("perm.webProvider"), t("perm.webProviderHint"), providerSel));

    const urlHead = document.createElement("div");
    urlHead.className = "perm-list-head";
    urlHead.textContent = `${t("perm.webUrl")} — ${t("perm.webUrlHint")}`;
    urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "perm-input";
    urlInput.spellcheck = false;
    urlInput.required = providerSel.value === "searxng";
    urlInput.placeholder = t("perm.webUrlPh");
    urlInput.value = web.base_url ?? "";
    const urlWrap = document.createElement("div");
    urlWrap.className = "perm-list";
    urlWrap.append(urlHead, urlInput);
    webCard.appendChild(urlWrap);

    const webSave = document.createElement("button");
    webSave.type = "button";
    webSave.className = "perm-save";
    webSave.textContent = t("perm.webSave");
    webSave.addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (providerSel.value === "searxng" && url === "") {
        toast(t("perm.webNeedUrl"), "err");
        return;
      }
      if (url !== "" && !/^https?:\/\//i.test(url)) {
        toast(t("perm.webBadUrl"), "err");
        return;
      }
      webSave.disabled = true;
      try {
        await rpc("permissions.websearch.set", { provider: providerSel.value, base_url: url });
        if (stale()) return;
        toast(t("perm.webSaved"), "ok");
      } catch (err) {
        if (stale()) return;
        toast(t("perm.saveFailed", err.message), "err");
      } finally {
        webSave.disabled = false;
      }
    });
    webCard.appendChild(webSave);
  } catch (err) {
    if (stale()) return;
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = t("perm.webLoadFailed", err.message);
    webCard.appendChild(note);
  }
}

async function renderApprovalsSection(content, stale = () => false) {
  const c = card(t("nav.approvals"), t("perm.desc"));
  content.appendChild(c);
  let policy;
  try {
    policy = await rpc("permissions.policy", {});
  } catch (err) {
    if (stale()) return;
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = t("perm.loadFailed", err.message);
    c.appendChild(note);
    return;
  }
  if (stale()) return;
  const user = policy?.user ?? {};
  const list = (v) => (Array.isArray(v) ? v.join("\n") : "");

  const modeSel = selectControl(
    [
      [t("perm.modeAllow"), "allow"],
      [t("perm.modeAsk"), "ask"],
    ],
    user.mode ?? "allow",
    () => {},
  );
  c.appendChild(settingRow(t("perm.mode"), t("perm.modeHint"), modeSel));

  const area = (label, value) => {
    const wrap = document.createElement("div");
    wrap.className = "perm-list";
    const head = document.createElement("div");
    head.className = "perm-list-head";
    head.textContent = label;
    const ta = document.createElement("textarea");
    ta.className = "perm-textarea";
    ta.rows = 5;
    ta.spellcheck = false;
    ta.value = value;
    wrap.append(head, ta);
    return { wrap, ta };
  };
  const allow = area(t("perm.allow"), list(user.allow));
  const ask = area(t("perm.ask"), list(user.ask));
  const deny = area(t("perm.deny"), list(user.deny));
  c.append(allow.wrap, ask.wrap, deny.wrap);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "perm-save";
  save.textContent = t("perm.save");
  save.addEventListener("click", async () => {
    save.disabled = true;
    const split = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
    try {
      await rpc("permissions.setPolicy", {
        mode: modeSel.value,
        allow: split(allow.ta.value),
        ask: split(ask.ta.value),
        deny: split(deny.ta.value),
      });
      toast(t("perm.saved"), "ok");
    } catch (err) {
      toast(t("perm.saveFailed", err.message), "err");
    } finally {
      save.disabled = false;
    }
  });
  c.appendChild(save);

  // rule tester
  const tester = document.createElement("div");
  tester.className = "perm-tester";
  const tHead = document.createElement("div");
  tHead.className = "perm-list-head";
  tHead.textContent = t("perm.testTitle");
  const tRow = document.createElement("div");
  tRow.className = "perm-test-row";
  const tInput = document.createElement("input");
  tInput.type = "text";
  tInput.className = "perm-input";
  tInput.placeholder = t("perm.testPh");
  const tBtn = document.createElement("button");
  tBtn.type = "button";
  tBtn.className = "ghost";
  tBtn.textContent = t("perm.test");
  const tOut = document.createElement("div");
  tOut.className = "perm-test-out";
  tBtn.addEventListener("click", async () => {
    const command = tInput.value.trim();
    if (!command) return;
    tBtn.disabled = true;
    try {
      const res = await rpc("permissions.test", { command });
      const key =
        res.action === "deny" ? "perm.decision.deny" : res.action === "ask" ? "perm.decision.ask" : "perm.decision.allow";
      tOut.textContent = `${t(key)}${res.reason ? ` — ${res.reason}` : ""}`;
      tOut.dataset.action = res.action;
    } catch (err) {
      tOut.textContent = t("perm.testFailed", err.message);
      tOut.dataset.action = "err";
    } finally {
      tBtn.disabled = false;
    }
  });
  tRow.append(tInput, tBtn);
  tester.append(tHead, tRow, tOut);
  c.appendChild(tester);
}

async function renderCronSection(content, stale = () => false) {
  const c = card(t("nav.cron"), t("cron.desc"));
  content.appendChild(c);
  let jobs = [];
  try {
    const res = await rpc("cron.status", {});
    jobs = res?.jobs ?? [];
  } catch (err) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = t("cron.failed", err.message);
    c.appendChild(note);
    return;
  }
  if (stale()) return;
  if (jobs.length === 0) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = t("cron.empty");
    c.appendChild(note);
    return;
  }
  for (const j of jobs) {
    const name = j.name ?? (j.prompt ?? "").slice(0, 24);
    const every = j.everyMinutes ?? j.every_minutes ?? 0;
    const enabled = j.enabled !== false;
    const row = document.createElement("div");
    row.className = "cron-row";
    const label = document.createElement("div");
    label.className = "cron-label";
    label.innerHTML =
      `<span class="cron-name">${esc(name)}</span>` +
      `<span class="cron-meta">${esc(every <= 0 ? t("cron.once") : t("cron.every", String(every)))}</span>` +
      `<span class="cron-role">${esc(enabled ? t("cron.enabled") : t("cron.paused"))}</span>`;
    const actions = document.createElement("div");
    actions.className = "cron-actions";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ghost";
    toggle.textContent = enabled ? t("cron.pause") : t("cron.resume");
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await rpc("cron.setEnabled", { name, enabled: !enabled });
        renderSettingsSection("cron");
      } catch (err) {
        toast(t("cron.failed", err.message), "err");
        toggle.disabled = false;
      }
    });
    const run = document.createElement("button");
    run.type = "button";
    run.className = "ghost";
    run.textContent = t("cron.run");
    run.addEventListener("click", async () => {
      run.disabled = true;
      try {
        await rpc("cron.run", { name });
        toast(t("cron.ran", name), "ok");
      } catch (err) {
        toast(t("cron.failed", err.message), "err");
      } finally {
        run.disabled = false;
      }
    });
    actions.append(toggle, run);
    row.append(label, actions);
    c.appendChild(row);
  }
}

async function renderTemplatesSection(content, stale = () => false) {
  const put = (node) => { if (!stale()) content.appendChild(node); };
  let templates = [];
  try {
    templates = (await rpc("office.templates")).templates ?? [];
  } catch (err) {
    put(sectionError(t("nav.templates"), err));
    return;
  }
  if (stale()) return;

  const intro = card(t("nav.templates"), t("tpl.intro"));
  intro.appendChild(howNote(t("tpl.how")));

  const kindIcon = { docx: "📘", xlsx: "📗", pptx: "📙" };
  if (templates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "note";
    empty.textContent = t("tpl.empty");
    intro.appendChild(empty);
  } else {
    for (const tpl of templates) {
      const row = document.createElement("div");
      row.className = "setting-row";
      const text = document.createElement("div");
      text.className = "setting-text";
      text.innerHTML = `<b>${kindIcon[tpl.kind] ?? "📄"} ${esc(tpl.name)}</b><span>${esc(tpl.kind)} · ${esc(formatBytes(tpl.size ?? 0))}</span>`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost tpl-del";
      del.textContent = t("tpl.delete");
      del.addEventListener("click", () => {
        if (!confirm(t("tpl.confirm", tpl.name))) return;
        void (async () => {
          try {
            await rpc("office.templates.delete", { name: tpl.name });
            toast(t("tpl.deleted"), "ok");
          } catch (err) {
            toast(t("tpl.importFailed", err.message), "err");
          }
          renderSettingsSection("templates");
        })();
      });
      row.append(text, del);
      intro.appendChild(row);
    }
  }

  // file picking: the desktop exposes a native dialog; a browser uploads bytes
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".docx,.dotx,.xlsx,.xltx,.pptx,.potx";
  picker.style.display = "none";
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    void importTemplateFromFile(file);
  });
  intro.appendChild(picker);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "tpl-add";
  add.textContent = `＋ ${t("tpl.add")}`;
  add.addEventListener("click", () => picker.click());
  intro.appendChild(add);
  put(intro);
}

/** Register a template from a picked file (path on the desktop, bytes in a browser). */
async function importTemplateFromFile(file) {
  const name = file.name;
  try {
    let params = null;
    const pickFile = window.familiarDesktop?.filePathFor;
    if (typeof pickFile === "function") {
      try {
        const p = pickFile(file);
        if (typeof p === "string" && p !== "") params = { path: p, name };
      } catch { /* fall back to uploading the bytes */ }
    }
    if (!params) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("read failed"));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsDataURL(file);
      });
      params = { name, dataBase64: dataUrl };
    }
    await rpc("office.templates.import", params);
    toast(t("tpl.added", name.replace(/\.[^.]+$/, "")), "ok");
  } catch (err) {
    toast(t("tpl.importFailed", err.message), "err");
  }
  renderSettingsSection("templates");
}

/** Small hint paragraph used inside cards. */
function howNote(text) {
  const el = document.createElement("div");
  el.className = "note";
  el.textContent = text;
  return el;
}

async function renderConnectorsSection(content, stale = () => false) {
  // every append goes through here: a section the user navigated away
  // from while an RPC was in flight must not land in the new tab
  const put = (node) => { if (!stale()) content.appendChild(node); };
  const putInto = (parent, node) => { if (!stale()) parent.appendChild(node); };

  // MCP and LSP are server-side connectors and share a framed subsection.
  // Their status/config calls load independently so a slow MCP discovery
  // cannot block the external-service settings below.
  const serverGroup = buildConnectorGroup(
    "servers",
    t("conn.serverGroupTitle"),
    t("conn.serverGroupDesc"),
    "MCP / LSP",
  );
  serverGroup.group.classList.add("connector-server-group");
  serverGroup.body.classList.add("connector-server-list");
  const mcpCard = buildMcpServersCard();
  const lspCard = buildLspServersCard();
  serverGroup.body.append(mcpCard, lspCard);
  put(serverGroup.group);
  void fillMcpServersCard(mcpCard, stale);
  void fillLspServersCard(lspCard, stale);

  if (!(await ensureNsConfig())) return;
  if (stale()) return;

  const externalGroup = buildConnectorGroup(
    "services",
    t("conn.externalGroupTitle"),
    t("conn.externalGroupDesc"),
  );
  externalGroup.group.classList.add("connector-external-group");
  externalGroup.body.classList.add("connector-external-list");
  put(externalGroup.group);

  let stored = {};
  try {
    stored = (await rpc("connectors.get")).connectors ?? {};
  } catch (err) {
    putInto(externalGroup.body, sectionError(t("conn.title"), err));
    return;
  }
  // ---- Google (OAuth: Gmail / カレンダー) ----
  const googleCard = card(t("conn.googleTitle"), t("conn.googleDesc"));
  googleCard.dataset.connector = "google";
  const g = stored.google ?? {};
  const gInputs = {};
  for (const [key, label, secret] of [
    ["client_id", t("conn.googleClientId"), false],
    ["client_secret", t("conn.googleClientSecret"), true],
  ]) {
    const input = document.createElement("input");
    input.type = secret ? "password" : "text";
    input.className = "setting-input";
    input.value = typeof g[key] === "string" && g[key] !== "" ? (secret ? "***" : g[key]) : "";
    input.placeholder = label;
    gInputs[key] = input;
    const row = document.createElement("div");
    row.className = "conn-field";
    row.appendChild(input);
    googleCard.appendChild(row);
  }
  const gActions = document.createElement("div");
  gActions.className = "conn-actions";
  const gSave = document.createElement("button");
  gSave.type = "button";
  gSave.textContent = t("conn.save");
  gSave.className = "ghost";
  const gAuth = document.createElement("button");
  gAuth.type = "button";
  gAuth.textContent = t("conn.googleAuth");
  const gTest = document.createElement("button");
  gTest.type = "button";
  gTest.textContent = t("conn.test");
  const gMail = document.createElement("button");
  gMail.type = "button";
  gMail.textContent = "Gmail";
  gMail.hidden = true;
  const gCal = document.createElement("button");
  gCal.type = "button";
  gCal.textContent = t("conn.calendar");
  gCal.hidden = true;
  const gResult = document.createElement("span");
  gResult.className = "conn-result";
  const gDel = document.createElement("button");
  gDel.type = "button";
  gDel.className = "ghost";
  gDel.textContent = t("conn.delete");
  const gList = document.createElement("div");
  gList.className = "conn-list";

  const gSaveSettings = async () => {
    const settings = {};
    for (const key of Object.keys(gInputs)) {
      settings[key] = gInputs[key].value.trim() === "***" && g[key] ? g[key] : gInputs[key].value.trim();
    }
    await rpc("connectors.set", { kind: "google", settings });
  };
  gSave.addEventListener("click", async () => {
    try {
      await gSaveSettings();
      gResult.textContent = "✓ " + t("conn.saved");
      gResult.style.color = "var(--ok)";
    } catch (err) {
      gResult.textContent = "✗ " + err.message;
      gResult.style.color = "var(--err)";
    }
  });
  gAuth.addEventListener("click", async () => {
    try {
      await gSaveSettings();
      const r = await rpc("google.authUrl", { origin: location.origin });
      // noopener: the opened page must not reach back through window.opener
      window.open(r.url, "_blank", "noopener,noreferrer");
      gResult.textContent = t("conn.googleAuthHint");
      gResult.style.color = "var(--dim)";
    } catch (err) {
      gResult.textContent = "✗ " + err.message;
      gResult.style.color = "var(--err)";
    }
  });
  gTest.addEventListener("click", async () => {
    gResult.textContent = "…";
    try {
      const r = await rpc("google.test");
      gResult.textContent = r.ok ? `✓ ${r.email}` : "✗ " + r.message;
      gResult.style.color = r.ok ? "var(--ok)" : "var(--err)";
      gMail.hidden = false;
      gCal.hidden = false;
    } catch (err) {
      gResult.textContent = "✗ " + err.message;
      gResult.style.color = "var(--err)";
    }
  });
  const loadList = async (kind) => {
    gList.innerHTML = `<div class="files-note">${esc(t("files.loading"))}</div>`;
    try {
      const r = kind === "gmail"
        ? await rpc("google.gmailList", { max: 10 })
        : await rpc("google.calendarList", { max: 10 });
      gList.innerHTML = "";
      for (const item of r.items ?? []) {
        const row = document.createElement("div");
        row.className = "conn-list-row";
        if (kind === "gmail") {
          row.innerHTML = `<b>${esc(item.subject || "(no subject)")}</b><small>${esc(item.from)} · ${esc(item.date)}</small>`;
        } else {
          row.innerHTML = `<b>${esc(item.summary)}</b><small>${esc(item.start)}${item.location ? " · " + esc(item.location) : ""}</small>`;
        }
        gList.appendChild(row);
      }
      if ((r.items ?? []).length === 0) gList.innerHTML = `<div class="files-note">—</div>`;
    } catch (err) {
      gList.innerHTML = `<div class="files-note">${esc(t("files.loadFailed", err.message))}</div>`;
    }
  };
  gMail.addEventListener("click", () => void loadList("gmail"));
  gCal.addEventListener("click", () => void loadList("calendar"));
  gDel.addEventListener("click", async () => {
    await rpc("connectors.delete", { kind: "google" });
    refreshSettingsSectionIfActive("connectors");
  });
  gActions.append(gSave, gAuth, gTest, gMail, gCal, gResult, gDel);
  googleCard.appendChild(gActions);
  if (g.refresh_token) {
    gMail.hidden = false;
    gCal.hidden = false;
  }
  googleCard.appendChild(gList);
  putInto(externalGroup.body, googleCard);

  const KINDS = [
    { id: "github", label: "GitHub", fields: [["token", t("conn.token"), true]] },
    { id: "gitlab", label: "GitLab", fields: [["base_url", t("conn.gitlabBase")], ["token", t("conn.token"), true]] },
    { id: "backlog", label: "Backlog", fields: [["base_url", t("conn.backlogBase")], ["api_key", t("conn.apiKey"), true]] },
    { id: "notion", label: "Notion", fields: [["token", "Internal Integration Token", true]] },
    { id: "slack", label: "Slack", fields: [["token", "Bot / User Token (xox…) ", true]] },
    { id: "teams", label: "Microsoft Teams", fields: [["token", t("conn.teamsToken"), true]] },
    { id: "discord", label: "Discord", fields: [["token", "Bot Token", true]] },
    { id: "jira", label: "Jira", fields: [["base_url", t("conn.baseUrl")], ["email", t("conn.email")], ["token", t("conn.token"), true]] },
    { id: "confluence", label: "Confluence", fields: [["base_url", t("conn.baseUrl")], ["email", t("conn.email")], ["token", t("conn.token"), true]] },
    { id: "redmine", label: "Redmine", fields: [["base_url", t("conn.baseUrl")], ["api_key", t("conn.apiKey"), true]] },
  ];
  for (const k of KINDS) {
    const saved = stored[k.id] ?? {};
    const cardEl = card(`${k.label}`, t("conn.desc"));
    cardEl.dataset.connector = k.id;
    const inputs = {};
    for (const [key, label, secret] of k.fields) {
      const input = document.createElement("input");
      input.type = secret ? "password" : "text";
      input.className = "setting-input";
      input.value = typeof saved[key] === "string" ? saved[key] : "";
      input.placeholder = label;
      input.dataset.key = key;
      inputs[key] = input;
      const row = document.createElement("div");
      row.className = "conn-field";
      row.appendChild(input);
      cardEl.appendChild(row);
    }
    const actions = document.createElement("div");
    actions.className = "conn-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = t("conn.save");
    save.className = "ghost";
    const test = document.createElement("button");
    test.type = "button";
    test.textContent = t("conn.test");
    const result = document.createElement("span");
    result.className = "conn-result";
    save.addEventListener("click", async () => {
      const settings = {};
      for (const [key] of k.fields) settings[key] = inputs[key].value.trim();
      try {
        await rpc("connectors.set", { kind: k.id, settings });
        result.textContent = "✓ " + t("conn.saved");
        result.style.color = "var(--ok)";
      } catch (err) {
        result.textContent = "✗ " + err.message;
        result.style.color = "var(--err)";
      }
    });
    test.addEventListener("click", async () => {
      // save first so the test uses the values on screen
      const settings = {};
      for (const [key] of k.fields) settings[key] = inputs[key].value.trim();
      await rpc("connectors.set", { kind: k.id, settings }).catch(() => {});
      result.textContent = "…";
      result.style.color = "var(--dim)";
      try {
        const r = await rpc("connectors.test", { kind: k.id });
        result.textContent = r.ok ? "✓ " + t("conn.ok") : "✗ " + r.message;
        result.style.color = r.ok ? "var(--ok)" : "var(--err)";
      } catch (err) {
        result.textContent = "✗ " + err.message;
        result.style.color = "var(--err)";
      }
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = t("conn.delete");
    del.addEventListener("click", async () => {
      await rpc("connectors.delete", { kind: k.id });
      refreshSettingsSectionIfActive("connectors");
    });
    actions.append(save, test, del, result);
    cardEl.appendChild(actions);
    putInto(externalGroup.body, cardEl);
  }
}

async function renderSystemSection(content, stale = () => false) {
  // every append goes through here: a section the user navigated away
  // from while an RPC was in flight must not land in the new tab
  const put = (node) => { if (!stale()) content.appendChild(node); };
  // ---- about card (version / developer / links) ----
  const about = card(t("set.about"), "");
  about.querySelector("h4")?.remove();
  const brand = document.createElement("div");
  brand.className = "about-brand";
  brand.innerHTML =
    `<img class="about-icon" src="/brand.png" alt="" />` +
    `<div class="about-text"><b>Familiar Harness</b>` +
    `<span id="about-version">${esc(t("set.version"))}: …</span>` +
    `<span>${esc(t("set.developer"))}: keima_tech</span>` +
    `<a href="https://note.com/keima_tech" target="_blank" rel="noopener">note.com/keima_tech ↗</a></div>`;
  about.appendChild(brand);
  try {
    if (stale()) return;
    const hz = await fetch("/healthz").then((r) => r.json());
    const vEl = about.querySelector("#about-version");
    if (vEl && hz?.version) vEl.textContent = `${t("set.version")}: v${hz.version}`;
    if (hz?.uiBuild) {
      const uEl = document.createElement("span");
      const d = new Date(hz.uiBuild);
      uEl.textContent = `${t("set.uiBuild")}: ${Number.isNaN(d.getTime()) ? hz.uiBuild : d.toLocaleString()}`;
      vEl?.after(uEl);
    }
  } catch { /* keep placeholder */ }
  put(about);

  const hint = card(t("set.systemStats"), t("sys.desc"));
  put(hint);
  try {
    const res = await rpc("curator.status");
    const c = res.curator ?? {};
    put(sectionCard("curator", [
      [t("stat.state"), `${c.enabled ? t("stat.enabled") : t("stat.disabled")}${c.paused ? " · " + t("stat.paused") : ""}`],
      [t("stat.lastRun"), `${fmtTime(c.lastRunAt)}${c.lastRunAt ? ` (${relTime(c.lastRunAt)})` : ""}`],
      [t("stat.nextDue"), fmtTime(c.nextDueAt)],
      [t("stat.stale"), (c.stale ?? []).join(", ") || "—"],
      [t("stat.archived"), `${(c.archived ?? []).length} (${t("stat.snapshots")}: ${c.snapshots ?? 0})`],
      [t("stat.consolidation"), c.consolidate ? t("stat.enabled") : t("stat.disabled")],
    ]));
  } catch (err) {
    put(sectionError("curator", err));
  }
  try {
    const res = await rpc("cron.status");
    const jobs = res.jobs ?? [];
    put(sectionCard(
      "cron scheduler",
      jobs.length > 0 ? jobs.map((j) => [j.name ?? "(unnamed)", j.enabled === false ? t("stat.disabled") : t("stat.everyMinutes", j.every_minutes)]) : [["—", t("stat.noJobs")]],
      res.started ? t("stat.running") : t("stat.stopped"),
    ));
  } catch (err) {
    put(sectionError("cron scheduler", err));
  }
}

// ---------------------------------------------------------------------------
// session info drawer (context usage + counts, OpenCode 実装準拠の概要)

// ---------------------------------------------------------------------------
// session list context menu (right click)
// ---------------------------------------------------------------------------
function hideCtxMenu() {
  $("#ctx-menu").hidden = true;
}

function openCtxMenu(ev, sessionId) {
  ev.preventDefault();
  hideFileMenu();
  const menu = $("#ctx-menu");
  menu.dataset.id = sessionId ?? "";
  menu.hidden = false;
  const pad = 4;
  const x = Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - pad);
  const y = Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - pad);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
}

// ---------------------------------------------------------------------------
// new session picker (provider / model / profile)
// ---------------------------------------------------------------------------
/** Load provider/profile catalog once for both the sidebar picker and the
 * composer model popover. */
async function ensureNsConfig() {
  if (ns.loaded) return true;
  try {
    const cfg = await rpc("config.get");
    ns.providers = cfg.providers ?? {};
    ns.profiles = cfg.profiles ?? {};
    ns.defaultProvider = cfg.default_provider ?? "mock";
    ns.defaultModel = cfg.default_model;
    ns.loaded = true;
    // Provider metadata may change the selected provider's brand (for example,
    // after editing base_url in Settings). Keep the composer chip in sync.
    renderModelChip();
    return true;
  } catch (err) {
    toast(t("toast.configUnavailable", err.message), "err");
    return false;
  }
}

// ---------------------------------------------------------------------------
// composer chips: agent mode + model for the current session
// ---------------------------------------------------------------------------
const MODES = ["plan", "ask", "edit", "yolo"];
const MODE_ICON = { plan: "🛡", ask: "✋", edit: "📝", yolo: "🔓" };

function modeKey(mode) {
  return MODES.includes(mode) ? mode : "edit";
}

/** Selected mode for the composer (the session's saved value wins). */
function activeMode() {
  return modeKey(state.draft.permissionMode || state.mode);
}

function renderModeChip() {
  const mode = activeMode();
  const chip = $("#mode-chip");
  chip.textContent = `${MODE_ICON[mode]} ${t(`mode.${mode}`)} ▾`;
  chip.classList.toggle("plan-mode", mode === "plan");
  chip.classList.toggle("yolo-mode", mode === "yolo");
  // highlight the current row in the popover
  for (const btn of document.querySelectorAll("#mode-pop button[data-mode]")) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
}

function setMode(mode) {
  const next = modeKey(mode);
  if (next !== "plan") state.lastEditMode = next;
  state.mode = next;
  state.draft.permissionMode = next;
  renderModeChip();
  $("#mode-pop").hidden = true;
}

/** Reasoning effort chip: default ⇔ low ⇔ medium ⇔ high (per session). */
function effortLabel(v) {
  return v ? String(v) : t("effort.default");
}

function activeEffort() {
  return state.draft.effort || (state.currentSession?.effort ?? "");
}

function renderEffortChip() {
  $("#effort-chip").textContent = `${effortLabel(activeEffort())} ▾`;
}

async function setEffort(v) {
  $("#effort-pop").hidden = true;
  const valid = v === "" || v === "low" || v === "medium" || v === "high";
  if (!valid) return;
  if (state.sessionId) {
    try {
      const updated = await rpc("session.update", { id: state.sessionId, effort: v });
      state.currentSession = updated;
      state.draft.effort = "";
      renderEffortChip();
      refreshSessions();
      toast(t("toast.effortSet", effortLabel(updated.effort ?? "")), "ok");
      return;
    } catch (err) {
      toast(t("toast.modelFailed", err.message), "err");
      return;
    }
  }
  // no session yet: stashed into the draft, applied at first send
  state.draft.effort = v;
  renderEffortChip();
  toast(t("toast.effortNext", effortLabel(v)), "info");
}

function renderModelChip() {
  const s = state.currentSession;
  const provider = state.draft.provider || s?.provider || ns.defaultProvider;
  const model = state.draft.model || s?.model || "";
  state.modelChipDefault = !provider && !model;
  const pc = provider ? ns.providers[provider] : null;
  const known = providerKnown(provider, pc?.base_url, pc?.kind);
  const mark = provider
    ? providerTile(provider, known?.color ?? "#8a8a94", pc?.base_url, pc?.kind)
    : "";
  const label = `${provider ?? t("chip.modelLabel")}${model ? "/" + model : ""} ▾`;
  $("#model-chip").innerHTML = `${mark}<span>${esc(label)}</span>`;
}

// ---------------------------------------------------------------------------
// model picker popover — searchable list grouped by provider (OpenCode-style)
// ---------------------------------------------------------------------------
let mpFilterBound = false;

async function openModelPopover() {
  const pop = $("#model-pop");
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  closeAllPops();
  if (!(await ensureNsConfig())) return;
  const list = $("#mp-list");
  list.innerHTML = "";
  $("#mp-search").value = "";
  const cur = {
    provider: state.draft.provider || state.currentSession?.provider || ns.defaultProvider || "",
    model: state.draft.model || state.currentSession?.model || "",
  };
  const names = usableProviderNames();
  const addNote = (box) => {
    const note = document.createElement("div");
    note.className = "mp-note";
    note.textContent = t("mp.unreachable");
    box.appendChild(note);
    applyMpFilter();
  };
  for (const name of names) {
    const box = document.createElement("div");
    box.className = "mp-grp";
    const pc = ns.providers[name] ?? {};
    const known = providerKnown(name, pc.base_url, pc.kind);
    box.innerHTML = `<div class="mp-group">${providerTile(name, known?.color ?? "#8a8a94", pc.base_url, pc.kind)}<span>${esc(name)}</span></div>`;
    list.appendChild(box);
    // progressive: fill the group as soon as this provider answers
    rpc("models.list", { provider: name })
      .then((res) => {
        if (res.error) addNote(box);
        else {
          for (const m of res.models ?? []) mpRow(box, name, m.id, cur, m.contextTokens);
          applyMpFilter();
        }
      })
      .catch(() => addNote(box));
  }
  if (!mpFilterBound) {
    mpFilterBound = true;
    $("#mp-search").addEventListener("input", applyMpFilter);
  }
  applyMpFilter();
  pop.hidden = false;
  $("#mp-search").focus();
}

function mpRow(box, provider, model, cur, contextTokens) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mp-row";
  const label = model === "" ? t("ns.modelDefault") : model;
  const selected = provider === cur.provider && model === cur.model;
  b.innerHTML =
    `<span class="mp-name">${esc(label)}</span>` +
    (contextTokens ? `<span class="mp-badge">${Math.round(contextTokens / 1000)}k</span>` : "") +
    `<span class="mp-check">${selected ? "✓" : ""}</span>`;
  b.dataset.search = `${provider} ${model}`.toLowerCase();
  b.addEventListener("click", () => void applyModelChoice(provider, model));
  box.appendChild(b);
  return b;
}

function applyMpFilter() {
  const q = ($("#mp-search").value || "").trim().toLowerCase();
  for (const box of $("#mp-list").children) {
    let any = false;
    for (const row of box.querySelectorAll(".mp-row")) {
      const hit = q === "" || (row.dataset.search ?? "").includes(q);
      row.hidden = !hit;
      if (hit) any = true;
    }
    const note = box.querySelector(".mp-note");
    if (note) {
      note.hidden = q !== "";
      if (!note.hidden) any = true;
    }
    box.hidden = !any;
  }
}

/** Apply a provider/model choice immediately (click = select, no Apply button). */
async function applyModelChoice(provider, model) {
  const prevProvider = state.draft.provider;
  const prevModel = state.draft.model;
  $("#model-pop").hidden = true;
  state.draft.provider = provider;
  state.draft.model = model;
  if (!state.sessionId) {
    renderModelChip();
    toast(t("toast.nextSession", `${provider}${model ? "/" + model : ""}`), "info");
    return;
  }
  try {
    const patch = { id: state.sessionId, provider };
    if (model !== "") patch.model = model;
    const updated = await rpc("session.update", patch);
    state.currentSession = updated;
    state.draft = { provider: "", model: "", effort: state.draft.effort };
    const bits = [updated.provider];
    if (updated.model) bits.push(updated.model);
    if (updated.profile) bits.push(`profile: ${updated.profile}`);
    $("#session-meta").textContent = bits.join(" · ");
    renderModelChip();
    refreshSessions();
    toast(t("toast.modelSet", bits.join("/")), "ok");
  } catch (err) {
    state.draft.provider = prevProvider;
    state.draft.model = prevModel;
    renderModelChip();
    toast(t("toast.modelFailed", err.message), "err");
  }
}

// ---- desktop self-update UI (⬇ in the topbar; main process does the work) ----
let updateState = null;

function renderUpdateBtn(st) {
  updateState = st;
  const btn = $("#update-btn");
  if (!btn) return;
  if (!st || st.status === "idle" || st.status === "upToDate" || st.status === "error") {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (st.status === "available") {
    btn.textContent = "⬇";
    btn.title = t("update.available", st.version ?? "");
  } else if (st.status === "downloading") {
    btn.textContent = "◌";
    btn.title = t("update.downloading");
  } else if (st.status === "applied") {
    btn.textContent = "↻";
    btn.title = t("update.restartTitle", st.version ?? "");
  }
}

function initUpdateUi() {
  const od = window.familiarDesktop;
  if (!od?.onUpdateStatus) return; // plain browser — updates via `familiar update`
  if (remoteBoot.isRemote) return; // updates apply to the local install only
  let prev = null;
  od.onUpdateStatus((st) => {
    prev = updateState;
    renderUpdateBtn(st);
    if (st?.status === "applied" && prev?.status === "downloading") {
      toast(t("update.applied", st.version ?? ""), "ok");
    } else if (st?.status === "available" && st.error) {
      toast(t("update.failed", st.error), "err");
    }
  });
  void od.checkForUpdate();
  $("#update-btn").addEventListener("click", () => {
    if (!updateState) return;
    if (updateState.status === "applied") {
      void od.restartApp();
      return;
    }
    if (updateState.status === "available") void od.applyUpdate();
  });
}

async function manualUpdateCheck() {
  const od = window.familiarDesktop;
  if (remoteBoot.isRemote) {
    toast(t("update.remoteHint"), "info");
    return;
  }
  if (!od?.checkForUpdate) {
    toast(t("update.cliHint"), "info");
    return;
  }
  const res = await od.checkForUpdate();
  if (res?.status === "available") toast(t("update.available", res.version ?? ""), "ok");
  else if (res?.status === "upToDate") toast(t("update.uptodate", res.version ?? ""), "ok");
  else toast(t("update.failed", res?.error ?? res?.status ?? ""), "err");
}

/** "+" opens the new-session dialog (Claude-desktop-style: the working
 * folder list sits centered in the dialog). Selecting a folder + 作成
 * creates the session with that cwd. */
let nsSuggestTimer = null;
let nsSelectedFolder = "";
let nsTarget = "local";

// ---------------------------------------------------------------------------
// SSH connections (desktop bridge; swiches the whole window to a remote
// `familiar serve` through an SSH tunnel)
// ---------------------------------------------------------------------------
const connState = {
  loaded: false,
  local: true,
  connections: [],
  current: null,
  loading: null,
  error: "",
};

/** Server-side equivalents of the desktop preload bridge, so the browser
 * WebUI can manage hosts and open remote serve tunnels too. */
const rpcConnApi = {
  connections: () => rpc("conn.list"),
  saveConnection: (profile) => rpc("conn.save", profile),
  deleteConnection: (id) => rpc("conn.delete", { id }),
  testConnection: (profile) =>
    rpc("conn.test", typeof profile === "string" ? { id: profile } : { profile }),
  connectProfile: (id, opts) => rpc("conn.connect", { id, ...(opts ?? {}) }),
  hostKeyScan: (params) => rpc("conn.hostkey", params),
  trustHostKey: (params) => rpc("conn.trusthost", params),
  disconnectConnection: () => rpc("conn.disconnect"),
  /** no push channel: browser UIs poll `conn.status` on demand */
  onConnectionStatus: () => () => {},
};

/** Tests force the RPC path inside the desktop shell (`connApiOverride`). */
let connApiOverride = null;

/** The desktop preload bridge inside the shell, else the server RPC layer. */
function connApi() {
  if (connApiOverride) return connApiOverride;
  return window.familiarDesktop && typeof window.familiarDesktop.connections === "function"
    ? window.familiarDesktop
    : rpcConnApi;
}

/** Remote-UI URL for a server-side tunnel (`conn.connect` response). */
function buildTunnelUrl(res, opts = {}) {
  const params = new URLSearchParams({
    token: res.token,
    remote: "1",
    host: res.hostname || res.host || "SSH",
  });
  if (res.id) params.set("conn", res.id);
  if (res.stop) params.set("stop", res.stop);
  params.set("local", location.origin);
  if (opts.newSession) {
    params.set("new", "1");
    const cwd = (opts.cwd ?? "").trim();
    if (cwd) params.set("cwd", cwd);
  }
  return `${res.url}/?${params.toString()}`;
}

async function refreshConnections(force = false) {
  const api = connApi();
  if (!api) return connState;
  if (connState.loading && !force) return connState.loading;
  connState.loading = api.connections()
    .then((res) => {
      connState.loaded = true;
      connState.local = res?.local !== false;
      connState.connections = Array.isArray(res?.connections) ? res.connections : [];
      connState.current = res?.current ?? null;
      connState.error = "";
    })
    .catch((err) => {
      connState.loaded = true;
      connState.error = String(err?.message ?? err);
    })
    .finally(() => {
      connState.loading = null;
    });
  return connState.loading;
}

function sshProfileLabel(p) {
  if (!p) return "";
  const user = p.user ? `${p.user}@` : "";
  const port = p.port && p.port !== 22 ? `:${p.port}` : "";
  return `${user}${p.host}${port}`;
}

/** Short, actionable hints appended to raw ssh errors in the UI. */
function sshErrorHint(msg) {
  const text = String(msg ?? "");
  if (/paused connection attempts|rate limit/i.test(text)) return t("ssh.rateHint");
  if (/Permission denied|publickey/i.test(text)) return t("ssh.authHint");
  if (/host key is known|Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(text)) return t("ssh.hostKeyHint");
  if (/kex_exchange_identification|Connection reset|Connection refused|No route to host|Connection timed out/i.test(text)) return t("ssh.netHint");
  return "";
}

/** Resolve a typed remote path: ~ and bare names are home-relative, then
 * normalized textually (posix). Used for the preview and session creation. */
function resolveRemotePath(value, home) {
  let v = String(value ?? "").trim();
  if (v === "" || v === "~") return home;
  if (v.startsWith("~/")) v = `${home}${v.slice(1)}`;
  else if (!v.startsWith("/")) v = `${String(home).replace(/\/+$/, "")}/${v}`;
  const parts = [];
  for (const seg of v.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** RPC `ssh` parameter for a stored profile (no secrets in it). */
function sshParams(p) {
  return {
    host: p.host,
    ...(p.user ? { user: p.user } : {}),
    ...(p.port && p.port !== 22 ? { port: p.port } : {}),
    ...(p.identityFile ? { identityFile: p.identityFile } : {}),
  };
}

/** True when the current session's tools do not run on this machine. */
function remoteToolsActive() {
  return remoteBoot.isRemote || !!state.currentSession?.remote;
}

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function showConnBanner(text) {
  $("#conn-banner-text").textContent = text;
  $("#conn-banner").hidden = false;
}

function hideConnBanner() {
  $("#conn-banner").hidden = true;
}

/** Return from a remote host: close the tunnel and restore the local UI. */
async function backToLocal() {
  if (remoteBoot.stop) {
    // Browser-initiated tunnel: the remote page is served by the *remote*
    // server, so stop the local tunnel through the capability endpoint and
    // navigate back (sessionStorage keeps the local token for this tab).
    const base = remoteBoot.local || "";
    if (base) {
      try {
        await fetch(`${base}/tunnel/stop?stop=${encodeURIComponent(remoteBoot.stop)}`, {
          mode: "cors",
          keepalive: true,
        });
      } catch {
        /* TTL on the server cleans up if this never lands */
      }
      location.href = base;
      return;
    }
    history.back();
    return;
  }
  // Desktop shell (or the local browser UI stopping a server-side tunnel).
  const api = connApi();
  if (!api || typeof api.disconnectConnection !== "function") return;
  try {
    await api.disconnectConnection();
  } catch (err) {
    toast(String(err?.message ?? err), "err");
  }
}

function maybeOpenBootNewSession() {
  if (!remoteBoot.wantNewSession) return;
  remoteBoot.wantNewSession = false;
  openNewSessionModal(remoteBoot.cwd);
}

/** One-time wiring: remote badge/banner, or the local connection list. */
function setupConnectionUi() {
  const badge = $("#remote-badge");
  if (remoteBoot.isRemote) {
    document.body.classList.add("remote-mode");
    const host = remoteBoot.host || "SSH";
    badge.hidden = false;
    badge.textContent = t("remote.badge", host);
    badge.title = t("remote.badgeTitle", host);
    badge.addEventListener("click", () => openSettingsModal("connections"));
    // remote paths cannot come from the local native picker
    $("#cwd-browse").hidden = true;
  } else {
    document.body.classList.add("local-mode");
    void refreshConnections();
  }
  $("#conn-banner-back").addEventListener("click", () => void backToLocal());
  $("#conn-banner-close").addEventListener("click", hideConnBanner);
  $("#ns-remote-back").addEventListener("click", () => void backToLocal());
  const api = connApi();
  if (api && typeof api.onConnectionStatus === "function") {
    api.onConnectionStatus((status) => {
      if (!status) return;
      if (status.state === "lost") {
        showConnBanner(t("remote.lost", status.host || remoteBoot.host || "SSH"));
      } else if (status.state === "local") {
        hideConnBanner();
      }
    });
  }
}

function openNewSessionModal(initialCwd = "") {
  const input = $("#ns-folder-input");
  input.value = initialCwd || "";
  nsSelectedFolder = initialCwd || "";
  const errBox = $("#new-session-overlay .form-error");
  errBox.hidden = true;
  errBox.textContent = "";
  $("#ns-browse").hidden = remoteBoot.isRemote || typeof window.familiarDesktop?.pickDirectory !== "function";
  $("#new-session-overlay").hidden = false;
  if (remoteBoot.isRemote) {
    // This page is served by the SSH host: sessions are always remote, and
    // other hosts cannot be reached from here.
    $("#ns-target-wrap").hidden = true;
    $("#ns-remote-bar").hidden = false;
    $("#ns-remote-bar-host").textContent = remoteBoot.host || t("remote.current");
    $("#ns-local-picker").hidden = false;
    $("#ns-remote-picker").hidden = true;
    renderNsRecent();
    input.focus();
    return;
  }
  $("#ns-target-wrap").hidden = false;
  $("#ns-remote-bar").hidden = true;
  renderNsTargets();
  selectNsTarget("local", { silent: true });
  renderNsRecent();
  input.focus();
  void refreshConnections().then(() => {
    if ($("#new-session-overlay").hidden) return;
    renderNsTargets();
    selectNsTarget(nsTarget, { silent: true });
  });
}

function closeNewSessionModal() {
  $("#new-session-overlay").hidden = true;
}

/** "Runs on" rows: this machine + each saved SSH profile (+ add shortcut). */
function renderNsTargets() {
  const box = $("#ns-targets");
  box.innerHTML = "";
  const row = (id, icon, name, sub) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ns-target-row";
    b.dataset.target = id;
    b.innerHTML =
      `<span class="ns-target-ic">${icon}</span>` +
      `<span class="ns-target-text"><span class="ns-target-name">${esc(name)}</span>` +
      `<span class="ns-target-sub">${esc(sub)}</span></span>`;
    b.addEventListener("click", () => selectNsTarget(id));
    box.appendChild(b);
    return b;
  };
  row("local", "💻", t("ns.localMachine"), t("ns.localHint"));
  for (const p of connState.connections) {
    const badge = p.mode === "proxy" ? t("ns.proxyBadge") : t("ns.serveBadge");
    row(p.id, "🖥", p.name, `${sshProfileLabel(p)} · ${badge}`);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "ns-target-row ns-target-add";
  add.innerHTML =
    `<span class="ns-target-ic">＋</span>` +
    `<span class="ns-target-text"><span class="ns-target-name">${esc(t("ns.addSsh"))}</span>` +
    `<span class="ns-target-sub">${esc(t("ns.addSshHint"))}</span></span>`;
  add.addEventListener("click", () => {
    closeNewSessionModal();
    openSettingsModal("connections");
  });
  box.appendChild(add);
}

/** Pick "local" or one SSH profile in the new-session dialog. */
function selectNsTarget(id, opts = {}) {
  if (id !== "local" && !connState.connections.some((p) => p.id === id)) id = "local";
  nsTarget = id;
  const remote = id !== "local";
  const profile = connState.connections.find((p) => p.id === id);
  const proxy = profile?.mode === "proxy";
  $("#ns-local-picker").hidden = remote;
  $("#ns-remote-picker").hidden = !remote;
  $("#ns-remote-name").textContent = profile ? sshProfileLabel(profile) : "";
  $("#ns-remote-list").hidden = !proxy;
  $("#ns-remote-hint").textContent = t(proxy ? "ns.proxyHint" : "ns.remoteHint");
  $("#ns-create").textContent = t(remote ? (proxy ? "ns.create" : "ns.connect") : "ns.create");
  for (const el of $("#ns-targets").querySelectorAll("[data-target]")) {
    el.classList.toggle("selected", el.dataset.target === id);
  }
  if (!opts.silent) (remote ? $("#ns-remote-cwd") : $("#ns-folder-input")).focus();
  if (proxy) {
    $("#ns-remote-cwd").value = "";
    // synchronous state so the box is never silently blank
    $("#ns-remote-list").innerHTML = `<div class="mp-note">${esc(t("skills.loading"))}</div>`;
    void renderNsRemoteDirs();
  } else {
    $("#ns-remote-list").innerHTML = "";
  }
}

/** Note with a retry button — used when the folder listing fails. */
function nsRemoteError(message, retryLabel = t("ns.retry")) {
  const box = document.createElement("div");
  box.className = "mp-note";
  const text = document.createElement("div");
  text.textContent = message;
  box.appendChild(text);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ghost";
  retry.textContent = retryLabel;
  retry.addEventListener("click", () => void renderNsRemoteDirs());
  box.appendChild(retry);
  return box;
}

/** Browse the remote host's folders for a proxy target (fs.dirs over ssh). */
let nsRemoteTimer = null;

async function renderNsRemoteDirs() {
  const box = $("#ns-remote-list");
  try {
    await renderNsRemoteDirsInner(box);
  } catch (err) {
    // a silent exception would leave the box blank — surface it instead
    box.replaceChildren(nsRemoteError(String(err?.message ?? err)));
  }
}

async function renderNsRemoteDirsInner(box) {
  const profile = connState.connections.find((p) => p.id === nsTarget);
  if (!profile || profile.mode !== "proxy" || $("#new-session-overlay").hidden) return;
  const ssh = sshParams(profile);
  const typed = $("#ns-remote-cwd").value.trim();
  // like the local picker: list the parent and filter by the typed prefix,
  // so "work", "~/wo" and "/srv/we" all suggest matching folders
  const { dir, prefix } = cwdQueryParts(typed);
  box.innerHTML = `<div class="mp-note">${esc(t("skills.loading"))}</div>`;
  let res;
  try {
    res = await rpc("fs.dirs", { path: dir, ssh });
  } catch (err) {
    // show the real reason (auth / host key / backoff), not "no match"
    const msg = String(err?.message ?? err);
    const hint = sshErrorHint(msg);
    box.replaceChildren(nsRemoteError(`${msg}${hint ? ` — ${hint}` : ""}`));
    return;
  }
  if (nsTarget !== profile.id || $("#new-session-overlay").hidden) return;
  const home = typeof res.home === "string" ? res.home : "";
  const needle = prefix.toLowerCase();
  const all = res.dirs ?? [];
  // prefix hits first, then anything containing the text (typing "ork" still
  // finds "work" — users rarely know the exact beginning)
  const starts = all.filter((d) => baseName(d).toLowerCase().startsWith(needle));
  const contains =
    needle.length >= 2
      ? all.filter((d) => !starts.includes(d) && baseName(d).toLowerCase().includes(needle))
      : [];
  const items = [...starts, ...contains].slice(0, 60);
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ns-label";
  head.textContent = t("ns.remoteSuggestions", String(items.length));
  box.appendChild(head);
  if (home && resolveRemotePath(typed, home) !== home && baseName(home)) {
    box.appendChild(nsRemoteRow("🏠", baseName(home), home));
  }
  if (dir !== "") {
    const parent = dir.replace(/[^/]+\/$/, "");
    box.appendChild(nsRemoteRow("↩︎", "..", parent === "" ? (home || "/") : parent, true));
  }
  for (const d of items) {
    box.appendChild(nsRemoteRow("📁", baseName(d), d));
  }
  if (items.length === 0) {
    const noMatch = document.createElement("div");
    noMatch.className = "mp-note";
    noMatch.textContent = prefix === "" ? t("ns.noFolderHere") : t("ns.noMatch");
    box.appendChild(noMatch);
  }
  if (home) {
    const resolved = resolveRemotePath(typed, home);
    const note = document.createElement("div");
    note.className = "files-note";
    note.textContent = t("ns.resolvedTo", resolved);
    box.appendChild(note);
  }
}

function nsRemoteRow(icon, name, value, isParent = false) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "ns-row";
  row.innerHTML =
    `<span class="ns-icon">${icon}</span>` +
    `<span class="ns-text"><span class="ns-name">${esc(name)}</span>` +
    `<span class="ns-path">${esc(value)}</span></span>`;
  row.addEventListener("click", () => {
    const next = isParent ? value : value.endsWith("/") ? value : `${value}/`;
    $("#ns-remote-cwd").value = next;
    void renderNsRemoteDirs();
    $("#ns-remote-cwd").focus();
  });
  return row;
}

/** Recent working folders from the session history (deduped, newest first). */
function renderNsRecent() {
  const box = $("#ns-list");
  box.innerHTML = "";
  const seen = new Map();
  for (const s of state.sessions) {
    if (s.remote) continue; // remote folders live on the SSH host
    const cwd = s.cwd || "";
    if (!cwd) continue;
    if (!seen.has(cwd)) seen.set(cwd, { cwd, count: 0, last: s.updatedAt ?? 0 });
    const e = seen.get(cwd);
    e.count += 1;
    e.last = Math.max(e.last, s.updatedAt ?? 0);
  }
  const list = [...seen.values()].sort((a, b) => b.last - a.last);
  if (list.length === 0) {
    box.innerHTML = `<div class="mp-note">${esc(t("ns.noRecent"))}</div>`;
    return;
  }
  for (const e of list) {
    box.appendChild(nsFolderRow(e.cwd, `${esc(t("ns.sessions", e.count))}`, e.cwd));
  }
}

/** One selectable folder row (label + sub line). Clicking selects it. */
function nsFolderRow(cwd, label, sub) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "ns-row" + (cwd === nsSelectedFolder ? " selected" : "");
  row.innerHTML =
    `<span class="ns-icon">📁</span>` +
    `<span class="ns-text"><span class="ns-name">${esc(label)}</span>` +
    `<span class="ns-path">${esc(sub)}</span></span>` +
    (cwd === nsSelectedFolder ? `<span class="ns-check">✓</span>` : "");
  row.addEventListener("click", () => {
    nsSelectedFolder = cwd;
    $("#ns-folder-input").value = cwd;
    renderNsList();
  });
  return row;
}

/** The dialog's center list: recent folders when the search box is empty,
 * fs.dirs suggestions while typing. */
async function renderNsList() {
  const box = $("#ns-list");
  const q = $("#ns-folder-input").value.trim();
  if (q === "") {
    renderNsRecent();
    return;
  }
  const { dir, prefix } = cwdQueryParts(q);
  let res;
  try {
    res = await rpc("fs.dirs", { path: dir });
  } catch {
    box.innerHTML = `<div class="mp-note">${esc(t("ns.noMatch"))}</div>`;
    return;
  }
  const needle = prefix.toLowerCase();
  const items = (res.dirs ?? []).filter((d) => baseName(d).toLowerCase().startsWith(needle));
  box.innerHTML = "";
  if (items.length === 0) {
    box.innerHTML = `<div class="mp-note">${esc(t("ns.noMatch"))}</div>`;
    return;
  }
  for (const d of items.slice(0, 60)) {
    // a typed path is only "selected" once the user clicks a suggestion
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ns-row" + (d === nsSelectedFolder ? " selected" : "");
    row.innerHTML =
      `<span class="ns-icon">📁</span>` +
      `<span class="ns-text"><span class="ns-name">${esc(baseName(d))}</span>` +
      `<span class="ns-path">${esc(d)}</span></span>` +
      (d === nsSelectedFolder ? `<span class="ns-check">✓</span>` : "");
    row.addEventListener("click", () => {
      nsSelectedFolder = d;
      $("#ns-folder-input").value = d;
      void renderNsList();
    });
    box.appendChild(row);
  }
}

async function createSessionFromModal() {
  const errBox = $("#new-session-overlay .form-error");
  const showErr = (msg) => {
    errBox.textContent = msg;
    errBox.hidden = false;
  };
  if (nsTarget !== "local") {
    // SSH target, two flavors:
    //  - familiar server: the shell starts `familiar serve` over a tunnel and loads
    //    the remote UI (the dialog there pre-fills the cwd)
    //  - SSH proxy: the session stays local, but every tool call runs on the
    //    remote host over ssh (nothing installed remotely)
    const api = connApi();
    const profile = connState.connections.find((p) => p.id === nsTarget);
    if (!profile) {
      showErr(t("ssh.desktopOnly"));
      return;
    }
    const connectBtn = $("#ns-create");
    errBox.hidden = true;
    connectBtn.disabled = true;
    try {
      if (profile.mode === "proxy") {
        connectBtn.textContent = t("ns.creating");
        const ssh = sshParams(profile);
        const info = await rpc("fs.dirs", { path: "", ssh });
        // ~, bare names and relative paths are resolved against the remote home
        const cwd = resolveRemotePath($("#ns-remote-cwd").value, info.home);
        const created = await rpc("session.create", { cwd, ssh });
        state.sessionId = created.id;
        closeNewSessionModal();
        await refreshSessions();
        await openSession(created.id);
        $("#input").focus();
        return;
      }
      if (!api || typeof api.connectProfile !== "function") {
        showErr(t("ssh.desktopOnly"));
        connectBtn.disabled = false;
        connectBtn.textContent = t("ns.connect");
        return;
      }
      connectBtn.textContent = t("ns.connecting");
      const cwdHint = $("#ns-remote-cwd").value.trim();
      const res = await api.connectProfile(nsTarget, { newSession: true, cwd: cwdHint });
      if (res && res.url && res.token) {
        // server-managed tunnel (browser WebUI): navigate to the remote UI
        location.href = buildTunnelUrl(res, { newSession: true, cwd: cwdHint });
        return;
      }
      // the desktop shell navigates its window; keep the button disabled
    } catch (err) {
      showErr(t("ns.connectFailed", err?.message ?? err));
      connectBtn.disabled = false;
      connectBtn.textContent = t(profile.mode === "proxy" ? "ns.create" : "ns.connect");
    }
    return;
  }
  // accept the typed path as-is when nothing is picked from the list
  const typed = $("#ns-folder-input").value.trim();
  const folder = nsSelectedFolder || typed;
  if (!folder) {
    showErr(t("ns.errNoFolder"));
    return;
  }
  const btn = $("#ns-create");
  btn.disabled = true;
  try {
    const s = await rpc("session.create", { cwd: folder });
    state.sessionId = s.id;
    closeNewSessionModal();
    await refreshSessions();
    await openSession(s.id);
    $("#input").focus();
  } catch (err) {
    showErr(t("toast.createFailed", err.message));
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// composer
// ---------------------------------------------------------------------------
/** Abort the running turn when busy; otherwise send the composer text. */
function composerAction() {
  // One button: busy + empty box stops the turn; otherwise it sends (while a
  // turn runs, sending steers that turn rather than aborting it).
  if (state.busy && $("#input").value.trim() === "") {
    void stopTurn();
    return;
  }
  void send();
}

async function send() {
  const input = $("#input");
  const text = input.value.trim();
  if (text === "") return;
  if (state.busy) {
    const runningText =
      state.runningTextBySession.get(state.sessionId) ??
      (state.busySessionId === state.sessionId ? state.lastUserText : null);
    if (typeof runningText === "string" && runningText.trim() === text.trim()) {
      // this exact instruction is the one already being processed — queuing
      // it would deliver a duplicate to the agent after the turn ends
      input.value = "";
      autoSize(input);
      toast(t("toast.dupRunning"), "info");
      return;
    }
    // the turn keeps running; steer it — the message is read at the next step
    const atts = state.pendingAttachments.slice();
    state.pendingAttachments = [];
    renderAttachStrip();
    input.value = "";
    autoSize(input);
    refreshSendButton();
    void steerRunningTurn(text, atts);
    return;
  }
  input.value = "";
  autoSize(input);
  await sendTurn(text, state.pendingAttachments.slice());
}

/** Steering: while a turn runs, a new instruction is injected into it so the
 *  model reads it at the next step (no abort, no wait for the turn to end). */
async function steerRunningTurn(text, atts) {
  const bubble = appendMessage("user", text, null, { attachments: atts });
  bubble.closest(".msg")?.setAttribute("data-opt", "1");
  try {
    await rpc("session.steer", {
      id: state.sessionId,
      text,
      ...(atts.length > 0 ? { attachments: atts } : {}),
    });
    toast(t("toast.steered"), "info");
  } catch (err) {
    // the turn finished between typing and sending — deliver it as a normal turn
    bubble.closest(".msg")?.remove();
    toast(t("toast.steerFallback", err.message), "info");
    await sendTurn(text, atts);
  }
}

/** /compact — summarize and shrink the stored context now (persisted). */
async function compactContext() {
  if (!state.sessionId) {
    toast(t("compact.noSession"), "err");
    return;
  }
  if (state.busy) {
    toast(t("compact.busy"), "info");
    return;
  }
  try {
    const res = await rpc("session.compact", { id: state.sessionId });
    if (res?.compacted) {
      toast(t("compact.done", String(res.dropped ?? 0), String(res.kept ?? 0)), "ok");
      await openSession(state.sessionId); // re-render the shortened transcript
    } else {
      toast(t("compact.nothing"), "info");
    }
  } catch (err) {
    toast(t("compact.failed", err.message), "err");
  }
}

/** Import a JSON transcript (from /export --format json) as a new session. */
function importTranscript() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const content = await file.text();
      const res = await rpc("session.import", { content });
      toast(t("import.done", String(res?.imported ?? 0)), "ok");
      if (res?.session?.id) await openSession(res.session.id);
    } catch (err) {
      toast(t("import.failed", err.message), "err");
    }
  });
  input.click();
}

/** Cross-session full-text search overlay (/)find. */
function openFindPanel() {
  let panel = document.getElementById("find-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "find-panel";
    panel.className = "find-panel";
    const head = document.createElement("div");
    head.className = "find-head";
    head.textContent = t("find.title");
    const input = document.createElement("input");
    input.className = "find-input";
    input.type = "search";
    input.placeholder = t("find.placeholder");
    const results = document.createElement("div");
    results.className = "find-results";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "find-close";
    close.textContent = "✕";
    close.addEventListener("click", () => panel.remove());
    head.appendChild(close);
    panel.append(head, input, results);
    document.body.appendChild(panel);
    let timer = null;
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void runFind(input.value), 250);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") panel.remove();
      e.stopPropagation();
    });
  }
  panel.hidden = false;
  const input = panel.querySelector(".find-input");
  input.value = "";
  panel.querySelector(".find-results").innerHTML = "";
  input.focus();
}

async function runFind(query) {
  const panel = document.getElementById("find-panel");
  if (!panel) return;
  const box = panel.querySelector(".find-results");
  const q = (query || "").trim();
  if (q === "") {
    box.innerHTML = "";
    return;
  }
  let hits = [];
  try {
    const res = await rpc("session.search", { query: q, limit: 40 });
    hits = res?.hits ?? [];
  } catch (err) {
    box.innerHTML = `<div class="find-row find-empty">${esc(t("find.failed", err.message))}</div>`;
    return;
  }
  box.innerHTML = "";
  if (hits.length === 0) {
    const none = document.createElement("div");
    none.className = "find-row find-empty";
    none.textContent = t("find.none");
    box.appendChild(none);
    return;
  }
  for (const h of hits) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "find-row";
    const meta = document.createElement("span");
    meta.className = "find-meta";
    meta.textContent = `${h.sessionTitle || t("find.untitled")} · ${h.role}`;
    const snip = document.createElement("span");
    snip.className = "find-snip";
    // snippet uses <<match>> markers; render them safely
    snip.innerHTML = esc(h.snippet || "").replace(/&lt;&lt;/g, "<b>").replace(/&gt;&gt;/g, "</b>");
    row.append(meta, snip);
    row.addEventListener("click", () => {
      panel.remove();
      void openSession(h.sessionId);
    });
    box.appendChild(row);
  }
}

/** Revert the files the previous turn's write/edit tools changed. */
async function undoLastTurn() {
  if (!state.sessionId) {
    toast(t("undo.noSession"), "err");
    return;
  }
  if (state.busy) {
    toast(t("undo.busy"), "info");
    return;
  }
  try {
    const res = await rpc("session.undo", { id: state.sessionId });
    if (res?.undone) {
      toast(t("undo.done", String((res.paths ?? []).length)), "ok");
      if ((res.failed ?? []).length > 0) toast(t("undo.failed", String(res.failed.length)), "err");
      await openSession(state.sessionId); // refresh any open file previews
    } else {
      toast(t("undo.nothing"), "info");
    }
  } catch (err) {
    toast(t("undo.failed", err.message), "err");
  }
}

/** Start a turn with an explicit message (composer or queue drain). */
async function sendTurn(text, atts) {
  const input = $("#input");
  let id = state.sessionId;
  setBusy(true);
  try {
    if (!id) {
      const createParams = {};
      if (state.draft.provider) createParams.provider = state.draft.provider;
      if (state.draft.model) createParams.model = state.draft.model;
      if (state.draft.effort) createParams.effort = state.draft.effort;
      const s = await rpc("session.create", createParams);
      id = s.id;
      state.sessionId = id;
      state.draft = { provider: "", model: "", effort: "" };
      await refreshSessions();
      // refreshSessions only auto-opens while no session is active
      if (state.currentSession?.id !== id) await openSession(id);
    }
    state.busySessionId = id;
    const bubble = appendMessage("user", text, null, { attachments: atts });
    bubble.closest(".msg")?.setAttribute("data-opt", "1");
    showPendingBubble(id);
    state.pendingAttachments = [];
    renderAttachStrip();
    input.value = "";
    autoSize(input);
    // a pending model-chip change is persisted first; on failure fall back to
    // per-turn overrides passed straight into session.send
    let overrides = null;
    if (state.draft.provider) {
      try {
        const patch = { id, provider: state.draft.provider };
        if (state.draft.model) patch.model = state.draft.model;
        state.currentSession = await rpc("session.update", patch);
        state.draft = { provider: "", model: "", effort: state.draft.effort };
        refreshSessions();
      } catch {
        overrides = { ...state.draft };
      }
    }
    state.lastUserText = text;
    const permMode = activeMode();
    const sparams = { id, text, plan: permMode === "plan", permissionMode: permMode };
    if (atts.length > 0) {
      sparams.attachments = atts.map((a) => ({ media_type: a.media_type, data: a.data, ...(a.name ? { name: a.name } : {}) }));
    }
    if (overrides?.provider) sparams.provider = overrides.provider;
    if (overrides?.model) sparams.model = overrides.model;
    if (state.draft.effort) sparams.effort = state.draft.effort;
    await rpc("session.send", sparams);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/already running/i.test(msg)) {
      const runningText = typeof err?.data?.runningText === "string" ? err.data.runningText : null;
      if (runningText !== null && runningText.trim() === text.trim()) {
        // the identical instruction is already running (double Enter, a stale
        // tab, /retry …): keep the bubble but never deliver a second copy
        state.pendingAttachments = [];
        renderAttachStrip();
        state.lastUserText = runningText;
        setBusy(true);
        state.busySessionId = id ?? state.sessionId;
        toast(t("toast.dupRunning"), "info");
        return;
      }
      // a *different* instruction: wait for the running turn to end and send
      // it then, instead of failing (the queue chip shows it is waiting)
      document.querySelector('#transcript .msg[data-opt="1"]')?.remove();
      state.pendingAttachments = [];
      renderAttachStrip();
      enqueueMessage(text, atts, { otherDevice: true });
      setBusy(true);
      state.busySessionId = id ?? state.sessionId;
      return;
    }
    document.querySelector('#transcript .msg[data-opt="1"]')?.remove();
    // nothing was sent: give the images back to the composer
    if (atts.length > 0) {
      state.pendingAttachments = atts;
      renderAttachStrip();
    }
    toast(t("toast.sendFailed", err.message), "err");
    setBusy(false);
  }
}

function autoSize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}

/** Append text at the composer cursor and keep the caret visible. */
function insertIntoComposer(text) {
  const ta = $("#input");
  ta.focus();
  const start = ta.selectionStart ?? ta.value.length;
  ta.setRangeText(text, start, ta.selectionEnd ?? start, "end");
  autoSize(ta);
}

// ---------------------------------------------------------------------------
// voice input (Web Speech API; no server round-trip, no extra dependency)
// ---------------------------------------------------------------------------
function speechRecognitionCtor() {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * Voice input needs the browser's Web Speech API. Electron builds Chromium
 * without Google's speech service (recognition errors with "not-allowed"),
 * so the mic is only offered in a real browser — including an Electron
 * renderer that somehow gets a working implementation.
 */
function speechSupported() {
  if (typeof (window.SpeechRecognition ?? window.webkitSpeechRecognition) !== "function") return false;
  const isElectron = typeof window.familiarDesktop === "object" && window.familiarDesktop !== null;
  return !isElectron;
}

/** Feature-detect once at startup; hide the button when unsupported. */
function setupMic() {
  const btn = $("#mic-btn");
  if (!btn) return;
  if (!speechSupported()) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.addEventListener("click", () => toggleMic());
}

let micRec = null;
/** Text that was in the composer when dictation started. */
let micBase = "";
/** Final transcripts accumulated for this session. */
let micFinal = "";

function micStop() {
  try {
    micRec?.stop();
  } catch {
    /* already stopped */
  }
  micRec = null;
  micBase = "";
  micFinal = "";
  const btn = $("#mic-btn");
  if (btn) {
    btn.classList.remove("recording");
    btn.title = t("mic.start");
  }
}

function micStart() {
  if (!speechSupported()) {
    toast(t("mic.unsupported"), "err");
    return;
  }
  const Ctor = speechRecognitionCtor();
  if (!Ctor) {
    toast(t("mic.unsupported"), "err");
    return;
  }
  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  const ta = $("#input");
  micBase = ta.value;
  micFinal = "";
  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (!res) continue;
      const chunk = res[0]?.transcript ?? "";
      if (res.isFinal) micFinal += chunk;
      else interim += chunk;
    }
    const sep = micBase !== "" && !/\s$/.test(micBase) ? " " : "";
    ta.value = `${micBase}${micBase ? sep : ""}${micFinal}${interim}`;
    autoSize(ta);
  };
  rec.onerror = (ev) => {
    // "no-speech" / "aborted" are normal end conditions, not errors
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      toast(t("mic.denied"), "err");
      micStop();
    }
  };
  rec.onend = () => {
    // continuous mode can end on its own (silence / tab switch)
    micStop();
  };
  micRec = rec;
  try {
    rec.start();
  } catch {
    micStop();
    return;
  }
  const btn = $("#mic-btn");
  if (btn) {
    btn.classList.add("recording");
    btn.title = t("mic.stop");
  }
  ta.focus();
}

function toggleMic() {
  if (micRec) micStop();
  else micStart();
}

/** Resolve an absolute path for a dropped/attached file (Electron ships
 * webUtils.getPathForFile; the browser fallback only has the file name). */
function resolveFilePath(f) {
  try {
    const viaBridge = window.familiarDesktop?.filePathFor?.(f);
    if (typeof viaBridge === "string" && viaBridge !== "" ) return viaBridge;
  } catch {
    /* bridge not available (plain browser) */
  }
  return f.path || f.name;
}

const ATTACH_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ATTACH_MAX = 4;             // images per message (mirrors the server cap)
const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
const ATTACH_UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // non-image upload cap (server caps at 20MB)

/** Read one image file into a { media_type, data, name } attachment. */
function fileToAttachment(f) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const m = url.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) {
        reject(new Error("unsupported data"));
        return;
      }
      resolve({ media_type: m[1], data: m[2], name: f.name });
    };
    reader.readAsDataURL(f);
  });
}

/** Picker + drag & drop: raster images become multimodal attachments,
 * everything else keeps the classic @path insertion. */
async function attachFiles(fileList) {
  const files = [...fileList].slice(0, 8);
  if (files.length === 0) return;
  const refs = [];
  let added = 0;
  for (const f of files) {
    const isImage = ATTACH_TYPES.has(f.type);
    if (isImage && f.size > ATTACH_MAX_BYTES) {
      toast(t("attach.tooLarge", f.name), "err");
      continue;
    }
    if (isImage) {
      if (state.pendingAttachments.length >= ATTACH_MAX) {
        toast(t("attach.limit", String(ATTACH_MAX)), "err");
        break;
      }
      try {
        state.pendingAttachments.push(await fileToAttachment(f));
        added += 1;
      } catch {
        toast(t("toast.attachFailed", f.name), "err");
      }
      continue;
    }
    const ref = resolveFilePath(f);
    if (!ref) {
      toast(t("toast.attachFailed", f.name), "err");
      continue;
    }
    if (remoteToolsActive()) {
      // tools run on the SSH host — upload the bytes there and reference the
      // remote path (proxy and familiar-server sessions alike)
      if (!state.sessionId) {
        toast(t("attach.remoteNoSession"), "err");
        continue;
      }
      if (f.size > ATTACH_UPLOAD_MAX_BYTES) {
        toast(t("attach.fileTooLarge", String(Math.floor(ATTACH_UPLOAD_MAX_BYTES / 1024 / 1024)), f.name), "err");
        continue;
      }
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const res = await rpc("fs.upload", {
          session: state.sessionId,
          name: f.name,
          data: bytesToBase64(bytes),
        });
        insertIntoComposer(`@${res.path} `);
        refs.push(res.path);
        toast(t("attach.uploaded", res.path), "ok");
      } catch (err) {
        toast(t("attach.uploadFailed", err?.message ?? err), "err");
      }
      continue;
    }
    insertIntoComposer(`@${ref} `);
    refs.push(ref);
  }
  renderAttachStrip();
  if (added > 0) toast(t("attach.added", String(added)), "ok");
  if (refs.length > 0) toast(t("toast.dropAttach", refs.join(" ")), "ok");
}

/** Composer strip: one thumbnail per pending image with a ✕ remove button. */
function renderAttachStrip() {
  const strip = $("#attach-strip");
  if (!strip) return;
  strip.innerHTML = "";
  strip.hidden = state.pendingAttachments.length === 0;
  state.pendingAttachments.forEach((a, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "attach-thumb";
    const img = imageThumb(a);
    img.classList.add("attach-img");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "attach-del";
    del.textContent = "✕";
    del.title = t("attach.remove");
    del.addEventListener("click", () => {
      state.pendingAttachments.splice(idx, 1);
      renderAttachStrip();
    });
    wrap.append(img, del);
    strip.appendChild(wrap);
  });
}

/** Hermes-style /retry: re-send the last user message. */
function retryLastTurn() {
  if (!state.sessionId || !state.lastUserText) {
    toast(t("toast.noRetry"), "info");
    return;
  }
  const input = $("#input");
  input.value = state.lastUserText;
  autoSize(input);
  void send();
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function boot() {
  applyTheme();
  applyUiPrefs();
  applyI18n();
  setupConnectionUi();
  // notifications default on: secure the browser permission early (Electron
  // grants it automatically; browsers may show a one-time prompt)
  if (prefs.notify && typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentModePref() === "system") applyTheme();
  });

  state.openTabs = loadOpenTabs();
  $("#new-session").addEventListener("click", () => openNewSessionModal());
  const closeSidebar = () => {
    $("#sidebar").classList.remove("open");
    $("#drawer-backdrop").hidden = true;
  };
  const openSidebar = () => {
    $("#sidebar").classList.add("open");
    if (window.matchMedia("(max-width: 900px)").matches) $("#drawer-backdrop").hidden = false;
  };
  // desktop: the hamburger collapses/expands the rail; the choice persists.
  const setSidebarCollapsed = (collapsed) => {
    $("#app").classList.toggle("side-collapsed", collapsed);
    $("#sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
    try { localStorage.setItem("familiar.sidebarCollapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
  };
  try {
    setSidebarCollapsed(localStorage.getItem("familiar.sidebarCollapsed") === "1");
  } catch {
    /* storage unavailable */
  }
  $("#sidebar-toggle").addEventListener("click", () => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      if ($("#sidebar").classList.contains("open")) closeSidebar();
      else openSidebar();
    } else {
      setSidebarCollapsed(!$("#app").classList.contains("side-collapsed"));
    }
  });
  $("#close-sidebar").addEventListener("click", closeSidebar);
  $("#drawer-backdrop").addEventListener("click", closeSidebar);
  // The session rail is draggable: its width persists like the right pane's.
  // The CSS clamps it to clamp(180px, --side-w, 40vw), so the handle stays
  // usable on small windows as well.
  const SIDE_W_MIN = 180;
  const SIDE_W_MAX = 480;
  const SIDE_W_DEFAULT = 248;
  const sideResizer = $("#side-resizer");
  const applySideWidth = (w) => {
    $("#app").style.setProperty("--side-w", `${Math.round(w)}px`);
  };
  try {
    const saved = Number(localStorage.getItem("familiar.sideW"));
    if (Number.isFinite(saved) && saved >= SIDE_W_MIN && saved <= SIDE_W_MAX) applySideWidth(saved);
  } catch {
    /* storage unavailable */
  }
  sideResizer.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = $("#sidebar").getBoundingClientRect().width;
    let width = startW;
    sideResizer.classList.add("dragging");
    document.body.style.userSelect = "none";
    const move = (e) => {
      width = Math.min(SIDE_W_MAX, Math.max(SIDE_W_MIN, startW + (e.clientX - startX)));
      applySideWidth(width);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      sideResizer.classList.remove("dragging");
      document.body.style.userSelect = "";
      try { localStorage.setItem("familiar.sideW", String(Math.round(width))); } catch { /* ignore */ }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  sideResizer.addEventListener("dblclick", () => {
    applySideWidth(SIDE_W_DEFAULT);
    try { localStorage.setItem("familiar.sideW", String(SIDE_W_DEFAULT)); } catch { /* ignore */ }
  });
  $("#sessions").addEventListener("click", (ev) => {
    if (window.matchMedia("(max-width: 900px)").matches && ev.target.closest("li[data-id]")) closeSidebar();
  });
  initUpdateUi();
  $("#ns-close").addEventListener("click", closeNewSessionModal);
  $("#ns-cancel").addEventListener("click", closeNewSessionModal);
  $("#ns-create").addEventListener("click", () => void createSessionFromModal());
  $("#ns-folder-input").addEventListener("input", () => {
    clearTimeout(nsSuggestTimer);
    nsSuggestTimer = setTimeout(() => void renderNsList(), 200);
  });
  $("#ns-folder-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void createSessionFromModal();
    }
  });
  $("#ns-remote-cwd").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void createSessionFromModal();
    }
  });
  $("#ns-remote-cwd").addEventListener("input", () => {
    // each list is one ssh round trip; 350ms feels live while the host
    // cooldown still protects against failed-auth bursts
    clearTimeout(nsRemoteTimer);
    nsRemoteTimer = setTimeout(() => void renderNsRemoteDirs(), 350);
  });
  $("#ns-browse").addEventListener("click", async () => {
    try {
      const picked = await window.familiarDesktop.pickDirectory();
      if (picked) {
        nsSelectedFolder = picked;
        $("#ns-folder-input").value = picked;
        await renderNsList();
      }
    } catch {
      /* dialog dismissed */
    }
  });
  $("#new-session-overlay").addEventListener("click", (ev) => {
    if (ev.target === $("#new-session-overlay")) closeNewSessionModal();
  });
  $("#ctx-btn").addEventListener("click", () => {
    const opening = $("#ctx-pop").hidden;
    closeAllPops();
    $("#ctx-pop").hidden = !opening;
    if (opening) renderCtxPane();
  });
  $("#retry").addEventListener("click", retryLastTurn);
  $("#edit-cwd").addEventListener("click", () => openCwdModal());
  $("#cwd-cancel").addEventListener("click", closeCwdModal);
  $("#cwd-ok").addEventListener("click", () => void confirmCwd());
  $("#cwd-input").addEventListener("input", () => {
    clearTimeout(cwdSuggestTimer);
    cwdSuggestTimer = setTimeout(() => void refreshCwdSuggest(), 200);
  });
  $("#cwd-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void confirmCwd();
    }
  });
  $("#cwd-browse").addEventListener("click", async () => {
    try {
      const picked = await window.familiarDesktop.pickDirectory();
      if (picked) {
        $("#cwd-input").value = picked;
        void refreshCwdSuggest();
      }
    } catch {
      /* dialog dismissed */
    }
  });
  $("#cwd-overlay").addEventListener("click", (ev) => {
    if (ev.target === $("#cwd-overlay")) closeCwdModal();
  });
  $("#composer-new").addEventListener("click", () => {
    const opening = $("#plus-pop").hidden;
    closeAllPops();
    $("#plus-pop").hidden = !opening;
  });
  $("#plus-pop").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-ins]");
    if (!btn) return;
    $("#plus-pop").hidden = true;
    const kind = btn.dataset.ins;
    if (kind === "file") {
      $("#file-attach").click();
    } else if (kind === "ctx") {
      insertIntoComposer("@ ");
    } else if (kind === "shell") {
      insertIntoComposer("! ");
      toast(t("toast.shellHint"), "info");
    }
  });
  $("#file-attach").addEventListener("change", () => {
    const files = [...($("#file-attach").files ?? [])];
    $("#file-attach").value = "";
    if (files.length === 0) return;
    void attachFiles(files);
  });

  // ---- drag & drop attachments into the composer --------------------------
  // Dropping must never navigate the page away, even outside the composer.
  for (const evt of ["dragover", "drop"]) {
    document.addEventListener(evt, (ev) => ev.preventDefault());
  }
  const composerEl = $("#composer");
  composerEl.addEventListener("dragover", (ev) => {
    if (ev.dataTransfer?.types?.includes("Files")) {
      ev.preventDefault();
      composerEl.classList.add("dragover");
    }
  });
  composerEl.addEventListener("dragleave", (ev) => {
    if (!composerEl.contains(ev.relatedTarget)) composerEl.classList.remove("dragover");
  });
  composerEl.addEventListener("drop", (ev) => {
    composerEl.classList.remove("dragover");
    const files = [...(ev.dataTransfer?.files ?? [])];
    if (files.length > 0) {
      ev.preventDefault();
      void attachFiles(files);
    }
  });

  // Ctrl+V of a clipboard image (screenshots) becomes an attachment
  $("#input").addEventListener("paste", (ev) => {
    const items = [...(ev.clipboardData?.items ?? [])];
    const imgs = items
      .filter((it) => it.kind === "file" && ATTACH_TYPES.has(it.type))
      .map((it) => it.getAsFile())
      .filter((f) => f !== null);
    if (imgs.length > 0) {
      ev.preventDefault();
      void attachFiles(imgs);
    }
  });
  $("#img-overlay").addEventListener("click", () => {
    $("#img-overlay").hidden = true;
    $("#img-overlay-img").src = "";
  });

  $("#session-filter").addEventListener("input", () => renderSessions());
  $("#fold-all-btn")?.addEventListener("click", () => toggleAllFolds());
  ulSessionsClick();
  initFileMenu();

  // topbar: search + gauge + settings + session menu
  $("#search-toggle").addEventListener("click", () => toggleSearch());
  $("#search-close").addEventListener("click", () => toggleSearch(false));
  $("#transcript-search").addEventListener("input", applyTranscriptFilter);
  $("#open-settings").addEventListener("click", () => openSettingsModal());
  $("#close-settings").addEventListener("click", () => closeSettingsModal());
  $("#settings-overlay").addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) closeSettingsModal();
  });
  $("#session-menu-btn").addEventListener("click", () => {
    const opening = $("#session-menu-pop").hidden;
    closeAllPops();
    $("#session-menu-pop").hidden = !opening;
  });
  $("#session-menu-pop").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    $("#session-menu-pop").hidden = true;
    if (btn.dataset.act === "rename") startRename();
    else if (btn.dataset.act === "export") void exportMarkdown();
    else if (btn.dataset.act === "delete") void deleteSession(state.sessionId);
    else if (btn.dataset.act === "update-check") void manualUpdateCheck();
  });

  // composer chips
  $("#mode-chip").addEventListener("click", () => {
    const opening = $("#mode-pop").hidden;
    closeAllPops();
    $("#mode-pop").hidden = !opening;
  });
  $("#mode-pop").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-mode]");
    if (!btn) return;
    setMode(btn.dataset.mode);
  });
  $("#effort-chip").addEventListener("click", () => {
    const opening = $("#effort-pop").hidden;
    closeAllPops();
    $("#effort-pop").hidden = !opening;
  });
  $("#effort-pop").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-effort]");
    if (!btn) return;
    void setEffort(btn.dataset.effort ?? "");
  });
  $("#model-chip").addEventListener("click", () => void openModelPopover());
  $("#mp-settings").addEventListener("click", () => openSettingsModal("providers"));

  // close popovers / context menu on outside click, scroll or resize
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".menu-wrap")) closeAllPops();
    if (!ev.target.closest("#ctx-menu")) hideCtxMenu();
    if (!ev.target.closest("#file-menu") && !ev.target.closest("#file-submenu")) hideFileMenu();
  });
  for (const evt of ["scroll", "resize"]) {
    $("#transcript").addEventListener(evt, hideCtxMenu, { passive: true });
    $("#files-tree").addEventListener(evt, hideFileMenu, { passive: true });
    $("#files-view").addEventListener(evt, hideFileMenu, { passive: true });
    window.addEventListener(evt, () => {
      hideCtxMenu();
      hideFileMenu();
    }, { passive: true });
  }
  // the composer hint depends on the device (touch ⇒ Enter inserts a newline)
  for (const evt of ["resize", "orientationchange"]) {
    window.addEventListener(evt, () => applyComposerPlaceholder(), { passive: true });
  }

  $("#composer").addEventListener("submit", (ev) => {
    ev.preventDefault();
    composerAction();
  });
  const input = $("#input");
  input.addEventListener("keydown", (ev) => {
    if (!$("#cmd-pop").hidden && ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      $("#cmd-pop").hidden = true;
      return;
    }
    if (!$("#cmd-pop").hidden && cmdMode === "cmd" && ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      runFirstCommand();
      return;
    }
    if (!$("#cmd-pop").hidden && cmdMode === "file" && ev.key === "Tab") {
      ev.preventDefault();
      insertFirstFile();
      return;
    }
    if (!$("#cmd-pop").hidden && ev.key === "Tab") $("#cmd-pop").hidden = true;
    const wantsSend = mobileComposer()
      ? // phones: Enter inserts a newline, the ↑ button sends
        ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)
      : prefs.sendWithEnter
        ? ev.key === "Enter" && !ev.shiftKey
        : ev.key === "Enter" && (ev.ctrlKey || ev.metaKey);
    if (wantsSend) {
      ev.preventDefault();
      // Enter (or Ctrl/Cmd+Enter) means "send": while a turn runs this queues
      // the text (visible chip) — the ■ button is the one that aborts
      void send();
    }
  });
  input.addEventListener("input", () => {
    autoSize(input);
    refreshSendButton(); // toggle ↑ / ■ while a turn runs
    void updateComposerPop();
  });

  $("#pane-toggle").addEventListener("click", () => togglePane());
  const rp = $("#rightpane");
  const savedW = Number(localStorage.getItem("familiar.paneW"));
  if (savedW >= 280 && savedW <= 760) rp.style.width = `${savedW}px`;
  $("#pane-resizer").addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = rp.getBoundingClientRect().width;
    $("#pane-resizer").classList.add("dragging");
    const move = (e) => {
      const w = Math.min(760, Math.max(280, startW + (startX - e.clientX)));
      rp.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      $("#pane-resizer").classList.remove("dragging");
      localStorage.setItem("familiar.paneW", String(Math.round(rp.getBoundingClientRect().width)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  $("#close-pane").addEventListener("click", closePane);
  $(".pane-tabs").addEventListener("click", (ev) => {
    const tab = ev.target.closest("[data-tab]");
    if (tab) showPane(tab.dataset.tab);
  });
  $("#ctx-gauge").addEventListener("click", () => {
    // gauge click: open the context tab; clicking again closes the pane
    if (!$("#rightpane").hidden && activePaneTab() === "ctx") closePane();
    else showPane("ctx");
  });

  // Code-block controls are delegated: streamed markdown, file previews and
  // re-renders all work without per-render wiring.
  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const copyBtn = target?.closest("button.code-copy");
    if (copyBtn) {
      const code = copyBtn.closest(".codeblock")?.querySelector("pre code");
      void copyText(code?.textContent ?? "").then((ok) => {
        copyBtn.textContent = ok ? "✓" : "✕";
        copyBtn.classList.toggle("copied", ok);
        copyBtn.classList.toggle("copy-fail", !ok);
        if (!ok) toast(t("msg.copyFailed"), "err");
        setTimeout(() => {
          copyBtn.textContent = "⧉";
          copyBtn.classList.remove("copied", "copy-fail");
        }, 1200);
      });
      return;
    }
    const expandBtn = target?.closest("button.code-expand");
    if (expandBtn) {
      const block = expandBtn.closest(".codeblock");
      if (!block) return;
      block.classList.toggle("collapsed");
      expandBtn.textContent = block.classList.contains("collapsed") ? t("code.showAll") : t("code.collapse");
    }
  });

  document.addEventListener("keydown", (ev) => {
    // Tab toggles Build/Plan (skips while renaming or searching)
    if (ev.key === "Tab" && prefs.tabModeToggle) {
      const t = ev.target;
      const editable = t instanceof HTMLElement &&
        (t.tagName === "SELECT" || (t.tagName === "INPUT" && t.id !== "input"));
      if (!editable) {
        ev.preventDefault();
        setMode(state.mode === "plan" ? (state.lastEditMode ?? "edit") : "plan");
        return;
      }
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      $("#session-filter").focus();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      toggleSearch(true);
      return;
    }
    if (ev.key === "Escape") {
      if (!$("#settings-overlay").hidden) {
        closeSettingsModal();
        return;
      }
      if (!$("#cwd-overlay").hidden) {
        closeCwdModal();
        return;
      }
      if (!$("#new-session-overlay").hidden) {
        closeNewSessionModal();
        return;
      }
      if (!$("#img-overlay").hidden) {
        $("#img-overlay").hidden = true;
        $("#img-overlay-img").src = "";
        return;
      }
      hideCtxMenu();
      closeAllPops();
      if (!$("#search-bar").hidden) {
        toggleSearch(false);
        return;
      }
      if (!$("#rightpane").hidden) {
        closePane();
        return;
      }
      // Esc with nothing else to dismiss interrupts a running turn
      if (state.busy) void stopTurn();
    }
  });

  setMode(state.mode === "plan" ? "plan" : "edit");
  setupMic();
  renderModelChip();
  // Load endpoint metadata early so custom provider IDs can resolve their brand
  // mark from base_url before the first session is opened. ensureNsConfig()
  // refreshes the chip after a successful load.
  void ensureNsConfig();
  renderEffortChip();
  updateContextGauge();
  void refreshSessions().then(
    () => maybeOpenBootNewSession(),
    () => maybeOpenBootNewSession(),
  );
  void refreshTodoProgress();
  autoSize(input);
  input.focus();
  connectEvents();
}

boot();
