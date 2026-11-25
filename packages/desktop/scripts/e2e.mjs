#!/usr/bin/env node
/**
 * Desktop α headless e2e (manual; not part of `npm run smoke`).
 * Requires: electron binary (npm install -w packages/desktop) and xvfb.
 *   xvfb is used because this repo's dev box has no display.
 * Run: node scripts/e2e.mjs
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
if (!fs.existsSync(electronBin)) {
  console.error("electron not installed — run: npm install -w packages/desktop");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reserve an unused localhost TCP port for the isolated desktop run. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a localhost port"));
        return;
      }
      server.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

/** Wait for a child to exit, without rejecting when the grace period expires. */
function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pid) && Date.now() < deadline) await sleep(50);
  return !processGroupAlive(pid);
}

/** Stop Electron and every child it spawned, then wait for the group to exit. */
async function terminateProcessTree(child) {
  if (!child?.pid) return;
  signalProcessGroup(child, "SIGTERM");
  await waitForExit(child, 5_000);
  if (!(await waitForProcessGroupExit(child.pid, 2_000))) {
    signalProcessGroup(child, "SIGKILL");
    await waitForExit(child, 2_000);
    await waitForProcessGroupExit(child.pid, 2_000);
  }
}

/** Stop a directly managed child (used for the isolated Xvfb server). */
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await waitForExit(child, 5_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    await waitForExit(child, 2_000);
  }
}

/** Start an Xvfb display directly so the test can wait for and reap it. */
async function startXvfb() {
  const proc = spawn(
    "Xvfb",
    ["-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp", "-ac"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  const display = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Xvfb did not allocate a display: ${stderr.trim()}`));
    }, 10_000);
    proc.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      const value = String(chunk).trim().split(/\s+/)[0] ?? "";
      if (!/^\d+$/.test(value)) {
        proc.kill("SIGKILL");
        reject(new Error(`Xvfb returned an invalid display: ${value}`));
        return;
      }
      resolve(value);
    });
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited before startup (${code}): ${stderr.trim()}`));
    });
  });
  return { process: proc, display: `:${display}` };
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-desktop-"));
const electronProfile = path.join(home, "electron-profile");
fs.mkdirSync(electronProfile, { recursive: true });
const unusedProviderEnv = `FAMILIAR_E2E_UNUSED_${process.pid}`;
const runId = randomUUID();
const isolatedOpenAiUrl = `https://api.openai.com/v1?e2e=${runId}`;
// Every built-in provider is explicitly non-usable. The two mock providers
// exercise brand resolution while keeping model discovery entirely local.
const config = `version: 1
default_provider: my-openai
providers:
  openai:
    auth: { env: ${unusedProviderEnv} }
  anthropic:
    auth: { env: ${unusedProviderEnv} }
  google:
    auth: { env: ${unusedProviderEnv} }
  nvidia:
    auth: { env: ${unusedProviderEnv} }
  openrouter:
    auth: { env: ${unusedProviderEnv} }
  ollama:
    auth: { env: ${unusedProviderEnv} }
  my-openai:
    kind: mock
    base_url: ${isolatedOpenAiUrl}
  custom:
    kind: mock
    base_url: https://example.com/v1
server:
  port: 0
  bind: 127.0.0.1
`;
fs.writeFileSync(path.join(home, "config.yaml"), config);

let servePort = 0;
let debugPort = 0;

let failures = 0;
const check = (okFlag, label, extra = "") => {
  console.log(`${okFlag ? "ok  " : "FAIL"} ${label}${okFlag ? "" : ` ${extra}`}`);
  if (!okFlag) failures += 1;
};

/** Minimal CDP client for Runtime.evaluate against the Electron renderer. */
function openCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(msgId);
              rej(new Error(`cdp ${method} timed out`));
            }, 60_000);
            pending.set(msgId, {
              res: (value) => {
                clearTimeout(timer);
                res(value);
              },
              rej: (err) => {
                clearTimeout(timer);
                rej(err);
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
      });
    });
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.rej(new Error(message.error.message ?? "cdp error"));
      else slot.res(message.result);
    });
    ws.addEventListener("error", (err) => reject(new Error(`cdp connect failed: ${err?.message ?? "error"}`)));
  });
}

async function pageTarget() {
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  return targets.find(
    (target) => target.type === "page" && (target.url ?? "").startsWith(`http://127.0.0.1:${servePort}`),
  );
}

async function evaluate(expression) {
  const target = await pageTarget();
  if (!target) throw new Error("no Electron page target");
  const cdp = await openCdp(target.webSocketDebuggerUrl);
  try {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "eval failed");
    }
    return response.result?.value;
  } finally {
    cdp.close();
  }
}

