// Familiar desktop preload — the only bridge between the sandboxed UI and the
// shell. Keep this surface minimal.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("familiarDesktop", {
  /** Native folder picker; resolves to the chosen absolute path or null. */
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
});
