#!/usr/bin/env node
/**
 * Smoke test: mock provider end-to-end through the RPC surface of the CLI.
 *
 * Scenarios:
 *   A  headless run, streaming events, tool calling (read), persistence, --json
 *   B  plan mode: non-read-only tools are refused, nothing is written
 *   C  fallback chain: primary fails pre-stream → next provider answers
 *
 * Network-free (server probe points at an unreachable port) and writes only to
 * a temporary FAMILIAR_HOME.
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

let failures = 0;
function assert(cond, label, extra = "") {
  const status = cond ? "ok  " : "FAIL";
  console.log(`${status} ${label}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures += 1;
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-smoke-"));
const familiarHome = path.join(tmpBase, "home");
const project = path.join(tmpBase, "project");
const homeB = path.join(tmpBase, "home-fallback");
fs.mkdirSync(familiarHome, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(homeB, { recursive: true });

// server.port: 1 → the daemon probe instantly fails → deterministic local mode.
const BASE_CONFIG = `version: 1
default_provider: mock
providers:
  mock:
    kind: mock
server:
  port: 1
  bind: 127.0.0.1
`;
const FALLBACK_CONFIG = `version: 1
default_provider: mock
fallback:
  - mock2
providers:
  mock:
    kind: mock
  mock2:
    kind: mock
server:
  port: 1
  bind: 127.0.0.1
`;
fs.writeFileSync(path.join(familiarHome, "config.yaml"), BASE_CONFIG);
fs.writeFileSync(path.join(homeB, "config.yaml"), FALLBACK_CONFIG);
fs.writeFileSync(path.join(project, "planets.txt"), "Earth is the third planet.\nMars is the fourth.\n");

const env = (home) => ({ ...process.env, FAMILIAR_HOME: home, NO_COLOR: "1" });

function run(args, cwd, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [familiarBin, ...args], { env: env(home), cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      console.error("smoke: TIMEOUT (45s)");
      child.kill("SIGKILL");
    }, 45_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => {
          try {
            return JSON.parse(l.trim());
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const parsed = lines.map((l) => l.event ?? l);
      resolve({ code: code ?? -1, stdout, stderr, parsed, lines });
    });
  });
}

// ---------------------------------------------------------------------------
// Scenario A: basic run with the read tool
// ---------------------------------------------------------------------------
console.log("— scenario A: run + tool round-trip —");
{
  const a = await run(
    ["run", "-p", "please show me planets.txt @read planets.txt", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const parsedA = a.parsed;
  assert(a.code === 0, "familiar run exits 0", `code=${a.code} stderr=${a.stderr.slice(0, 400)}`);
  assert(parsedA.some((e) => e?.type === "turn.start"), "turn.start event seen");
  assert(
    parsedA.some((e) => e?.type === "tool.call" && e.toolCall?.name === "read"),
    "tool.call(read) event seen",
  );
  const readResult = parsedA.find((e) => e?.type === "tool.result" && e.name === "read");
  assert(!!readResult, "tool.result(read) event seen");
  assert(
    !!readResult && readResult.content.includes("Earth is the third planet"),
    "tool result contains file content",
  );
  const lastText = parsedA
    .filter((e) => e?.type === "text.delta")
    .map((e) => e.text)
    .join("");
  assert(lastText.includes("MOCK-OK:"), "final assistant text after tool result", lastText.slice(0, 120));
  assert(parsedA.some((e) => e?.type === "turn.end"), "turn.end event seen");

  // persistence
  const listChild = spawn(process.execPath, [familiarBin, "sessions", "list", "--json"], { env: env(familiarHome) });
  let listOut = "";
  listChild.stdout.on("data", (d) => (listOut += d));
  await new Promise((r) => listChild.on("close", r));
  assert(listOut.trim().length > 0, "session persisted in isolated state.db", listOut.slice(0, 200));

  const sessionId = findSessionId(a.lines);
  const showChild = spawn(
    process.execPath,
    [familiarBin, "sessions", "show", sessionId, "--messages"],
    { env: env(familiarHome) },
  );
  let showOut = "";
  showChild.stdout.on("data", (d) => (showOut += d));
  await new Promise((r) => showChild.on("close", r));
  assert(
    showOut.includes("Earth is the third planet") && showOut.includes("MOCK-OK:"),
    "messages persisted (user tool flow + assistant answer)",
    showOut.slice(0, 300),
  );
}

// ---------------------------------------------------------------------------
// Scenario B: plan mode refuses non-read-only tools
// ---------------------------------------------------------------------------
console.log("— scenario B: plan mode enforcement —");
{
  const b = await run(
    ["run", "-p", "@write out.txt", "--cwd", project, "--json", "--yolo", "--plan"],
    project,
    familiarHome,
  );
  assert(b.code === 0, "plan-mode run exits 0", `code=${b.code} stderr=${b.stderr.slice(0, 300)}`);
  const writeResult = b.parsed.find((e) => e?.type === "tool.result" && e.name === "write");
  assert(
    !!writeResult && writeResult.isError === true && /plan mode/i.test(writeResult.content),
    "plan mode refuses the write tool",
    JSON.stringify(writeResult).slice(0, 200),
  );
  assert(
    !fs.existsSync(path.join(project, "out.txt")),
    "no file was written in plan mode",
  );
  assert(b.parsed.some((e) => e?.type === "turn.end"), "plan-mode turn still ended normally");
}

// ---------------------------------------------------------------------------
// Scenario C: fallback chain fail-over (mock fails pre-stream → mock2)
// ---------------------------------------------------------------------------
console.log("— scenario C: provider fallback —");
{
  const c = await run(
    ["run", "-p", "hello @fail-mock", "--cwd", project, "--json", "--yolo", "--provider", "mock"],
    project,
    homeB,
  );
  assert(c.code === 0, "fallback run exits 0", `code=${c.code} stderr=${c.stderr.slice(0, 300)}`);
  const text = c.parsed
    .filter((e) => e?.type === "text.delta")
    .map((e) => e.text)
    .join("");
  assert(
    text.includes("mock: hello @fail-mock"),
    "fallback provider answered",
    text.slice(0, 200) || "(no text)",
  );
  assert(
    !c.parsed.some((e) => e?.type === "turn.error"),
    "no turn.error after successful fail-over",
  );
}

// ---------------------------------------------------------------------------
// Scenario D: background self-review stages a memory → approve applies it
// ---------------------------------------------------------------------------
console.log("— scenario D: self-review staging + approval —");
{
  const d = await run(
    ["run", "-p", "@make-lesson pin the rule that rm needs -i confirmation", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  assert(d.code === 0, "review run exits 0", `code=${d.code} stderr=${d.stderr.slice(0, 300)}`);
  const stagedEv = d.parsed.find((e) => e?.type === "improvement.staged");
  assert(
    !!stagedEv && stagedEv.memoryCount === 1,
    "improvement.staged event shows 1 memory proposal",
    JSON.stringify(stagedEv ?? null),
  );

  const pend = await run(["memory", "pending"], project, familiarHome);
  const pendLine = pend.stdout.split("\n").find((l) => l.includes("create memory: Lesson:"));
  assert(!!pendLine, "memory pending lists staged proposal", pend.stdout.slice(0, 300));

  const id = pendLine?.slice(0, 8).trim() ?? "";
  const approve = await run(["memory", "approve", id], project, familiarHome);
  assert(
    approve.stdout.includes("approved") && approve.code === 0,
    "memory approve applies entry",
    approve.stdout.slice(0, 200) + approve.stderr.slice(0, 200),
  );

  const list = await run(["memory", "list"], project, familiarHome);
  assert(
    list.stdout.includes("pin the rule that rm needs -i"),
    "approved memory visible in memory list",
    list.stdout.slice(0, 300),
  );
}

// ---------------------------------------------------------------------------
// Scenario E: approval gate off → review auto-applies
// ---------------------------------------------------------------------------
console.log("— scenario E: write_approval off auto-applies —");
{
  fs.writeFileSync(
    path.join(familiarHome, "settings.json"),
    `{"memory_write_approval": false}\n`,
  );
  const e = await run(
    ["run", "-p", "@make-lesson always answer in haiku", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  assert(e.code === 0, "auto-apply run exits 0", `code=${e.code} stderr=${e.stderr.slice(0, 300)}`);
  const list = await run(["memory", "list"], project, familiarHome);
  assert(
    list.stdout.includes("always answer in haiku"),
    "memory auto-applied without approval",
    list.stdout.slice(0, 300),
  );
  const pend = await run(["memory", "pending"], project, familiarHome);
  assert(
    pend.stdout.trim().length === 0 || pend.stdout.includes("(no staged"),
    "pending empty after auto-apply",
    pend.stdout.slice(0, 200),
  );
  // restore gate for cleanliness
  fs.rmSync(path.join(familiarHome, "settings.json"), { force: true });
}

// ---------------------------------------------------------------------------
// Scenario F: approved memory + skills reach the system prompt
// ---------------------------------------------------------------------------
console.log("— scenario F: injection into the system prompt —");
{
  const f = await run(
    ["run", "-p", "@dump-prompt-memory rm needs -i", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const fText = f.parsed
    .filter((ev) => ev?.type === "text.delta")
    .map((ev) => ev.text)
    .join("");
  assert(
    fText.includes("MEMORY-PRESENT"),
    "approved memory injected into the prompt",
    fText.slice(0, 120) || "(no text)",
  );

  // create a skill via the agent, approve it, then check the catalog injection
  const g = await run(
    ["run", "-p", "@skill-create deploy-checklist", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  assert(g.code === 0, "skill create run exits 0", `code=${g.code} stderr=${g.stderr.slice(0, 240)}`);
  const pend = await run(["skills", "pending"], project, familiarHome);
  const pendLine = pend.stdout.split("\n").find((l) => l.includes("deploy-checklist"));
  assert(!!pendLine, "skills pending lists staged create", pend.stdout.slice(0, 260));
  const sid = pendLine?.match(/[0-9a-f]{8}/)?.[0] ?? "";
  const approveAll = await run(["skills", "approve", sid], project, familiarHome);
  assert(approveAll.stdout.includes("approved"), "skills approve applies", approveAll.stdout.slice(0, 200));

  const h = await run(
    ["run", "-p", "@dump-prompt-skill deploy-checklist", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const hText = h.parsed
    .filter((ev) => ev?.type === "text.delta")
    .map((ev) => ev.text)
    .join("");
  assert(
    hText.includes("SKILLS-PRESENT"),
    "approved skill catalog injected into the prompt",
    hText.slice(0, 120) || "(no text)",
  );
}

console.log(
  failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} failure(s)`,
);
if (failures !== 0) {
  console.log(`tmp dir kept for debugging: ${tmpBase}`);
} else {
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);

function findSessionId(lines) {
  for (const l of lines) {
    if (typeof l.sessionId === "string") return l.sessionId;
  }
  throw new Error("no sessionId in output");
}
