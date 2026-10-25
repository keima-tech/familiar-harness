#!/usr/bin/env node
/**
 * SSH connection e2e (manual; not part of `npm run smoke`).
 * Requires: electron binary + xvfb.
 *
 * Boots the real desktop shell against a fake `ssh` (FAMILIAR_SSH_BIN) whose
 * `-L` spawns a real TCP forward and whose remote command runs locally.
 * The "remote" server is a second FAMILIAR_HOME reached through the tunnel, so
 * the whole feature — profile form, target list, window switch, remote
 * session creation, remote tool run, security guards, back to local — is
 * exercised end to end without an sshd.
 *
 * Run: node scripts/ssh-e2e.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
if (!fs.existsSync(electronBin)) {
  console.error("electron not installed — run: npm install -w packages/desktop");
  process.exit(1);
}

// random debug port: a leftover Electron from an aborted run must not be
// mistaken for this run's page
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
const LOCAL_PORTS = [46440, 46441, 46442];
const base = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-ssh-e2e-"));
const localHome = path.join(base, "local-home");
const remoteHome = path.join(base, "remote-home");
const remoteWork = path.join(remoteHome, "work");
const binDir = path.join(base, "bin");
for (const dir of [localHome, remoteHome, remoteWork, binDir]) fs.mkdirSync(dir, { recursive: true });

const CONFIG = `version: 1
default_provider: mock
providers:
  mock:
    kind: mock
server:
  port: 0
  bind: 127.0.0.1
mcp:
  servers:
    remote:
      command: mcp-home-mock
      read_only: true
lsp:
  servers:
    mock:
      command: mock-lsp-remote
      extensions: [txt]
      timeout_ms: 8000
uploads:
  retention_days: 30
`;
fs.writeFileSync(path.join(localHome, "config.yaml"), CONFIG);
fs.writeFileSync(path.join(remoteHome, "config.yaml"), CONFIG);

const shim = path.join(binDir, "familiar-remote");
fs.writeFileSync(
  shim,
  `#!/bin/sh\nexport HOME=${JSON.stringify(remoteHome)}\nexport FAMILIAR_HOME=${JSON.stringify(remoteHome)}\nexec node ${JSON.stringify(path.join(repoRoot, "packages", "cli", "dist", "familiar.js"))} "$@"\n`,
);
fs.chmodSync(shim, 0o755);

// Remote-only MCP server: names its tool after the host's $HOME, so seeing
// the tool proves the process was spawned through ssh (not locally).
const MCP_MOCK = `#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { createInterface } = require("node:readline");
const home = process.env.HOME || "/";
const tool = "where_" + (path.basename(home).replace(/[^A-Za-z0-9_]/g, "_") || "unknown");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "home-mock", version: "0.0.1" } } });
  } else if (m.method === "tools/list") {
    send({ id: m.id, result: { tools: [{ name: tool, description: "reports the host home", inputSchema: { type: "object", properties: {} } }] } });
  } else if (m.method === "tools/call") {
    send({ id: m.id, result: { content: [{ type: "text", text: "home: " + home }] } });
  }
});
`;
const mcpMock = path.join(binDir, "mcp-home-mock");
fs.writeFileSync(mcpMock, MCP_MOCK);
fs.chmodSync(mcpMock, 0o755);

const lspShim = path.join(binDir, "mock-lsp-remote");
fs.writeFileSync(
  lspShim,
  `#!/bin/sh\nexec node ${JSON.stringify(path.join(repoRoot, "packages", "cli", "scripts", "mock-lsp-server.mjs"))} "$@"\n`,
);
fs.chmodSync(lspShim, 0o755);

// Minimal fake ssh: -L becomes a real forward, the server command runs via sh
// with stdin piped (that is how the token file is streamed over).
const FAKE_SSH = `#!/usr/bin/env node
"use strict";
const net = require("node:net");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
let forward = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-L") { forward = argv[++i]; continue; }
  if (a === "-p" || a === "-i" || a === "-l" || a === "-o") { argv[++i]; continue; }
  if (a.startsWith("-")) continue;
  positional.push(a);
}
const host = positional[0] ?? "";
if (host === "badhost" || host.startsWith("unreachable")) {
  process.stderr.write("ssh: connect to host " + host + " port 22: Connection refused\\n");
  process.exit(255);
}
if (forward) {
  const m = /^127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)$/.exec(forward);
  if (!m) { process.stderr.write("fake ssh: unsupported -L " + forward + "\\n"); process.exit(2); }
  const srv = net.createServer((sock) => {
    const up = net.connect({ host: "127.0.0.1", port: Number(m[2]) });
    sock.pipe(up); up.pipe(sock);
    const both = () => { sock.destroy(); up.destroy(); };
    sock.on("error", both); up.on("error", both);
    sock.on("close", () => up.destroy()); up.on("close", () => sock.destroy());
  });
  srv.on("error", (err) => { process.stderr.write("fake ssh: forward failed: " + err.message + "\\n"); process.exit(255); });
  srv.listen(Number(m[1]), "127.0.0.1");
  const stop = () => { srv.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
} else {
  const command = positional.slice(1).join(" ");
  const child = spawn("/bin/sh", ["-c", command], {
    stdio: ["pipe", "pipe", "pipe"],
    // model a distinct remote machine: a different $HOME for the remote shell
    env: {
      ...process.env,
      HOME: process.env.FAKE_SSH_REMOTE_HOME || process.env.HOME,
      ...(process.env.FAKE_SSH_REMOTE_PATH
        ? { PATH: process.env.FAKE_SSH_REMOTE_PATH + ":" + process.env.PATH }
        : {}),
    },
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 143 : 0)));
  const kill = () => child.kill("SIGTERM");
  process.on("SIGTERM", kill); process.on("SIGINT", kill);
}
`;
const fakeSsh = path.join(base, "fake-ssh.cjs");
fs.writeFileSync(fakeSsh, FAKE_SSH);
fs.chmodSync(fakeSsh, 0o755);

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------
let failures = 0;
// accepts (label, ok) or (ok, label) — keeps every call site readable
const check = (a, b, extra = "") => {
  const label = typeof a === "string" ? a : b;
  const ok = typeof a === "string" ? b : a;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — ${extra}`}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = String(err?.message ?? err);
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (${lastErr})` : ""}`);
}

// ---------------------------------------------------------------------------
// CDP helpers (one fresh session per call — navigation replaces targets)
// ---------------------------------------------------------------------------
async function pageTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
  return res.filter((t) => t.type === "page" && (t.url ?? "").startsWith("http://127.0.0.1:"));
}

function openCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send(method, params) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(msgId);
              rej(new Error(`cdp ${method} timed out`));
            }, 15_000);
            pending.set(msgId, {
              res: (v) => {
                clearTimeout(timer);
                res(v);
              },
              rej: (e) => {
                clearTimeout(timer);
                rej(e);
              },
            });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
        _ws: ws,
        _pending: pending,
      });
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.error) slot.rej(new Error(msg.error.message ?? "cdp error"));
      else slot.res(msg.result);
    });
    ws.addEventListener("error", (err) => reject(new Error(`cdp connect failed: ${err?.message ?? "error"}`)));
  });
}

/** Evaluate once in the first page target; throws on any failure. */
async function evalOnce(expression) {
  const targets = await pageTargets();
  const target = targets[0];
  if (!target) throw new Error("no page target");
  const cdp = await openCdp(target.webSocketDebuggerUrl);
  try {
    const res = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "eval failed");
    }
    return res.result?.value;
  } finally {
    cdp.close();
  }
}

