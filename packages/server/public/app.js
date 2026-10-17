/* Familiar web UI (α, M4) — vanilla JS, no build step.
 * Talks to the same RPC surface as the CLI/desktop:
 *   POST /rpc  JSON-RPC         WS /ws  shared event stream
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

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// app state
// ---------------------------------------------------------------------------
const state = {
  sessions: [],
  sessionId: null,
  busy: false,
  pendingEvents: new Map(), // sessionId -> partial assistant render state
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
    const when = new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ");
    li.innerHTML = `<span>${esc(title)}</span><span class="when">${esc(when)} · ${esc(s.provider)}</span>`;
    if (s.id === state.sessionId) li.classList.add("active");
    li.addEventListener("click", () => openSession(s.id));
    ul.appendChild(li);
  }
  if (!state.sessionId && state.sessions.length > 0) {
    await openSession(state.sessions[0].id);
  }
}

async function openSession(id) {
  state.sessionId = id;
  state.pendingEvents.delete(id);
  $("#turn-state").textContent = "";
  for (const li of document.querySelectorAll("#sessions li")) {
    li.classList.toggle("active", li.dataset.id === id);
  }
  const data = await rpc("session.get", { id });
  const s = data.session;
  $("#session-title").textContent = s.title || s.id.slice(0, 8);
  renderTranscript(data.messages ?? []);
}

async function newSession() {
  const s = await rpc("session.create", {});
  state.sessionId = s.id;
  await refreshSessions();
  await openSession(s.id);
  $("#input").focus();
}

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------
function renderTranscript(messages) {
  const t = $("#transcript");
  t.innerHTML = "";
  for (const m of messages) {
    if (m.meta?.ephemeral) continue;
    appendMessage(m.role, m.content, m.toolCalls);
  }
  t.scrollTop = t.scrollHeight;
}

function appendMessage(role, content, toolCalls) {
  const t = $("#transcript");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const isTool = role === "tool";
  const head = isTool ? `tool ${esc(nameOf(toolCalls))}` : esc(role);
  div.innerHTML = `<div class="role">${head}</div><div class="bubble"></div>`;
  const bubble = div.querySelector(".bubble");
  if (isTool) {
    bubble.textContent = String(content ?? "").slice(0, 600);
  } else {
    bubble.innerHTML = esc(content ?? "");
  }
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
  return bubble;
}

function nameOf(toolCalls) {
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return `${toolCalls[0].name ?? ""}(${toolCalls[0].arguments?.slice(0, 80) ?? ""})`;
  }
  return "";
}

// live streaming: one bubble per step for the active session
function liveBubble(sessionId) {
  if (sessionId !== state.sessionId) return null;
  let entry = state.pendingEvents.get(sessionId);
  if (!entry) {
    const bubble = appendMessage("assistant", "");
    entry = { bubble, text: "" };
    state.pendingEvents.set(sessionId, entry);
  }
  return entry;
}

function setBusy(busy) {
  state.busy = busy;
  $("#send").disabled = busy;
  $("#input").disabled = busy;
  $("#turn-state").textContent = busy ? "working…" : "";
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
  if (e.type === "permission.request" && sessionId === "") {
    showApproval(e);
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
        live.bubble.innerHTML = esc(live.text);
        scrollBottom();
      }
      break;
    }
    case "tool.call":
      appendMessage(
        "tool",
        `${e.toolCall.name}(${String(e.toolCall.arguments ?? "").slice(0, 120)})`,
        [{ name: e.toolCall.name, arguments: e.toolCall.arguments }],
      );
      state.pendingEvents.delete(sessionId);
      break;
    case "tool.result":
      appendMessage("tool", e.isError ? `⚠ ${e.content.slice(0, 240)}` : `↳ ${String(e.content).slice(0, 200)}`, [{ name: e.name }]);
      break;
    case "turn.error":
      appendMessage("assistant", `⚠ ${e.error}`, null);
      break;
    case "turn.end":
      setBusy(false);
      state.pendingEvents.delete(sessionId);
      refreshSessions();
      loadInbox();
      break;
    case "improvement.staged":
      loadInbox();
      break;
    default:
      break;
  }
}

function scrollBottom() {
  const t = $("#transcript");
  t.scrollTop = t.scrollHeight;
}

// ---------------------------------------------------------------------------
// dynamic approvals (serve mode)
// ---------------------------------------------------------------------------
function showApproval(e) {
  $("#turn-state").textContent = `approval needed: ${e.tool}`;
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
  $("#turn-state").textContent = "";
  try {
    await rpc("permission.respond", { requestId, approved });
  } catch (err) {
    appendMessage("assistant", `⚠ approval failed: ${err.message}`, null);
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
  try {
    await rpc("session.send", { id, text });
  } catch (err) {
    appendMessage("assistant", `⚠ ${err.message}`, null);
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function boot() {
  $("#new-session").addEventListener("click", newSession);
  $("#composer").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send();
  });
  $("#input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send();
    }
  });
  $("#toggle-inbox").addEventListener("click", async () => {
    const box = $("#inbox");
    box.hidden = !box.hidden;
    await loadInbox();
  });
  $("#close-inbox").addEventListener("click", () => {
    $("#inbox").hidden = true;
  });
  void refreshSessions();
  void loadInbox();
  connectEvents();
}

boot();
