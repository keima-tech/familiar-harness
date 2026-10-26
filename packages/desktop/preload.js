// Familiar desktop preload — the only bridge between the sandboxed UI and the
// shell. Keep this surface minimal.
"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("familiarDesktop", {
  /** Native folder picker; resolves to the chosen absolute path or null. */
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
  /** Absolute path of a dropped/attached File (Electron ≥32 removed File.path). */
  filePathFor: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** Self-update surface (main process; see main.js `update:*` handlers). */
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  applyUpdate: () => ipcRenderer.invoke("update:apply"),
  restartApp: () => ipcRenderer.invoke("update:restart"),
  onUpdateStatus: (cb) => {
    ipcRenderer.on("update:status", (_ev, st) => cb(st));
  },
  /** Native desktop notification (turn finished / approval needed). */
  notify: (payload) => ipcRenderer.send("app:notify", payload),
  /** Open a file with the OS default application (file preview fallback). */
  openPath: (target) => ipcRenderer.invoke("shell:openPath", target),
  /** SSH connection profiles + window-wide connect/disconnect (main.js). */
  connections: () => ipcRenderer.invoke("conn:list"),
  saveConnection: (profile) => ipcRenderer.invoke("conn:save", profile),
  deleteConnection: (id) => ipcRenderer.invoke("conn:delete", id),
  testConnection: (profile) => ipcRenderer.invoke("conn:test", profile),
  /** Fingerprints via ssh-keyscan (server-side; shared known_hosts). */
  hostKeyScan: (params) => ipcRenderer.invoke("conn:hostkey", params),
  /** Append verified keys to ~/.ssh/known_hosts. */
  trustHostKey: (params) => ipcRenderer.invoke("conn:trusthost", params),
  connectProfile: (id, opts) => ipcRenderer.invoke("conn:connect", { id, ...(opts ?? {}) }),
  disconnectConnection: () => ipcRenderer.invoke("conn:disconnect"),
  onConnectionStatus: (cb) => {
    const handler = (_ev, status) => cb(status);
    ipcRenderer.on("conn:status", handler);
    return () => ipcRenderer.removeListener("conn:status", handler);
  },
});
