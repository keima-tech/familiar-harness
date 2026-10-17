/* Familiar web UI (v1.0, M6) — vanilla JS, no build step.
 * Talks to the same RPC surface as the CLI/desktop:
 *   POST /rpc  JSON-RPC         WS /ws  shared event stream
 * v1.0 additions: per-session delete, provider/model/profile picker for new
 * sessions, and a system status drawer (curator / MCP / cron).
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

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
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

// new-session picker cache (filled once from config.get)
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
      `<div class="row-line"><span>${esc(title)}</span>` +
      `<button class="del" data-id="${esc(s.id)}" title="delete session">✕</button></div>` +
      `<span class="when">${esc(when)} · ${esc(s.provider)}${esc(model)}</span>`;
    if (s.id === state.sessionId) li.classList.add("active");
    ul.appendChild(li);
  }
  if (!state.sessionId && state.sessions.length > 0) {
    await openSession(state.sessions[0].id);
  }
}

ulSessionsClick();

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
  $("#turn-state").textContent = "";
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
    appendMessage("assistant", `⚠ delete failed: ${err.message}`, null);
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
      appendMessage("assistant", `⚠ config unavailable, creating a default session: ${err.message}`, null);
      void newSession(); // legacy fallback
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
    appendMessage("assistant", `⚠ session.create failed: ${err.message}`, null);
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
      ["last run", fmtTime(c.lastRunAt)],
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
  $("#new-session").addEventListener("click", () => void openNewSessionPanel());
  $("#ns-cancel").addEventListener("click", () => {
    $("#new-session-panel").hidden = true;
  });
  $("#ns-create").addEventListener("click", () => void createFromPanel());
  $("#ns-provider").addEventListener("change", () => void refreshModelList());
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
  $("#toggle-inbox").addEventListener("click", () => openDrawer("inbox"));
  $("#close-inbox").addEventListener("click", () => {
    $("#inbox").hidden = true;
  });
  $("#toggle-status").addEventListener("click", () => openDrawer("status"));
  $("#close-status").addEventListener("click", () => {
    $("#status").hidden = true;
  });
  void refreshSessions();
  void loadInbox();
  connectEvents();
}

boot();
