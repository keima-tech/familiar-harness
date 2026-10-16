#!/usr/bin/env node
/**
 * Smoke test: mock provider end-to-end through the RPC surface of the CLI.
 *
 * Verifies: headless run, streaming events, tool calling (read tool),
 * tool result round-trip, final message, session persistence, --json output.
 *
 * Network-free and writes only to a temporary FAMILIAR_HOME.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const familiarBin = path.join(repoRoot, "packages", "cli", "dist", "familiar.js");
if (!fs.existsSync(familiarBin)) {
  console.error(`smoke: familiar binary not built at ${familiarBin} — run 'npm run build' first`);
  process.exit(1);
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-smoke-"));
const familiarHome = path.join(tmpBase, "home");
const project = path.join(tmpBase, "project");
fs.mkdirSync(familiarHome, { recursive: true });
fs.mkdirSync(project, { recursive: true });

fs.writeFileSync(
  path.join(familiarHome, "config.yaml"),
  `version: 1\ndefault_provider: mock\n`,
);
fs.writeFileSync(path.join(project, "planets.txt"), "Earth is the third planet.\nMars is the fourth.\n");

const child = spawn(
  process.execPath,
  [familiarBin, "run", "-p", "please show me planets.txt @read planets.txt", "--cwd", project, "--json", "--yolo"],
  {
    env: { ...process.env, FAMILIAR_HOME: familiarHome, NO_COLOR: "1" },
    cwd: project,
  },
);

let stdout = "";
let stderr = "";
const timer = setTimeout(() => {
  console.error("smoke: TIMEOUT (30s)");
  child.kill("SIGKILL");
}, 30_000);
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));

const events = await new Promise((resolve, _reject) => {
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? -1 });
  });
});

const lines = stdout
  .split("\n")
  .filter((l) => l.trim().startsWith("{"))
  .map((l) => JSON.parse(l));
const parsed = lines.map((l) => l.event ?? l);

let failures = 0;
function assert(cond, label, extra = "") {
  const status = cond ? "ok  " : "FAIL";
  console.log(`${status} ${label}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures += 1;
}

assert(events.code === 0, "familiar run exits 0", `code=${events.code} stderr=${stderr.slice(0, 400)}`);
assert(parsed.some((e) => e?.type === "turn.start"), "turn.start event seen");
assert(
  parsed.some((e) => e?.type === "tool.call" && e.toolCall?.name === "read"),
  "tool.call(read) event seen",
);
const readResult = parsed.find((e) => e?.type === "tool.result" && e.name === "read");
assert(!!readResult, "tool.result(read) event seen");
assert(
  !!readResult && readResult.content.includes("Earth is the third planet"),
  "tool result contains file content",
);
const lastText = parsed
  .filter((e) => e?.type === "text.delta")
  .map((e) => e.text)
  .join("");
assert(lastText.includes("MOCK-OK:"), "final assistant text after tool result", lastText.slice(0, 120));
assert(parsed.some((e) => e?.type === "turn.end"), "turn.end event seen");

// Verify persistence: list sessions of the isolated home.
const listChild = spawn(process.execPath, [familiarBin, "sessions", "list", "--json"], {
  env: { ...process.env, FAMILIAR_HOME: familiarHome, NO_COLOR: "1" },
});
let listOut = "";
listChild.stdout.on("data", (d) => (listOut += d));
await new Promise((r) => listChild.on("close", r));
const created = /session:/.test(listOut) || /^_/.test(listOut);
const hasSession = listOut.trim().length > 0;

const showChild = spawn(
  process.execPath,
  [familiarBin, "sessions", "show", findSessionId(lines), "--messages"],
  { env: { ...process.env, FAMILIAR_HOME: familiarHome, NO_COLOR: "1" } },
);
let showOut = "";
showChild.stdout.on("data", (d) => (showOut += d));
await new Promise((r) => showChild.on("close", (code) => r(code)));

assert(hasSession, "session persisted in isolated state.db", listOut.slice(0, 200));
assert(
  showOut.includes("Earth is the third planet") && showOut.includes("MOCK-OK:"),
  "messages persisted (user tool flow + assistant answer)",
  showOut.slice(0, 300),
);
void created;

console.log(
  failures === 0
    ? "\nsmoke: all checks passed"
    : `\nsmoke: ${failures} failure(s)\nstdout:\n${stdout.slice(0, 2000)}\nstderr:\n${stderr.slice(0, 2000)}`,
);
fs.rmSync(tmpBase, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

function findSessionId(lines) {
  for (const l of lines) {
    if (typeof l.sessionId === "string") return l.sessionId;
  }
  throw new Error("no sessionId in output");
}