/** Evaluate, tolerating page-load races (returns undefined on failure). */
async function probe(expression) {
  try {
    return await evalOnce(expression);
  } catch {
    return undefined;
  }
}

function countSshTmpDirs() {
  try {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("familiar-ssh-")).length;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const tmpBefore = countSshTmpDirs();
const app = spawn(
  "xvfb-run",
  [
    "-a",
    electronBin,
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${DEBUG_PORT}`,
    path.join(repoRoot, "packages", "desktop"),
  ],
  {
    env: {
      ...process.env,
      FAMILIAR_HOME: localHome,
      FAMILIAR_PORTS: LOCAL_PORTS.join(","),
      FAMILIAR_SPAWN_PORT: String(LOCAL_PORTS[0]),
      FAMILIAR_SSH_BIN: fakeSsh,
      FAKE_SSH_REMOTE_HOME: remoteHome, // the "remote" shell gets its own home
      FAKE_SSH_REMOTE_PATH: binDir, //     …and its own PATH (remote-only tools)
    },
    stdio: "ignore",
    detached: true, // own process group: kill the whole xvfb/electron tree
  },
);

let failed = false;
try {
  // ---- local UI + bridge ---------------------------------------------------
  await waitFor(async () => {
    if ((await pageTargets()).length === 0) return false;
    return (await probe(`1 + 1`)) === 2;
  }, "desktop page");
  await waitFor(() => probe(`typeof window.familiarDesktop?.connections === "function"`), "preload bridge");
  check(true, "desktop shell exposes the connection bridge");

  const localFs = await evalOnce(`rpc("fs.list", { path: ${JSON.stringify(repoRoot)} }).then((r) => r.entries.length)`);
  check(typeof localFs === "number" && localFs > 0, "local fs.list still works", String(localFs));
  const localSuggest = await evalOnce(`rpc("fs.suggest", { prefix: ${JSON.stringify(path.join(repoRoot, "packa"))}, cwd: ${JSON.stringify(repoRoot)} })`);
  check(
    (localSuggest?.items ?? []).some((i) => i.path === path.join(repoRoot, "packages")),
    "local fs.suggest still works",
    JSON.stringify(localSuggest?.items),
  );

  await evalOnce(`openNewSessionModal(); 1`);
  await sleep(500);
  const rows = await evalOnce(`document.querySelectorAll("#ns-targets .ns-target-row").length`);
  check(rows === 2, "new-session modal lists local + add-SSH", `rows=${rows}`);
  await evalOnce(`closeNewSessionModal(); 1`);

  // ---- save a profile through the settings form ----------------------------
  const saved = await evalOnce(`(async () => {
    openSettingsModal("connections");
    await new Promise((r) => setTimeout(r, 500));
    const inputs = [...document.querySelectorAll("#settings-content .ssh-field input")];
    if (inputs.length < 6) return { err: "form inputs missing: " + inputs.length };
    inputs[0].value = "Test remote";
    inputs[1].value = "remote1";
    inputs[2].value = "tester";
    inputs[5].value = ${JSON.stringify(shim)};
    const form = document.querySelector("#settings-content > .card:last-of-type");
    form.querySelector(".conn-actions button").click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const list = await window.familiarDesktop.connections();
      if (list.connections.length === 1) {
        return { id: list.connections[0].id, name: list.connections[0].name, host: list.connections[0].host };
      }
    }
    return { err: "profile not saved" };
  })()`);
  check(!saved?.err && saved?.host === "remote1", "settings form saves an SSH profile", JSON.stringify(saved));
  const profileId = saved?.id ?? "";
  const storeMode = fs.statSync(path.join(localHome, "desktop.json")).mode & 0o777;
  check(storeMode === 0o600, "profile store is chmod 0600", `mode=${storeMode.toString(8)}`);
  check(!fs.readFileSync(path.join(localHome, "desktop.json"), "utf8").includes("token"), "profile store has no token");
  await evalOnce(`closeSettingsModal(); 1`);

  // ---- target list shows the profile, pick it ------------------------------
  const picked = await evalOnce(`(async () => {
    openNewSessionModal();
    await new Promise((r) => setTimeout(r, 400));
    const rows = document.querySelectorAll("#ns-targets .ns-target-row").length;
    selectNsTarget(${JSON.stringify(profileId)});
    document.querySelector("#ns-remote-cwd").value = ${JSON.stringify(remoteWork)};
    return {
      rows,
      createLabel: document.querySelector("#ns-create").textContent,
      localHidden: document.querySelector("#ns-local-picker").hidden,
      remoteHidden: document.querySelector("#ns-remote-picker").hidden,
    };
  })()`);
  check(picked?.rows === 3, "profile appears in the target list", JSON.stringify(picked));
  check(picked?.localHidden === true && picked?.remoteHidden === false, "SSH target swaps to the remote picker", JSON.stringify(picked));
  check(picked?.createLabel === "接続", "create button becomes 接続", String(picked?.createLabel));

  // ---- connect: window switches to the remote UI ---------------------------
  await evalOnce(`void createSessionFromModal(); 1`);
  await waitFor(() => probe(`typeof remoteBoot !== "undefined" && remoteBoot.isRemote === true`), "remote UI", 90_000);
  check(true, "window switched to the remote UI over the tunnel");

  const remoteUi = await probe(`({
    remoteMode: document.body.classList.contains("remote-mode"),
    badge: !document.querySelector("#remote-badge").hidden,
    targetsHidden: document.querySelector("#ns-target-wrap").hidden,
    browseHidden: document.querySelector("#ns-browse").hidden,
  })`);
  check(
    remoteUi?.remoteMode && remoteUi?.badge && remoteUi?.targetsHidden && remoteUi?.browseHidden,
    "remote UI shows the badge and hides local-only controls",
    JSON.stringify(remoteUi),
  );

  const prefilled = await waitFor(async () => {
    const v = await probe(`({
      open: !document.querySelector("#new-session-overlay").hidden,
      cwd: document.querySelector("#ns-folder-input").value,
    })`);
    return v?.open ? v : undefined;
  }, "remote new-session dialog");
  check(prefilled?.cwd === remoteWork, "remote dialog pre-fills the requested cwd", JSON.stringify(prefilled));

  // ---- healthz through the tunnel: this really is the other home -----------
  const health = await probe(`fetch("/healthz").then((r) => r.json())`);
  check(health?.home === remoteHome, "tunnel reaches the remote server", JSON.stringify(health));
  check(health?.hostname === os.hostname() && health?.platform === process.platform, "healthz reports the remote host identity");

  // ---- create the session remotely, run a tool -----------------------------
  await evalOnce(`void createSessionFromModal(); 1`);
  const created = await waitFor(async () => {
    const v = await probe(`typeof state !== "undefined" && state.currentSession ? { cwd: state.currentSession.cwd, id: state.sessionId } : undefined`);
    return v?.cwd ? v : undefined;
  }, "remote session");
  check(created?.cwd === remoteWork, "session created with the remote cwd", JSON.stringify(created));

  await evalOnce(`void rpc("session.send", { id: state.sessionId, text: "@write note.txt" }); 1`);
  const note = path.join(remoteWork, "note.txt");
  await waitFor(() => fs.existsSync(note), "remote write tool", 30_000);
  check(fs.readFileSync(note, "utf8").includes("mock content from Familiar"), "tool call wrote into the remote cwd");

  const remoteList = await probe(`rpc("session.list").then((s) => s.length)`);
  check(remoteList === 1, "remote server holds the session", `count=${remoteList}`);
  const localList = await fetch(`http://127.0.0.1:${LOCAL_PORTS[0]}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list" }),
  })
    .then((r) => r.json())
    .then((r) => r.result?.length)
    .catch(() => -1);
  check(localList === 0, "local server does not know the remote session", `count=${localList}`);

  // ---- serve mode: the same attachment flow uploads to the remote server ----
  const serveUpload = await evalOnce(`(async () => {
    const file = new File(["serve upload\\n"], "serve notes.txt", { type: "text/plain" });
    await attachFiles([file]);
    return { composer: document.querySelector("#input").value };
  })()`);
  const serveUploadPath = (/@(\S+)/.exec(String(serveUpload?.composer ?? "")) ?? [])[1] ?? "";
  check(
    serveUploadPath.startsWith(path.join(remoteHome, ".familiar", "uploads")) && fs.existsSync(serveUploadPath),
    "serve mode: attachment uploads through the remote server",
    String(serveUpload?.composer),
  );
  await evalOnce(`document.querySelector("#input").value = ""; 1`);

  // ---- remote page cannot pivot to other hosts / local shell ---------------
  const guards = await probe(`(async () => {
    const out = {};
    try { await window.familiarDesktop.saveConnection({ host: "evil.example" }); out.save = "allowed"; }
    catch (err) { out.save = String(err.message); }
    try { await window.familiarDesktop.pickDirectory(); out.pick = "allowed"; }
    catch (err) { out.pick = String(err.message); }
    const list = await window.familiarDesktop.connections();
    out.listLocal = list.local;
    out.listLen = list.connections.length;
    return out;
  })()`);
  check(/local machine/.test(String(guards?.save)), "remote cannot save connection profiles", String(guards?.save));
  check(guards?.pick !== "allowed", "remote cannot open the native folder picker", String(guards?.pick));
  check(guards?.listLocal === false && guards?.listLen === 0, "remote sees no other saved hosts", JSON.stringify(guards));

  // ---- back to local -------------------------------------------------------
  await evalOnce(`void backToLocal(); 1`);
  await waitFor(() => probe(`typeof remoteBoot !== "undefined" && remoteBoot.isRemote === false`), "local UI again", 60_000);
  const back = await probe(`({
    remoteMode: document.body.classList.contains("remote-mode"),
    localMode: document.body.classList.contains("local-mode"),
    badge: !document.querySelector("#remote-badge").hidden,
    banner: !document.querySelector("#conn-banner").hidden,
  })`);
  check(!back?.remoteMode && back?.localMode && !back?.badge && !back?.banner, "back on the local UI", JSON.stringify(back));
  const tmpAfter = countSshTmpDirs();
  check(tmpAfter === tmpBefore, "local token temp dirs cleaned up", `before=${tmpBefore} after=${tmpAfter}`);

  // ---- SSH proxy: tools over ssh, nothing installed on the remote ----------
  const proxyProfile = await evalOnce(`(async () => {
    const r = await window.familiarDesktop.saveConnection({
      name: "Proxy host", host: "proxy1", user: "tester", mode: "proxy",
    });
    return r.connections.find((p) => p.host === "proxy1") ?? null;
  })()`);
  check(proxyProfile?.mode === "proxy", "proxy profile saved with mode", JSON.stringify(proxyProfile));
  const proxyId = proxyProfile?.id ?? "";

  const proxyPick = await evalOnce(`(async () => {
    openNewSessionModal();
    await new Promise((r) => setTimeout(r, 500));
    selectNsTarget(${JSON.stringify(proxyId)});
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const rows = document.querySelectorAll("#ns-remote-list .ns-row").length;
      if (rows > 0) return { rows, create: document.querySelector("#ns-create").textContent };
    }
    return { rows: 0, create: document.querySelector("#ns-create").textContent };
  })()`);
  check(proxyPick?.rows > 0, "proxy target browses remote folders over ssh", JSON.stringify(proxyPick));
  check(proxyPick?.create === "作成", "proxy target keeps the 作成 button", String(proxyPick?.create));

  const proxyCreated = await evalOnce(`(async () => {
    document.querySelector("#ns-remote-cwd").value = ${JSON.stringify(remoteWork)};
    await createSessionFromModal();
    return {
      remote: state.currentSession?.remote ?? null,
      cwd: state.currentSession?.cwd,
      port: location.port,
      meta: document.querySelector("#session-meta").textContent,
    };
  })()`);
  check(proxyCreated?.remote?.host === "proxy1", "proxy session carries the ssh target", JSON.stringify(proxyCreated));
  check(
    proxyCreated?.cwd === remoteWork && proxyCreated?.port === String(LOCAL_PORTS[0]),
    "proxy session stays in the local UI",
    JSON.stringify(proxyCreated),
  );
  check(/ssh: tester@proxy1/.test(String(proxyCreated?.meta)), "session meta shows the ssh host", String(proxyCreated?.meta));

  await evalOnce(`void rpc("session.send", { id: state.sessionId, text: "@write proxy-note.txt", yolo: true }); 1`);
  const proxyNote = path.join(remoteWork, "proxy-note.txt");
  await waitFor(() => fs.existsSync(proxyNote), "proxy write tool", 30_000);
  check(fs.readFileSync(proxyNote, "utf8").includes("mock content from Familiar"), "proxy tools write to the remote cwd");

  const proxyRead = await evalOnce(`rpc("fs.read", { session: state.sessionId, path: ${JSON.stringify(proxyNote)} })`);
  check(String(proxyRead?.content ?? "").includes("mock content from Familiar"), "fs.read follows the proxy backend", JSON.stringify(proxyRead).slice(0, 160));
  const proxySuggest = await evalOnce(`rpc("fs.suggest", { session: state.sessionId, cwd: state.currentSession.cwd, prefix: ${JSON.stringify(path.join(remoteWork, "proxy-"))} })`);
  check(
    (proxySuggest?.items ?? []).some((i) => i.path === proxyNote),
    "fs.suggest follows the proxy backend",
    JSON.stringify(proxySuggest?.items),
  );

  // MCP + language servers run on the ssh host (the commands exist only on
  // the remote PATH, so a local spawn cannot produce these results).
  const toolDump = await evalOnce(`(async () => {
    await rpc("session.send", { id: state.sessionId, text: "@dump-prompt-tools", yolo: true });
    const d = await rpc("session.get", { id: state.sessionId });
    const m = [...(d.messages ?? [])].reverse().find((x) => x.role === "assistant");
    return m ? m.content : "";
  })()`);
  check(
    String(toolDump).includes("mcp__remote__where_remote_home"),
    "MCP server spawns on the ssh host",
    String(toolDump).slice(0, 240),
  );

  const mcpStatus = await evalOnce(`rpc("mcp.status", { session: state.sessionId })`);
  check(
    mcpStatus?.remote === "tester@proxy1" && (mcpStatus?.servers ?? []).some((x) => x.name === "remote"),
    "mcp.status reports the ssh host's servers",
    JSON.stringify(mcpStatus),
  );

  fs.writeFileSync(path.join(remoteWork, "bad.txt"), "ok\nFAIL: broken\n");
  const lspResult = await evalOnce(`(async () => {
    await rpc("session.send", { id: state.sessionId, text: "@lsp " + ${JSON.stringify(path.join(remoteWork, "bad.txt"))}, yolo: true });
    const d = await rpc("session.get", { id: state.sessionId });
    const m = [...(d.messages ?? [])].reverse().find((x) => x.role === "tool" && x.name === "lsp_diagnostics");
    return m ? m.content : "";
  })()`);
  check(/MOCK001/.test(String(lspResult)), "language server runs on the ssh host", String(lspResult).slice(0, 240));

  const localToolDump = await evalOnce(`(async () => {
    const s = await rpc("session.create", { cwd: ${JSON.stringify(repoRoot)} });
    await rpc("session.send", { id: s.id, text: "@dump-prompt-tools", yolo: true });
    const d = await rpc("session.get", { id: s.id });
    const m = [...(d.messages ?? [])].reverse().find((x) => x.role === "assistant");
    await rpc("session.delete", { id: s.id });
    return m ? m.content : "";
  })()`);
  check(
    !String(localToolDump).includes("mcp__remote__"),
    "local sessions do not spawn the remote-only MCP command",
    String(localToolDump).slice(0, 240),
  );

  const uploaded = await evalOnce(`(async () => {
    const file = new File(["hello from the client\\n"], "notes data.txt", { type: "text/plain" });
    await attachFiles([file]);
    return { composer: document.querySelector("#input").value };
  })()`);
  const uploadedPath = (/@(\S+)/.exec(String(uploaded?.composer ?? "")) ?? [])[1] ?? "";
  check(
    uploadedPath.startsWith(path.join(remoteHome, ".familiar", "uploads")),
    "non-image attachment uploads to the remote host",
    String(uploaded?.composer),
  );
  check(uploadedPath.endsWith("notes_data.txt"), "uploaded name is sanitized", uploadedPath);
  check(uploadedPath !== "" && fs.existsSync(uploadedPath), "uploaded file exists on the remote side", uploadedPath);
  check(
    uploadedPath !== "" && fs.readFileSync(uploadedPath, "utf8") === "hello from the client\n",
    "uploaded content round-trips",
  );
  await evalOnce(`document.querySelector("#input").value = ""; 1`);

  const uploadBucket = path.dirname(uploadedPath);
  await evalOnce(`rpc("session.delete", { id: state.sessionId }).then(() => 1)`);
  await waitFor(() => !fs.existsSync(uploadBucket), "remote upload cleanup", 20_000);
  check(!fs.existsSync(uploadBucket), "deleting a session removes its remote uploads");

  // ---- EN mode: every new string is translated (no CJK fallback) -----------
  const cjk = await evalOnce(`(() => {
    setLang("en");
    applyI18n();
    const keys = [
      "ns.target", "ns.localMachine", "ns.localHint", "ns.addSsh", "ns.addSshHint",
      "ns.connect", "ns.connecting", "ns.connectFailed", "ns.remoteCwd", "ns.remoteHint",
      "remote.back", "remote.badge", "remote.badgeTitle", "remote.lost", "remote.current", "remote.readOnly",
      "ssh.title", "ssh.desc", "ssh.name", "ssh.host", "ssh.user", "ssh.port", "ssh.key", "ssh.remoteBin",
      "ssh.save", "ssh.edit", "ssh.delete", "ssh.connect", "ssh.test", "ssh.testing", "ssh.testOk",
      "ssh.testFail", "ssh.saved", "ssh.deleted", "ssh.deleteConfirm", "ssh.none", "ssh.errHost",
      "ssh.desktopOnly", "ssh.connectFail", "ssh.current", "nav.connections", "attach.remotePath",
    ];
    const bad = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/;
    return keys.filter((k) => bad.test(t(k))).map((k) => k + "=" + t(k));
  })()`);
  check(cjk.length === 0, "EN mode: new SSH strings are translated", cjk.join(" | "));
  await evalOnce(`openNewSessionModal(); 1`);
  await new Promise((r) => setTimeout(r, 300));
  const modalCjk = await evalOnce(`/[\u3040-\u30ff\u3400-\u9fff]/.test(document.querySelector("#new-session-overlay").innerText)`);
  check(modalCjk === false, "EN mode: new-session dialog renders without CJK");
  await evalOnce(`setLang("ja"); applyI18n(); closeNewSessionModal(); 1`);

  // ---- failure path: unreachable host --------------------------------------
  const failedTest = await evalOnce(`(async () => {
    const r = await window.familiarDesktop.saveConnection({ host: "badhost", name: "bad" });
    const id = r.connections.find((p) => p.host === "badhost").id;
    try {
      await window.familiarDesktop.testConnection(id);
      return "allowed";
    } catch (err) {
      return String(err.message);
    } finally {
      await window.familiarDesktop.deleteConnection(id);
    }
  })()`);
  check(/SSH launch failed|Connection refused/.test(String(failedTest)), "unreachable host reports an error", String(failedTest));
} catch (err) {
  failed = true;
  check("ssh e2e completed without exceptions", false, String(err?.stack ?? err));
} finally {
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {
    app.kill("SIGTERM");
  }
  await sleep(1_000);
  try {
    spawn("pkill", ["-f", `remote-debugging-port=${DEBUG_PORT}`], { stdio: "ignore" });
  } catch {
    /* pkill unavailable */
  }
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failed || failures > 0 ? `ssh e2e: ${failures} failure(s)` : "ssh e2e: all ok");
process.exit(failed || failures > 0 ? 1 : 0);
