#!/usr/bin/env node
// Remove generated build outputs so a build never ships stale files.
//
// `tsc -b` only writes the files it knows about; when a source file is
// renamed or deleted, the old JavaScript stays in dist/ and ends up in the
// release tarball and in the desktop packages. Cleaning dist/ and the
// incremental build info before every build keeps the artifacts in sync
// with the sources.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = fs.readdirSync(path.join(root, "packages"), { withFileTypes: true });

let removed = 0;
for (const entry of packages) {
  if (!entry.isDirectory()) continue;
  const pkgDir = path.join(root, "packages", entry.name);
  for (const target of [path.join(pkgDir, "dist"), path.join(pkgDir, "tsconfig.tsbuildinfo")]) {
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed += 1;
    console.log(`clean: ${path.relative(root, target)}`);
  }
}
console.log(removed === 0 ? "clean: nothing to remove" : `clean: removed ${removed} path(s)`);
