#!/usr/bin/env node
/**
 * Stage what the Tauri shell bundles as resources (src-tauri/resources/):
 *
 *   resources/node/            the Node.js runtime (a copy of the running node)
 *   resources/familiar/           the familiar runtime tree — packages/{cli,server,
 *                              core,protocol}/dist + package.json + the two
 *                              runtime deps (yaml, ws) + the @familiar/* links
 *
 * The shell spawns `node resources/familiar/packages/cli/dist/familiar.js serve` and
 * loads the Web UI from it, so no Node install is needed on the user's machine
 * (this is the "Tauri + official Node bundled" layout). Everything is
 * dereferenced so the bundle carries no symlinks. Run before `tauri build`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const res = path.join(pkgRoot, "src-tauri", "resources");
const iconsDir = path.join(pkgRoot, "src-tauri", "icons");

// --- 1) the Node runtime (the interpreter running this script) --------------
fs.rmSync(res, { recursive: true, force: true });
const nodeDir = path.join(res, "node");
fs.mkdirSync(nodeDir, { recursive: true });
const nodeName = process.platform === "win32" ? "node.exe" : "node";
const nodeDst = path.join(nodeDir, nodeName);
fs.copyFileSync(process.execPath, nodeDst);
try {
  fs.chmodSync(nodeDst, 0o755);
} catch {
  /* Windows / read-only fs — the exec bit is a no-op there */
}

// --- 2) the familiar runtime tree ---------------------------------------------
const packages = ["cli", "server", "core", "protocol"];
for (const p of packages) {
  const dist = path.join(repoRoot, "packages", p, "dist");
  if (!fs.existsSync(dist)) {
    console.error(`stage: packages/${p} is not built (missing dist) — run 'npm run build' first`);
    process.exit(1);
  }
}
const familiar = path.join(res, "familiar");
fs.mkdirSync(path.join(familiar, "packages"), { recursive: true });
for (const p of packages) {
  fs.cpSync(path.join(repoRoot, "packages", p), path.join(familiar, "packages", p), {
    recursive: true,
    force: true,
    dereference: true,
    filter: (src) => !/(^|[\\/])tsbuildinfo$/.test(src),
  });
}
fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(familiar, "package.json"));

// runtime npm deps (hoisted at the repo root; workspace entries are symlinks
// into packages/, which dereference:true resolves into real copies)
const nmRoot = path.join(repoRoot, "node_modules");
const deps = ["@familiar/core", "@familiar/protocol", "@familiar/server", "yaml", "ws"];
fs.mkdirSync(path.join(familiar, "node_modules", "@familiar"), { recursive: true });
for (const dep of deps) {
  const src = path.join(nmRoot, dep);
  if (!fs.existsSync(src)) {
    console.error(`stage: runtime dependency not installed: ${dep}`);
    process.exit(1);
  }
  const dst = path.join(familiar, "node_modules", dep);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true, dereference: true });
}

// --- 3) the app icon (reuse the Web UI brand mark) --------------------------
fs.mkdirSync(iconsDir, { recursive: true });
const iconSrc = path.join(repoRoot, "packages", "server", "public", "icon-512.png");
if (fs.existsSync(iconSrc)) {
  fs.copyFileSync(iconSrc, path.join(iconsDir, "icon.png"));
}

const size = (dir) => {
  let total = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
};
console.log(`stage: node    ${(fs.statSync(nodeDst).size / 1048576).toFixed(1)} MB`);
console.log(`stage: familiar   ${(size(familiar) / 1048576).toFixed(1)} MB`);
console.log(`stage: -> ${path.relative(repoRoot, res)}`);
