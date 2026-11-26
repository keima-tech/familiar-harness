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
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
/** A stale `/tmp/.mount_*` PATH entry (terminated AppImage) makes exec fail
 * with ENOTCONN — drop such entries for everything this test spawns. */
const CLEAN_PATH = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((p) => p !== "" && !p.startsWith("/tmp/.mount_"))
  .join(path.delimiter);
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

// the test process shares the isolated home with the app (core helpers use it)
process.env.FAMILIAR_HOME = localHome;

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

const KEYSCAN_MOCK = `#!/usr/bin/env node
"use strict";
const args = process.argv.slice(2);
let port = 22;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-p") { port = Number(args[++i]) || 22; continue; }
  if (args[i] === "-T") { args[++i]; continue; }
  if (args[i].startsWith("-")) continue;
  rest.push(args[i]);
}
const host = rest[0] || "unknown";
const field = port === 22 ? host : "[" + host + "]:" + port;
console.log("# " + field + " SSH-2.0-fake");
console.log(field + " ssh-ed25519 " + Buffer.from("familiar-test-ed25519").toString("base64"));
console.log(field + " ssh-rsa " + Buffer.from("familiar-test-rsa").toString("base64"));
`;
const keyscanMock = path.join(binDir, "fake-keyscan");
fs.writeFileSync(keyscanMock, KEYSCAN_MOCK);
fs.chmodSync(keyscanMock, 0o755);

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
if (host.startsWith("pw")) {
  let ok = false;
  try {
    ok = require("node:fs").readFileSync(process.env.FAMILIAR_ASKPASS_FILE || "", "utf8").trim() === "s3cret";
  } catch { ok = false; }
  if (!ok) {
    process.stderr.write("user@" + host + ": Permission denied (publickey,password).\\n");
    process.exit(255);
  }
}
if (host.startsWith("denied")) {
  process.stderr.write("user@" + host + ": Permission denied (publickey,password).\\n");
  process.exit(255);
}
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
            }, 60_000);
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

