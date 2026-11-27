#!/usr/bin/env node
/**
 * Capture the screenshots used by docs/guide.md and docs/guide.ja.md.
 * Uses the same isolated, synthetic setup as the desktop E2E suite: a mock
 * provider, a throw-away FAMILIAR_HOME and no real user data.
 *
 * Run: node scripts/capture-guide.mjs
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
const outDir = path.join(repoRoot, "docs", "screenshots");
if (!fs.existsSync(electronBin)) {
  console.error("electron not installed — run: npm install -w packages/desktop");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(); }, timeoutMs);
    child.once("exit", onExit);
  });
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

async function terminateTree(child) {
  if (!child?.pid) return;
  signalGroup(child, "SIGTERM");
  await waitForExit(child, 5_000);
  signalGroup(child, "SIGKILL");
  await waitForExit(child, 2_000);
}

async function startXvfb() {
  const proc = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1440x1000x24", "-nolisten", "tcp", "-ac"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => { stderr = (stderr + c).slice(-2_000); });
  const display = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`Xvfb: ${stderr}`)); }, 10_000);
    proc.stdout.once("data", (c) => {
      clearTimeout(timer);
      const value = String(c).trim().split(/\s+/)[0] ?? "";
      if (!/^\d+$/.test(value)) { proc.kill("SIGKILL"); reject(new Error("bad Xvfb display")); return; }
      resolve(`:${value}`);
    });
    proc.once("error", reject);
  });
  return { process: proc, display };
}

function openCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const msgId = ++id;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(msgId); rej(new Error(`cdp ${method} timeout`)); }, 60_000);
          pending.set(msgId, {
            res: (value) => { clearTimeout(timer); res(value); },
            rej: (err) => { clearTimeout(timer); rej(err); },
          });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    }));
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.error) slot.rej(new Error(msg.error.message ?? "cdp error"));
      else slot.res(msg.result);
    });
    ws.addEventListener("error", (err) => reject(new Error(`cdp failed: ${err?.message ?? "error"}`)));
  });
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-guide-capture-"));
const profile = path.join(home, "electron-profile");
const runtime = path.join(home, "runtime");
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const unusedEnv = `FAMILIAR_GUIDE_UNUSED_${process.pid}`;
const config = `version: 1
default_provider: my-openai
providers:
  openai: { auth: { env: ${unusedEnv} } }
  anthropic: { auth: { env: ${unusedEnv} } }
  google: { auth: { env: ${unusedEnv} } }
  nvidia: { auth: { env: ${unusedEnv} } }
  openrouter: { auth: { env: ${unusedEnv} } }
  ollama: { auth: { env: ${unusedEnv} } }
  my-openai:
    kind: mock
    base_url: https://api.openai.com/v1?guide=${randomUUID()}
server:
  port: 0
  bind: 127.0.0.1
`;
fs.writeFileSync(path.join(home, "config.yaml"), config);

let xvfb = null;
let app = null;
let cdp = null;
let servePort = 0;
let debugPort = 0;

try {
  xvfb = await startXvfb();
  servePort = await freePort();
  debugPort = await freePort();
  while (debugPort === servePort) debugPort = await freePort();

  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY",
    "OPENROUTER_API_KEY", unusedEnv, "ELECTRON_RUN_AS_NODE", "XAUTHORITY",
  ]) delete env[key];
  Object.assign(env, {
    DISPLAY: xvfb.display,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_RUNTIME_DIR: runtime,
    FAMILIAR_HOME: home,
    FAMILIAR_PORTS: String(servePort),
    FAMILIAR_SPAWN_PORT: String(servePort),
  });

  app = spawn(electronBin, [
    "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${debugPort}`,
    path.join(repoRoot, "packages", "desktop"),
  ], { env, stdio: "ignore", detached: true });

  let uiUrl = "";
  for (let i = 0; i < 120 && !uiUrl; i++) {
    await sleep(250);
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
      uiUrl = targets.find((t) => t.type === "page" && (t.url ?? "").startsWith(`http://127.0.0.1:${servePort}`))?.url ?? "";
    } catch { /* debugger not ready */ }
  }
  if (!uiUrl) throw new Error("Electron UI page did not load");
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && (t.url ?? "").startsWith(`http://127.0.0.1:${servePort}`));
  cdp = await openCdp(page.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? "eval failed");
    return response.result?.value;
  };
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`typeof rpc === "function" && typeof openSettingsModal === "function"`).catch(() => false)) break;
    await sleep(100);
  }

  const shot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const target = path.join(outDir, `guide-${name}.png`);
    fs.writeFileSync(target, Buffer.from(data, "base64"));
    console.log(`saved ${path.relative(repoRoot, target)}`);
  };

  // Synthetic data for the settings screenshots.
  await evaluate(`(async () => {
    await rpc("mcp.servers.set", { name: "filesystem", command: "node", args: ["mcp-fs.mjs"], read_only: true, disabled: true });
    await rpc("lsp.servers.set", { name: "typescript", command: "typescript-language-server", args: ["--stdio"], extensions: ["ts", "tsx"] });
    await rpc("connectors.set", { kind: "github", settings: { token: "fixture-only" } });
    await rpc("connectors.set", { kind: "redmine", settings: { base_url: "https://redmine.example.com", api_key: "fixture-only" } });
    await rpc("memory.file.set", { content: "# Decisions\\n- Keep the web UI as the main entry point\\n- Review staged proposals daily\\n" });
    await rpc("skills.save", { name: "release-check", body: "# Release check\\n1. npm run smoke\\n2. Tag and publish\\n" });
    await rpc("permissions.websearch.set", { provider: "searxng", base_url: "http://127.0.0.1:8080" });
    return true;
  })()`);

  const sections = ["skills", "connectors", "websearch", "memory"];
  for (const lang of ["en", "ja"]) {
    await evaluate(`setLang(${JSON.stringify(lang)}); 1`);
    // A fresh synthetic turn per language: transcript labels are baked at
    // render time, so the chat shot must be produced in the target language.
    await evaluate(`(async () => {
      const s = await rpc("session.create", { cwd: ${JSON.stringify(home)} });
      await openSession(s.id);
      await rpc("session.send", { id: s.id, text: "@write note.txt" });
      return s.id;
    })()`);
    for (let i = 0; i < 100; i++) {
      const ready = await evaluate(
        `(document.querySelector("#transcript")?.textContent ?? "").includes("note.txt")`,
      ).catch(() => false);
      if (ready) break;
      await sleep(200);
    }
    await evaluate(`closeSettingsModal(); 1`);
    await sleep(300);
    await shot(lang === "ja" ? "chat.ja" : "chat");
    for (const section of sections) {
      await evaluate(`openSettingsModal(${JSON.stringify(section)}); 1`);
      await sleep(600);
      await shot(lang === "ja" ? `${section}.ja` : section);
      if (section === "connectors") {
        await evaluate(`document.querySelector("#settings-content").scrollTop = 9999; 1`);
        await sleep(200);
        await shot(lang === "ja" ? "services.ja" : "services");
      }
    }
  }
} finally {
  if (cdp) cdp.close();
  if (app) await terminateTree(app);
  if (xvfb?.process) {
    xvfb.process.kill("SIGTERM");
    await waitForExit(xvfb.process, 3_000);
  }
  fs.rmSync(home, { recursive: true, force: true });
}
