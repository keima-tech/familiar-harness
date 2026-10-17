#!/usr/bin/env node
/**
 * Stage the runtime tree packaged into the desktop app (M6 installers).
 *
 * Output: packages/desktop/stage/familiar/ …
 *   packages/{cli,server,core,protocol}/   dist + package.json (+ license bits)
 *   node_modules/@familiar/*                  workspace packages (dereferenced)
 *   node_modules/{yaml,ws}                 runtime deps of the server/cli
 *
 * electron-builder ships `stage/familiar` under the app's extraResources, and
 * main.js resolves the CLI entry from process.resourcesPath when packaged.
 * Everything is dereferenced so the installer carries no symlinks.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const stage = path.join(desktopRoot, "stage", "familiar");
const packages = ["cli", "server", "core", "protocol"];

let failed = false;
for (const p of packages) {
  const dist = path.join(repoRoot, "packages", p, "dist");
  if (!existsSync(dist) || !existsSync(path.join(repoRoot, "packages", p, "package.json"))) {
    console.error(`stage: packages/${p} is not built (missing dist) — run 'npm run build' first`);
    failed = true;
  }
}
if (failed) process.exit(1);

rmSync(path.join(desktopRoot, "stage"), { recursive: true, force: true });
for (const p of packages) {
  cpSync(path.join(repoRoot, "packages", p), path.join(stage, "packages", p), {
    recursive: true,
    force: true,
    dereference: true,
    filter: (src) => !/(^|[\\/])tsbuildinfo$/.test(src),
  });
}

// Runtime npm dependencies (hoisted at the repo root; workspace entries are
// symlinks into packages/, which dereference:true resolves into real copies).
const nmRoot = path.join(repoRoot, "node_modules");
const nodeDeps = ["@familiar/core", "@familiar/protocol", "@familiar/server", "yaml", "ws"];
mkdirSync(path.join(stage, "node_modules"), { recursive: true });
mkdirSync(path.join(stage, "node_modules", "@familiar"), { recursive: true });
for (const dep of nodeDeps) {
  const src = path.join(nmRoot, dep);
  if (!existsSync(src)) {
    console.error(`stage: runtime dependency not installed: ${dep}`);
    process.exit(1);
  }
  cpSync(src, path.join(stage, "node_modules", dep), {
    recursive: true,
    force: true,
    dereference: true,
  });
}

console.log(`staged desktop runtime at ${stage}`);
