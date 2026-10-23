// Familiar desktop shell (Electron) — M4 α.
// Strategy: talk to a running `familiar serve` daemon, or spawn one as a child
// process, then load the built-in web UI from http://127.0.0.1:<port>.
// Packaging (electron-builder installers) is the M6 milestone.
"use strict";

const { app, BrowserWindow, shell, dialog, ipcMain, Notification } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");

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

// ---------------------------------------------------------------------------
// self-update: check the Forgejo releases, surface a ⬇ in the topbar, and
// replace the installation on request (same swap scheme as `familiar update`)
// ---------------------------------------------------------------------------
const UPDATE_CFG = {
  host: process.env.FAMILIAR_FORGEJO || "https://example.invalid:3000",
  repo: process.env.FAMILIAR_REPO || "owner/familiar-harness",
  pollMs: 6 * 60 * 60 * 1000, // auto re-check every 6h
};

let updateStatus = { status: "idle" };

function semverCmp(a, b) {
  const triple = (v) => {
    const [nums] = String(v).split("-");
    const p = (nums ?? "").split(".").map((n) => Number.parseInt(n, 10));
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  };
  const [pa, pb] = [triple(a), triple(b)];
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** GET a URL as a buffer, tolerating self-signed CAs on the second try
 * (self-hosted Forgejo). FAMILIAR_TLS_STRICT=1 disables the fallback. */
function httpGetBuffer(url) {
  const viaHttps = () =>
    new Promise((resolve, reject) => {
      const req = https.get(url, { rejectUnauthorized: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 0, buffer: Buffer.concat(chunks) }),
        );
      });
      req.on("error", reject);
      req.setTimeout(300_000, () => req.destroy(new Error("timeout")));
    });
  return fetch(url, { signal: AbortSignal.timeout(300_000) })
    .then(async (res) => ({ ok: res.ok, status: res.status, buffer: Buffer.from(await res.arrayBuffer()) }))
    .catch((err) => {
      const code = String(err?.cause?.code ?? "");
      if (!/CERT|SSL|TLS/i.test(code) || process.env.FAMILIAR_TLS_STRICT === "1") throw err;
      return viaHttps();
    });
}

function pushUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update:status", updateStatus);
  }
}

/** The asset matching this platform (NSIS on Windows, AppImage on Linux). */
function pickUpdateAsset(assets) {
  const list = assets ?? [];
  if (process.platform === "win32") {
    return list.find((a) => /^familiar-\d+\.\d+\.\d+-win-x64\.exe$/.test(a.name ?? "")) ?? null;
  }
  if (process.platform === "linux") {
    return list.find((a) => /^familiar-\d+\.\d+\.\d+-linux-x86_64\.AppImage$/.test(a.name ?? "")) ?? null;
  }
  return null;
}