/** Evaluate once with an emulated viewport (narrow-screen media queries). */
async function evalAtViewport(width, height, expression) {
  const targets = await pageTargets();
  const target = targets[0];
  if (!target) throw new Error("no page target");
  const cdp = await openCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
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
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
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
      PATH: CLEAN_PATH,
      FAMILIAR_HOME: localHome,
      FAMILIAR_PORTS: LOCAL_PORTS.join(","),
      FAMILIAR_SPAWN_PORT: String(LOCAL_PORTS[0]),
      FAMILIAR_SSH_BIN: fakeSsh,
      FAKE_SSH_REMOTE_HOME: remoteHome, // the "remote" shell gets its own home
      FAKE_SSH_REMOTE_PATH: binDir, //     …and its own PATH (remote-only tools)
      FAMILIAR_SSH_KEYSCAN_BIN: keyscanMock, // fake ssh-keyscan (no sshd in tests)
      FAMILIAR_SSH_KNOWN_HOSTS: path.join(base, "known_hosts"),
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
  // the app persists the interface language; pin it for label-based checks
  await evalOnce(`typeof setLang === "function" ? (setLang("ja"), applyI18n(), 1) : 1`);

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
    if (inputs.length < 7) return { err: "form inputs missing: " + inputs.length };
    inputs[0].value = "Test remote";
    inputs[1].value = "remote1";
    inputs[2].value = "tester";
    inputs[6].value = ${JSON.stringify(shim)};
    // the form defaults to SSH proxy + password; this profile drives the
    // familiar-server (tunnel) flow, so pick serve + key explicitly
    const sels = [...document.querySelectorAll("#settings-content .ssh-field select")];
    const modeSel = sels.find((x) => [...x.options].some((o) => o.value === "serve"));
    if (modeSel) { modeSel.value = "serve"; modeSel.dispatchEvent(new Event("change")); }
    const authSel0 = sels.find((x) => [...x.options].some((o) => o.value === "password"));
    if (authSel0) { authSel0.value = "key"; authSel0.dispatchEvent(new Event("change")); }
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

  // ---- WebUI path: the same features through server RPCs (no desktop shell)
  const sharedStore = await evalOnce(`(async () => {
    const list = await rpcConnApi.connections();
    return { count: list.connections.length, hosts: list.connections.map((p) => p.host) };
  })()`);
  check(
    sharedStore?.hosts?.includes("remote1") && sharedStore?.hosts?.includes("proxy1"),
    "server RPCs read the profiles the desktop saved",
    JSON.stringify(sharedStore),
  );

  const webSaved = await evalOnce(`(async () => {
    const res = await rpcConnApi.saveConnection({ host: "web1", user: "tester", mode: "proxy", name: "Web proxy" });
    return { id: res.profile.id, mode: res.profile.mode, count: res.connections.length };
  })()`);
  check(webSaved?.mode === "proxy" && webSaved?.count >= 3, "RPC saves a profile from the WebUI", JSON.stringify(webSaved));
  const webProxyId = webSaved?.id ?? "";

  const probeResult = await evalOnce(`rpcConnApi.testConnection(${JSON.stringify(webProxyId)})`);
  check(
    probeResult?.ok === true && probeResult?.home === remoteHome && typeof probeResult?.familiar === "string" && probeResult?.hostname === os.hostname(),
    "RPC connection test probes the host",
    JSON.stringify(probeResult),
  );

  const desktopProxyTest = await evalOnce(`window.familiarDesktop.testConnection(${JSON.stringify(webProxyId)})`);
  check(
    desktopProxyTest?.ok === true && desktopProxyTest?.home === remoteHome,
    "the desktop shell tests proxy profiles via the server probe",
    JSON.stringify(desktopProxyTest),
  );

  const serveProfileId = await evalOnce(`(async () => {
    const list = await rpcConnApi.connections();
    return list.connections.find((p) => p.host === "remote1")?.id ?? "";
  })()`);
  const tunnel = await evalOnce(`rpcConnApi.connectProfile(${JSON.stringify(serveProfileId)}, { newSession: false })`);
  check(
    /^http:\/\/127\.0\.0\.1:\d+$/.test(String(tunnel?.url)) && /^[0-9a-f]{64}$/.test(String(tunnel?.token)) && /^[0-9a-f]{32}$/.test(String(tunnel?.stop)),
    "RPC connect opens a server-side tunnel",
    JSON.stringify({ url: tunnel?.url, stop: tunnel?.stop }),
  );
  const tunnelHealth = await fetch(`${tunnel.url}/healthz`, { headers: { Authorization: `Bearer ${tunnel.token}` } })
    .then((r) => r.json())
    .catch(() => null);
  check(tunnelHealth?.ok === true && tunnelHealth?.home === remoteHome, "the server tunnel reaches the remote server", JSON.stringify(tunnelHealth));
  const statusWhileUp = await evalOnce(`rpc("conn.status").then((r) => r.current)`);
  check(statusWhileUp?.id === serveProfileId && !!statusWhileUp?.hostname, "conn.status reports the active tunnel", JSON.stringify(statusWhileUp));

  const stopped = await fetch(`http://127.0.0.1:${LOCAL_PORTS[0]}/tunnel/stop?stop=${encodeURIComponent(String(tunnel.stop))}`, {
    headers: { Origin: `http://127.0.0.1:${LOCAL_PORTS[0]}` },
  })
    .then((r) => r.json())
    .catch(() => null);
  check(stopped?.ok === true, "the capability stop endpoint closes the tunnel", JSON.stringify(stopped));
  let tunnelGone = false;
  for (let i = 0; i < 30 && !tunnelGone; i++) {
    await new Promise((r) => setTimeout(r, 200));
    tunnelGone = await fetch(`${tunnel.url}/healthz`).then(() => false).catch(() => true);
  }
  check(tunnelGone, "the tunnel port is closed after the stop");
  const statusAfter = await evalOnce(`rpc("conn.status").then((r) => r.current)`);
  check(statusAfter === null, "conn.status is empty after the stop", JSON.stringify(statusAfter));

  // the remote URL a browser would navigate to is served end to end
  const secondTunnel = await evalOnce(`rpcConnApi.connectProfile(${JSON.stringify(serveProfileId)}, { newSession: true, cwd: ${JSON.stringify(remoteWork)} })`);
  const browserUrl = await evalOnce(`buildTunnelUrl(${JSON.stringify(secondTunnel)}, { newSession: true, cwd: ${JSON.stringify(remoteWork)} })`);
  const browserPage = await fetch(browserUrl).then((r) => ({ ok: r.ok, body: null, status: r.status })).catch(() => null);
  const browserHtml = browserPage?.ok ? await fetch(browserUrl).then((r) => r.text()) : "";
  check(
    browserPage?.ok === true && browserHtml.includes("new-session-overlay") && /stop=[0-9a-f]{32}/.test(browserUrl) && /local=http/.test(browserUrl),
    "the browser tunnel URL serves the remote UI with stop/local params",
    `${browserUrl.slice(0, 120)} status=${browserPage?.status}`,
  );
  await fetch(`http://127.0.0.1:${LOCAL_PORTS[0]}/tunnel/stop?stop=${encodeURIComponent(String(secondTunnel.stop))}`).catch(() => null);

  // the WebUI connection layer works without the desktop bridge
  const overrideWorked = await evalOnce(`(async () => {
    connApiOverride = rpcConnApi;
    try {
      openNewSessionModal();
      await new Promise((r) => setTimeout(r, 600));
      const rows = document.querySelectorAll("#ns-targets .ns-target-row").length;
      selectNsTarget(${JSON.stringify(webProxyId)});
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (document.querySelectorAll("#ns-remote-list .ns-row").length > 0) break;
      }
      const remoteRows = document.querySelectorAll("#ns-remote-list .ns-row").length;
      document.querySelector("#ns-remote-cwd").value = ${JSON.stringify(remoteWork)};
      await createSessionFromModal();
      const out = {
        rows,
        remoteRows,
        host: state.currentSession?.remote?.host ?? "",
        port: location.port,
      };
      if (state.sessionId) await rpc("session.delete", { id: state.sessionId });
      return out;
    } finally {
      connApiOverride = null;
      if (!document.querySelector("#new-session-overlay").hidden) closeNewSessionModal();
    }
  })()`);
  check(
    overrideWorked?.rows >= 4 && overrideWorked?.remoteRows > 0 && overrideWorked?.host === "web1" && overrideWorked?.port === String(LOCAL_PORTS[0]),
    "the WebUI connection layer creates proxy sessions without the desktop bridge",
    JSON.stringify(overrideWorked),
  );

  // ---- failure backoff: stop hammering a host after auth errors ------------
  const denied1 = await evalOnce(`(async () => {
    try { await rpc("conn.test", { profile: { host: "denied1", user: "tester" } }); return "allowed"; }
    catch (err) { return String(err.message); }
  })()`);
  check(/Permission denied/.test(String(denied1)), "auth failures surface the ssh error", String(denied1).slice(0, 160));
  const denied2 = await evalOnce(`(async () => {
    try { await rpc("conn.test", { profile: { host: "denied1", user: "tester" } }); return "allowed"; }
    catch (err) { return String(err.message); }
  })()`);
  check(/paused connection attempts/.test(String(denied2)), "repeated failures back off instead of hammering", String(denied2).slice(0, 160));
  const deniedDirs = await evalOnce(`(async () => {
    try { await rpc("fs.dirs", { path: "~", ssh: { host: "denied1", user: "tester" } }); return "allowed"; }
    catch (err) { return String(err.message); }
  })()`);
  check(/paused connection attempts/.test(String(deniedDirs)), "proxy file RPCs obey the backoff", String(deniedDirs).slice(0, 160));

  // ---- remote folder picker: bare names + suggestions -----------------------
  const barePicker = await evalOnce(`(async () => {
    connApiOverride = rpcConnApi;
    try {
      openNewSessionModal();
      await new Promise((r) => setTimeout(r, 600));
      selectNsTarget(${JSON.stringify(proxyId)});
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (document.querySelectorAll("#ns-remote-list .ns-row").length > 0) break;
      }
      const input = document.querySelector("#ns-remote-cwd");
      const note = () => document.querySelector("#ns-remote-list .files-note")?.textContent ?? "";
      document.querySelector("#ns-remote-list").innerHTML = ""; // no stale rows
      input.value = "wo";
      input.dispatchEvent(new Event("input"));
      let suggested = "";
      let previewWo = "";
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        previewWo = note();
        const row = [...document.querySelectorAll("#ns-remote-list .ns-row")].find((x) => x.textContent.includes("work"));
        if (row && previewWo.includes("/wo")) { suggested = row.textContent; break; }
      }
      // substring match: "ork" should still find "work"
      const box = () => document.querySelector("#ns-remote-list");
      box().innerHTML = "";
      input.value = "ork";
      input.dispatchEvent(new Event("input"));
      let substringHit = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if ([...box().querySelectorAll(".ns-row")].some((x) => x.textContent.includes("work"))) { substringHit = true; break; }
      }
      // drilling in shows a ".." row and the folder's children
      box().innerHTML = "";
      input.value = "work/";
      input.dispatchEvent(new Event("input"));
      let parentRow = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if ([...box().querySelectorAll(".ns-row")].some((x) => x.textContent.includes(".."))) { parentRow = true; break; }
      }
      const header = box().querySelector(".ns-label")?.textContent ?? "";
      input.value = "work";
      input.dispatchEvent(new Event("input"));
      let preview = "";
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        preview = note();
        if (preview.includes("/work")) break;
      }
      await createSessionFromModal();
      const out = {
        suggested,
        previewWo,
        preview,
        substringHit,
        parentRow,
        header,
        cwd: state.currentSession?.cwd ?? "",
        remote: state.currentSession?.remote?.host ?? "",
      };
      if (state.sessionId) await rpc("session.delete", { id: state.sessionId });
      return out;
    } finally {
      connApiOverride = null;
      if (!document.querySelector("#new-session-overlay").hidden) closeNewSessionModal();
    }
  })()`);
  check(barePicker?.suggested?.includes("work"), "typing a bare name suggests remote folders", JSON.stringify(barePicker).slice(0, 200));
  check(
    barePicker?.cwd === path.join(remoteHome, "work") && barePicker?.remote === "proxy1",
    "a bare name creates a remote-home session",
    JSON.stringify(barePicker).slice(0, 200),
  );
  check(
    String(barePicker?.previewWo ?? "").includes(path.join(remoteHome, "wo")) &&
      String(barePicker?.preview ?? "").includes(path.join(remoteHome, "work")),
    "the picker previews the resolved path",
    `wo=${barePicker?.previewWo} work=${barePicker?.preview}`,
  );
  check(barePicker?.substringHit === true, "suggestions also match mid-name", JSON.stringify(barePicker).slice(0, 160));
  check(
    barePicker?.parentRow === true && /候補/.test(String(barePicker?.header ?? "")),
    'drilling in shows ".." and a suggestion count',
    `parent=${barePicker?.parentRow} header=${barePicker?.header}`,
  );

  // a short dialog must not squeeze the list to zero height (phone layout):
  // the flex shrink used to collapse it to ~4px while the rows stayed "there"
  const squeeze = await evalOnce(`(async () => {
    connApiOverride = rpcConnApi;
    const modal = document.querySelector("#new-session-overlay .modal");
    const prev = modal.style.maxHeight;
    try {
      openNewSessionModal();
      await new Promise((r) => setTimeout(r, 600));
      selectNsTarget(${JSON.stringify(proxyId)});
      modal.style.maxHeight = "420px"; // simulate a short screen
      const input = document.querySelector("#ns-remote-cwd");
      input.value = "work";
      input.dispatchEvent(new Event("input"));
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (document.querySelector("#ns-remote-list .ns-row")) break;
      }
      const box = document.querySelector("#ns-remote-list");
      return {
        listH: Math.round(box.getBoundingClientRect().height),
        rows: box.querySelectorAll(".ns-row").length,
      };
    } finally {
      modal.style.maxHeight = prev;
      connApiOverride = null;
      if (!document.querySelector("#new-session-overlay").hidden) closeNewSessionModal();
    }
  })()`);
  check(
    squeeze?.listH >= 40 && squeeze?.rows >= 1,
    "the suggestion list survives short dialogs",
    JSON.stringify(squeeze),
  );

  // new profiles default to the no-install path: SSH proxy + password
  const formDefaults = await evalOnce(`(async () => {
    connApiOverride = rpcConnApi;
    try {
      sshEditId = null;
      openSettingsModal("connections");
      await new Promise((r) => setTimeout(r, 600));
      const form = document.querySelector("#settings-content > .card:last-of-type");
      return [...form.querySelectorAll("select")].map((x) => x.value);
    } finally {
      connApiOverride = null;
    }
  })()`);
  check(
    formDefaults?.[0] === "proxy" && formDefaults?.[1] === "password",
    "new profiles default to SSH proxy + password",
    JSON.stringify(formDefaults),
  );
  await evalOnce(`closeSettingsModal(); 1`);

  // ---- password auth: connect without keys or changes on the host ----------
  const authMod = await import(new URL("../../../packages/core/dist/exec/ssh-auth.js", import.meta.url).href);
  const pwTarget = { host: "pw1", user: "tester" };
  const secretFile = authMod.sshSecretPath(pwTarget);
  authMod.writeSshSecret(pwTarget, "s3cret");
  check(
    (fs.statSync(secretFile).mode & 0o777) === 0o600 && fs.readFileSync(secretFile, "utf8").trim() === "s3cret",
    "password secrets are stored 0600",
    secretFile,
  );
  const helper = authMod.askpassHelperPath();
  const helperOut = spawnSync("/bin/sh", [helper], {
    env: { ...process.env, FAMILIAR_ASKPASS_FILE: secretFile },
  }).stdout.toString().trim();
  check(helperOut === "s3cret", "the askpass helper returns the stored password", helperOut);
  authMod.deleteSshSecret(pwTarget);
  check(!authMod.hasSshSecret(pwTarget), "stored secrets can be cleared");

  const pwSaved = await evalOnce(
    `rpcConnApi.saveConnection({ host: "pw1", user: "tester", auth: "password", password: "s3cret", name: "PW host" })`,
  );
  check(
    pwSaved?.profile?.auth === "password" && (pwSaved.connections ?? []).some((x) => x.host === "pw1" && x.hasPassword === true),
    "RPC stores a password profile",
    JSON.stringify(pwSaved).slice(0, 200),
  );
  const pwTest = await evalOnce(`rpcConnApi.testConnection(${JSON.stringify(pwSaved.profile.id)})`);
  check(
    pwTest?.ok === true && pwTest?.hostname === os.hostname() && pwTest?.home === remoteHome,
    "password auth connects without a key",
    JSON.stringify(pwTest),
  );
  const expectedSecret = path.join(
    localHome,
    "secrets",
    `ssh-${crypto.createHash("sha256").update("tester@pw1:22").digest("hex").slice(0, 16)}.pass`,
  );
  check(fs.existsSync(expectedSecret), "the secret lands in the familiar home", expectedSecret);
  check(
    !fs.readFileSync(path.join(localHome, "desktop.json"), "utf8").includes("s3cret"),
    "profiles never contain the password",
  );
  check(!fs.readFileSync(path.join(localHome, "state.db")).includes("s3cret"), "sessions never contain the password");

  const pwSession = await evalOnce(`(async () => {
    const s = await rpc("session.create", { cwd: ${JSON.stringify(remoteWork)}, ssh: { host: "pw1", user: "tester" } });
    await rpc("session.send", { id: s.id, text: "@write pw-note.txt", yolo: true });
    await rpc("session.delete", { id: s.id });
    return { cwd: s.cwd };
  })()`);
  await waitFor(() => fs.existsSync(path.join(remoteWork, "pw-note.txt")), "password session write", 30_000);
  check(pwSession?.cwd === remoteWork && fs.existsSync(path.join(remoteWork, "pw-note.txt")), "tool calls work over password auth");

  await evalOnce(`rpcConnApi.saveConnection({ host: "pw2", user: "tester", auth: "password", password: "wrong" })`);
  const pwBad = await evalOnce(`(async () => {
    const list = await rpcConnApi.connections();
    const id = list.connections.find((x) => x.host === "pw2")?.id;
    try { await rpcConnApi.testConnection(id); return "allowed"; }
    catch (err) { return String(err.message); }
  })()`);
  check(/Permission denied/.test(String(pwBad)), "a wrong password reports the ssh error", String(pwBad).slice(0, 140));

  const pwForm = await evalOnce(`(async () => {
    connApiOverride = rpcConnApi;
    try {
      openSettingsModal("connections");
      await new Promise((r) => setTimeout(r, 600));
      const inputs = () => [...document.querySelectorAll("#settings-content .ssh-field input")];
      inputs()[0].value = "PW form";
      inputs()[1].value = "pw3";
      inputs()[2].value = "tester";
      const authSel = [...document.querySelectorAll("#settings-content .ssh-field select")]
        .find((x) => [...x.options].some((o) => o.value === "password"));
      authSel.value = "password";
      authSel.dispatchEvent(new Event("change"));
      const pwInput = inputs().find((i) => i.type === "password");
      pwInput.value = "s3cret";
      [...document.querySelectorAll("#settings-content .conn-actions button")]
        .find((b) => b.textContent.trim() === "保存")
        .click();
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const list = await rpcConnApi.connections();
        if (list.connections.some((x) => x.host === "pw3" && x.hasPassword)) return { ok: true };
      }
      return { ok: false };
    } finally {
      connApiOverride = null;
    }
  })()`);
  check(pwForm?.ok === true, "the settings form saves password profiles");
  await evalOnce(`closeSettingsModal(); 1`);

  // typing a password and pressing Test must save it first, then connect
  const pwAutoSave = await evalOnce(`(async () => {
    connApiOverride = rpcConnApi;
    try {
      openSettingsModal("connections");
      await new Promise((r) => setTimeout(r, 600));
      const inputs = () => [...document.querySelectorAll("#settings-content .ssh-field input")];
      inputs()[0].value = "PW auto";
      inputs()[1].value = "pw4";
      inputs()[2].value = "tester";
      const authSel = [...document.querySelectorAll("#settings-content .ssh-field select")]
        .find((x) => [...x.options].some((o) => o.value === "password"));
      authSel.value = "password";
      authSel.dispatchEvent(new Event("change"));
      inputs().find((i) => i.type === "password").value = "s3cret";
      // click the FORM's test button (the first match is a row-level one)
      const form = document.querySelector("#settings-content > .card:last-of-type");
      const fout = () => form.querySelector(".conn-result")?.textContent ?? "";
      [...form.querySelectorAll(".conn-actions button")]
        .find((b) => /接続テスト|test/i.test(b.textContent))
        .click();
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (fout().includes("✓") || fout().includes("✗")) break;
      }
      const list = await rpcConnApi.connections();
      const saved = list.connections.find((x) => x.host === "pw4");
      return { result: fout(), hasPassword: !!saved?.hasPassword, id: saved?.id ?? "" };
    } finally {
      connApiOverride = null;
    }
  })()`);
  check(
    pwAutoSave?.result?.includes("✓") && pwAutoSave?.hasPassword === true,
    "typing a password and testing saves it first",
    JSON.stringify(pwAutoSave).slice(0, 200),
  );
  await evalOnce(`closeSettingsModal(); 1`);

  // deleting a profile through the RPC layer removes it and its secret
  const pw4Secret = path.join(
    localHome,
    "secrets",
    `ssh-${crypto.createHash("sha256").update("tester@pw4:22").digest("hex").slice(0, 16)}.pass`,
  );
  const delResult = await evalOnce(`(async () => {
    await rpcConnApi.deleteConnection(${JSON.stringify(pwAutoSave?.id ?? "")});
    const list = await rpcConnApi.connections();
    return { gone: !list.connections.some((x) => x.host === "pw4") };
  })()`);
  check(
    delResult?.gone === true && !fs.existsSync(pw4Secret),
    "deleting a profile removes it and its stored password",
    JSON.stringify(delResult),
  );

  // ---- host-key verification (ssh-keyscan fingerprints → known_hosts) ------
  const knownHostsFile = path.join(base, "known_hosts");
  const scan = await evalOnce(`rpc("conn.hostkey", { host: "remote1", port: 22 })`);
  check(
    scan?.keys?.length === 2 &&
      scan.keys.every((k) => /^SHA256:/.test(k.fingerprint)) &&
      scan?.knownHosts === knownHostsFile,
    "conn.hostkey scans and fingerprints keys",
    JSON.stringify(scan).slice(0, 200),
  );
  const trust1 = await evalOnce(
    `rpc("conn.trusthost", { host: "remote1", port: 22, keys: ${JSON.stringify(scan.keys.map((k) => k.line))} })`,
  );
  check(trust1?.added === 2 && trust1?.skipped === 0, "conn.trusthost adds scanned keys", JSON.stringify(trust1));
  const knownHostsText = fs.readFileSync(knownHostsFile, "utf8");
  check(
    knownHostsText.includes(scan.keys[0].line) &&
      knownHostsText.includes(scan.keys[1].line) &&
      (fs.statSync(knownHostsFile).mode & 0o777) === 0o600,
    "known_hosts gets the verified lines with mode 0600",
    knownHostsText.slice(0, 120),
  );
  const trust2 = await evalOnce(
    `rpc("conn.trusthost", { host: "remote1", port: 22, keys: ${JSON.stringify(scan.keys.map((k) => k.line))} })`,
  );
  check(trust2?.added === 0 && trust2?.skipped === 2, "re-trusting the same keys is a no-op", JSON.stringify(trust2));

  const otherBlob = Buffer.from("familiar-other-key").toString("base64");
  fs.writeFileSync(knownHostsFile, `remote1 ssh-ed25519 ${otherBlob}\n`);
  const conflict = await evalOnce(`(async () => {
    try {
      await rpc("conn.trusthost", { host: "remote1", port: 22, keys: ${JSON.stringify([scan.keys[0].line])} });
      return "allowed";
    } catch (err) {
      return String(err.message);
    }
  })()`);
  check(/CHANGED/.test(String(conflict)), "a changed host key is refused", String(conflict).slice(0, 180));

  const scanPort = await evalOnce(`rpc("conn.hostkey", { host: "remote1", port: 2222 })`);
  check(
    scanPort?.keys?.length === 2 && scanPort.keys.every((k) => k.host === "[remote1]:2222"),
    "keyscan uses the [host]:port field for non-22 ports",
    JSON.stringify(scanPort?.keys?.map((k) => k.host)),
  );
  const trustPort = await evalOnce(
    `rpc("conn.trusthost", { host: "remote1", port: 2222, keys: ${JSON.stringify(scanPort.keys.map((k) => k.line))} })`,
  );
  check(trustPort?.added === 2, "non-22 keys register with the bracketed host", JSON.stringify(trustPort));

  const ipcScan = await evalOnce(`window.familiarDesktop.hostKeyScan({ host: "remote1", port: 22 })`);
  check(
    ipcScan?.keys?.length === 2,
    "the desktop shell delegates host-key scans to the server",
    JSON.stringify(ipcScan?.keys?.map((k) => k.fingerprint)),
  );

  const uiRows = await evalOnce(`(async () => {
    connApiOverride = rpcConnApi;
    try {
      openSettingsModal("connections");
      await new Promise((r) => setTimeout(r, 600));
      const inputs = [...document.querySelectorAll("#settings-content .ssh-field input")];
      inputs[0].value = "Key test";
      inputs[1].value = "keyscan-ui";
      [...document.querySelectorAll("#settings-content .conn-actions button")]
        .find((b) => /ホスト鍵|host key/i.test(b.textContent))
        .click();
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (document.querySelectorAll("#settings-content .ssh-hostkey-row").length > 0) break;
      }
      const rows = document.querySelectorAll("#settings-content .ssh-hostkey-row").length;
      const box = document.querySelector("#settings-content .ssh-hostkey");
      [...box.querySelectorAll("button")].find((b) => /登録|trust/i.test(b.textContent)).click();
      return { rows };
    } finally {
      connApiOverride = null;
    }
  })()`);
  await waitFor(() => fs.readFileSync(knownHostsFile, "utf8").includes("keyscan-ui"), "UI host-key trust", 20_000);
  check(uiRows?.rows === 2 && fs.readFileSync(knownHostsFile, "utf8").includes("keyscan-ui"), "the settings form verifies and trusts keys", JSON.stringify(uiRows));
  await evalOnce(`closeSettingsModal(); 1`);

  // ---- UI polish: empty state, target badges, queue, code copy --------------
  const emptyState = await evalOnce(`(async () => {
    const created = await rpc("session.create", { cwd: ${JSON.stringify(repoRoot)} });
    await openSession(created.id);
    await new Promise((r) => setTimeout(r, 400));
    const before = document.querySelectorAll("#transcript .empty-state").length;
    document.querySelector("#input").value = "hello there";
    await send();
    await new Promise((r) => setTimeout(r, 900));
    return {
      before,
      after: document.querySelectorAll("#transcript .empty-state").length,
      bubbles: document.querySelectorAll("#transcript .msg.user").length,
      logo: !!document.querySelector("#transcript .empty-state") || true,
    };
  })()`);
  check(
    emptyState?.before === 1 && emptyState?.after === 0 && emptyState?.bubbles >= 1,
    "the empty-state placeholder disappears on the first message",
    JSON.stringify(emptyState),
  );

  const badge = await evalOnce(`(async () => {
    const local = await rpc("session.create", { cwd: ${JSON.stringify(remoteWork)} });
    const proxy = await rpc("session.create", { cwd: ${JSON.stringify(remoteWork)}, ssh: { host: "proxy1", user: "tester" } });
    await refreshSessions();
    await new Promise((r) => setTimeout(r, 400));
    const rows = [...document.querySelectorAll("#sessions .folder-row")]
      .filter((r) => r.dataset.cwd === ${JSON.stringify(remoteWork)})
      .map((r) => ({ target: r.dataset.target, badge: r.querySelector(".ftarget")?.textContent.trim() ?? "", count: r.querySelector(".fcount")?.textContent ?? "" }));
    return { rows, localId: local.id, proxyId: proxy.id };
  })()`);
  const badgeTargets = (badge?.rows ?? []).map((r) => r.target).sort();
  check(
    badge?.rows?.length === 2 &&
      badgeTargets[0] === "local" &&
      badgeTargets[1] === "tester@proxy1" &&
      badge.rows.some((r) => r.badge.includes("ローカル")) &&
      badge.rows.some((r) => r.badge.includes("tester@proxy1")),
    "folder groups distinguish local from SSH targets",
    JSON.stringify(badge?.rows),
  );

  // steering: while a turn runs, sending injects the text into it (no queue)
  const steer = await evalOnce(`(async () => {
    const real = rpc;
    const calls = [];
    rpc = async (m) => { calls.push(m); return { steered: true, pending: 1 }; };
    setBusy(true);
    document.querySelector("#input").value = "steer this";
    await send();
    const steered = calls.includes("session.steer");
    const chips = document.querySelectorAll("#queue-strip .queue-chip").length;
    const bubbleSeen = [...document.querySelectorAll("#transcript .msg.user")].some((m) => m.textContent.includes("steer this"));
    rpc = real;
    setBusy(false);
    return { steered, chips, bubbleSeen };
  })()`);
  check(
    steer?.steered === true && steer?.chips === 0 && steer?.bubbleSeen === true,
    "sending while busy steers the running turn (no queue chip)",
    JSON.stringify(steer),
  );

  // one button: ■ while busy + empty (stop), ↑ otherwise (send/steer)
  const oneButton = await evalOnce(`(async () => {
    const real = rpc; rpc = async () => ({ aborted: true });
    const input = document.querySelector("#input");
    input.value = "";
    setBusy(true);
    const busyEmpty = document.querySelector("#send").textContent;
    let stopped = false;
    const realStop = stopTurn; stopTurn = () => { stopped = true; };
    composerAction(); // busy + empty => stop
    stopTurn = realStop;
    input.value = "x";
    refreshSendButton();
    const busyTyped = document.querySelector("#send").textContent;
    setBusy(false);
    const idle = document.querySelector("#send").textContent;
    input.value = "";
    refreshSendButton();
    rpc = real;
    return { busyEmpty, busyTyped, idle, stopped };
  })()`);
  check(
    oneButton?.busyEmpty === "■" && oneButton?.busyTyped === "↑" && oneButton?.idle === "↑" && oneButton?.stopped === true,
    "the single send button is ■ while busy+empty (stop) and ↑ otherwise",
    JSON.stringify(oneButton),
  );

  // /compact: the composer command runs session.compact
  const compactCmd = await evalOnce(`(async () => {
    const real = rpc; const calls = [];
    rpc = async (m) => {
      calls.push(m);
      if (m === "session.get") return { session: { id: "x", cwd: "" }, messages: [] };
      return { compacted: true, dropped: 3, kept: 5 };
    };
    const listed = COMMANDS.some((c) => c.cmd === "/compact");
    const hadSession = state.sessionId;
    state.sessionId = state.sessionId ?? "fake";
    let threw = "";
    try { await compactContext(); } catch (e) { threw = String(e?.message ?? e); }
    state.sessionId = hadSession;
    rpc = real;
    return { listed, called: calls.includes("session.compact"), threw };
  })()`);
  check(
    compactCmd?.listed === true && compactCmd?.called === true && compactCmd?.threw === "",
    "/compact runs session.compact from the composer",
    JSON.stringify(compactCmd),
  );

  // fallback: a send the server rejects (turn running on another client) queues
  const otherDev = await evalOnce(`(async () => {
    const real = rpc;
    rpc = async (m) => {
      if (m === "session.send") throw new Error("a turn is already running for this session (stop it first)");
      return {};
    };
    state.busy = false;
    document.querySelector("#input").value = "from another device";
    await send();
    await new Promise((r) => setTimeout(r, 200));
    const chips = [...document.querySelectorAll("#queue-strip .queue-chip")].map((c) => c.textContent.trim());
    rpc = real;
    state.queue.length = 0;
    renderQueueStrip();
    setBusy(false);
    return { chips };
  })()`);
  check(
    (otherDev?.chips ?? []).some((c) => c.includes("from another device")),
    "a send rejected because a turn runs elsewhere is queued (fallback)",
    JSON.stringify(otherDev),
  );

  // phone (coarse pointer + narrow): Enter inserts a newline, it does not send
  const mobileEnter = await evalOnce(`(async () => {
    const real = window.matchMedia;
    window.matchMedia = (q) => (String(q).includes("coarse") || String(q).includes("max-width: 900px"))
      ? { matches: true, addEventListener() {}, removeEventListener() {} }
      : real.call(window, q);
    const input = document.querySelector("#input");
    const isMobile = mobileComposer();
    applyComposerPlaceholder();
    const ph = input.placeholder;
    input.value = "abc";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const kept = input.value;
    const queued = state.queue.length;
    window.matchMedia = real;
    applyComposerPlaceholder();
    input.value = "";
    return { isMobile, ph, kept, queued };
  })()`);
  check(
    mobileEnter?.isMobile === true && /↑/.test(String(mobileEnter?.ph)),
    "a coarse pointer + narrow width is treated as mobile (Enter=newline hint)",
    JSON.stringify(mobileEnter),
  );
  check(
    mobileEnter?.kept === "abc" && mobileEnter?.queued === 0,
    "on mobile Enter does not send (newline) and is not queued",
    JSON.stringify({ kept: mobileEnter?.kept, queued: mobileEnter?.queued }),
  );

  const copyCheck = await evalOnce(`(async () => {
    const fence = String.fromCharCode(96).repeat(3);
    appendMessage("assistant", fence + "js" + String.fromCharCode(10) + "const x = 1;" + String.fromCharCode(10) + fence);
    await new Promise((r) => setTimeout(r, 150));
    const btn = document.querySelector("#transcript .code-copy");
    if (!btn) return { err: "no copy button" };
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return { text: btn.textContent, copied: btn.classList.contains("copied") };
  })()`);
  check(
    copyCheck?.copied === true || copyCheck?.text === "✓",
    "the code-block copy button works on live messages",
    JSON.stringify(copyCheck),
  );

  // ---- duplicate-send protection, pending bubble, Enter-while-busy ---------
  // `@hold <ms>` keeps a mock turn (and its session lock) open, so a stale
  // client that sends the same text is rejected with the running text and
  // must NOT queue a duplicate delivery.
  const dupGuard = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = await rpc("session.create", { cwd: ${JSON.stringify(repoRoot)} });
    const p1 = rpc("session.send", { id: s.id, text: "@hold 1800 dup-check" }).catch(() => null);
    await sleep(420);
    await openSession(s.id);
    const runningDuring = (await rpc("session.get", { id: s.id })).running === true;
    state.busy = false; // a stale client does not know the turn is alive
    await sendTurn("@hold 1800 dup-check", []);
    const queued = state.queue.length;
    const busyAfterDup = state.busy === true;
    const msgs1 = (await rpc("session.get", { id: s.id })).messages.filter((m) => m.role === "user").length;
    await p1;
    await sleep(900); // a (wrong) queue drain would fire here
    const msgs2 = (await rpc("session.get", { id: s.id })).messages.filter((m) => m.role === "user").length;
    return { runningDuring, queued, busyAfterDup, msgs1, msgs2, queue: state.queue.length };
  })()`);
  check(dupGuard?.runningDuring === true, "session.get reports a live turn", JSON.stringify(dupGuard));
  check(
    dupGuard?.queued === 0 && dupGuard?.queue === 0,
    "the identical text is not queued as a duplicate",
    JSON.stringify(dupGuard),
  );
  check(
    dupGuard?.msgs1 === 1 && dupGuard?.msgs2 === 1,
    "the duplicate never reaches the session",
    JSON.stringify(dupGuard),
  );

  const queueOther = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = await rpc("session.create", { cwd: ${JSON.stringify(repoRoot)} });
    const p1 = rpc("session.send", { id: s.id, text: "@hold 1500 first" }).catch(() => null);
    await sleep(420);
    await openSession(s.id);
    state.busy = false;
    await sendTurn("@hold 1500 second", []);
    const chips = state.queue.length;
    await p1;
    for (let i = 0; i < 25; i++) {
      if (!(await rpc("session.get", { id: s.id })).running) break;
      await sleep(200);
    }
    const users = (await rpc("session.get", { id: s.id })).messages
      .filter((m) => m.role === "user")
      .map((m) => String(m.content));
    return { chips, users, queue: state.queue.length };
  })()`);
  check(queueOther?.chips === 1, "a different instruction waits in the queue", JSON.stringify(queueOther));
  check(
    queueOther?.users?.length === 2 &&
      queueOther.users[0].includes("first") &&
      queueOther.users[1].includes("second"),
    "the queued instruction is delivered exactly once after the turn",
    JSON.stringify(queueOther),
  );

  const pending = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = await rpc("session.create", { cwd: ${JSON.stringify(repoRoot)} });
    await openSession(s.id);
    void sendTurn("@hold 1200 bubble-check", []);
    await sleep(350);
    const node = document.querySelector("#transcript .pending-turn");
    const during = node !== null;
    await sleep(1700);
    const after = document.querySelector("#transcript .pending-turn") !== null;
    for (let i = 0; i < 25; i++) {
      if (!(await rpc("session.get", { id: s.id })).running) break;
      await sleep(200);
    }
    return { during, after };
  })()`);
  check(pending?.during === true, "the received placeholder shows before the first token", JSON.stringify(pending));
  check(pending?.after === false, "the placeholder is replaced once tokens stream", JSON.stringify(pending));

  const enterSteer = await evalOnce(`(async () => {
    const real = rpc; const calls = [];
    rpc = async (m) => { calls.push(m); return { steered: true }; };
    state.busy = true;
    state.busySessionId = state.sessionId;
    state.lastUserText = "previous turn text";
    const input = document.querySelector("#input");
    input.value = "steered via Enter";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 120));
    rpc = real;
    state.busy = false;
    state.busySessionId = null;
    return { steered: calls.includes("session.steer"), cleared: input.value === "" };
  })()`);
  check(
    enterSteer?.steered === true && enterSteer?.cleared === true,
    "Enter while busy steers the running turn (does not stop it)",
    JSON.stringify(enterSteer),
  );

  // ---- auto-continue notices, stop retry, long-wait hint -------------------
  const notices = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = document.querySelectorAll("#transcript .turn-note").length;
    onEvent(state.sessionId, { type: "turn.continuing", turnId: "t1", kind: "steps", step: 25, ceiling: 100 });
    onEvent(state.sessionId, { type: "turn.ceiling", turnId: "t2", step: 100 });
    await sleep(100);
    const notes = [...document.querySelectorAll("#transcript .turn-note")].map((n) => n.textContent);
    const action = document.querySelector("#turn-label .label-action")?.textContent ?? "";
    document.querySelector("#turn-label").textContent = "";
    return { added: notes.length - before, last: notes.slice(-2).join(" / "), action };
  })()`);
  check(
    notices?.added === 2 && String(notices?.last).includes("自動継続") && String(notices?.last).includes("上限"),
    "auto-continue and ceiling notices appear in the transcript",
    JSON.stringify(notices),
  );
  check(String(notices?.action).includes("続けて"), "the ceiling offers a one-click continue", JSON.stringify(notices));

  const retryBtn = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    state.lastUserText = "retry target text";
    state.busySessionId = state.sessionId; // the turn was started from here
    onEvent(state.sessionId, { type: "turn.aborted", turnId: "t3" });
    await sleep(100);
    const btn = document.querySelector("#turn-label .label-action");
    const label = document.querySelector("#turn-label").textContent;
    document.querySelector("#turn-label").textContent = "";
    state.lastUserText = "";
    return { hasBtn: btn !== null, label };
  })()`);
  check(
    retryBtn?.hasBtn === true && String(retryBtn?.label).includes("停止"),
    "a stopped turn offers a one-click retry",
    JSON.stringify(retryBtn),
  );

  const longWait = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = await rpc("session.create", { cwd: ${JSON.stringify(repoRoot)} });
    await openSession(s.id);
    const prev = state.pendingHintMs;
    state.pendingHintMs = 60;
    void sendTurn("@hold 2200 hint-check", []);
    await sleep(400);
    const hinted = document.querySelector("#transcript .pending-label")?.textContent ?? "";
    state.pendingHintMs = prev;
    for (let i = 0; i < 30; i++) {
      if (!(await rpc("session.get", { id: s.id })).running) break;
      await sleep(200);
    }
    await sleep(300);
    return { hinted };
  })()`);
  check(
    String(longWait?.hinted).includes("まだ応答を待っています"),
    "the pending bubble explains a long first-token wait",
    JSON.stringify(longWait),
  );

  // ---- filtering must not rewrite the saved fold state ---------------------
  const filterFolds = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    localStorage.removeItem("familiar.folderFolds");
    await refreshSessions();
    await sleep(400);
    const rows = () => [...document.querySelectorAll("#sessions .folder-row")];
    document.querySelector("#fold-all-btn").click();
    await sleep(700);
    const collapsed = rows().length > 0 && rows().every((r) => r.querySelector(".chev").textContent === "\u25b8");
    const before = localStorage.getItem("familiar.folderFolds");
    const filter = document.querySelector("#session-filter");
    filter.value = "e";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(500);
    const openWhileFiltering = rows().every((r) => r.querySelector(".chev").textContent === "\u25be");
    const after = localStorage.getItem("familiar.folderFolds");
    filter.value = "";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
    const back = rows().every((r) => r.querySelector(".chev").textContent === "\u25b8");
    localStorage.removeItem("familiar.folderFolds");
    await refreshSessions();
    return { collapsed, openWhileFiltering, unchanged: before === after, back };
  })()`);
  check(
    filterFolds?.collapsed === true &&
      filterFolds?.openWhileFiltering === true &&
      filterFolds?.unchanged === true &&
      filterFolds?.back === true,
    "filtering opens folders without rewriting the saved fold state",
    JSON.stringify(filterFolds),
  );

  // ---- settings: Office templates -----------------------------------------
  {
    const tplDir = path.join(localHome, "templates");
    fs.mkdirSync(tplDir, { recursive: true });
    const { createOfficeCreateTool } = await import(
      path.join(repoRoot, "packages/core/dist/tools/office.js")
    );
    await createOfficeCreateTool().execute(
      { kind: "docx", path: path.join(tplDir, "house.docx"), title: "house", blocks: [{ text: "t" }] },
      {
        sessionId: "e2e",
        cwd: tplDir,
        yolo: true,
        config: { homeDir: localHome },
        approval: { request: async () => true },
        backend: {
          path,
          mkdirp: async (d) => fs.mkdirSync(d, { recursive: true }),
          writeFile: async (f, data) => fs.writeFileSync(f, data),
        },
      },
    );
  }
  const tplSettings = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    openSettingsModal("templates");
    await sleep(700);
    const content = document.querySelector("#settings-content");
    return {
      hasAdd: content.querySelector(".tpl-add") !== null,
      rows: [...content.querySelectorAll(".setting-row")].map((r) => r.textContent),
      how: content.querySelector(".note")?.textContent ?? "",
    };
  })()`);
  check(
    tplSettings?.hasAdd === true && (tplSettings?.rows ?? []).some((r) => r.includes("house")),
    "the templates settings section lists registered templates",
    JSON.stringify(tplSettings),
  );
  check(
    String(tplSettings?.how).includes("office_create"),
    "the templates section explains how they are used",
    String(tplSettings?.how),
  );

  // ---- top-bar layout + no proposals section ------------------------------
  const props = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    openSettingsModal("general");
    await sleep(600);
    const navItems = [...document.querySelectorAll("#settings-nav .nav-item")];
    const nav = navItems.map((n) => n.textContent);
    const navSections = navItems.map((n) => n.dataset.section);
    closeSettingsModal();
    const gear = document.querySelector(".top-actions #open-settings");
    const gauge = document.querySelector(".top-actions #ctx-gauge");
    const folder = document.querySelector("#pane-toggle");
    const order = [...document.querySelectorAll(".top-actions > *")].map((el) => el.id || el.className);
    return {
      nav,
      navSections,
      hasProposalsSection: nav.some((n) => n.includes("提案")),
      hasExtensionsSection: navSections.includes("extensions"),
      hasSkillsSection: navSections.includes("skills"),
      hasConnectorsSection: navSections.includes("connectors"),
      skillsLabel: nav.some((n) => n.includes("スキル")),
      connectorsLabel: nav.some((n) => n.includes("コネクタ")),
      todoChip: !!document.querySelector("#todo-progress"),
      todoFn: typeof refreshTodoProgress === "function",
      gearLeftOfGauge: !!(gear && gauge) && (gear.compareDocumentPosition(gauge) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      folderSvg: !!(folder && folder.querySelector("svg")),
      folderInTop: !!document.querySelector(".top-actions #pane-toggle"),
      gearInSide: !!document.querySelector("#sidebar #open-settings"),
      order,
    };
  })()`);
  check(
    props?.hasProposalsSection === false,
    "settings has no proposals section",
    JSON.stringify(props?.nav),
  );
  check(
    props?.hasExtensionsSection === false &&
      props?.hasSkillsSection === true && props?.hasConnectorsSection === true &&
      props?.skillsLabel === true && props?.connectorsLabel === true,
    "settings replaces Extensions with independent Skills and Connectors sections",
    JSON.stringify(props),
  );
  check(
    props?.todoChip === true && props?.todoFn === true,
    "the top bar has a task-progress chip",
    JSON.stringify({ chip: props?.todoChip, fn: props?.todoFn }),
  );
  check(
    props?.gearLeftOfGauge === true && props?.gearInSide === false,
    "the settings gear sits left of the context gauge",
    JSON.stringify({ left: props?.gearLeftOfGauge, side: props?.gearInSide, order: props?.order }),
  );
  check(
    props?.folderSvg === true && props?.folderInTop === true,
    "the file pane uses a monochrome folder icon in the top bar",
    JSON.stringify({ svg: props?.folderSvg, top: props?.folderInTop }),
  );

  // ---- skills: filter + bulk delete ---------------------------------------
  const extUi = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    openSettingsModal("skills");
    const c = document.querySelector("#settings-content");
    for (let i = 0; i < 50; i++) {
      const summary = c.querySelector(".skill-details summary")?.textContent?.trim() ?? "";
      if (summary || c.querySelector(".status-err")) break;
      await sleep(100);
    }
    const rows = [...c.querySelectorAll(".skill-row")];
    const external = rows.filter((r) => r.classList.contains("skill-external"));
    const familiar = rows.filter((r) => !r.classList.contains("skill-external"));
    // open the first external skill: its editor must be view-only
    let extEditor = null;
    const firstExternal = external[0];
    if (firstExternal) {
      firstExternal.querySelector(".skill-open").click();
      for (let i = 0; i < 20; i++) {
        const next = firstExternal.nextElementSibling;
        if (next?.classList.contains("skill-editor")) break;
        await sleep(100);
      }
      const ed = firstExternal.nextElementSibling;
      if (ed && ed.classList.contains("skill-editor")) {
        const acts = [...ed.querySelectorAll(".skill-editor-actions button")];
        extEditor = {
          readOnly: ed.querySelector(".skill-editor-body")?.readOnly === true,
          saveHidden: acts[0]?.hidden === true,
          deleteHidden: !!ed.querySelector(".ghost.danger")?.hidden,
        };
      }
    }
    const res = {
      skillsCard: !!c.querySelector('.card[data-section="skills"]'),
      hasMcp: !!c.querySelector('.card[data-section="mcp"]'),
      hasLsp: !!c.querySelector('.card[data-section="lsp"]'),
      filter: !!c.querySelector(".skill-toolbar .skill-filter"),
      selAll: [...c.querySelectorAll(".skill-toolbar .ghost")].some((b) => /選択|select all/i.test(b.textContent)),
      delDisabled: !!c.querySelector(".skill-toolbar .ghost.danger")?.disabled,
      externalRows: external.length,
      familiarRows: familiar.length,
      externalReadOnly: external.every((r) => !!r.querySelector(".skill-badge") && !r.querySelector(".skill-check")),
      familiarSelectable: familiar.every((r) => !!r.querySelector(".skill-check")),
      extEditor,
    };
    closeSettingsModal();
    return res;
  })()`);
  check(
    extUi?.skillsCard === true && extUi?.hasMcp === false && extUi?.hasLsp === false,
    "the Skills section owns only the skills catalog",
    JSON.stringify(extUi),
  );
  check(
    extUi?.filter === true && extUi?.selAll === true && extUi?.delDisabled === true,
    "the skills section has a filter and a (disabled) bulk delete",
    JSON.stringify(extUi),
  );
  check(
    extUi?.externalReadOnly === true && extUi?.familiarSelectable === true,
    "external (global/shared) skills are read-only and not selectable for deletion",
    JSON.stringify({ externalRows: extUi?.externalRows, familiarRows: extUi?.familiarRows, ro: extUi?.externalReadOnly }),
  );
  check(
    (extUi?.externalRows ?? 0) === 0 ||
      (extUi?.extEditor?.readOnly === true && extUi?.extEditor?.saveHidden === true &&
        extUi?.extEditor?.deleteHidden === true),
    "an external skill opens as a view-only editor (no save, no delete)",
    JSON.stringify(extUi?.extEditor),
  );

  // ---- connectors: service settings + MCP / LSP servers --------------------
  const connectorUi = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    openSettingsModal("connectors");
    const c = document.querySelector("#settings-content");
    for (let i = 0; i < 50; i++) {
      const ready = !!c.querySelector('.card[data-section="mcp"]') &&
        !!c.querySelector('.card[data-section="lsp"]') &&
        !!c.querySelector('.card[data-connector="google"]') &&
        !!c.querySelector('.card[data-connector="github"]');
      if (ready) break;
      await sleep(100);
    }
    const serverGroup = c.querySelector('[data-connector-group="servers"]');
    const serviceGroup = c.querySelector('[data-connector-group="services"]');
    const mcpCard = serverGroup?.querySelector('.card[data-section="mcp"]');
    const lspCard = serverGroup?.querySelector('.card[data-section="lsp"]');
    const externalCards = [...c.querySelectorAll('.card[data-connector]')];
    const serverStyle = serverGroup ? getComputedStyle(serverGroup) : null;
    const frameEdges = serverStyle
      ? ["Top", "Right", "Bottom", "Left"].every((side) =>
          serverStyle["border" + side + "Style"] !== "none" &&
          Number.parseFloat(serverStyle["border" + side + "Width"]) > 0)
      : false;
    const res = {
      mcp: !!c.querySelector('.card[data-section="mcp"]'),
      lsp: !!c.querySelector('.card[data-section="lsp"]'),
      google: !!c.querySelector('.card[data-connector="google"]'),
      github: !!c.querySelector('.card[data-connector="github"]'),
      skillsCard: !!c.querySelector('.card[data-section="skills"]'),
      serverGroup: !!serverGroup,
      serviceGroup: !!serviceGroup,
      serverGroupFramed: frameEdges,
      serverGroupBackground: !!serverStyle &&
        serverStyle.backgroundColor !== "rgba(0, 0, 0, 0)" && serverStyle.backgroundColor !== "transparent",
      mcpInServerGroup: !!mcpCard,
      lspInServerGroup: !!lspCard,
      externalCardCount: externalCards.length,
      allExternalInServiceGroup: externalCards.length > 0 &&
        externalCards.every((card) => serviceGroup?.contains(card)),
      noExternalInServerGroup: externalCards.length > 0 &&
        externalCards.every((card) => !serverGroup?.contains(card)),
    };
    closeSettingsModal();
    return res;
  })()`);
  check(
    connectorUi?.mcp === true && connectorUi?.lsp === true &&
      connectorUi?.google === true && connectorUi?.github === true &&
      connectorUi?.skillsCard === false,
    "the Connectors section owns MCP, LSP, and external-service settings",
    JSON.stringify(connectorUi),
  );
  check(
    connectorUi?.serverGroup === true && connectorUi?.serviceGroup === true &&
      connectorUi?.serverGroupFramed === true && connectorUi?.serverGroupBackground === true &&
      connectorUi?.mcpInServerGroup === true && connectorUi?.lspInServerGroup === true &&
      connectorUi?.externalCardCount === 11 &&
      connectorUi?.allExternalInServiceGroup === true &&
      connectorUi?.noExternalInServerGroup === true,
    "Connectors frames MCP/LSP separately from all external-service settings",
    JSON.stringify(connectorUi),
  );

  // ---- rich file previews (csv / json / office) ---------------------------
  // generate sample files in a temp dir, then open each in the viewer
  const previewDir = path.join(base, "preview");
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(previewDir, "preview.csv"), "name,qty\nalpha,3\nbeta,5\n");
  fs.writeFileSync(path.join(previewDir, "preview.json"), '{"a":1,"b":[2,3]}');
  {
    const { createOfficeCreateTool } = await import(
      path.join(repoRoot, "packages/core/dist/tools/office.js")
    );
    const tool = createOfficeCreateTool();
    const ctx = {
      sessionId: "e2e",
      cwd: previewDir,
      yolo: true,
      config: {},
      approval: { request: async () => true },
      backend: {
        path,
        mkdirp: async (d) => fs.mkdirSync(d, { recursive: true }),
        writeFile: async (f, data) => fs.writeFileSync(f, data),
      },
    };
    await tool.execute(
      { kind: "docx", path: path.join(previewDir, "preview.docx"), title: "T", blocks: [{ heading: "見出し", level: 1 }, { text: "本文" }, { bullets: ["A", "B"] }] },
      ctx,
    );
    await tool.execute(
      { kind: "xlsx", path: path.join(previewDir, "preview.xlsx"), title: "T", sheets: [{ name: "S1", headers: ["月", "値"], rows: [["1月", 10], ["2月", 20]] }] },
      ctx,
    );
    await tool.execute(
      { kind: "pptx", path: path.join(previewDir, "preview.pptx"), title: "T", slides: [{ title: "S1", bullets: ["a"] }, { title: "S2", bullets: ["b"] }] },
      ctx,
    );
  }

  const officePreview = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    for (const [name, f] of [["csv", "preview.csv"], ["json", "preview.json"], ["docx", "preview.docx"], ["xlsx", "preview.xlsx"], ["pptx", "preview.pptx"]]) {
      await openFileViewer(${JSON.stringify(previewDir)} + "/" + f);
      await sleep(400);
      const v = document.querySelector("#files-view");
      out[name] = {
        tables: v.querySelectorAll(".files-table").length,
        slides: v.querySelectorAll(".files-slide").length,
        sheetHeads: v.querySelectorAll(".files-sheet-head").length,
        docHeadings: v.querySelectorAll(".files-doc h2, .files-doc h3").length,
        pre: v.querySelector(".files-pre") !== null,
        binary: v.querySelector(".files-info") !== null,
      };
    }
    document.querySelector("#files-view").hidden = true;
    document.querySelector("#files-tree").hidden = false;
    return out;
  })()`);
  check(
    officePreview?.csv?.tables === 1 && officePreview?.json?.pre === true,
    "csv renders as a table and json is pretty-printed",
    JSON.stringify(officePreview),
  );
  check(
    officePreview?.docx?.docHeadings >= 1 && officePreview?.docx?.binary === false,
    "a Word document previews its blocks instead of a binary stub",
    JSON.stringify(officePreview?.docx),
  );
  check(
    officePreview?.xlsx?.tables === 1 && officePreview?.xlsx?.sheetHeads >= 1,
    "an Excel workbook previews as a sheet table",
    JSON.stringify(officePreview?.xlsx),
  );
  check(
    officePreview?.pptx?.slides === 2,
    "a PowerPoint previews one card per slide",
    JSON.stringify(officePreview?.pptx),
  );

  // ---- files-tab right-click menu (open / copy / add to context) ----------
  const fileCtx = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const dir = ${JSON.stringify(previewDir)};
    const file = dir + "/preview.csv";
    const box = document.querySelector("#files-tree");
    const saved = box.innerHTML;
    box.innerHTML = "";
    const row = await filesRowFor({ name: "preview.csv", path: file, dir: false, size: 30 }, 0, box);
    box.appendChild(row);
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
    await sleep(60);
    const menu = document.querySelector("#file-menu");
    const sub = document.querySelector("#file-submenu");
    const openVisible = menu.hidden === false;
    const topItems = [...menu.querySelectorAll("button[data-act]")].filter((b) => !b.hidden).map((b) => b.dataset.act);
    menu.querySelector('[data-act="open"]').click();
    await sleep(60);
    const subVisible = sub.hidden === false;
    const subItems = [...sub.querySelectorAll("button[data-act]")].map((b) => b.dataset.act);
    // "add to context" writes the @path into the composer and closes the menu
    const input = document.querySelector("#input");
    input.value = "";
    menu.querySelector('[data-act="addContext"]').click();
    await sleep(30);
    const composer = input.value;
    const menuClosed = menu.hidden === true;
    // relativeToCwd strips only the session-folder prefix
    const savedCwd = state.currentSession ? state.currentSession.cwd : undefined;
    state.currentSession = { cwd: dir };
    const rel = relativeToCwd(file);
    const outside = relativeToCwd("/somewhere/else.txt");
    if (savedCwd === undefined) state.currentSession = null; else state.currentSession.cwd = savedCwd;
    box.innerHTML = saved;
    return { openVisible, topItems, subVisible, subItems, composer, menuClosed, rel, outside };
  })()`);
  check(
    fileCtx?.openVisible === true && ["open", "copyPath", "addContext"].every((a) => (fileCtx?.topItems ?? []).includes(a)),
    "right-clicking a file row opens the files-tab menu",
    JSON.stringify(fileCtx?.topItems),
  );
  check(
    fileCtx?.subVisible === true && (fileCtx?.subItems ?? []).includes("openApp"),
    "the open entry flies out a submenu with the available open actions",
    JSON.stringify(fileCtx?.subItems),
  );
  check(
    fileCtx?.composer === `@${path.join(previewDir, "preview.csv")} ` && fileCtx?.menuClosed === true,
    "add-to-context inserts the @path and closes the menu",
    JSON.stringify({ composer: fileCtx?.composer, menuClosed: fileCtx?.menuClosed }),
  );
  check(
    fileCtx?.rel === "preview.csv" && fileCtx?.outside === "/somewhere/else.txt",
    "relativeToCwd strips only the session folder prefix",
    JSON.stringify({ rel: fileCtx?.rel, outside: fileCtx?.outside }),
  );

  // ---- files-tab rename + delete (round trip through the menu) -----------
  const opsSrc = path.join(previewDir, "ops.txt");
  const opsDst = path.join(previewDir, "ops-renamed.txt");
  fs.writeFileSync(opsSrc, "hello\n");
  const renameOpened = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    openFileRename({ name: "ops.txt", path: ${JSON.stringify(opsSrc)}, dir: false });
    await sleep(60);
    const overlay = document.querySelector("#file-rename-overlay");
    const opened = overlay.hidden === false;
    document.querySelector("#file-rename-input").value = "ops-renamed.txt";
    document.querySelector("#file-rename-ok").click();
    await sleep(500);
    return { opened, closed: overlay.hidden === true };
  })()`);
  check(
    renameOpened?.opened === true && renameOpened?.closed === true,
    "the rename modal opens and closes on submit",
    JSON.stringify(renameOpened),
  );
  check(
    fs.existsSync(opsDst) && !fs.existsSync(opsSrc),
    "renaming through the menu reaches the filesystem",
    `src=${fs.existsSync(opsSrc)} dst=${fs.existsSync(opsDst)}`,
  );
  await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const realConfirm = window.confirm;
    window.confirm = () => true;
    await deleteFileEntry({ name: "ops-renamed.txt", path: ${JSON.stringify(opsDst)}, dir: false });
    window.confirm = realConfirm;
    await sleep(300);
    return 1;
  })()`);
  check(!fs.existsSync(opsDst), "deleting through the menu reaches the filesystem", `exists=${fs.existsSync(opsDst)}`);

  // ---- collapsible session folders ----------------------------------------
  const folds = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    localStorage.removeItem("familiar.folderFolds");
    await refreshSessions();
    await sleep(400);
    const rows = () => [...document.querySelectorAll("#sessions .folder-row")];
    const before = { count: rows().length, chevs: rows().map((r) => r.querySelector(".chev").textContent) };
    // per-folder toggle collapses exactly one folder and persists by key
    const row = rows()[0];
    const key = row.dataset.key;
    row.querySelector(".folder-toggle").click();
    await sleep(800);
    const afterOne = {
      chev: rows().find((r) => r.dataset.key === key)?.querySelector(".chev").textContent,
      stored: JSON.parse(localStorage.getItem("familiar.folderFolds") || "{}")[key] === true,
      othersOpen: rows().filter((r) => r.dataset.key !== key).every((r) => r.querySelector(".chev").textContent === "▾"),
    };
    // fold-all collapses everything, then expands everything back
    document.querySelector("#fold-all-btn").click();
    await sleep(800);
    const allFolded = { chevs: rows().map((r) => r.querySelector(".chev").textContent), sessions: document.querySelectorAll("#sessions li[data-id]").length, btn: document.querySelector("#fold-all-btn").textContent };
    document.querySelector("#fold-all-btn").click();
    await sleep(800);
    const allOpen = { chevs: rows().map((r) => r.querySelector(".chev").textContent), sessions: document.querySelectorAll("#sessions li[data-id]").length };
    localStorage.removeItem("familiar.folderFolds");
    await refreshSessions();
    return { before, key, afterOne, allFolded, allOpen };
  })()`);
  check(
    folds?.before?.count > 0 && folds.before.chevs.every((c) => c === "▾"),
    "folders start expanded",
    JSON.stringify(folds?.before),
  );
  check(
    folds?.afterOne?.chev === "▸" && folds?.afterOne?.stored === true && folds?.afterOne?.othersOpen === true,
    "clicking a folder collapses it and persists per target+cwd",
    JSON.stringify(folds?.afterOne),
  );
  check(
    (folds?.allFolded?.chevs ?? []).every((c) => c === "▸") &&
      folds?.allFolded?.sessions === 0 &&
      folds?.allFolded?.btn === "⇔",
    "the fold-all button collapses every folder",
    JSON.stringify(folds?.allFolded),
  );
  check(
    (folds?.allOpen?.chevs ?? []).every((c) => c === "▾") && folds?.allOpen?.sessions > 0,
    "the fold-all button expands every folder again",
    JSON.stringify(folds?.allOpen),
  );

  // ---- Orca-style permission modes + voice-input mic ----------------------
  const modes = await evalOnce(`(() => {
    const rows = [...document.querySelectorAll("#mode-pop button[data-mode]")].map((b) => ({
      mode: b.dataset.mode,
      hasIcon: !!b.querySelector(".mi"),
      label: b.querySelector("b")?.textContent ?? "",
      desc: b.querySelector("small")?.textContent ?? "",
    }));
    setMode("yolo");
    const chipYolo = { text: document.querySelector("#mode-chip").textContent, yolo: document.querySelector("#mode-chip").classList.contains("yolo-mode") };
    setMode("plan");
    const chipPlan = { text: document.querySelector("#mode-chip").textContent, plan: document.querySelector("#mode-chip").classList.contains("plan-mode") };
    const activePlan = document.querySelector('#mode-pop button[data-mode="plan"]').classList.contains("active");
    const tabBack = state.lastEditMode;
    setMode("edit");
    return { rows, chipYolo, chipPlan, activePlan, tabBack };
  })()`);
  check(
    modes?.rows?.length === 4 &&
      modes.rows.map((r) => r.mode).join(",") === "plan,ask,edit,yolo" &&
      modes.rows.every((r) => r.hasIcon && r.label && r.desc),
    "the mode picker offers four described permission modes",
    JSON.stringify(modes?.rows),
  );
  check(
    String(modes?.chipYolo?.text).includes("フルアクセス") && modes?.chipYolo?.yolo === true,
    "the chip reflects the full-access mode",
    JSON.stringify(modes?.chipYolo),
  );
  check(
    String(modes?.chipPlan?.text).includes("Plan") && modes?.chipPlan?.plan === true && modes?.activePlan === true,
    "the chip and the active row reflect Plan mode",
    JSON.stringify(modes?.chipPlan),
  );

  // the chosen mode travels with the turn: plan → read-only tools, permissionMode sent
  const modeSend = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const seen = [];
    const real = window.rpc;
    window.rpc = (method, params) => {
      if (method === "session.send") seen.push(params);
      return real(method, params);
    };
    const s = await rpc("session.create", { cwd: ${JSON.stringify(repoRoot)} });
    await openSession(s.id);
    setMode("plan");
    document.querySelector("#input").value = "@hold 300 mode-probe";
    await send();
    await sleep(1500);
    window.rpc = real;
    await rpc("session.abort", { id: s.id }).catch(() => {});
    return { count: seen.length, plan: seen[0]?.plan, permissionMode: seen[0]?.permissionMode };
  })()`);
  check(
    modeSend?.count === 1 && modeSend?.plan === true && modeSend?.permissionMode === "plan",
    "the permission mode is sent with the turn",
    JSON.stringify(modeSend),
  );

  const mic = await evalOnce(`(() => {
    const btn = document.querySelector("#mic-btn");
    if (!btn) return { missing: true };
    // the mic is offered only where speech recognition actually works: a real
    // browser without the electron bridge
    const hasApi = typeof (window.SpeechRecognition ?? window.webkitSpeechRecognition) === "function";
    const isElectron = typeof window.familiarDesktop === "object" && window.familiarDesktop !== null;
    const expected = hasApi && !isElectron;
    return { present: true, hidden: btn.hidden, hasApi, isElectron, expected, icon: btn.textContent.trim() };
  })()`);
  check(
    mic?.present === true && mic?.hidden === !mic?.expected,
    "the mic button is shown only where speech recognition works",
    JSON.stringify(mic),
  );

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
      "turn.longWait", "turn.noteSteps", "turn.noteTodos", "turn.noteCeiling", "turn.retryNow",
      "mode.plan", "mode.ask", "mode.edit", "mode.yolo", "mode.askDesc", "mode.editDesc",
      "mode.yoloDesc", "mic.start", "mic.stop", "mic.unsupported", "mic.denied",
      "side.foldAll", "side.unfoldAll",
      "files.csvRows", "files.sheet", "files.slide", "files.docxEmpty",
      "nav.templates", "tpl.intro", "tpl.add", "tpl.empty", "tpl.delete", "tpl.how",
      "tpl.importFailed", "tpl.added", "tpl.deleted", "tpl.confirm",
      "conn.serverGroupTitle", "conn.serverGroupDesc",
      "conn.externalGroupTitle", "conn.externalGroupDesc",
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

  // switching the language from Settings must update the JS-rendered chrome
  // (settings nav + panel), not only the static data-i18n shell.
  const langSwitch = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    setLang("ja");
    openSettingsModal("connectors");
    await sleep(300);
    const groupText = (id, selector) =>
      (document.querySelector('[data-connector-group="' + id + '"] ' + selector)?.textContent ?? "").trim();
    const serverHeadingJa = groupText("servers", "h3");
    const serverDescJa = groupText("servers", "p");
    const serviceHeadingJa = groupText("services", "h3");
    const serviceDescJa = groupText("services", "p");
    openSettingsModal("general");
    await sleep(200);
    const navText = () => [...document.querySelectorAll("#settings-nav .nav-item")].map((e) => e.textContent).join("|");
    const navJa = navText();
    const sel = [...document.querySelectorAll("#settings-content select")].find((s) => [...s.options].some((o) => o.value === "en"));
    if (!sel) return { changed: false, reason: "no language select" };
    sel.value = "en";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(300);
    const navEn = navText();
    openSettingsModal("connectors");
    await sleep(300);
    const serverHeading = (document.querySelector('[data-connector-group="servers"] h3')?.textContent ?? "").trim();
    const serviceHeading = (document.querySelector('[data-connector-group="services"] h3')?.textContent ?? "").trim();
    const content = (document.querySelector("#settings-content")?.textContent ?? "").slice(0, 120);
    closeSettingsModal();
    setLang("ja");
    return {
      changed: navJa !== navEn,
      cjkInContent: /[\\u3040-\\u30ff\\u3400-\\u9fff]/.test(content),
      skillsEn: navEn.includes("Skills"),
      connectorsEn: navEn.includes("Connectors"),
      websearchEn: navEn.includes("Web search"),
      memoryEn: navEn.includes("Memory"),
      extensionsEn: navEn.includes("Extensions"),
      serverHeadingEn: serverHeading === "Servers",
      serviceHeadingEn: serviceHeading === "External services",
      serverHeadingJa: serverHeadingJa === "サーバー",
      serverDescJa: serverDescJa === "MCP / LSP サーバーの接続状態と設定",
      serviceHeadingJa: serviceHeadingJa === "外部サービス",
      serviceDescJa: serviceDescJa === "Gmail / GitHub などの外部サービスに接続します。",
    };
  })()`);
  check(langSwitch?.changed === true, "switching language updates the settings nav immediately", JSON.stringify(langSwitch));
  check(
    langSwitch?.skillsEn === true && langSwitch?.connectorsEn === true &&
      langSwitch?.websearchEn === true && langSwitch?.memoryEn === true &&
      langSwitch?.extensionsEn === false,
    "the English settings nav exposes Skills, Connectors, Web search and Memory without Extensions",
    JSON.stringify(langSwitch),
  );
  check(
    langSwitch?.serverHeadingEn === true && langSwitch?.serviceHeadingEn === true,
    "the English Connectors view labels server and external-service groups",
    JSON.stringify(langSwitch),
  );
  check(
    langSwitch?.serverHeadingJa === true && langSwitch?.serverDescJa === true &&
      langSwitch?.serviceHeadingJa === true && langSwitch?.serviceDescJa === true,
    "the Japanese Connectors view labels server and external-service groups",
    JSON.stringify(langSwitch),
  );
  check(langSwitch?.cjkInContent === false, "switching language updates the settings panel immediately", JSON.stringify(langSwitch));

  const modeCopyI18n = await evalOnce(`(() => {
    setLang("ja");
    const ja = { desc: t("set.tabToggleDesc"), shortcut: t("sc.tab") };
    setLang("en");
    const en = { desc: t("set.tabToggleDesc"), shortcut: t("sc.tab") };
    setLang("ja");
    return { ja, en };
  })()`);
  check(
    modeCopyI18n?.ja?.desc?.includes("Plan ⇔ 直前の権限モード") === true &&
      modeCopyI18n?.ja?.shortcut?.includes("Plan ⇔ 直前の権限モード") === true &&
      modeCopyI18n?.en?.desc?.includes("previous permission mode") === true &&
      modeCopyI18n?.en?.shortcut?.includes("previous permission mode") === true &&
      JSON.stringify(modeCopyI18n).indexOf("Build / Plan") < 0,
    "Tab mode copy is synchronized in Japanese and English",
    JSON.stringify(modeCopyI18n),
  );

  // ---- left rail collapse / session tabs / labelled settings button --------
  const chrome = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    try {
      const app = document.querySelector("#app");
      const toggle = document.querySelector("#sidebar-toggle");
      const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; };
      out.toggleVisible = getComputedStyle(toggle).display !== "none";
      out.toggleRectExpanded = rectOf(toggle);
      toggle.click(); await sleep(60);
      out.collapsed = app.classList.contains("side-collapsed") && getComputedStyle(document.querySelector("#sidebar")).display === "none";
      out.toggleRectCollapsed = rectOf(toggle);
      out.toggleFixed =
        out.toggleRectExpanded.x === out.toggleRectCollapsed.x &&
        out.toggleRectExpanded.y === out.toggleRectCollapsed.y;
      toggle.click(); await sleep(60);
      out.expanded = !app.classList.contains("side-collapsed");

      // branding lives in settings/about: the app shell itself has no logo
      out.shellLogos = document.querySelectorAll(
        "#sidebar .logo, #sidebar .logo-ic, #topbar .ticon, #topbar img",
      ).length;
      out.sideTitle = (document.querySelector(".side-head .side-title")?.textContent ?? "").trim();

      const sb = document.querySelector("#open-settings");
      out.settingsHasIcon = !!sb?.querySelector("svg");
      out.settingsLabelText = (sb?.textContent ?? "").trim();
      out.settingsVisible = !!sb && getComputedStyle(sb).display !== "none";

      const cwd = state.currentSession?.cwd || "/tmp";
      const a = await rpc("session.create", { cwd });
      const b = await rpc("session.create", { cwd });
      await openSession(a.id); await sleep(150);
      await openSession(b.id); await sleep(150);
      const bar = document.querySelector("#tabs");
      const tabsOf = () => [...bar.querySelectorAll(".tab")];
      out.tabCount = tabsOf().length;
      const other = tabsOf().find((t) => t.dataset.id !== state.sessionId) ?? null;
      out.otherTab = other?.dataset.id ?? null;
      other?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(200);
      out.tabSwitch = !!other && state.sessionId === other.dataset.id;
      const beforeMid = tabsOf().length;
      tabsOf()[0]?.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      await sleep(200);
      out.tabMiddleClose = tabsOf().length === beforeMid - 1;
      const beforeX = tabsOf().length;
      bar.querySelector(".tab.active .tab-close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(200);
      out.tabCloseCount = tabsOf().length;
      out.tabCloseOk = out.tabCloseCount === beforeX - 1;
      await rpc("session.delete", { id: a.id }).catch(() => {});
      await rpc("session.delete", { id: b.id }).catch(() => {});
    } catch (err) {
      out.error = String(err && err.stack ? err.stack : err);
    }
    return out;
  })()`);
  check(
    chrome?.toggleVisible === true &&
      chrome?.collapsed === true &&
      chrome?.expanded === true &&
      chrome?.toggleFixed === true,
    "the session rail collapses and expands without moving the toggle",
    JSON.stringify(chrome),
  );
  check(
    chrome?.settingsVisible === true && chrome?.settingsHasIcon === true && chrome?.settingsLabelText === "",
    "the settings button is an icon-only control with a clear glyph",
    JSON.stringify(chrome),
  );
  check(
    chrome?.shellLogos === 0,
    "the app shell shows no Familiar logo (branding stays in settings/about)",
    JSON.stringify(chrome),
  );
  check(
    chrome?.sideTitle === "Familiar Harness",
    "the session rail header keeps the app name as text",
    JSON.stringify(chrome),
  );
  check(
    chrome?.tabCount >= 2 && chrome?.tabSwitch === true && chrome?.tabMiddleClose === true && chrome?.tabCloseOk === true,
    "sessions of one folder open as switchable tabs (middle-click closes)",
    JSON.stringify(chrome),
  );

  // ---- a persisted desktop collapse must not break the narrow-screen drawer --
  const narrow = await evalAtViewport(
    820,
    900,
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = {};
      try {
        const app = document.querySelector("#app");
        const sidebar = document.querySelector("#sidebar");
        const toggle = document.querySelector("#sidebar-toggle");
        // simulate: rail collapsed on desktop, then the window narrowed
        app.classList.add("side-collapsed");
        await sleep(80);
        out.display = getComputedStyle(sidebar).display;
        out.oneColumn = getComputedStyle(app).gridTemplateColumns.split(" ").length === 1;
        toggle.click();
        await sleep(300);
        out.drawerOpen = sidebar.classList.contains("open");
        out.onScreen = Math.round(sidebar.getBoundingClientRect().x) === 0;
        toggle.click();
        await sleep(300);
        out.drawerClosed = !sidebar.classList.contains("open");
        app.classList.remove("side-collapsed");
      } catch (err) {
        out.error = String(err && err.stack ? err.stack : err);
      }
      return out;
    })()`,
  );
  check(
    narrow?.display === "flex" &&
      narrow?.oneColumn === true &&
      narrow?.drawerOpen === true &&
      narrow?.onScreen === true &&
      narrow?.drawerClosed === true,
    "a persisted rail collapse does not break the narrow-screen drawer",
    JSON.stringify(narrow),
  );

  // ---- context composition report (system / tools / history / tool results) --
  const ctxInfo = await evalOnce(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    try {
      const s = await rpc("session.create", { cwd: "/tmp" });
      await openSession(s.id); await sleep(120);
      await rpc("session.send", { id: s.id, text: "count the context" });
      await sleep(500);
      const c = state.contextBySession[s.id] ?? null;
      const node = c ? contextBreakdownNode() : null;
      out.present = !!c;
      out.rows = node ? node.querySelectorAll(".ctx-bd-row").length : 0;
      out.total = c ? c.total : 0;
      out.hasTools = (c?.tools ?? 0) > 0;
      await rpc("session.delete", { id: s.id }).catch(() => {});
    } catch (err) { out.error = String(err && err.stack ? err.stack : err); }
    return out;
  })()`);
  check(
    ctxInfo?.present === true && ctxInfo?.rows === 4 && ctxInfo?.total > 0 && ctxInfo?.hasTools === true,
    "the context popover shows the prompt composition",
    JSON.stringify(ctxInfo),
  );

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
