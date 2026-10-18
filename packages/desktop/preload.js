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
});
