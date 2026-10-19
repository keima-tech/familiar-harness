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

async function rpc(method, params = {}) {
  const headers = { "Content-Type": "application/json" };
  if (serverToken) headers["Authorization"] = `Bearer ${serverToken}`;
  const res = await fetch("/rpc", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showAuthHint();
    throw new Error("unauthorized");
  }
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
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
    "side.settings": "⚙ 設定",
    "top.inbox": "承認インボックス",
    "top.status": "ステータス",
    "del.confirm": "セッション「{0}」を削除しますか? この操作は元に戻せません",
    "none": "(なし)",
    "top.noSession": "セッションなし",
    "top.gaugeTitle": "コンテキスト使用量 — クリックでセッション情報",
    "top.gaugeNoTurn": "コンテキスト使用量 — 次のターン送信後に表示",
    "side.noFolder": "フォルダーなし",
    "chip.ctx": "コンテキスト使用量",
    "update.available": "アップデートがあります — v{0}(⬇ から適用)",
    "update.downloading": "アップデートをダウンロード中…",
    "update.applied": "v{0} を適用しました — ↻ で再起動してください",
    "update.restartTitle": "再起動して v{0} を適用",
    "update.uptodate": "最新です (v{0})",
    "update.failed": "アップデートに失敗しました: {0}",
    "update.cliHint": "ブラウザ版の更新は `familiar update` で実行できます",
    "menu.updateCheck": "アップデートを確認",
    "top.pane": "サイドペイン",
    "pane.inbox": "承認",
    "pane.todo": "タスク",
    "pane.status": "状態",
    "pane.info": "情報",
    "pane.ctx": "コンテキスト",
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
    "ns.title": "新規セッション",
    "ns.search": "フォルダーを検索・入力… (例: ~/work)",
    "ns.pickFolder": "作業フォルダーを選択",
    "ns.create": "作成",
    "ns.noRecent": "最近のフォルダーはまだありません — 上に入力してください",
    "ns.noMatch": "一致するフォルダーがありません",
    "ns.sessions": "{0} セッション",
    "ns.errNoFolder": "作業フォルダーを選択するか入力してください",
    "top.search": "トランスクリプト内検索 (Ctrl+F)",
    "top.sessionActions": "セッション操作",
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
    "chip.mode": "エージェントモード",
    "chip.model": "セッションのモデル",
    "mode.build": "Build",
    "mode.buildDesc": "全ツール使用可",
    "mode.plan": "Plan",
    "mode.planDesc": "読み取り専用ツール",
    "chip.modelLabel": "モデル",
    "mp.search": "モデルを検索…",
    "mp.manage": "モデルを管理",
    "mp.unreachable": "一覧取得失敗",
    "msg.copy": "回答をコピー",
    "msg.thinking": "思考",
    "send.enter": "送信 (Enter)",
    "send.ctrlEnter": "送信 (Ctrl+Enter)",
    "send.stop": "停止 (Enter)",
    "composer.phEnter": "何でも聞いてください (Enter で送信 / Shift+Enter で改行)",
    "composer.phCtrl": "何でも聞いてください (Ctrl+Enter で送信 / Enter で改行)",
    "drawer.inbox": "承認インボックス",
    "drawer.status": "システム状態",
    "drawer.info": "セッション情報",
    "settings.title": "設定",
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
    "toast.dropAttach": "ドロップで添付しました: {0}",
    "toast.attachFailed": "添付ファイルのパスを取得できませんでした: {0}",
    "toast.stopRequested": "停止を要求しました…",
    "toast.effortSet": "エフォート: {0}",
    "toast.effortNext": "エフォート: {0} (次のセッションから適用)",
    "chip.effort": "推論エフォート",
    "effort.default": "既定",
    "effort.defaultDesc": "エフォートなし (プロバイダ既定)",
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
    "home.title": "まだメッセージがありません",
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
    "set.tabToggleDesc": "Build / Plan を Tab キーで切り替えます(メッセージ入力中も有効)",
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
    "sc.tab": "Build / Plan を切替",
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
    "cmd.plan": "Plan モードへ切替",
    "cmd.build": "Build モードへ切替",
    "cmd.export": "Markdown で出力",
    "cmd.retry": "直前のターンを再実行",
    "cmd.settings": "設定を開く",
    "cmd.search": "トランスクリプト内検索",
    "top.todo": "タスク (todo)",
    "drawer.todo": "タスク (todo)",
    "todo.empty": "タスクはありません。エージェントに「TODO: ...」形式で依頼するとここに表示されます",
    "todo.pending": "未着手",
    "todo.in_progress": "進行中",
    "todo.done": "完了",
    "tool.diff": "変更差分",
    "toast.cwdSet": "作業フォルダー: {0}",
    "toast.cwdFailed": "フォルダーを変更できませんでした: {0}",
    "prov.badUrl": "エンドポイントは http:// か https:// で始めてください",
    "prov.default": "既定",
    "prov.keyOk": "キー ✓",
    "prov.keyMissing": "キー未設定",
    "prov.none": "(なし)",
    "ext.mcp": "MCP サーバー",
    "ext.mcpDesc": "mcp.status より(n. = そのサーバーの公開ツール数)。設定は config.yaml の mcp.servers です。",
    "ext.lsp": "LSP サーバー",
    "ext.skills": "スキル (Skills)",
    "ext.skillsDesc": "~/.familiar/skills/<名前>/SKILL.md。チャットで「〜するスキルを作って」と依頼すると skill_manage ツールが提案を作り、承認後に有効になります。",
    "ext.noSkills": "スキルはまだありません",
    "ext.skillUses": "使用 {0} 回 · {1} 文字",
    "ext.lspDesc": "lsp_diagnostics が使用する言語サーバー。設定は config.yaml の lsp.servers です。",
    "ext.enabled": "有効",
    "ext.disabled": "無効",
    "ext.tools": "{0} ツール",
    "sys.desc": "カレーター(自己改善 cron)とスケジューラの現在状態。詳細はステータスドロワー、設定は config.yaml です。",
  },
  en: {
    "side.newSession": "New session",
    "side.filterPh": "filter sessions…  (Ctrl+K)",
    "side.settings": "⚙ Settings",
    "top.inbox": "approvals",
    "top.status": "status",
    "del.confirm": "delete session \"{0}\"? this cannot be undone",
    "none": "(none)",
    "top.noSession": "no session",
    "top.gaugeTitle": "context usage — click for session info",
    "top.gaugeNoTurn": "context usage — shown after the next turn is sent",
    "side.noFolder": "no folder",
    "chip.ctx": "context usage",
    "update.available": "Update available — v{0} (apply from ⬇)",
    "update.downloading": "Downloading the update…",
    "update.applied": "v{0} applied — press ↻ to restart",
    "update.restartTitle": "Restart to apply v{0}",
    "update.uptodate": "Up to date (v{0})",
    "update.failed": "Update failed: {0}",
    "update.cliHint": "Browser builds update via `familiar update`",
    "menu.updateCheck": "Check for updates",
    "top.pane": "side pane",
    "pane.inbox": "approvals",
    "pane.todo": "tasks",
    "pane.status": "status",
    "pane.info": "info",
    "pane.ctx": "context",
    "notify.approvalTitle": "Familiar Harness — approval needed",
    "notify.turnDone": "Familiar Harness — turn completed",
    "notify.turnFailed": "Familiar Harness — turn failed",
    "notify.turnFailed": "turn failed",
    "ctx.used": "used",
    "ctx.window": "window",
    "ctx.free": "free",
    "ctx.noteNoTurn": "Shown after the first turn is sent (each turn re-sends the full context, so the last prompt = the current context)",
    "ctx.noteNoWindow": "This model's context window is unknown (not exposed by the model list)",
    "ctx.noteHint": "{0} / {1} tok used",
    "ns.title": "New session",
    "ns.search": "search or type a folder… (e.g. ~/work)",
    "ns.pickFolder": "Pick a working folder",
    "ns.create": "Create",
    "ns.noRecent": "No recent folders yet — type a path above",
    "ns.noMatch": "No matching folders",
    "ns.sessions": "{0} sessions",
    "ns.errNoFolder": "Pick or type a working folder first",
    "top.search": "search in transcript (Ctrl+F)",
    "top.sessionActions": "session actions",
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
    "chip.mode": "agent mode",
    "chip.model": "model for this session",
    "mode.build": "Build",
    "mode.buildDesc": "full tool access",
    "mode.plan": "Plan",
    "mode.planDesc": "read-only tools",
    "chip.modelLabel": "model",
    "mp.search": "Search models…",
    "mp.manage": "Manage models",
    "mp.unreachable": "unreachable",
    "msg.copy": "Copy answer",
    "msg.thinking": "Thinking",
    "send.enter": "send (Enter)",
    "send.ctrlEnter": "send (Ctrl+Enter)",
    "send.stop": "stop (Enter)",
    "composer.phEnter": "Ask anything… (Enter to send / Shift+Enter for a new line)",
    "composer.phCtrl": "Ask anything… (Ctrl+Enter to send / Enter for a new line)",
    "drawer.inbox": "approval inbox",
    "drawer.status": "system status",
    "drawer.info": "session info",
    "settings.title": "Settings",
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
    "toast.dropAttach": "attached via drop: {0}",
    "toast.attachFailed": "could not resolve a file path: {0}",
    "toast.stopRequested": "stop requested…",
    "toast.effortSet": "effort: {0}",
    "toast.effortNext": "effort: {0} (applies from the next session)",
    "chip.effort": "reasoning effort",
    "effort.default": "default",
    "effort.defaultDesc": "no effort (provider default)",
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
    "home.title": "No messages yet",
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
    "set.tabToggleDesc": "Toggle Build / Plan with the Tab key (also while typing)",
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
    "sc.tab": "toggle Build / Plan",
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
    "cmd.plan": "switch to Plan mode",
    "cmd.build": "switch to Build mode",
    "cmd.export": "export as markdown",
    "cmd.retry": "retry the last turn",
    "cmd.settings": "open settings",
    "cmd.search": "search the transcript",
    "top.todo": "tasks (todo)",
    "drawer.todo": "tasks (todo)",
    "todo.empty": "no tasks yet — ask the agent with a \"TODO: …\" list and it shows up here",
    "todo.pending": "pending",
    "todo.in_progress": "in progress",
    "todo.done": "done",
    "tool.diff": "changes",
    "toast.cwdSet": "working folder: {0}",
    "toast.cwdFailed": "could not change folder: {0}",
    "prov.badUrl": "endpoint must start with http:// or https://",
    "prov.default": "default",
    "prov.keyOk": "key ✓",
    "prov.keyMissing": "key missing",
    "prov.none": "(none)",
    "ext.mcp": "MCP servers",
    "ext.mcpDesc": "from mcp.status (n. = tools exposed by that server). Configure in config.yaml [mcp.servers].",
    "ext.lsp": "LSP servers",
    "ext.skills": "Skills",
    "ext.skillsDesc": "~/.familiar/skills/<name>/SKILL.md. Ask in chat to create one — the skill_manage tool stages a proposal that activates after approval.",
    "ext.noSkills": "no skills yet",
    "ext.skillUses": "used {0}× · {1} chars",
    "ext.lspDesc": "language servers used by lsp_diagnostics. Configure in config.yaml [lsp.servers].",
    "ext.enabled": "enabled",
    "ext.disabled": "disabled",
    "ext.tools": "{0} tools",
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
  $("#mode-chip").textContent = `${t(state.mode === "plan" ? "mode.plan" : "mode.build")} ▾`;
  renderEffortChip();
  if (state.modelChipDefault) {
    $("#model-chip").textContent = `${t("chip.modelLabel")} ▾`;
  }
}