async function checkForUpdate() {
  if (updateStatus.status === "downloading") return updateStatus;
  try {
    const res = await httpGetBuffer(`${UPDATE_CFG.host}/api/v1/repos/${UPDATE_CFG.repo}/releases`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const releases = JSON.parse(res.buffer.toString("utf8"));
    const current = app.getVersion();
    let pick = null;
    for (const r of releases) {
      const asset = pickUpdateAsset(r.assets);
      if (!asset) continue;
      const v = (r.tag_name ?? "").replace(/^v/, "");
      if (semverCmp(v, current) > 0 && (!pick || semverCmp(v, pick.version) > 0)) {
        pick = { version: v, url: asset.browser_download_url };
      }
    }
    if (pick) pushUpdateStatus({ status: "available", version: pick.version, url: pick.url, error: "" });
    else pushUpdateStatus({ status: "upToDate", version: current, error: "" });
  } catch (err) {
    pushUpdateStatus({ status: "error", error: String(err?.message ?? err) });
  }
  return updateStatus;
}

/** The directory an update replaces (extracted-AppImage layout), or null when
 * the install layout is unknown (dev checkout → update via git pull). */
function installRoot() {
  if (process.env.FAMILIAR_INSTALL_ROOT) return process.env.FAMILIAR_INSTALL_ROOT;
  if (process.platform === "win32" || process.env.APPIMAGE) return null;
  try {
    const dir = path.dirname(fs.realpathSync(process.execPath));
    return fs.existsSync(path.join(dir, "resources", "familiar")) ? dir : null;
  } catch {
    return null;
  }
}

async function applyUpdate() {
  if (updateStatus.status !== "available") return updateStatus;
  const url = updateStatus.url ?? "";
  const version = updateStatus.version ?? "";
  try {
    pushUpdateStatus({ status: "downloading" });
    if (process.platform === "win32") {
      // NSIS: download the installer, then the ↻ click launches it and quits
      const tmp = path.join(os.tmpdir(), `familiar-setup-v${version}.exe`);
      const dl = await httpGetBuffer(url);
      if (!dl.ok) throw new Error(`download failed (HTTP ${dl.status})`);
      fs.writeFileSync(tmp, dl.buffer);
      pushUpdateStatus({ status: "applied", version, installer: tmp });
      return updateStatus;
    }
    const root = installRoot();
    if (!root) throw new Error("unsupported install layout — update via the release page");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-update-"));
    try {
      const appimg = path.join(tmp, "familiar.AppImage");
      const dl = await httpGetBuffer(url);
      if (!dl.ok) throw new Error(`download failed (HTTP ${dl.status})`);
      fs.writeFileSync(appimg, dl.buffer);
      fs.chmodSync(appimg, 0o755);
      // --appimage-extract is handled by the AppImage runtime itself (no FUSE)
      await new Promise((resolve, reject) =>
        execFile(appimg, ["--appimage-extract"], { cwd: tmp }, (err) => (err ? reject(err) : resolve())),
      );
      const staged = path.join(tmp, "squashfs-root");
      if (!fs.existsSync(path.join(staged, "resources", "familiar", "packages", "cli", "dist", "familiar.js"))) {
        throw new Error("staged update looks incomplete — refusing to swap");
      }
      const backup = `${root}.bak-${process.pid}`;
      if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
      fs.renameSync(root, backup);
      try {
        fs.renameSync(staged, root);
      } catch (err) {
        fs.renameSync(backup, root); // restore
        throw err;
      }
      fs.rmSync(backup, { recursive: true, force: true });
      pushUpdateStatus({ status: "applied", version, error: "" });
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (err) {
    pushUpdateStatus({ status: "available", version, url, error: String(err?.message ?? err) });
  }
  return updateStatus;
}

ipcMain.handle("update:check", () => checkForUpdate());
ipcMain.handle("update:apply", () => applyUpdate());
ipcMain.handle("update:restart", () => {
  app.relaunch();
  app.exit(0);
});

// open a file with the OS default application (GUI file viewer: 外部アプリで開く)
ipcMain.handle("shell:openPath", async (_ev, target) => {
  if (typeof target !== "string" || target === "") return "invalid path";
  return shell.openPath(target);
});

// Desktop notifications requested by the web UI (turn finished, approval
// needed). Falls back to a taskbar flash when no notification daemon is
// available (common on bare X11 sessions).
const appIconPath = path.join(__dirname, "build", "icon.png");
ipcMain.on("app:notify", (_ev, payload) => {
  const title = String(payload?.title ?? "Familiar Harness").slice(0, 120);
  const body = String(payload?.body ?? "").slice(0, 300);
  console.log(`[familiar] notify: ${title} — ${body}`);
  try {
    if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  } catch {
    /* ignore */
  }
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title,
      body,
      silent: false,
      ...(fs.existsSync(appIconPath) ? { icon: appIconPath } : {}),
    });
    n.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
  } catch (err) {
    console.warn(`[familiar] notification failed: ${err?.message ?? err}`);
  }
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
  // dev: packages/desktop/build/icon.png — packaged installs get the icon
  // from the electron-builder desktop entries, so this is only a fallback
  const iconPath = path.join(__dirname, "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Familiar Harness",
    backgroundColor: "#0f1117",
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // built-in PDF viewer for the file preview
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
    // auto-check for updates once the window is up, then every 6h — only when
    // the install layout is updatable (dev checkouts update via git pull)
    if (installRoot() !== null || process.platform === "win32") {
      setTimeout(() => void checkForUpdate(), 4_000);
      setInterval(() => void checkForUpdate(), UPDATE_CFG.pollMs);
    }
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
