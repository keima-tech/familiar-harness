// Familiar desktop shell (Electron) — M4 α.
// Strategy: talk to a running `familiar serve` daemon, or spawn one as a child
// process, then load the built-in web UI from http://127.0.0.1:<port>.
// Packaging (electron-builder installers) is the M6 milestone.
"use strict";

const { app, BrowserWindow, shell, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const CFG = {
  ports: [46210, 46211, 46212], // try in order; first free lives
  healthTimeoutMs: 400,
  spawnPort: 46210,
};

let mainWindow = null;
let child = null;

// Native "browse" folder picker for the web UI (window.familiarDesktop.pickDirectory).
ipcMain.handle("dialog:pickDirectory", async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender) ?? mainWindow;
  const res = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});

function probeOnce(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: CFG.healthTimeoutMs },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.ok === true ? { port, tokenFile: parsed.tokenFile } : false);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** M2: when the server requires a bearer token, /healthz tells us which file
 * holds it (the value itself is never exposed). Read it and pass it to the
 * UI via ?token= so the local desktop app works without manual setup. */
function readServerToken(tokenFile) {
  if (!tokenFile || !fs.existsSync(tokenFile)) return "";
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

async function findOrSpawnServer() {
  for (const port of CFG.ports) {
    const live = await probeOnce(port);
    if (live) return { url: `http://127.0.0.1:${live.port}`, token: readServerToken(live.tokenFile), spawned: false };
  }
  const port = CFG.spawnPort;
  child = spawnServe(port);
  // wait for healthz
  for (let i = 0; i < 100; i++) {
    const live = await probeOnce(port);
    if (live) return { url: `http://127.0.0.1:${port}`, token: readServerToken(live.tokenFile), spawned: true };
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function resolveFamiliarCli() {
  // repo layout: packages/desktop/main.js -> ../cli/dist/familiar.js
  const sibling = path.resolve(__dirname, "..", "cli", "dist", "familiar.js");
  if (fs.existsSync(sibling)) return sibling;
  // packaged layout (electron-builder extraResources): <resources>/familiar/packages/cli/dist/familiar.js
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, "familiar", "packages", "cli", "dist", "familiar.js");
    if (fs.existsSync(packed)) return packed;
  }
  return "familiar"; // assume installed globally (familiar / familiar.cmd on PATH)
}

function spawnServe(port) {
  const cli = resolveFamiliarCli();
  const isJs = cli.endsWith(".js");
  const command = isJs ? process.execPath : cli;
  const args = isJs ? [cli, "serve", "--port", String(port)] : ["serve", "--port", String(port)];
  // ELECTRON_RUN_AS_NODE makes the electron binary act as plain node for the
  // child (process.execPath IS the electron binary in the packged app).
  return spawn(command, args, {
    stdio: "ignore",
    detached: false,
    env: isJs ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Familiar Harness",
    backgroundColor: "#0f1117",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // External links (docs etc.) open in the default browser, not the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  void mainWindow.loadURL(url);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const server = await findOrSpawnServer();
    if (!server) {
      const { dialog } = require("electron");
      void dialog.showMessageBox({
        type: "error",
        message: "familiar server could not be started",
        detail: "`familiar serve` did not come up on 127.0.0.1:46210..46212. Start it manually and retry.",
      });
      app.quit();
      return;
    }
    createWindow(server.token ? `${server.url}/?token=${encodeURIComponent(server.token)}` : server.url);
  });

  app.on("window-all-closed", () => {
    if (child) child.kill();
    child = null;
    app.quit();
  });

  app.on("before-quit", () => {
    if (child) child.kill();
    child = null;
  });
}