async function evaluateAtViewport(width, height, expression) {
  const target = await pageTarget();
  if (!target) throw new Error("no Electron page target");
  const cdp = await openCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "eval failed");
    }
    return response.result?.value;
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    cdp.close();
  }
}

let app = null;
let xvfb = null;

try {
  xvfb = await startXvfb();
  // A foreign process may still claim the reserved port before Electron binds
  // it. The config-identity check below refuses to mutate such a server.
  servePort = await freePort();
  debugPort = await freePort();
  while (debugPort === servePort) debugPort = await freePort();

  const testEnv = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "NVIDIA_API_KEY",
    "OPENROUTER_API_KEY",
    unusedProviderEnv,
    "ELECTRON_RUN_AS_NODE",
    "XAUTHORITY",
  ]) {
    delete testEnv[key];
  }
  const runtimeDir = path.join(home, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  testEnv.DISPLAY = xvfb.display;
  testEnv.HOME = home;
  testEnv.USERPROFILE = home;
  testEnv.XDG_CONFIG_HOME = path.join(home, "xdg-config");
  testEnv.XDG_CACHE_HOME = path.join(home, "xdg-cache");
  testEnv.XDG_DATA_HOME = path.join(home, "xdg-data");
  testEnv.XDG_RUNTIME_DIR = runtimeDir;
  testEnv.FAMILIAR_HOME = home;
  testEnv.FAMILIAR_PORTS = String(servePort);
  testEnv.FAMILIAR_SPAWN_PORT = String(servePort);

  app = spawn(
    electronBin,
    [
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${electronProfile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
      path.join(repoRoot, "packages", "desktop"),
    ],
    {
      env: testEnv,
      stdio: "ignore",
      detached: true,
    },
  );
  let appError = null;
  app.on("error", (err) => {
    appError = err;
  });

  let uiUrl = "";
  for (let i = 0; i < 100 && !uiUrl; i++) {
    if (appError) throw appError;
    await sleep(250);
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      uiUrl = targets.find(
        (target) => target.type === "page" && (target.url ?? "").startsWith(`http://127.0.0.1:${servePort}`),
      )?.url ?? "";
    } catch {
      /* debugger not up yet */
    }
  }
  check(Boolean(uiUrl), "desktop shell loaded the web UI page", uiUrl);
  if (!uiUrl) throw new Error("Electron UI page did not load");

  let serveUp = false;
  try {
    const health = await fetch(`${new URL(uiUrl).origin}/healthz`).then((response) => response.json());
    serveUp = health.ok === true;
  } catch {
    serveUp = false;
  }
  check(serveUp, "embedded familiar serve is reachable");

  // The page target can exist before the classic app.js script finishes
  // evaluating. Wait for its runtime API before issuing RPC-backed checks.
  let appReady = false;
  for (let i = 0; i < 100 && !appReady; i++) {
    await sleep(100);
    appReady = await evaluate(
      `typeof rpc === "function" && typeof openSettingsModal === "function"`,
    ).catch(() => false);
  }
  check(appReady, "desktop web UI runtime is ready");
  if (!appReady) throw new Error("Electron web UI runtime did not initialize");

  const isolated = await evaluate(`(async () => {
    const cfg = await rpc("config.get");
    const providers = cfg.providers ?? {};
    const connected = Object.entries(providers)
      .filter(([, provider]) =>
        provider?.auth?.source === "none" ||
        provider?.auth?.source === "env:none" ||
        provider?.auth?.resolved === true)
      .map(([name]) => name)
      .sort();
    return {
      myOpenai: providers["my-openai"]?.base_url ?? "",
      custom: providers["custom"]?.base_url ?? "",
      connected,
    };
  })()`);
  const isolatedProviders = ["custom", "my-openai"];
  const isolatedOk =
    isolated?.myOpenai === isolatedOpenAiUrl &&
    isolated?.custom === "https://example.com/v1" &&
    JSON.stringify(isolated?.connected) === JSON.stringify(isolatedProviders);
  check(
    isolatedOk,
    "desktop attached to the isolated provider configuration",
    JSON.stringify(isolated),
  );
  if (!isolatedOk) {
    throw new Error("desktop attached to a non-test server; refusing to mutate its config");
  }

  const settings = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 50 && !ns.loaded; i++) await sleep(100);
    openSettingsModal("providers");
    const content = document.querySelector("#settings-content");
    for (let i = 0; i < 50 && !content.querySelector(".provcard"); i++) await sleep(100);
    const cards = [...content.querySelectorAll(".provcard")];
    const rows = [...content.querySelectorAll(".provrow")];
    const cardByName = (name) => cards.find((card) => card.querySelector(".pname")?.textContent.includes(name));
    const knownCard = cardByName("my-openai");
    const fallbackCard = cardByName("custom");
    const fallbackLogo = fallbackCard?.querySelector(".plogo");
    const allLogos = [...content.querySelectorAll(".plogo")];
    const allSvgs = [...content.querySelectorAll(".plogo svg")];
    return {
      cards: cards.length,
      rows: rows.length,
      logos: allLogos.length,
      svgCount: allSvgs.length,
      distinctPaths: new Set(allSvgs.map((svg) => svg.querySelector("path")?.getAttribute("d"))).size,
      knownPath: knownCard?.querySelector(".plogo path")?.getAttribute("d") ?? "",
      knownText: knownCard?.querySelector(".pname")?.textContent ?? "",
      fallbackSvg: fallbackCard?.querySelectorAll(".plogo svg").length ?? -1,
      fallbackText: fallbackLogo?.textContent ?? "",
      fallbackColor: fallbackLogo ? getComputedStyle(fallbackLogo).color : "",
      fallbackBackground: fallbackLogo ? getComputedStyle(fallbackLogo).backgroundColor : "",
      fallbackHidden: fallbackLogo?.getAttribute("aria-hidden") === "true",
      allSvgAccessible: allSvgs.every((svg) => svg.getAttribute("aria-hidden") === "true" && svg.getAttribute("focusable") === "false"),
    };
  })()`);
  check(
    settings?.cards === 2 && settings?.rows === 6 && settings?.logos === settings?.cards + settings?.rows,
    "settings renders connected and candidate provider rows",
    JSON.stringify(settings),
  );
  check(
    settings?.knownPath.startsWith("M22.2819") && settings?.knownText.includes("my-openai"),
    "settings renders the known provider brand shape beside its name",
    JSON.stringify(settings),
  );
  check(
    settings?.fallbackSvg === 0 && settings?.fallbackText === "C" &&
      settings?.fallbackColor === "rgb(21, 21, 25)" &&
      settings?.fallbackBackground === "rgb(138, 138, 148)" && settings?.fallbackHidden === true,
    "settings renders an accessible high-contrast fallback monogram",
    JSON.stringify(settings),
  );
  check(
    settings?.distinctPaths === 6 && settings?.allSvgAccessible === true,
    "settings renders six distinct accessible brand shapes",
    JSON.stringify(settings),
  );

  const settingsSections = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    openSettingsModal("general");
    const nav = [...document.querySelectorAll("#settings-nav .nav-item")].map((item) => item.dataset.section);
    openSettingsModal("skills");
    for (let i = 0; i < 50; i++) {
      const summary = document.querySelector("#settings-content .skill-details summary")?.textContent?.trim() ?? "";
      if (summary || document.querySelector("#settings-content .status-err")) break;
      await sleep(100);
    }
    const skills = {
      card: !!document.querySelector('#settings-content .card[data-section="skills"]'),
      mcp: !!document.querySelector('#settings-content .card[data-section="mcp"]'),
      lsp: !!document.querySelector('#settings-content .card[data-section="lsp"]'),
    };
    openSettingsModal("connectors");
    for (let i = 0; i < 50; i++) {
      const ready = !!document.querySelector('#settings-content .card[data-section="mcp"]') &&
        !!document.querySelector('#settings-content .card[data-section="lsp"]') &&
        !!document.querySelector('#settings-content .card[data-connector="google"]') &&
        !!document.querySelector('#settings-content .card[data-connector="github"]');
      if (ready) break;
      await sleep(100);
    }
    const serverGroup = document.querySelector('#settings-content [data-connector-group="servers"]');
    const serviceGroup = document.querySelector('#settings-content [data-connector-group="services"]');
    const mcpCard = serverGroup?.querySelector('.card[data-section="mcp"]');
    const lspCard = serverGroup?.querySelector('.card[data-section="lsp"]');
    const externalCards = [...document.querySelectorAll('#settings-content .card[data-connector]')];
    const serverStyle = serverGroup ? getComputedStyle(serverGroup) : null;
    const frameEdges = serverStyle
      ? ["Top", "Right", "Bottom", "Left"].every((side) =>
          serverStyle["border" + side + "Style"] !== "none" &&
          Number.parseFloat(serverStyle["border" + side + "Width"]) > 0)
      : false;
    const connectors = {
      mcp: !!document.querySelector('#settings-content .card[data-section="mcp"]'),
      lsp: !!document.querySelector('#settings-content .card[data-section="lsp"]'),
      skills: !!document.querySelector('#settings-content .card[data-section="skills"]'),
      google: !!document.querySelector('#settings-content .card[data-connector="google"]'),
      github: !!document.querySelector('#settings-content .card[data-connector="github"]'),
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
    return { nav, skills, connectors };
  })()`);
  check(
    settingsSections?.nav.includes("skills") && settingsSections?.nav.includes("connectors") &&
      !settingsSections?.nav.includes("extensions"),
    "settings navigation exposes Skills and Connectors without Extensions",
    JSON.stringify(settingsSections?.nav),
  );
  check(
    settingsSections?.skills?.card === true && settingsSections?.skills?.mcp === false &&
      settingsSections?.skills?.lsp === false,
    "the Skills section owns only the skills catalog",
    JSON.stringify(settingsSections?.skills),
  );
  check(
    settingsSections?.connectors?.mcp === true && settingsSections?.connectors?.lsp === true &&
      settingsSections?.connectors?.google === true && settingsSections?.connectors?.github === true &&
      settingsSections?.connectors?.skills === false,
    "the Connectors section owns MCP, LSP, and external-service settings",
    JSON.stringify(settingsSections?.connectors),
  );
  check(
    settingsSections?.connectors?.serverGroup === true &&
      settingsSections?.connectors?.serviceGroup === true &&
      settingsSections?.connectors?.serverGroupFramed === true &&
      settingsSections?.connectors?.serverGroupBackground === true &&
      settingsSections?.connectors?.mcpInServerGroup === true &&
      settingsSections?.connectors?.lspInServerGroup === true &&
      settingsSections?.connectors?.externalCardCount === 11 &&
      settingsSections?.connectors?.allExternalInServiceGroup === true &&
      settingsSections?.connectors?.noExternalInServerGroup === true,
    "Connectors frames MCP/LSP separately from all external-service settings",
    JSON.stringify(settingsSections?.connectors),
  );

  const connectorIndependence = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const realRpc = window.rpc;
    let releaseMcp = () => {};
    const mcpGate = new Promise((resolve) => { releaseMcp = resolve; });
    window.rpc = (method, params) => method === "mcp.status"
      ? mcpGate.then(() => realRpc(method, params))
      : realRpc(method, params);
    try {
      openSettingsModal("connectors");
      const content = document.querySelector("#settings-content");
      for (let i = 0; i < 50; i++) {
        if (content.querySelector('.card[data-connector="google"]') &&
            content.querySelector('.card[data-connector="github"]')) break;
        await sleep(100);
      }
      const externalReady = !!content.querySelector('.card[data-connector="google"]') &&
        !!content.querySelector('.card[data-connector="github"]');
      const mcpPending = !content.querySelector('.card[data-section="mcp"] .pair');
      releaseMcp();
      await sleep(200);
      return { externalReady, mcpPending };
    } finally {
      releaseMcp();
      window.rpc = realRpc;
      closeSettingsModal();
    }
  })()`);
  check(
    connectorIndependence?.externalReady === true && connectorIndependence?.mcpPending === true,
    "slow MCP discovery does not block external connector settings",
    JSON.stringify(connectorIndependence),
  );

  const narrowConnectorLayout = await evaluateAtViewport(320, 800, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const realRpc = window.rpc;
    const longName = "mcp-server-with-an-extremely-long-name-that-must-wrap-without-clipping";
    window.rpc = (method, params) => {
      if (method === "mcp.status") {
        return Promise.resolve({
          servers: [{ name: longName, state: "ready", tools: ["alpha", "beta", "gamma"] }],
        });
      }
      if (method === "config.get") {
        return realRpc(method, params).then((cfg) => ({
          ...cfg,
          lsp: { servers: { [longName]: { extensions: ["ts", "tsx"] } } },
        }));
      }
      return realRpc(method, params);
    };
    try {
      openSettingsModal("connectors");
      const group = document.querySelector('#settings-content [data-connector-group="servers"]');
      for (let i = 0; i < 50; i++) {
        if (group?.querySelector('.card[data-section="mcp"] .ext-reconnect') &&
            group?.querySelector('.card[data-section="lsp"] .pair')) break;
        await sleep(100);
      }
      const mcpCard = group?.querySelector('.card[data-section="mcp"]');
      const lspCard = group?.querySelector('.card[data-section="lsp"]');
      const mcpRow = mcpCard?.querySelector('.pair');
      const lspRow = lspCard?.querySelector('.pair');
      const button = mcpRow?.querySelector(".ext-reconnect");
      button?.focus();
      const groupRect = group?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      const fits = (el) => !!el && el.scrollWidth <= el.clientWidth + 1;
      return {
        hasRows: !!mcpRow && !!lspRow && !!button,
        groupFits: fits(group),
        mcpCardFits: fits(mcpCard),
        lspCardFits: fits(lspCard),
        mcpRowFits: fits(mcpRow),
        lspRowFits: fits(lspRow),
        buttonVisible: !!groupRect && !!buttonRect && buttonRect.width > 0 && buttonRect.height > 0 &&
          buttonRect.left >= groupRect.left - 0.5 && buttonRect.right <= groupRect.right + 0.5 &&
          buttonRect.top >= groupRect.top - 0.5 && buttonRect.bottom <= groupRect.bottom + 0.5,
        buttonFocused: document.activeElement === button,
        metrics: {
          group: group ? { scroll: group.scrollWidth, client: group.clientWidth } : null,
          mcpRow: mcpRow ? { scroll: mcpRow.scrollWidth, client: mcpRow.clientWidth } : null,
          button: buttonRect ? { left: buttonRect.left, right: buttonRect.right } : null,
          groupRect: groupRect ? { left: groupRect.left, right: groupRect.right } : null,
        },
      };
    } finally {
      window.rpc = realRpc;
      closeSettingsModal();
    }
  })()`);
  check(
    narrowConnectorLayout?.hasRows === true && narrowConnectorLayout?.groupFits === true &&
      narrowConnectorLayout?.mcpCardFits === true && narrowConnectorLayout?.lspCardFits === true &&
      narrowConnectorLayout?.mcpRowFits === true && narrowConnectorLayout?.lspRowFits === true &&
      narrowConnectorLayout?.buttonVisible === true && narrowConnectorLayout?.buttonFocused === true,
    "long MCP/LSP names wrap without clipping the reconnect control at 320px",
    JSON.stringify(narrowConnectorLayout),
  );

  const connectorStaleRender = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const realRpc = window.rpc;
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = new Set();
    let configCalls = 0;
    window.rpc = (method, params) => {
      if (method === "mcp.status" || method === "connectors.get") {
        pending.add(method);
        return gate.then(() => {
          pending.delete(method);
          return realRpc(method, params);
        });
      }
      if (method === "config.get") {
        configCalls += 1;
        if (configCalls === 1) {
          pending.add(method);
          return gate.then(() => {
            pending.delete(method);
            return realRpc(method, params);
          });
        }
      }
      return realRpc(method, params);
    };
    try {
      openSettingsModal("connectors");
      for (let i = 0; i < 50; i++) {
        if (pending.has("mcp.status") && pending.has("config.get") && pending.has("connectors.get")) break;
        await sleep(50);
      }
      const pendingBefore = [...pending].sort();
      openSettingsModal("general");
      release();
      await sleep(300);
      const content = document.querySelector("#settings-content");
      return {
        pendingBefore,
        activeSection: document.querySelector("#settings-nav .nav-item.active")?.dataset.section ?? "",
        connectorGroups: content.querySelectorAll("[data-connector-group]").length,
        serverCards: content.querySelectorAll('.card[data-section="mcp"], .card[data-section="lsp"]').length,
        externalCards: content.querySelectorAll(".card[data-connector]").length,
      };
    } finally {
      release();
      window.rpc = realRpc;
      closeSettingsModal();
    }
  })()`);
  check(
    connectorStaleRender?.pendingBefore?.includes("mcp.status") === true &&
      connectorStaleRender?.pendingBefore?.includes("config.get") === true &&
      connectorStaleRender?.pendingBefore?.includes("connectors.get") === true &&
      connectorStaleRender?.activeSection === "general" &&
      connectorStaleRender?.connectorGroups === 0 &&
      connectorStaleRender?.serverCards === 0 &&
      connectorStaleRender?.externalCards === 0,
    "connector RPCs completing after navigation cannot render into another settings section",
    JSON.stringify(connectorStaleRender),
  );

  const connectorCasing = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    openSettingsModal("connectors");
    for (let i = 0; i < 60; i++) {
      if (document.querySelectorAll('.connector-external-list > .card h4').length >= 11) break;
      await sleep(100);
    }
    const titles = [...document.querySelectorAll('.connector-external-list > .card h4')].map((h) => ({
      text: (h.textContent ?? '').trim(),
      transform: getComputedStyle(h).textTransform,
    }));
    closeSettingsModal();
    return titles;
  })()`);
  check(
    connectorCasing?.some((t) => t.text === "GitHub") === true &&
      connectorCasing?.some((t) => t.text === "Jira") === true &&
      connectorCasing.every((t) => t.transform === "none"),
    "external connector titles keep official casing (GitHub / Jira)",
    JSON.stringify(connectorCasing),
  );

  const serverConfigUi = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const realRpc = window.rpc;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    const waitFor = async (fn) => {
      for (let i = 0; i < 60; i++) {
        if (fn()) return true;
        await sleep(100);
      }
      return false;
    };
    const waitForCfg = async (check) => {
      for (let i = 0; i < 60; i++) {
        const cfg = await realRpc('config.get');
        if (check(cfg)) return cfg;
        await sleep(100);
      }
      return null;
    };
    const card = (section) => document.querySelector('#settings-content .card[data-section="' + section + '"]');
    const rowFor = (section, name) => {
      const rows = card(section) ? [...card(section).querySelectorAll('.pair')] : [];
      return rows.find((row) => row.querySelector('.k')?.textContent === name);
    };
    try {
      openSettingsModal("connectors");
      if (!(await waitFor(() => card('mcp')?.querySelector('.srv-add')))) return { stage: 'mcp-add-button' };
      card('mcp').querySelector('.srv-add').click();
      if (!(await waitFor(() => card('mcp')?.querySelector('.srv-form')))) return { stage: 'mcp-form' };
      let form = card('mcp').querySelector('.srv-form');
      form.querySelector('.sf-name').value = 'e2e-mcp';
      form.querySelector('.sf-command').value = 'node';
      form.querySelector('.sf-timeout').value = '5000';
      form.querySelector('.sf-readonly').checked = true;
      form.querySelector('.sf-disabled').checked = true;
      form.querySelector('.sf-save').click();
      if (!(await waitFor(() => !!rowFor('mcp', 'e2e-mcp')))) return { stage: 'mcp-row' };
      const cfgMcp = await waitForCfg((cfg) => !!cfg.mcp?.servers?.['e2e-mcp']);
      const mcpAdded = cfgMcp?.mcp?.servers?.['e2e-mcp']?.command === 'node' &&
        cfgMcp.mcp.servers['e2e-mcp'].disabled === true &&
        cfgMcp.mcp.servers['e2e-mcp'].timeout_ms === 5000 &&
        cfgMcp.mcp.servers['e2e-mcp'].read_only === true;

      rowFor('mcp', 'e2e-mcp').querySelector('.srv-edit').click();
      if (!(await waitFor(() => card('mcp')?.querySelector('.srv-form')))) return { stage: 'mcp-edit-form' };
      form = card('mcp').querySelector('.srv-form');
      form.querySelector('.sf-args').value = '-e 0';
      form.querySelector('.sf-save').click();
      const cfgEdited = await waitForCfg((cfg) =>
        Array.isArray(cfg.mcp?.servers?.['e2e-mcp']?.args) &&
        cfg.mcp.servers['e2e-mcp'].args.join(' ') === '-e 0' &&
        cfg.mcp.servers['e2e-mcp'].timeout_ms === 5000);

      // Unchecking flags and clearing optional fields must actually clear them.
      await waitFor(() => !!rowFor('mcp', 'e2e-mcp')?.querySelector('.srv-edit'));
      rowFor('mcp', 'e2e-mcp').querySelector('.srv-edit').click();
      if (!(await waitFor(() => card('mcp')?.querySelector('.srv-form')))) return { stage: 'mcp-clear-form' };
      form = card('mcp').querySelector('.srv-form');
      form.querySelector('.sf-args').value = '';
      form.querySelector('.sf-timeout').value = '';
      form.querySelector('.sf-readonly').checked = false;
      form.querySelector('.sf-save').click();
      const cfgCleared = await waitForCfg((cfg) => {
        const sv = cfg.mcp?.servers?.['e2e-mcp'];
        return !!sv && sv.disabled === true && sv.read_only === undefined &&
          sv.timeout_ms === undefined && sv.args === undefined;
      });

      if (!(await waitFor(() => card('lsp')?.querySelector('.srv-add')))) return { stage: 'lsp-add-button' };
      card('lsp').querySelector('.srv-add').click();
      if (!(await waitFor(() => card('lsp')?.querySelector('.srv-form')))) return { stage: 'lsp-form' };
      form = card('lsp').querySelector('.srv-form');
      form.querySelector('.sf-name').value = 'e2e-lsp';
      form.querySelector('.sf-command').value = 'node';
      form.querySelector('.sf-ext').value = 'ts, tsx';
      form.querySelector('.sf-disabled').checked = true;
      form.querySelector('.sf-save').click();
      const cfgLsp = await waitForCfg((cfg) => !!cfg.lsp?.servers?.['e2e-lsp']);
      const lspAdded = cfgLsp?.lsp?.servers?.['e2e-lsp']?.extensions?.join(',') === 'ts,tsx';

      await waitFor(() => !!rowFor('mcp', 'e2e-mcp')?.querySelector('.srv-delete'));
      rowFor('mcp', 'e2e-mcp')?.querySelector('.srv-delete')?.click();
      await waitFor(() => !!rowFor('lsp', 'e2e-lsp')?.querySelector('.srv-delete'));
      rowFor('lsp', 'e2e-lsp')?.querySelector('.srv-delete')?.click();
      const deleted = !!(await waitForCfg((cfg) =>
        !cfg.mcp?.servers?.['e2e-mcp'] && !cfg.lsp?.servers?.['e2e-lsp']));
      return { mcpAdded, mcpEdited: !!cfgEdited, mcpCleared: !!cfgCleared, lspAdded, deleted };
    } finally {
      window.confirm = realConfirm;
      closeSettingsModal();
    }
  })()`);
  check(
    serverConfigUi?.mcpAdded === true && serverConfigUi?.mcpEdited === true &&
      serverConfigUi?.mcpCleared === true && serverConfigUi?.lspAdded === true &&
      serverConfigUi?.deleted === true,
    "MCP/LSP servers are added, edited and deleted from the Connectors UI",
    JSON.stringify(serverConfigUi),
  );

  const modeCopy = await evaluate(`(async () => {
    openSettingsModal("general");
    const general = document.querySelector('#settings-content');
    const tabDesc = [...general.querySelectorAll('*')]
      .map((el) => el.textContent ?? '')
      .find((text) => text.includes('Plan ⇔ 直前の権限モード')) ?? '';
    openSettingsModal("shortcuts");
    const shortcuts = document.querySelector('#settings-content').textContent ?? '';
    closeSettingsModal();
    return { tabDesc, shortcuts };
  })()`);
  check(
    modeCopy?.tabDesc?.includes('Plan ⇔ 直前の権限モード') === true &&
      modeCopy?.shortcuts?.includes('Plan ⇔ 直前の権限モードを切替') === true &&
      !modeCopy?.shortcuts?.includes('Build / Plan'),
    "Tab mode copy names Plan and the previous permission mode",
    JSON.stringify(modeCopy),
  );

  const webSearchUi = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rpcGet = window.rpc;
    const card = () => document.querySelector('#settings-content .card[data-section="websearch"]');
    const waitCard = async () => {
      for (let i = 0; i < 60; i++) {
        if (card()?.querySelector('.perm-save')) return true;
        await sleep(100);
      }
      return false;
    };
    const waitCfg = async (check) => {
      for (let i = 0; i < 60; i++) {
        const cfg = await rpcGet('config.get');
        if (check(cfg.permissions?.websearch)) return cfg;
        await sleep(100);
      }
      return null;
    };
    try {
      openSettingsModal("websearch");
      if (!(await waitCard())) return { stage: 'web-card' };
      const navHasSection = [...document.querySelectorAll('#settings-nav .nav-item')]
        .some((item) => item.dataset.section === 'websearch');
      openSettingsModal("approvals");
      const approvalsHasCard = !!document.querySelector('#settings-content .card[data-section="websearch"]');
      openSettingsModal("websearch");
      if (!(await waitCard())) return { stage: 'web-card-again' };
      const sel = card().querySelector('select');
      const input = card().querySelector('.perm-input');
      sel.value = 'searxng';
      input.value = '';
      card().querySelector('.perm-save').click();
      const guarded = [...document.querySelectorAll('#toasts .toast')]
        .some((n) => (n.textContent ?? '').includes('エンドポイントを入力'));
      const cfgBefore = await rpcGet('config.get');
      const unchanged = cfgBefore.permissions?.websearch?.provider !== 'searxng';
      input.value = 'http://127.0.0.1:8399';
      card().querySelector('.perm-save').click();
      const savedCfg = await waitCfg((w) => w?.provider === 'searxng' && w?.base_url === 'http://127.0.0.1:8399');
      const saved = !!savedCfg;
      sel.value = 'duckduckgo';
      input.value = 'http://should-be-cleared.invalid';
      card().querySelector('.perm-save').click();
      const resetCfg = await waitCfg((w) => w?.provider === 'duckduckgo' && w?.base_url === '');
      return { navHasSection, approvalsHasCard, guarded, unchanged, saved, reset: !!resetCfg };
    } finally {
      closeSettingsModal();
    }
  })()`);
  check(
    webSearchUi?.navHasSection === true && webSearchUi?.approvalsHasCard === false &&
      webSearchUi?.guarded === true && webSearchUi?.unchanged === true &&
      webSearchUi?.saved === true && webSearchUi?.reset === true,
    "SearXNG endpoint is configurable from the Web search settings, DuckDuckGo clears it",
    JSON.stringify(webSearchUi),
  );

  const picker = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    closeSettingsModal();
    state.draft.provider = "my-openai";
    state.draft.model = "mock-fast";
    renderModelChip();
    document.querySelector("#model-chip").click();
    for (let i = 0; i < 50 && !document.querySelector("#model-pop .mp-group"); i++) await sleep(100);
    const groups = [...document.querySelectorAll("#model-pop .mp-group")];
    const groupByName = (name) => groups.find((group) => group.querySelector(":scope > span:last-child")?.textContent === name);
    const knownGroup = groupByName("my-openai");
    const fallbackGroup = groupByName("custom");
    const chip = document.querySelector("#model-chip");
    const result = {
      groups: groups.map((group) => group.querySelector(":scope > span:last-child")?.textContent ?? ""),
      knownSvg: knownGroup?.querySelectorAll(".plogo svg").length ?? -1,
      fallbackSvg: fallbackGroup?.querySelectorAll(".plogo svg").length ?? -1,
      fallbackText: fallbackGroup?.querySelector(".plogo")?.textContent ?? "",
      chipSvg: chip?.querySelectorAll(".plogo svg").length ?? -1,
      chipText: chip?.textContent ?? "",
      chipAccessible: chip?.querySelector(".plogo svg")?.getAttribute("aria-hidden") === "true" &&
        chip?.querySelector(".plogo svg")?.getAttribute("focusable") === "false",
    };
    document.querySelector("#model-pop").hidden = true;
    const saved = await rpc("config.provider.set", {
      name: "my-openai",
      kind: "mock",
      base_url: "https://example.com/v1",
    });
    ns.loaded = false;
    await ensureNsConfig();
    const refreshedChip = document.querySelector("#model-chip");
    result.saved = saved?.updated === true;
    result.refreshedSvg = refreshedChip?.querySelectorAll(".plogo svg").length ?? -1;
    result.refreshedText = refreshedChip?.textContent ?? "";
    return result;
  })()`);
  check(
    picker?.knownSvg === 1 && picker?.fallbackSvg === 0 && picker?.fallbackText === "C" &&
      JSON.stringify([...(picker?.groups ?? [])].sort()) === JSON.stringify(["custom", "my-openai"]),
    "model picker renders provider brand shapes and the neutral fallback",
    JSON.stringify(picker),
  );
  check(
    picker?.chipSvg === 1 && picker?.chipText.includes("my-openai/mock-fast") && picker?.chipAccessible === true,
    "model chip renders the selected provider brand shape beside its text",
    JSON.stringify(picker),
  );
  check(
    picker?.saved === true && picker?.refreshedSvg === 0 && picker?.refreshedText.includes("my-openai/mock-fast"),
    "model chip refreshes after provider endpoint metadata changes",
    JSON.stringify(picker),
  );

  for (const width of [390, 560]) {
    const narrow = await evaluateAtViewport(width, 844, `(() => {
      const chip = document.querySelector("#model-chip");
      const logo = chip?.querySelector(".plogo");
      const text = chip?.querySelector(":scope > span");
      const rect = chip?.getBoundingClientRect();
      const logoRect = logo?.getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        right: rect?.right ?? -1,
        left: rect?.left ?? -1,
        logoWidth: logoRect?.width ?? 0,
        textWidth: text?.clientWidth ?? 0,
        overflow: chip ? getComputedStyle(chip).overflowX : "",
      };
    })()`);
    check(
      narrow?.right <= narrow?.viewport && narrow?.left >= 0 &&
        narrow?.logoWidth > 0 && narrow?.textWidth > 0 && narrow?.overflow === "hidden",
      `model chip stays within the ${width}px viewport`,
      JSON.stringify(narrow),
    );
  }
} catch (err) {
  check(false, "desktop e2e completed without an unexpected error", String(err?.stack ?? err));
} finally {
  if (app) await terminateProcessTree(app);
  if (xvfb) await stopChild(xvfb.process);
  await sleep(100);
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "desktop e2e: all ok" : `desktop e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
