#!/usr/bin/env node
// Set the same version in the root package, every workspace package and the
// lockfile. `npm version` only bumps the root, which would desync the CLI's
// self-update check and electron-builder's artifact names.
//
//   npm run version:set -- 0.2.0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("usage: npm run version:set -- <major.minor.patch>");
  process.exit(1);
}

const files = ["package.json"];
const workspaces = path.join(root, "packages");
for (const entry of fs.readdirSync(workspaces, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join("packages", entry.name, "package.json");
  if (fs.existsSync(path.join(root, file))) files.push(file);
}

let from = "";
let changed = 0;
for (const file of files) {
  const abs = path.join(root, file);
  const pkg = JSON.parse(fs.readFileSync(abs, "utf8"));
  from ||= pkg.version ?? "";
  if (pkg.version === next) continue;
  pkg.version = next;
  fs.writeFileSync(abs, JSON.stringify(pkg, null, 2) + "\n");
  changed++;
}

const lockFile = path.join(root, "package-lock.json");
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  let lockChanged = false;
  if (lock.version !== next) {
    lock.version = next;
    lockChanged = true;
  }
  if (lock.packages?.[""] && lock.packages[""].version !== next) {
    lock.packages[""].version = next;
    lockChanged = true;
  }
  for (const file of files.slice(1)) {
    const key = path.posix.dirname(file);
    if (lock.packages?.[key] && lock.packages[key].version !== next) {
      lock.packages[key].version = next;
      lockChanged = true;
    }
  }
  if (lockChanged) {
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
    changed++;
  }
}

if (changed === 0) {
  console.log(`already at ${next} (${files.length} package.json files)`);
} else {
  console.log(`version ${from || "?"} -> ${next} (${files.length} package.json files + lockfile)`);
  console.log("next: git commit, then tag `v" + next + "` before scripts/release.sh --publish");
}
