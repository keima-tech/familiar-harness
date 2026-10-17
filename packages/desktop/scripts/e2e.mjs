#!/usr/bin/env node
/**
 * Desktop α headless e2e (manual; not part of `npm run smoke`).
 * Requires: electron binary (npm install -w packages/desktop) and xvfb.
 *   xvfb is used because this repo's dev box has no display.
 * Run: node scripts/e2e.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
if (!fs.existsSync(electronBin)) {
  console.error("electron not installed — run: npm install -w packages/desktop");
  process.exit(1);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-desktop-"));
const config = `version: 1\ndefault_provider: mock\nproviders:\n  mock:\n    kind: mock\nserver:\n  port: 46210\n`;
fs.writeFileSync(path.join(home, "config.yaml"), config);

let failures = 0;
const check = (okFlag, label, extra = "") => {
  console.log(`${okFlag ? "ok  " : "FAIL"} ${label}${okFlag ? "" : ` ${extra}`}`);
  if (!okFlag) failures += 1;
};

const app = spawn(
  "xvfb-run",
  ["-a", electronBin, "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9223", path.join(repoRoot, "packages", "desktop")],
  { env: { ...process.env, FAMILIAR_HOME: home }, stdio: "ignore" },
);

let sawUiPage = false;
for (let i = 0; i < 100 && !sawUiPage; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const targets = await fetch("http://127.0.0.1:9223/json/list").then((r) => r.json());
    sawUiPage = targets.some(
      (t) => t.type === "page" && (t.url ?? "").startsWith("http://127.0.0.1:46210"),
    );
  } catch {
    /* debugger not up yet */
  }
}
check(sawUiPage, "desktop shell loaded the web UI page");

let serveUp = false;
try {
  const h = await fetch("http://127.0.0.1:46210/healthz").then((r) => r.json());
  serveUp = h.ok === true;
} catch {
  serveUp = false;
}
check(serveUp, "embedded familiar serve is reachable");

app.kill("SIGTERM");
fs.rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? "desktop e2e: all ok" : `desktop e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
