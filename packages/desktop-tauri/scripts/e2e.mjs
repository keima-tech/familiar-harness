#!/usr/bin/env node
/**
 * End-to-end test for the Tauri shell.
 *
 * Builds the debug shell (its devtools/debug build carries the test control
 * channel — see src-tauri/src/e2e.rs), launches it under a virtual display,
 * drives the real Web UI in the system webview over that channel, and checks
 * that the shell bundles + spawns its own Node, injects the window.familiarDesktop
 * bridge, and cleans the sidecar up on exit.
 *
 *   npm run -w packages/desktop-tauri e2e
 *
 * Requires: the Rust toolchain (cargo), xvfb. Network-free; writes only to a
 * temporary FAMILIAR_HOME.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const tauriDir = path.join(pkgRoot, "src-tauri");
const binary = path.join(tauriDir, "target", "debug", "familiar-desktop");

const E2E_PORT = 9231;
const SPAWN_PORT = 47811;
const PORTS = [SPAWN_PORT, SPAWN_PORT + 1, SPAWN_PORT + 2];

let checks = 0;
let failures = 0;
function check(cond, label, extra = "") {
  checks += 1;
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// build + stage
// ---------------------------------------------------------------------------
if (!fs.existsSync(path.join(repoRoot, "packages", "cli", "dist", "familiar.js"))) {
  console.error("e2e: build the workspace first (npm run build)");
  process.exit(1);
}
console.log("— staging + building the shell (cargo build) —");
{
  const stage = spawnSync("node", [path.join(pkgRoot, "scripts", "stage.mjs")], { stdio: "inherit" });
  if (stage.status !== 0) process.exit(stage.status ?? 1);
  const build = spawnSync("cargo", ["build"], { cwd: tauriDir, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
if (!fs.existsSync(binary)) {
  console.error(`e2e: shell binary not found at ${binary}`);
  process.exit(1);
}

const resources = path.join(tauriDir, "resources");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-tauri-e2e-"));
const familiarHome = path.join(base, "home");
fs.mkdirSync(familiarHome, { recursive: true });

let app = null;
let log = "";

async function evalOnce(expression) {
  const res = await fetch(`http://127.0.0.1:${E2E_PORT}/eval`, { method: "POST", body: expression });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? "eval failed");
  return body.value;
}

async function waitFor(fn, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* not ready yet */
    }
    await sleep(300);
  }
  console.error(`e2e: timed out waiting for ${label}`);
  return false;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(500);
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("timeout", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(true));
    s.connect(port, "127.0.0.1");
  });
}

try {
  app = spawn("xvfb-run", ["-a", binary], {
    env: {
      ...process.env,
      FAMILIAR_HOME: familiarHome,
      FAMILIAR_PORTS: PORTS.join(","),
      FAMILIAR_SPAWN_PORT: String(SPAWN_PORT),
      FAMILIAR_SHELL_E2E_PORT: String(E2E_PORT),
      // deterministic bundled runtime (independent of how tauri-build staged it)
      FAMILIAR_SHELL_NODE: path.join(resources, "node", process.platform === "win32" ? "node.exe" : "node"),
      FAMILIAR_SHELL_CLI: path.join(resources, "familiar", "packages", "cli", "dist", "familiar.js"),
      // headless webkit in a container/VM
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1",
      LIBGL_ALWAYS_SOFTWARE: "1",
      GDK_BACKEND: "x11",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  app.stdout.on("data", (d) => (log += d));
  app.stderr.on("data", (d) => (log += d));

  // ---- the shell comes up and spawns its bundled Node ----------------------
  const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${E2E_PORT}/eval`, { method: "POST", body: "1" })).ok, "the e2e control channel");
  check(up, "the shell starts and its control channel answers");
  const healthy = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${SPAWN_PORT}/healthz`).then((x) => x.json());
      return r.ok === true;
    } catch {
      return false;
    }
  }, "the spawned familiar serve /healthz");
  check(healthy, "the shell spawns familiar serve on the configured port");
  check(/spawned familiar serve on port /.test(log), "the shell reports spawning the bundled server", log.slice(0, 200));

  // ---- the Web UI is loaded and driven in the system webview ---------------
  const uiUp = await waitFor(async () => (await evalOnce('!!document.querySelector("#input")')) === true, "the Web UI");
  check(uiUp, "the Web UI is rendered in the Tauri webview");
  check(/bridge ready/.test(log), "the injected bridge reports IPC across the origin");
  check((await evalOnce('typeof window.familiarDesktop && typeof window.familiarDesktop.openPath === "function"')) === true,
    "window.familiarDesktop.openPath is wired");
  check((await evalOnce('window.familiarDesktop.writeClipboard("familiar-e2e").then((r) => r === true)')) === true,
    "the bridge reaches Rust (clipboard command round-trips)");

  // ---- shared Web UI logic runs unchanged ----------------------------------
  check((await evalOnce('!!document.querySelector("#file-menu") && !!document.querySelector("#file-submenu")')) === true,
    "the files-tab context menu markup is present");
  check((await evalOnce('typeof openFileMenu === "function" && typeof commitFileRename === "function" && typeof deleteFileEntry === "function"')) === true,
    "the files-tab menu handlers are wired");
  check((await evalOnce('(function () { const i = document.querySelector("#input"); i.value = ""; insertIntoComposer("hello e2e"); return i.value; })()')) === "hello e2e",
    "composer helpers work in the webview");

  // ---- exit cleans the sidecar up ------------------------------------------
  try { process.kill(-app.pid, "SIGTERM"); } catch { app.kill("SIGTERM"); }
  await sleep(2500);
  check(await portFree(SPAWN_PORT), "closing the shell stops the sidecar (no orphan on the port)");
} catch (err) {
  failures += 1;
  console.error(`e2e: ${err?.stack ?? err}`);
} finally {
  try { if (app) process.kill(-app.pid, "SIGTERM"); } catch { /* already gone */ }
  await sleep(500);
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failures === 0 ? `tauri e2e: all ok (${checks} checks)` : `tauri e2e: ${failures} failure(s) of ${checks}`);
process.exit(failures === 0 ? 0 : 1);