/** Composer placeholder reflects the send-key preference. */
function applyComposerPlaceholder() {
  $("#input").placeholder = prefs.sendWithEnter ? t("composer.phEnter") : t("composer.phCtrl");
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
  pendingToolCards: [], // live tool.call cards awaiting their result
  turnStartedAt: null,
  turnTimer: null,
  lastElapsed: null,
  /** live assistant bubbles of the running turn (thinking collapse + footer). */
  turnBubbles: [],
  mode: "build", // "build" | "plan" — passed per send (plan => read-only tools)
  /** pending provider/model/effort change before the next turn (applied + persisted). */
  draft: { provider: "", model: "", effort: "" },
  /** tokens seen this browsing session, per session id (turn.end events). */
  usageBySession: {},
  /** last turn's prompt tokens per session ≈ current context size. */
  lastPromptTokensBySession: {},
  /** cached context window sizes (provider/model → tokens|null). */
  modelCtxCache: {},
  toolCounter: 0,
  /** true while the model chip shows the localized placeholder (no selection). */
  modelChipDefault: true,
  /** last user message text, used by the retry button (Hermes /retry). */
  lastUserText: "",
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
const KNOWN_PROVIDERS = [
  { id: "openai", label: "OpenAI", kind: "openai_compatible", base_url: "https://api.openai.com/v1", color: "#10a37f", env: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", base_url: "https://api.anthropic.com/v1", color: "#d97757", env: "ANTHROPIC_API_KEY" },
  { id: "google", label: "Google Gemini", kind: "openai_compatible", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", color: "#4285f4", env: "GEMINI_API_KEY" },
  { id: "nvidia", label: "NVIDIA", kind: "openai_compatible", base_url: "https://integrate.api.nvidia.com/v1", color: "#76b900", env: "NVIDIA_API_KEY" },
  { id: "openrouter", label: "OpenRouter", kind: "openai_compatible", base_url: "https://openrouter.ai/api/v1", color: "#8083f2", env: "OPENROUTER_API_KEY" },
  { id: "ollama", label: "Ollama", kind: "openai_compatible", base_url: "http://127.0.0.1:11434/v1", color: "#e5e5e5", env: null },
];

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
  "One Dark": {
    dark: { bg: "#282c34", panel: "#21252b", panel2: "#2f343e", text: "#d7dae0", dim: "#636d83", accent: "#61afef", ok: "#98c379", warn: "#d19a66", err: "#e06c75", border: "#3e4451", bubble: "#4c78cc", hover: "#373c46", codebg: "#232730" },
    light: { bg: "#f2f3f5", panel: "#fafbfc", panel2: "#ffffff", text: "#383a42", dim: "#82899a", accent: "#4078f2", ok: "#50a14f", warn: "#c18401", err: "#e45649", border: "#dcdfe4", bubble: "#4078f2", hover: "#e8eaed", codebg: "#f4f5f7" },
  },
  Oxocarbon: {
    dark: { bg: "#161616", panel: "#1c1c1e", panel2: "#26262b", text: "#f2f4f8", dim: "#8d8d93", accent: "#78a9ff", ok: "#42be65", warn: "#f1c21b", err: "#fa4d56", border: "#343439", bubble: "#5a66d6", hover: "#26262a", codebg: "#131316" },
    light: { bg: "#f4f4f4", panel: "#fafafa", panel2: "#ffffff", text: "#161616", dim: "#525252", accent: "#0f62fe", ok: "#24a148", warn: "#bf8b00", err: "#da1e28", border: "#d0d0d3", bubble: "#0f62fe", hover: "#e8e8ea", codebg: "#f0f0f2" },
  },
};

const DEFAULT_THEME = "Tokyo Night";

function currentThemeName() {
  return localStorage.getItem("familiar.theme") ?? DEFAULT_THEME;
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
  const when = fmtTime(s.updatedAt);
  li.innerHTML =
    `<div class="row-line"><span class="t">${esc(title)}</span>` +
    `<button class="del" data-id="${esc(s.id)}" title="delete session">✕</button></div>` +
    `<span class="when" title="${esc(when)}">${esc(relTime(s.updatedAt))} · ${esc(s.provider)}${esc(model)}</span>`;
  if (s.id === state.sessionId) li.classList.add("active");
  return li;
}

async function refreshSessions() {
  state.sessions = await rpc("session.list");
  const ul = $("#sessions");
  ul.innerHTML = "";
  // Claude-desktop-style grouping: one collapsible folder (cwd) section,
  // newest folder first, newest session first within the folder.
  const groups = new Map();
  for (const s of state.sessions) {
    const key = s.cwd || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) =>
      Math.max(...b[1].map((x) => x.updatedAt ?? 0)) - Math.max(...a[1].map((x) => x.updatedAt ?? 0)),
  );
  const folds = loadFolderFolds();
  for (const [cwd, list] of sorted) {
    list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const collapsed = folds[cwd] === true;
    const head = document.createElement("li");
    head.className = "folder-row";
    head.dataset.cwd = cwd;
    head.title = cwd || t("side.noFolder");
    head.innerHTML =
      `<button class="folder-toggle" type="button">` +
      `<span class="chev">${collapsed ? "▸" : "▾"}</span>` +
      `<span class="fname">📁 ${esc(baseName(cwd) || t("side.noFolder"))}</span>` +
      `<span class="fcount">${list.length}</span></button>`;
    ul.appendChild(head);
    if (!collapsed) {
      for (const s of list) ul.appendChild(sessionLi(s));
    }
  }
  applySessionFilter();
  if (!state.sessionId && state.sessions.length > 0) {
    await openSession(state.sessions[0].id);
  }
}

function esc(text) {
  return escapeHtml(text);
}

function applySessionFilter() {
  const query = ($("#session-filter").value || "").trim().toLowerCase();
  let visible = 0;
  const matchesQuery = (s) => {
    if (query === "") return true;
    const hay = `${s.title ?? ""} ${s.provider ?? ""} ${s.model ?? ""}`.toLowerCase();
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
    const matches = state.sessions.filter((s) => (s.cwd || "") === row.dataset.cwd && matchesQuery(s));
    row.classList.toggle("filtered", query !== "" && matches.length === 0);
    if (query !== "" && matches.length > 0) {
      const chev = row.querySelector(".chev");
      if (chev && chev.textContent === "▸") row.querySelector(".folder-toggle")?.click();
    }
  }
  let none = document.querySelector("#sessions .filter-none");
  if (visible === 0 && state.sessions.length > 0) {
    if (!none) {
      none = document.createElement("li");
      none.className = "filter-none";
      none.textContent = "no matching sessions";
      $("#sessions").appendChild(none);
    }
  } else {
    if (none) none.remove();
  }
}

function toggleFolderFold(row) {
  const cwd = row.dataset.cwd;
  const folds = loadFolderFolds();
  folds[cwd] = !folds[cwd];
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
  if (used !== undefined && win === undefined && state.currentSession) {
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
  const win = state.modelCtxCache[`${state.currentSession?.provider}/${state.currentSession?.model}`];
  return { used, win };
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
    const pct = Math.min(1, used / win);
    const c = 2 * Math.PI * 8;
    bar.style.strokeDasharray = `${c}`;
    bar.style.strokeDashoffset = `${c * (1 - pct)}`;
    if (textEl) textEl.textContent = `${Math.round(pct * 100)}%`;
  } else {
    bar.style.strokeDashoffset = `${2 * Math.PI * 8 * 0.5}`;
    if (textEl) textEl.textContent = formatTokens(used);
  }
}

function renderTopbarGauge() {
  const btn = $("#ctx-gauge");
  const { used, win } = ctxNumbers();
  setGaugeSvg(btn.querySelector("svg"), used, win);
  const pctEl = $("#gauge-pct");
  if (used === undefined) {
    pctEl.textContent = "—";
    btn.title = t("top.gaugeNoTurn");
    return;
  }
  if (win) {
    const pct = Math.round((used / win) * 100);
    pctEl.textContent = `${pct}%`;
    btn.title = `${t("chip.ctx")}: ${formatTokens(used)} / ${formatTokens(win)} tok (${pct}%)`;
  } else {
    pctEl.textContent = formatTokens(used);
    btn.title = `${t("chip.ctx")}: ${formatTokens(used)} tok`;
  }
}

/** The composer gauge + its pane (context usage details). */
function renderCtxPane() {
  const { used, win } = ctxNumbers();
  const btnSvg = $("#ctx-btn").querySelector("svg");
  const popSvg = $("#ctx-pop").querySelector("svg");
  setGaugeSvg(btnSvg, used, win);
  setGaugeSvg(popSvg, used, win);
  $("#ctx-used").textContent = used === undefined ? "—" : `${formatTokens(used)} tok`;
  $("#ctx-window").textContent = win ? `${formatTokens(win)} tok` : t("info.unknown");
  $("#ctx-free").textContent =
    used === undefined ? "—" : win ? `${formatTokens(Math.max(0, win - used))} tok` : "—";
  $("#ctx-head-pct").textContent =
    used === undefined ? "—" : win ? `${Math.round((used / win) * 100)}%` : `${formatTokens(used)} tok`;
  const s = state.currentSession;
  $("#ctx-head-model").textContent = s ? `${s.provider}/${s.model}` : "";
  const note = $("#ctx-note");
  if (used === undefined) {
    note.textContent = t("ctx.noteNoTurn");
  } else if (!win) {
    note.textContent = t("ctx.noteNoWindow");
  } else {
    note.textContent = t("ctx.noteHint", formatTokens(used), formatTokens(win));
  }
}

/** The context tab inside the right pane (same numbers, card layout). */
function renderCtxPaneBody() {
  const body = $("#ctx-pane-body");
  if (!body) return;
  const { used, win } = ctxNumbers();
  const s = state.currentSession;
  body.innerHTML = "";
  const pct = used === undefined ? null : win ? Math.round((used / win) * 100) : null;
  body.appendChild(sectionCard(t("chip.ctx"), [
    [t("ctx.used"), used === undefined ? t("info.unknown") : `${formatTokens(used)} tok`],
    [t("ctx.window"), win ? `${formatTokens(win)} tok` : t("info.unknown")],
    [t("ctx.free"), used === undefined || !win ? "—" : `${formatTokens(Math.max(0, win - used))} tok`],
    ["%", pct === null ? "—" : `${pct}%`],
    ["model", s ? `${s.provider}/${s.model}` : "—"],
  ], pct === null ? undefined : `${pct}%`));
  const note = document.createElement("div");
  note.className = "ctx-note";
  if (used === undefined) note.textContent = t("ctx.noteNoTurn");
  else if (!win) note.textContent = t("ctx.noteNoWindow");
  else note.textContent = t("ctx.noteHint", formatTokens(used), formatTokens(win));
  body.appendChild(note);
}

async function contextWindowFor(provider, model) {
  const key = `${provider}/${model}`;
  if (!(key in state.modelCtxCache)) {
    try {
      const res = await rpc("models.list", { provider });
      const list = res.models ?? [];
      const info = list.find((m) => m.id === model) ?? list.find((m) => Boolean(m.contextTokens));
      state.modelCtxCache[key] = info?.contextTokens ?? null;
    } catch {
      state.modelCtxCache[key] = null;
    }
  }
  return state.modelCtxCache[key];
}

async function openSession(id) {
  state.sessionId = id;
  state.pendingEvents.delete(id);
  for (const li of document.querySelectorAll("#sessions li")) {
    li.classList.toggle("active", li.dataset.id === id);
  }
  const data = await rpc("session.get", { id });
  const s = data.session;
  state.currentSession = s;
  $("#session-title").textContent = s.title || s.id.slice(0, 8);
  const bits = [s.provider];
  if (s.model) bits.push(s.model);
  if (s.profile) bits.push(`profile: ${s.profile}`);
  $("#session-meta").textContent = bits.join(" · ");
  renderSessionCwd(s);
  renderModelChip();
  renderEffortChip();
  void refreshTodo();
  updateContextGauge();
  closeAllPops();
  renderTranscript(data.messages ?? []);
  applyTranscriptFilter();
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
  // native folder dialog is only available inside the Electron shell
  $("#cwd-browse").hidden = typeof window.familiarDesktop?.pickDirectory !== "function";
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
    res = await rpc("fs.dirs", { path: dir });
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
  const v = $("#cwd-input").value.trim();
  const errBox = $("#cwd-overlay .form-error");
  if (!s || v === "") return;
  try {
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
  const t = $("#transcript");
  t.innerHTML = "";
  state.pendingToolCards = [];
  state.toolCounter = 0;
  const visible = messages.filter((m) => m.meta?.ephemeral !== true);
  if (visible.length === 0) {
    t.appendChild(emptyStateNode());
    return;
  }
  const cur = state.currentSession;
  const modelBits = [cur?.provider, cur?.model].filter(Boolean).join("/");
  for (const m of visible) {
    if (m.role === "user") {
      appendMessage("user", m.content, null);
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
    <div class="glyph">◍</div>
    <h3>${esc(t("home.title"))}</h3>
    <div class="hint">${esc(t("home.hint"))}</div>`;
  return div;
}

/** User / assistant bubbles. opts: { reasoning, footBits, foot } */
function appendMessage(role, content, toolCalls, opts = {}) {
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
    wireCodeButtons(div);
  } else {
    bubble.textContent = content ?? "";
  }
  void toolCalls;
  tr.appendChild(div);
  scrollBottom();
  return bubble;
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

function wireCodeButtons(scope) {
  for (const btn of scope.querySelectorAll("button.code-copy:not([data-wired])")) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const code = btn.closest(".codeblock")?.querySelector("pre code");
      void copyText(code?.textContent ?? "").then((ok) => {
        btn.textContent = ok ? "✓" : "✕";
        setTimeout(() => (btn.textContent = "⧉"), 1200);
      });
    });
  }
  for (const btn of scope.querySelectorAll("button.code-expand:not([data-wired])")) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const block = btn.closest(".codeblock");
      block.classList.toggle("collapsed");
      btn.textContent = block.classList.contains("collapsed") ? "show all" : "collapse";
    });
  }
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
  { cmd: "/build", key: "cmd.build", run: () => setMode("build") },
  { cmd: "/export", key: "cmd.export", run: () => void exportMarkdown() },
  { cmd: "/retry", key: "cmd.retry", run: () => retryLastTurn() },
  { cmd: "/settings", key: "cmd.settings", run: () => openSettingsModal() },
  { cmd: "/search", key: "cmd.search", run: () => toggleSearch() },
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
    res = await rpc("fs.suggest", { prefix: token, cwd: state.currentSession?.cwd ?? "" });
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
  const t = $("#transcript");
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
  const expanded = prefs.toolsExpanded === true && status !== "run";
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
  wrap.querySelector(".tc-toggle").addEventListener("click", () => {
    const body = wrap.querySelector(".tc-body");
    body.hidden = !body.hidden;
    wrap.classList.toggle("open", !body.hidden);
  });
  t.appendChild(wrap);
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
  const t = $("#transcript");
  const near = t.scrollHeight - t.scrollTop - t.clientHeight < 240;
  if (force || near) t.scrollTop = t.scrollHeight;
}

// live streaming: one bubble per assistant step for the active session
function liveBubble(sessionId) {
  if (sessionId !== state.sessionId) return null;
  let entry = state.pendingEvents.get(sessionId);
  if (!entry) {
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
  const busy = state.busy === true;
  send.classList.toggle("stop", busy);
  send.textContent = busy ? "■" : (send.dataset.iconIdle ?? "↑");
  send.title = busy ? t("send.stop") : (prefs.sendWithEnter ? t("send.enter") : t("send.ctrlEnter"));
}

/** Abort the running turn of the current session. */
async function stopTurn() {
  if (!state.busy || !state.sessionId) return;
  try {
    toast(t("toast.stopRequested"), "info");
    await rpc("session.abort", { id: state.sessionId });
  } catch (err) {
    toast(t("toast.sendFailed", err.message), "err");
  }
}

function setBusy(busy) {
  state.busy = busy;
  $("#send").disabled = false; // the send button doubles as the stop button
  $("#input").disabled = busy;
  $("#turn-spinner").hidden = !busy;
  refreshSendButton();
  if (busy) {
    state.turnStartedAt = Date.now();
    if (state.turnTimer) clearInterval(state.turnTimer);
    state.turnTimer = setInterval(() => {
      const s = ((Date.now() - state.turnStartedAt) / 1000).toFixed(1);
      $("#turn-label").textContent = `working… ${s}s`;
    }, 100);
  } else {
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
  }
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
  const retry = () => setTimeout(connectEvents, 1500);
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
    onEvent(frame.sessionId, frame.event);
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
  if (sessionId !== state.sessionId) return;

  switch (e.type) {
    case "turn.start":
      state.turnBubbles = [];
      setBusy(true);
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
          det.className = "thinking";
          det.open = true;
          det.innerHTML = `<summary>◌ ${esc(t("msg.thinking"))}</summary><pre class="th-text"></pre>`;
          live.bubble.insertBefore(det, live.contentEl);
          live.reasoningEl = det.querySelector(".th-text");
          live.thinkingEl = det;
        }
        live.reasoning += e.text;
        live.reasoningEl.textContent = live.reasoning;
        scrollBottom();
      }
      break;
    }
    case "tool.call": {
      state.pendingEvents.delete(sessionId);
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
      rec.prompt += u.promptTokens ?? 0;
      rec.completion += u.completionTokens ?? 0;
      state.usageBySession[sessionId] = rec;
      if (u.promptTokens !== undefined) {
        state.lastPromptTokensBySession[sessionId] = u.promptTokens;
      }
      setBusy(false);
      const secs = parseFloat(state.lastElapsed ?? "") || 0;
      const hasUsage = u.promptTokens !== undefined;
      let completion = u.completionTokens ?? 0;
      if (!hasUsage) {
        // provider gave no usage (e.g. stream_options rejected): estimate from
        // the streamed text so the speed readout still works
        const all = state.turnBubbles.map((b) => b.text ?? "").join("");
        completion = estimateTokens(all);
      }
      const tps = secs > 0 && completion > 0 ? Math.round(completion / secs) : 0;
      const approx = hasUsage ? "" : "≈";
      const toks = hasUsage
        ? ` · ↑${u.promptTokens} ↓${u.completionTokens ?? 0} tok${tps ? ` (${tps} tok/s)` : ""}`
        : completion > 0
          ? ` · ↓${approx}${completion} tok${tps ? ` (${approx}${tps} tok/s)` : ""}`
          : "";
      setTurnEndLabel(t("turn.done", `${state.lastElapsed ?? ""}${toks}`));
      // collapse thinking blocks, stop carets; footer on the last bubble
      for (const b of state.turnBubbles) {
        if (b.thinkingEl) b.thinkingEl.open = false;
        if (b.caret) b.caret.remove();
      }
      const lastBubble = state.turnBubbles[state.turnBubbles.length - 1];
      if (lastBubble) {
        const s = state.currentSession;
        const bits = [t(state.mode === "plan" ? "mode.plan" : "mode.build")];
        const modelBits = [s?.provider, s?.model].filter(Boolean).join("/");
        if (modelBits) bits.push(modelBits);
        if (secs > 0) bits.push(`${secs.toFixed(1)}s`);
        if (tps) bits.push(`${approx}${tps} tok/s`);
        bits.push(fmtClock(Date.now()));
        addMsgFooter(lastBubble.bubble, lastBubble.text, bits);
      }
      state.turnBubbles = [];
      void refreshTodo();
      updateContextGauge();
      maybeNotify();
      state.pendingEvents.delete(sessionId);
      refreshSessions();
      loadInbox();
      break;
    }
    case "turn.error":
      setBusy(false);
      for (const b of state.turnBubbles) if (b.caret) b.caret.remove();
      state.turnBubbles = [];
      appendMessage("assistant", `⚠ ${e.error}`, null);
      void notifyDesktop(t("notify.turnFailed"), String(e.error ?? "").slice(0, 140), { urgent: true });
      break;
    case "turn.aborted":
      setBusy(false);
      for (const b of state.turnBubbles) if (b.caret) b.caret.remove();
      state.turnBubbles = [];
      setTurnEndLabel(t("turn.stopped"));
      void refreshTodo();
      refreshSessions();
      break;
    case "improvement.staged":
      loadInbox();
      break;
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
// approval inbox (self-improvement writes)
// ---------------------------------------------------------------------------
async function loadInbox() {
  let count = 0;
  const body = $("#inbox-body");
  const open = !$("#inbox").hidden;
  body.innerHTML = "";
  try {
    const mem = await rpc("memory.pending");
    for (const item of mem.items ?? []) {
      count += 1;
      body.appendChild(proposalNode("memory", item, async (approved) => {
        await rpc(approved ? "memory.approve" : "memory.reject", { id: item.id });
        await loadInbox();
      }));
    }
    const skills = await rpc("skills.pending");
    for (const item of skills.items ?? []) {
      count += 1;
      body.appendChild(proposalNode("skill", item, async (approved) => {
        if (approved) {
          await rpc("skills.approve", { prefix: item.id });
        } else {
          await rpc("skills.reject", { prefix: item.id });
        }
        await loadInbox();
      }));
    }
  } catch (err) {
    body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    toast(t("toast.inboxUnavailable", err.message), "err");
  }
  if (count === 0 && open) {
    body.innerHTML = `<div class="empty">${esc(t("inbox.empty"))}</div>`;
  }
  $("#inbox-count").textContent = count > 0 ? String(count) : "";
}

function proposalNode(kind, item, act) {
  const node = document.createElement("div");
  node.className = "proposal";
  const reason = item.reason ? `<div class="reason">${esc(item.reason)}</div>` : "";
  const warns = Array.isArray(item.warnings) && item.warnings.length > 0
    ? `<div class="reason">⚠ ${esc(item.warnings.join("; "))}</div>`
    : "";
  node.innerHTML = `
    <div class="kind">${esc(kind)} · ${esc(item.kind)} · ${esc(item.id)}</div>
    <div class="summary">${esc(item.summary)}</div>
    ${reason}${warns}
    <div class="row">
      <button data-act="approve">${esc(t("approval.approve"))}</button>
      <button class="ghost" data-act="reject">${esc(t("approval.denyShort"))}</button>
    </div>`;
  node.querySelector('button[data-act="approve"]').addEventListener("click", () => act(true, node));
  node.querySelector('button[data-act="reject"]').addEventListener("click", () => act(false, node));
  return node;
}

// ---------------------------------------------------------------------------
// status drawer (curator / MCP / cron)
// ---------------------------------------------------------------------------
const PANE_TABS = ["inbox", "todo", "status", "session-info", "ctx"];

function showPane(which) {
  $("#rightpane").hidden = false;
  for (const id of PANE_TABS) {
    $(`#${id}`).hidden = id !== which;
  }
  for (const b of document.querySelectorAll(".pane-tabs [data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === which);
  }
  localStorage.setItem("familiar.paneTab", which);
  if (which === "inbox") void loadInbox();
  if (which === "status") void loadStatus();
  if (which === "todo") void loadTodo();
  if (which === "session-info") void loadSessionInfo();
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
    showPane(PANE_TABS.includes(last) ? last : "inbox");
  } else {
    closePane();
  }
}

function openDrawer(which) {
  if (which === "none") {
    closePane();
    return;
  }
  showPane(which);
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

const TODO_STATUS = {
  pending: { icon: "○", label: "todo.pending", cls: "td-pending" },
  in_progress: { icon: "◐", label: "todo.in_progress", cls: "td-active" },
  done: { icon: "●", label: "todo.done", cls: "td-done" },
};

async function loadTodo() {
  const body = $("#todo-body");
  body.innerHTML = "";
  if (!state.sessionId) {
    body.innerHTML = `<div class="mp-note">${esc(t("home.noSession"))}</div>`;
    updateTodoBadge([]);
    return;
  }
  try {
    const res = await rpc("todo.list", { id: state.sessionId });
    const items = res.items ?? [];
    updateTodoBadge(items);
    if (items.length === 0) {
      body.innerHTML = `<div class="mp-note">${esc(t("todo.empty"))}</div>`;
      return;
    }
    for (const it of items) {
      const meta = TODO_STATUS[it.status] ?? { icon: "○", label: "todo.pending", cls: "td-pending" };
      const row = document.createElement("div");
      row.className = `todo-row ${meta.cls}`;
      row.innerHTML =
        `<span class="td-icon">${esc(meta.icon)}</span>` +
        `<span class="td-text">${esc(it.title ?? "")}</span>` +
        `<span class="td-status">${esc(t(meta.label))}</span>`;
      body.appendChild(row);
    }
  } catch (err) {
    body.innerHTML = `<div class="mp-note">${esc(err.message)}</div>`;
  }
}

/** Top-bar badge = number of in-progress tasks. */
function updateTodoBadge(items) {
  const n = (items ?? []).filter((x) => x && x.status === "in_progress").length;
  $("#todo-count").textContent = n > 0 ? String(n) : "";
}

/** Refresh the badge (cheap); reload the drawer body only when it is open. */
async function refreshTodo() {
  if (!state.sessionId) {
    updateTodoBadge([]);
    return;
  }
  try {
    const res = await rpc("todo.list", { id: state.sessionId });
    updateTodoBadge(res.items ?? []);
    if (!$("#todo").hidden) void loadTodo();
  } catch {
    /* session dropped */
  }
}

async function loadStatus() {
  const body = $("#status-body");
  body.innerHTML = "";
  try {
    const res = await rpc("curator.status");
    const c = res.curator ?? {};
    body.appendChild(sectionCard("curator", [
      [t("stat.state"), `${c.enabled ? t("stat.enabled") : t("stat.disabled")}${c.paused ? " · " + t("stat.paused") : ""}`],
      [t("stat.lastRun"), `${fmtTime(c.lastRunAt)}${c.lastRunAt ? ` (${relTime(c.lastRunAt)})` : ""}`],
      [t("stat.nextDue"), fmtTime(c.nextDueAt)],
      [t("stat.stale"), (c.stale ?? []).join(", ") || "—"],
      [t("stat.archived"), `${(c.archived ?? []).length} (${t("stat.snapshots")}: ${c.snapshots ?? 0})`],
      [t("stat.consolidation"), c.consolidate ? t("stat.enabled") : t("stat.disabled")],
    ]));
  } catch (err) {
    body.appendChild(sectionError("curator", err));
  }
  try {
    const res = await rpc("mcp.status");
    const servers = res.servers ?? [];
    const rows = servers.map((sv) => [
      sv.name ?? "(unknown)",
      `${sv.state ?? "?"} · ${(sv.tools ?? []).length} tools${sv.error ? " · " + sv.error : ""}`,
    ]);
    body.appendChild(sectionCard("mcp servers", rows.length > 0 ? rows : [["—", t("stat.noServers")]]));
  } catch (err) {
    body.appendChild(sectionError("mcp servers", err));
  }
  try {
    const res = await rpc("cron.status");
    const jobs = res.jobs ?? [];
    const rows = jobs.map((j) => [
      j.name ?? "(unnamed)",
      j.enabled === false ? t("stat.disabled") : t("stat.everyMinutes", j.every_minutes),
    ]);
    body.appendChild(sectionCard("cron scheduler", rows.length > 0 ? rows : [["—", t("stat.noJobs")]], res.started ? t("stat.running") : t("stat.stopped")));
  } catch (err) {
    body.appendChild(sectionError("cron scheduler", err));
  }
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
};

const FONT_SIZES = { s: "13px", m: "14px", l: "15.5px", xl: "17px" };
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
  { id: "general", label: "一般", icon: "⚙" },
  { id: "appearance", label: "外観", icon: "◧" },
  { id: "transcript", label: "トランスクリプト", icon: "▤" },
  { id: "shortcuts", label: "ショートカット", icon: "⌘" },
  { id: "providers", label: "プロバイダー", icon: "▣" },
  { id: "extensions", label: "拡張機能", icon: "↯" },
  { id: "system", label: "システム", icon: "🖥" },
];
let settingsSection = "general";

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
    item.innerHTML = `<span class="ni">${esc(s.icon)}</span>${esc(s.label)}`;
    item.addEventListener("click", () => {
      settingsSection = s.id;
      renderSettingsNav();
      renderSettingsSection(s.id);
    });
    nav.appendChild(item);
  }
}

function renderSettingsSection(id) {
  const content = $("#settings-content");
  content.innerHTML = "";
  content.scrollTop = 0;
  if (id === "general") renderGeneralSection(content);
  else if (id === "appearance") renderAppearanceSection(content);
  else if (id === "transcript") renderTranscriptSection(content);
  else if (id === "shortcuts") renderShortcutsSection(content);
  else if (id === "providers") void renderProvidersSection(content);
  else if (id === "extensions") void renderExtensionsSection(content);
  else if (id === "system") void renderSystemSection(content);
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
      setLang(value);
      renderSettingsSection("general");
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
  const c = card(t("set.colors"), t("set.appearanceDesc"));
  const modeRow = document.createElement("div");
  modeRow.className = "select-row";
  modeRow.appendChild(
    selectControl(
      [[t("set.light"), "light"], [t("set.dark"), "dark"], [t("set.system"), "system"]],
      pref,
      (value) => {
        setModePref(value);
        renderSettingsSection("appearance");
      },
    ),
  );
  c.appendChild(modeRow);

  const grid = document.createElement("div");
  grid.className = "theme-grid";
  const cur = currentThemeName();
  const eff = pref === "light" ? "light" : pref === "dark" ? "dark"
    : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  for (const [name, pal] of Object.entries(THEMES)) {
    const preview = pal[eff] ?? pal.dark;
    const sel = document.createElement("button");
    sel.type = "button";
    sel.className = `theme-card${name === cur ? " selected" : ""}`;
    sel.innerHTML = `
      <span class="sw" style="background:${preview.bg};border-color:${preview.border}">
        <i style="background:${preview.accent}"></i><i style="background:${preview.ok}"></i><i style="background:${preview.err}"></i>
      </span><span class="tname">${esc(name)}</span>`;
    sel.addEventListener("click", () => {
      setThemeName(name);
      renderSettingsSection("appearance");
      toast(t("toast.theme", name), "ok");
    });
    grid.appendChild(sel);
  }
  c.appendChild(grid);
  content.appendChild(c);

  const c2 = card(t("set.display"));
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
    savePrefs({ fontSize: "m", width: "normal" });
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
async function renderProvidersSection(content) {
  if (!(await ensureNsConfig())) return;
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
  content.appendChild(connHead);
  if (connected.length === 0) {
    const empty = document.createElement("div");
    empty.className = "proempty dim";
    empty.textContent = t("prov.noneConnected");
    content.appendChild(empty);
  }
  for (const name of connected) {
    const pc = ns.providers[name] ?? {};
    content.appendChild(providerCard(name, pc));
  }

  // ---- section 2: candidates ----
  const candHead = document.createElement("div");
  candHead.className = "provsec";
  candHead.innerHTML = `<b>${esc(t("prov.candidates"))}</b><span>${candidates.length}</span>`;
  content.appendChild(candHead);
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
    const isKnown = KNOWN_PROVIDERS.some((k) => k.id === name);
    const row = document.createElement("div");
    row.className = "provrow";
    const pc = candRows.get(name) ?? {};
    const k = pc.known ?? KNOWN_PROVIDERS.find((x) => x.id === name);
    const color = k?.color ?? "#8a8a94";
    const label = k?.label ?? name;
    const hint = pc.base_url ?? k?.base_url ?? "";
    const envRef = k?.env ? ` · ${k.env}` : "";
    row.innerHTML =
      `<span class="pdot" style="background:${esc(color)}"></span>` +
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
    content.appendChild(row);
  }

  // ---- custom provider (free form) ----
  if (providerOpen === "__new__") {
    const wrap = document.createElement("div");
    wrap.className = "provcard open";
    wrap.innerHTML = `<div class="provbody"></div>`;
    wrap.querySelector(".provbody").appendChild(providerForm("", null, true));
    content.appendChild(wrap);
  } else {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ghost small";
    add.textContent = t("prov.add");
    add.addEventListener("click", () => {
      providerOpen = "__new__";
      renderSettingsSection("providers");
    });
    content.appendChild(add);
  }
}

/** A collapsible card row for a connected provider (name + default badge). */
function providerCard(name, pc) {
  const wrap = document.createElement("div");
  wrap.className = `provcard${providerOpen === name ? " open" : ""}`;
  wrap.innerHTML = `
    <button class="provhead" type="button">
      <span class="pdot" style="background:${esc(KNOWN_PROVIDERS.find((k) => k.id === name)?.color ?? "#8a8a94")}"></span>
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

async function renderExtensionsSection(content) {
  // Skills (M3 self-improvement catalog)
  const skillCard = card(t("ext.skills"), t("ext.skillsDesc"));
  content.appendChild(skillCard);
  try {
    const res = await rpc("skills.list");
    const skills = res.skills ?? [];
    if (skills.length === 0) skillCard.appendChild(pairRow("—", t("ext.noSkills")));
    for (const sk of skills) {
      const meta = t("ext.skillUses", sk.useCount ?? 0, sk.bodyChars ?? 0);
      skillCard.appendChild(pairRow(sk.name, `${sk.description ?? ""}${sk.description ? " · " : ""}${meta}`));
    }
  } catch (err) {
    const row = document.createElement("div");
    row.className = "status-err";
    row.textContent = err.message;
    skillCard.appendChild(row);
  }
  // MCP servers
  const mcpCard = card(t("ext.mcp"), t("ext.mcpDesc"));
  content.appendChild(mcpCard);
  try {
    const res = await rpc("mcp.status");
    const servers = res.servers ?? [];
    if (servers.length === 0) {
      mcpCard.appendChild(pairRow("—", t("stat.noServers")));
    }
    for (const sv of servers) {
      mcpCard.appendChild(pairRow(sv.name ?? "(unknown)", `${sv.state ?? "?"} · ${t("ext.tools", (sv.tools ?? []).length)}${sv.error ? ` · ${sv.error}` : ""}`));
    }
  } catch (err) {
    const row = document.createElement("div");
    row.className = "status-err";
    row.textContent = err.message;
    mcpCard.appendChild(row);
  }
  // LSP servers (config.yaml lsp.servers)
  const lspCard = card(t("ext.lsp"), t("ext.lspDesc"));
  content.appendChild(lspCard);
  try {
    const cfg = await rpc("config.get");
    const lsp = cfg.lsp?.servers;
    const names = lsp && typeof lsp === "object" ? Object.keys(lsp) : [];
    if (names.length === 0) {
      lspCard.appendChild(pairRow("—", t("stat.noServers")));
    }
    for (const name of names) {
      const conf = lsp[name] ?? {};
      lspCard.appendChild(pairRow(
        name,
        `${conf.disabled ? t("ext.disabled") : t("ext.enabled")} · ${Array.isArray(conf.extensions) ? conf.extensions.join(", ") : "?"}`,
      ));
    }
  } catch (err) {
    const row = document.createElement("div");
    row.className = "status-err";
    row.textContent = err.message;
    lspCard.appendChild(row);
  }
}

function pairRow(k, v) {
  const row = document.createElement("div");
  row.className = "pair";
  row.innerHTML = `<span class="k">${esc(String(k))}</span><span class="v">${esc(String(v))}</span>`;
  return row;
}

async function renderSystemSection(content) {
  const hint = card(t("set.system"), t("sys.desc"));
  content.appendChild(hint);
  try {
    const res = await rpc("curator.status");
    const c = res.curator ?? {};
    content.appendChild(sectionCard("curator", [
      [t("stat.state"), `${c.enabled ? t("stat.enabled") : t("stat.disabled")}${c.paused ? " · " + t("stat.paused") : ""}`],
      [t("stat.lastRun"), `${fmtTime(c.lastRunAt)}${c.lastRunAt ? ` (${relTime(c.lastRunAt)})` : ""}`],
      [t("stat.nextDue"), fmtTime(c.nextDueAt)],
      [t("stat.stale"), (c.stale ?? []).join(", ") || "—"],
      [t("stat.archived"), `${(c.archived ?? []).length} (${t("stat.snapshots")}: ${c.snapshots ?? 0})`],
      [t("stat.consolidation"), c.consolidate ? t("stat.enabled") : t("stat.disabled")],
    ]));
  } catch (err) {
    content.appendChild(sectionError("curator", err));
  }
  try {
    const res = await rpc("cron.status");
    const jobs = res.jobs ?? [];
    content.appendChild(sectionCard(
      "cron scheduler",
      jobs.length > 0 ? jobs.map((j) => [j.name ?? "(unnamed)", j.enabled === false ? t("stat.disabled") : t("stat.everyMinutes", j.every_minutes)]) : [["—", t("stat.noJobs")]],
      res.started ? t("stat.running") : t("stat.stopped"),
    ));
  } catch (err) {
    content.appendChild(sectionError("cron scheduler", err));
  }
}

// ---------------------------------------------------------------------------
// session info drawer (context usage + counts, OpenCode 実装準拠の概要)
// ---------------------------------------------------------------------------
async function loadSessionInfo() {
  const body = $("#info-body");
  body.innerHTML = "";
  if (!state.sessionId) {
    body.innerHTML = `<div class="empty">${esc(t("top.noSession"))}</div>`;
    return;
  }
  let data;
  try {
    data = await rpc("session.get", { id: state.sessionId });
  } catch (err) {
    body.innerHTML = `<div class="status-err">${esc(err.message)}</div>`;
    return;
  }
  const s = data.session;
  const msgs = (data.messages ?? []).filter((m) => m.meta?.ephemeral !== true);
  const counts = { user: 0, assistant: 0, tool: 0 };
  for (const m of msgs) counts[m.role === "system" ? "user" : m.role] = (counts[m.role] ?? 0) + 1;
  body.appendChild(sectionCard(t("info.session"), [
    [t("info.title"), s.title || s.id.slice(0, 8)],
    [t("info.id"), s.id],
    [t("info.providerModel"), `${s.provider}${s.model ? ` / ${s.model}` : ""}`],
    [t("info.profile"), s.profile ?? t("none")],
    [t("info.cwd"), s.cwd],
    [t("info.created"), fmtTime(s.createdAt)],
    [t("info.updated"), fmtTime(s.updatedAt)],
  ]));
  body.appendChild(sectionCard(t("info.messages"), [
    [t("info.user"), counts.user],
    [t("info.assistant"), counts.assistant],
    [t("info.toolCalls"), counts.tool],
    [t("info.total"), msgs.length],
  ]));
  const used = state.lastPromptTokensBySession[s.id];
  const tot = state.usageBySession[s.id] ?? { prompt: 0, completion: 0 };
  const win = await contextWindowFor(s.provider, s.model).catch(() => null);
  body.appendChild(sectionCard(t("info.context"), [
    [t("info.currentContext"), used !== undefined ? `${formatTokens(used)} tok` : t("info.notMeasured")],
    [t("info.contextWindow"), win ? `${formatTokens(win)} tok` : t("info.unknown")],
    ["usage", win && used !== undefined ? `${Math.round(Math.min(1, used / win) * 100)}%` : "—"],
  ]));
  body.appendChild(sectionCard(t("info.usageVisit"), [
    [t("info.input"), `${formatTokens(tot.prompt)} tok`],
    [t("info.output"), `${formatTokens(tot.completion)} tok`],
  ]));
  const list = document.createElement("div");
  list.className = "card";
  list.innerHTML = `<h4>${esc(t("info.rawMessages"))}</h4>`;
  for (const m of msgs.slice(-14)) {
    const line = document.createElement("div");
    line.className = "rawmsg";
    const preview = String(m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
    line.innerHTML = `<span class="r ${esc(m.role)}">${esc(m.role === "tool" ? (m.name ?? "tool") : m.role)}</span>${esc(preview)}`;
    list.appendChild(line);
  }
  body.appendChild(list);
}

// ---------------------------------------------------------------------------
// session list context menu (right click)
// ---------------------------------------------------------------------------
function hideCtxMenu() {
  $("#ctx-menu").hidden = true;
}

function openCtxMenu(ev, sessionId) {
  ev.preventDefault();
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
    return true;
  } catch (err) {
    toast(t("toast.configUnavailable", err.message), "err");
    return false;
  }
}

// ---------------------------------------------------------------------------
// composer chips: agent mode + model for the current session
// ---------------------------------------------------------------------------
function setMode(mode) {
  state.mode = mode === "plan" ? "plan" : "build";
  $("#mode-chip").textContent = `${t(state.mode === "plan" ? "mode.plan" : "mode.build")} ▾`;
  $("#mode-chip").classList.toggle("plan-mode", state.mode === "plan");
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
  $("#model-chip").textContent = `${provider ?? t("chip.modelLabel")}${model ? "/" + model : ""} ▾`;
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
    box.innerHTML = `<div class="mp-group">${esc(name)}</div>`;
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
  const prevChip = $("#model-chip").textContent;
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
    $("#model-chip").textContent = prevChip;
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

function openNewSessionModal() {
  nsSelectedFolder = state.currentSession?.cwd || "";
  const input = $("#ns-folder-input");
  input.value = "";
  const errBox = $("#new-session-overlay .form-error");
  errBox.hidden = true;
  errBox.textContent = "";
  $("#ns-browse").hidden = typeof window.familiarDesktop?.pickDirectory !== "function";
  $("#new-session-overlay").hidden = false;
  renderNsRecent();
  input.focus();
}

function closeNewSessionModal() {
  $("#new-session-overlay").hidden = true;
}

/** Recent working folders from the session history (deduped, newest first). */
function renderNsRecent() {
  const box = $("#ns-list");
  box.innerHTML = "";
  const seen = new Map();
  for (const s of state.sessions) {
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
  if (state.busy) {
    void stopTurn();
    return;
  }
  void send();
}

async function send() {
  const input = $("#input");
  const text = input.value.trim();
  if (text === "" || state.busy) return;
  let id = state.sessionId;
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
  }
  setBusy(true);
  appendMessage("user", text, null);
  input.value = "";
  autoSize(input);
  try {
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
    const sparams = { id, text, plan: state.mode === "plan" };
    if (overrides?.provider) sparams.provider = overrides.provider;
    if (overrides?.model) sparams.model = overrides.model;
    if (state.draft.effort) sparams.effort = state.draft.effort;
    await rpc("session.send", sparams);
  } catch (err) {
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

/** Insert @path tokens for attachments (picker + drag & drop). */
async function attachFiles(fileList) {
  const files = [...fileList].slice(0, 8);
  if (files.length === 0) return;
  const refs = [];
  for (const f of files) {
    const ref = resolveFilePath(f);
    if (!ref) {
      toast(t("toast.attachFailed", f.name), "err");
      continue;
    }
    insertIntoComposer(`@${ref} `);
    refs.push(ref);
  }
  if (refs.length > 0) toast(t("toast.dropAttach", refs.join(" ")), "ok");
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
  // notifications default on: secure the browser permission early (Electron
  // grants it automatically; browsers may show a one-time prompt)
  if (prefs.notify && typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentModePref() === "system") applyTheme();
  });

  $("#new-session").addEventListener("click", () => openNewSessionModal());
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
    const f = $("#file-attach").files?.[0];
    $("#file-attach").value = "";
    if (!f) return;
    void attachFiles([f]);
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

  $("#session-filter").addEventListener("input", applySessionFilter);
  ulSessionsClick();

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
    if (!ev.target.closest("#ctx-menu") && !ev.target.closest("#sessions")) hideCtxMenu();
  });
  for (const evt of ["scroll", "resize"]) {
    $("#transcript").addEventListener(evt, hideCtxMenu, { passive: true });
    window.addEventListener(evt, hideCtxMenu, { passive: true });
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
    const wantsSend = prefs.sendWithEnter
      ? ev.key === "Enter" && !ev.shiftKey
      : ev.key === "Enter" && (ev.ctrlKey || ev.metaKey);
    if (wantsSend) {
      ev.preventDefault();
      composerAction();
    }
  });
  input.addEventListener("input", () => {
    autoSize(input);
    void updateComposerPop();
  });

  $("#pane-toggle").addEventListener("click", () => togglePane());
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

  document.addEventListener("keydown", (ev) => {
    // Tab toggles Build/Plan (skips while renaming or searching)
    if (ev.key === "Tab" && prefs.tabModeToggle) {
      const t = ev.target;
      const editable = t instanceof HTMLElement &&
        (t.tagName === "SELECT" || (t.tagName === "INPUT" && t.id !== "input"));
      if (!editable) {
        ev.preventDefault();
        setMode(state.mode === "plan" ? "build" : "plan");
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
      hideCtxMenu();
      closeAllPops();
      if (!$("#search-bar").hidden) {
        toggleSearch(false);
        return;
      }
      if (!$("#rightpane").hidden) closePane();
    }
  });

  setMode("build");
  renderModelChip();
  renderEffortChip();
  updateContextGauge();
  void refreshSessions();
  void loadInbox();
  autoSize(input);
  input.focus();
  connectEvents();
}

boot();
