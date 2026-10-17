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

async function rpc(method, params = {}) {
  const res = await fetch("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  return body.result;
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
  t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt, url) =>
    `<a href="${url}" target="_blank" rel="noreferrer noopener">${txt}</a>`);
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] ?? "");
  return t;
}

/** One fenced code block; long blocks render collapsed (expandable). */
function codeBlockHtml(code, lang) {
  const lineCount = code.split("\n").length;
  const head =
    (lang ? `<span class="lang">${escapeHtml(lang)}</span>` : "") +
    `<button class="code-copy" type="button">copy</button>` +
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
  busy: false,
  pendingEvents: new Map(), // sessionId -> partial assistant render state
  pendingToolCards: [], // live tool.call cards awaiting their result
  turnStartedAt: null,
  turnTimer: null,
  lastElapsed: null,
};

const ns = {
  providers: {},
  profiles: {},
  defaultProvider: null,
  defaultModel: null,
  loaded: false,
};

// ---------------------------------------------------------------------------
// sessions sidebar
// ---------------------------------------------------------------------------
async function refreshSessions() {
  state.sessions = await rpc("session.list");
  const ul = $("#sessions");
  ul.innerHTML = "";
  for (const s of state.sessions) {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    const title = s.title || s.id.slice(0, 8);
    const model = s.model ? "/" + s.model : "";
    const when = fmtTime(s.updatedAt);
    li.innerHTML =
      `<div class="row-line"><span class="t">${esc(title)}</span>` +
      `<button class="del" data-id="${esc(s.id)}" title="delete session">✕</button></div>` +
      `<span class="when" title="${esc(when)}">${esc(relTime(s.updatedAt))} · ${esc(s.provider)}${esc(model)}</span>`;
    if (s.id === state.sessionId) li.classList.add("active");
    ul.appendChild(li);
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
  for (const li of document.querySelectorAll("#sessions li")) {
    const s = state.sessions.find((x) => x.id === li.dataset.id) ?? {};
    const hay = `${s.title ?? ""} ${s.provider ?? ""} ${s.model ?? ""}`.toLowerCase();
    const show = query === "" || hay.includes(query);
    li.classList.toggle("filtered", !show);
    if (show) visible += 1;
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

function ulSessionsClick() {
  $("#sessions").addEventListener("click", (ev) => {
    const del = ev.target.closest("button.del");
    if (del) {
      void deleteSession(del.dataset.id);
      return;
    }
    const li = ev.target.closest("li");
    if (li?.dataset.id) void openSession(li.dataset.id);
  });
}

async function openSession(id) {
  state.sessionId = id;
  state.pendingEvents.delete(id);
  for (const li of document.querySelectorAll("#sessions li")) {
    li.classList.toggle("active", li.dataset.id === id);
  }
  const data = await rpc("session.get", { id });
  const s = data.session;
  $("#session-title").textContent = s.title || s.id.slice(0, 8);
  const bits = [s.provider];
  if (s.model) bits.push(s.model);
  if (s.profile) bits.push(`profile: ${s.profile}`);
  $("#session-meta").textContent = bits.join(" · ");
  renderTranscript(data.messages ?? []);
}

async function deleteSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  const label = s?.title || id.slice(0, 8);
  if (!window.confirm(`delete session "${label}"? this cannot be undone`)) return;
  try {
    await rpc("session.delete", { id });
  } catch (err) {
    toast(`delete failed: ${err.message}`, "err");
    return;
  }
  if (state.sessionId === id) {
    state.sessionId = null;
    $("#session-title").textContent = "no session";
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
  const visible = messages.filter((m) => m.meta?.ephemeral !== true);
  if (visible.length === 0) {
    t.appendChild(emptyStateNode());
    return;
  }
  for (const m of visible) {
    if (m.role === "user") {
      appendMessage("user", m.content, null);
    } else if (m.role === "assistant") {
      appendMessage("assistant", m.content, null);
    } else {
      const call = Array.isArray(m.toolCalls) ? m.toolCalls[0] : undefined;
      const duration = m.meta?.durationMs;
      appendToolCard(
        m.name ?? call?.name ?? "?",
        call?.arguments ?? "",
        m.content ?? "",
        m.meta?.isError === true ? "err" : "done",
        { resultLabel: "result", durationMs: duration },
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
    <h3>No messages yet</h3>
    <div class="hint">Ask anything — familiar can read files, run commands,<br>and edit code in this workspace.</div>`;
  return div;
}

/** User / assistant bubbles. */
function appendMessage(role, content, toolCalls) {
  const t = $("#transcript");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const head = role === "user" ? `<div class="role">${esc(role)}</div>` : "";
  const copyBtn = role === "assistant" ? `<button class="msg-copy ghost" title="copy message">copy</button>` : "";
  div.innerHTML = `${head}<div class="bubble"></div>${copyBtn}`;
  const bubble = div.querySelector(".bubble");
  if (role === "assistant") {
    bubble.innerHTML = mdRender(content);
    wireBubble(div, bubble, String(content ?? ""));
  } else {
    bubble.textContent = content ?? "";
  }
  void toolCalls;
  t.appendChild(div);
  scrollBottom();
  return bubble;
}

function wireBubble(div, bubble, raw) {
  const btn = div.querySelector(".msg-copy");
  if (btn) {
    btn.addEventListener("click", () => {
      void copyText(raw).then((ok) =>
        ok ? toast("message copied", "ok") : toast("copy failed", "err"));
    });
  }
  wireCodeButtons(div, bubble);
}

function wireCodeButtons(scope) {
  for (const btn of scope.querySelectorAll("button.code-copy:not([data-wired])")) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const code = btn.closest(".codeblock")?.querySelector("pre code");
      void copyText(code?.textContent ?? "").then((ok) => {
        btn.textContent = ok ? "copied ✓" : "failed";
        setTimeout(() => (btn.textContent = "copy"), 1200);
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

/** Collapsible tool card. Live cards keep a placeholder result until the
 * matching tool.result event arrives (paired by name below). */
function appendToolCard(name, args, resultContent, status, opts = {}) {
  const t = $("#transcript");
  const card = document.createElement("div");
  card.className = `toolcard ${status === "err" ? "is-error" : status === "run" ? "is-run" : ""}`;
  const argsText = String(args ?? "");
  const preview = argsText.replace(/\s+/g, " ").trim().slice(0, 64);
  let argsPretty = null;
  try {
    const parsed = JSON.parse(argsText);
    if (parsed && typeof parsed === "object") argsPretty = JSON.stringify(parsed, null, 2);
  } catch {
    argsPretty = null;
  }
  const argsBlock = argsPretty ?? argsText;
  const duration = opts.durationMs !== undefined ? ` <span class="tc-dur">${esc((opts.durationMs / 1000).toFixed(1))}s</span>` : "";
  card.innerHTML = `
    <div class="tc-head">
      <span class="tc-status"></span>
      <span class="tc-name">${esc(name)}</span>
      <span class="tc-args">${esc(preview)}</span>${duration}
      <button class="tc-toggle ghost" type="button">▾</button>
    </div>
    <div class="tc-body" hidden>
      ${argsText !== "" ? `<div class="tc-section"><h5>arguments</h5><pre>${esc(truncate(argsBlock, ARGS_CAP))}</pre></div>` : ""}
      <div class="tc-section tc-result"><h5>${opts.resultLabel ?? "result"}</h5><pre>${status === "run" ? `<span class="dim">running…</span>` : esc(truncate(resultContent, RESULT_CAP))}</pre></div>
    </div>`;
  card.querySelector(".tc-toggle").addEventListener("click", () => {
    const body = card.querySelector(".tc-body");
    body.hidden = !body.hidden;
    card.classList.toggle("open", !body.hidden);
  });
  t.appendChild(card);
  scrollBottom();
  const entry = {
    name,
    card,
    statusEl: card.querySelector(".tc-status"),
    resultEl: card.querySelector(".tc-result pre"),
    labelEl: card.querySelector(".tc-result h5"),
    resultFull: String(resultContent ?? ""),
  };
  if (status === "run") state.pendingToolCards.push(entry);
  return entry;
}

function completeToolCard(entry, content, isError) {
  if (!entry || !entry.resultEl) return;
  entry.resultFull = String(content ?? "");
  entry.labelEl.textContent = isError ? "error" : "result";
  entry.resultEl.textContent = truncate(content, RESULT_CAP);
  entry.statusEl.textContent = isError ? "✗" : "✓";
  entry.card.classList.remove("is-run");
  entry.card.classList.toggle("is-error", isError);
}

function scrollBottom(force = false) {
  const t = $("#transcript");
  const near = t.scrollHeight - t.scrollTop - t.clientHeight < 240;
  if (force || near) t.scrollTop = t.scrollHeight;
}

// live streaming: one bubble per assistant step for the active session
function liveBubble(sessionId) {
  if (sessionId !== state.sessionId) return null;
  let entry = state.pendingEvents.get(sessionId);
  if (!entry) {
    const bubble = appendMessage("assistant", "");
    entry = { bubble, text: "" };
    state.pendingEvents.set(sessionId, entry);
    const live = document.createElement("span");
    live.className = "caret";
    bubble.appendChild(live);
  }
  return entry;
}

function setBusy(busy) {
  state.busy = busy;
  $("#send").disabled = busy;
  $("#input").disabled = busy;
  $("#turn-spinner").hidden = !busy;
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
      setTurnEndLabel(`✓ done in ${s}s`);
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
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
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
      if (document.querySelector("#approval-dock").children.length === 0) $("#turn-state").textContent = "";
    }
    return;
  }
  if (sessionId !== state.sessionId) return;

  switch (e.type) {
    case "turn.start":
      setBusy(true);
      break;
    case "message.start":
      state.pendingEvents.delete(sessionId);
      break;
    case "text.delta": {
      const live = liveBubble(sessionId);
      if (live) {
        live.text += e.text;
        const caret = live.bubble.querySelector(".caret");
        live.bubble.innerHTML = mdRender(live.text);
        if (caret) live.bubble.appendChild(caret);
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
        completeToolCard(entry, e.content ?? "", e.isError === true);
      }
      break;
    }
    case "turn.end": {
      const u = e.usage ?? {};
      const toks = u.promptTokens !== undefined
        ? ` · ↑${u.promptTokens} ↓${u.completionTokens ?? 0} tok` : "";
      setBusy(false);
      setTurnEndLabel(`✓ done in ${state.lastElapsed ?? ""}${toks}`);
      state.pendingEvents.delete(sessionId);
      refreshSessions();
      loadInbox();
      break;
    }
    case "turn.error":
      setBusy(false);
      appendMessage("assistant", `⚠ ${e.error}`, null);
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
  $("#turn-label").textContent = `approval needed: ${e.tool}`;
  const dock = $("#approval-dock");
  const node = document.createElement("div");
  node.className = "dock";
  node.dataset.requestId = e.requestId;
  node.innerHTML = `
    <div>⚠ <b>${esc(e.tool)}</b> — ${esc(e.summary)}</div>
    <div class="detail">${esc(e.detail ?? "")}</div>
    <div class="row">
      <button data-act="approve">Approve</button>
      <button class="ghost" data-act="deny">Deny</button>
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
    toast(approved ? "approved" : "denied", approved ? "ok" : "info");
  } catch (err) {
    toast(`approval failed: ${err.message}`, "err");
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
    toast(`inbox unavailable: ${err.message}`, "err");
  }
  if (count === 0 && open) {
    body.innerHTML = `<div class="empty">no staged writes — all clear ✓</div>`;
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
      <button data-act="approve">Approve</button>
      <button class="ghost" data-act="reject">Reject</button>
    </div>`;
  node.querySelector('button[data-act="approve"]').addEventListener("click", () => act(true, node));
  node.querySelector('button[data-act="reject"]').addEventListener("click", () => act(false, node));
  return node;
}

// ---------------------------------------------------------------------------
// status drawer (curator / MCP / cron)
// ---------------------------------------------------------------------------
function openDrawer(which) {
  const inbox = $("#inbox");
  const status = $("#status");
  inbox.hidden = which !== "inbox";
  status.hidden = which !== "status";
  if (which === "inbox") void loadInbox();
  if (which === "status") void loadStatus();
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

async function loadStatus() {
  const body = $("#status-body");
  body.innerHTML = "";
  try {
    const res = await rpc("curator.status");
    const c = res.curator ?? {};
    body.appendChild(sectionCard("curator", [
      ["state", `${c.enabled ? "enabled" : "disabled"}${c.paused ? " · paused" : ""}`],
      ["last run", `${fmtTime(c.lastRunAt)}${c.lastRunAt ? ` (${relTime(c.lastRunAt)})` : ""}`],
      ["next due", fmtTime(c.nextDueAt)],
      ["stale skills", (c.stale ?? []).join(", ") || "—"],
      ["archived", `${(c.archived ?? []).length} (snapshots: ${c.snapshots ?? 0})`],
      ["consolidation", c.consolidate ? "on" : "off"],
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
    body.appendChild(sectionCard("mcp servers", rows.length > 0 ? rows : [["—", "no servers configured"]]));
  } catch (err) {
    body.appendChild(sectionError("mcp servers", err));
  }
  try {
    const res = await rpc("cron.status");
    const jobs = res.jobs ?? [];
    const rows = jobs.map((j) => [
      j.name ?? "(unnamed)",
      j.enabled === false ? "disabled" : `every ${j.every_minutes} min`,
    ]);
    body.appendChild(sectionCard("cron scheduler", rows.length > 0 ? rows : [["—", "no jobs"]], res.started ? "running" : "stopped"));
  } catch (err) {
    body.appendChild(sectionError("cron scheduler", err));
  }
}

// ---------------------------------------------------------------------------
// new session picker (provider / model / profile)
// ---------------------------------------------------------------------------
function providerAuthLabel(pc) {
  if (!pc?.auth || pc.auth.source === "none") return "";
  return pc.auth.resolved ? "key ✓" : `missing ${pc.auth.source}`;
}

async function openNewSessionPanel() {
  const panel = $("#new-session-panel");
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  if (!ns.loaded) {
    try {
      const cfg = await rpc("config.get");
      ns.providers = cfg.providers ?? {};
      ns.profiles = cfg.profiles ?? {};
      ns.defaultProvider = cfg.default_provider ?? "mock";
      ns.defaultModel = cfg.default_model;
      ns.loaded = true;
    } catch (err) {
      panel.hidden = true;
      toast(`config unavailable, creating a default session: ${err.message}`, "err");
      void newSession();
      return;
    }
  }
  const selProvider = $("#ns-provider");
  selProvider.innerHTML = "";
  const names = Object.keys(ns.providers).sort();
  names.sort((a, b) => (a === ns.defaultProvider ? -1 : b === ns.defaultProvider ? 1 : a.localeCompare(b)));
  for (const name of names) {
    const pc = ns.providers[name] ?? {};
    const hint = providerAuthLabel(pc);
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = hint ? `${name} (${hint})` : name;
    selProvider.appendChild(opt);
  }
  selProvider.value = names.includes(ns.defaultProvider) ? ns.defaultProvider : names[0] ?? "";
  const selProfile = $("#ns-profile");
  selProfile.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "(none)";
  selProfile.appendChild(empty);
  for (const name of Object.keys(ns.profiles).sort()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    selProfile.appendChild(opt);
  }
  $("#ns-model").value = "";
  panel.hidden = false;
  await refreshModelList();
}

async function refreshModelList() {
  const provider = $("#ns-provider").value;
  const pc = ns.providers[provider] ?? {};
  const hint = pc.default_model ?? ns.defaultModel;
  $("#ns-model").placeholder = hint ? `default: ${hint}` : "model name";
  $("#ns-auth").textContent = `${provider} · ${pc.kind ?? "?"}${providerAuthLabel(pc) ? " · " + providerAuthLabel(pc) : ""}`;
  $("#ns-models").innerHTML = "";
  try {
    const res = await rpc("models.list", { provider });
    for (const m of res.models ?? []) {
      const opt = document.createElement("option");
      opt.value = m.id;
      if (m.contextTokens) opt.label = `${m.id} (${Math.round(m.contextTokens / 1000)}k)`;
      $("#ns-models").appendChild(opt);
    }
  } catch {
    /* provider unreachable — free-text entry stays available */
  }
}

async function createFromPanel() {
  const provider = $("#ns-provider").value || ns.defaultProvider || "mock";
  const model = $("#ns-model").value.trim();
  const profile = $("#ns-profile").value;
  const params = { provider };
  if (model !== "") params.model = model;
  if (profile !== "") params.profile = profile;
  try {
    const s = await rpc("session.create", params);
    $("#new-session-panel").hidden = true;
    state.sessionId = s.id;
    await refreshSessions();
    await openSession(s.id);
    $("#input").focus();
  } catch (err) {
    toast(`session.create failed: ${err.message}`, "err");
  }
}

async function newSession() {
  const s = await rpc("session.create", {});
  state.sessionId = s.id;
  await refreshSessions();
  await openSession(s.id);
  $("#input").focus();
}

// ---------------------------------------------------------------------------
// composer
// ---------------------------------------------------------------------------
async function send() {
  const input = $("#input");
  const text = input.value.trim();
  if (text === "" || state.busy) return;
  let id = state.sessionId;
  if (!id) {
    const s = await rpc("session.create", {});
    id = s.id;
    state.sessionId = id;
    await refreshSessions();
  }
  setBusy(true);
  appendMessage("user", text, null);
  input.value = "";
  autoSize(input);
  try {
    await rpc("session.send", { id, text });
  } catch (err) {
    toast(`send failed: ${err.message}`, "err");
    setBusy(false);
  }
}

function autoSize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function boot() {
  $("#new-session").addEventListener("click", () => void openNewSessionPanel());
  $("#ns-cancel").addEventListener("click", () => {
    $("#new-session-panel").hidden = true;
  });
  $("#ns-create").addEventListener("click", () => void createFromPanel());
  $("#ns-provider").addEventListener("change", () => void refreshModelList());

  $("#session-filter").addEventListener("input", applySessionFilter);
  ulSessionsClick();

  $("#composer").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send();
  });
  const input = $("#input");
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send();
    }
  });
  input.addEventListener("input", () => autoSize(input));

  $("#toggle-inbox").addEventListener("click", () => openDrawer("inbox"));
  $("#close-inbox").addEventListener("click", () => {
    $("#inbox").hidden = true;
  });
  $("#toggle-status").addEventListener("click", () => openDrawer("status"));
  $("#close-status").addEventListener("click", () => {
    $("#status").hidden = true;
  });

  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      $("#session-filter").focus();
      return;
    }
    if (ev.key === "Escape") {
      if (!$("#new-session-panel").hidden) {
        $("#new-session-panel").hidden = true;
        return;
      }
      const status = $("#status");
      const inbox = $("#inbox");
      if (!status.hidden) status.hidden = true;
      else if (!inbox.hidden) inbox.hidden = true;
    }
  });

  void refreshSessions();
  void loadInbox();
  autoSize(input);
  input.focus();
  connectEvents();
}

boot();
