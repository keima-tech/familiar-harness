#!/usr/bin/env node
/**
 * Desktop α headless e2e (manual; not part of `npm run smoke`).
 * Requires: electron binary (npm install -w packages/desktop) and xvfb.
 *   xvfb is used because this repo's dev box has no display.
 * Run: node scripts/e2e.mjs
 */
import { spawn } from "node:child_process";
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-desktop-"));
const servePort = await freePort();
let fallbackPort = await freePort();
while (fallbackPort === servePort) fallbackPort = await freePort();
let debugPort = await freePort();
while (debugPort === servePort || debugPort === fallbackPort) debugPort = await freePort();
// The mock kind keeps model discovery local; base_url still exercises the
// provider-brand resolver without making any external API request.
const config = `version: 1
default_provider: my-openai
providers:
  my-openai:
    kind: mock
    base_url: https://api.openai.com/v1
  custom:
    kind: mock
    base_url: https://example.com/v1
server:
  port: 0
  bind: 127.0.0.1
`;
fs.writeFileSync(path.join(home, "config.yaml"), config);

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
  ) ?? targets.find((target) => target.type === "page" && (target.url ?? "").startsWith("http://127.0.0.1:"));
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

const app = spawn(
  "xvfb-run",
  [
    "-a",
    electronBin,
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${debugPort}`,
    path.join(repoRoot, "packages", "desktop"),
  ],
  {
    env: {
      ...process.env,
      FAMILIAR_HOME: home,
      FAMILIAR_PORTS: `${servePort},${fallbackPort}`,
      FAMILIAR_SPAWN_PORT: String(servePort),
    },
    stdio: "ignore",
    detached: true,
  },
);

try {
  let uiUrl = "";
  for (let i = 0; i < 100 && !uiUrl; i++) {
    await sleep(250);
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      uiUrl = targets.find(
        (target) => target.type === "page" && (target.url ?? "").startsWith("http://127.0.0.1:"),
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
    settings?.cards >= 3 && settings?.rows >= 5 && settings?.logos === settings?.cards + settings?.rows,
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
    picker?.knownSvg === 1 && picker?.fallbackSvg === 0 && picker?.fallbackText === "C",
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
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {
    try {
      app.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  }
  await sleep(200);
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "desktop e2e: all ok" : `desktop e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
