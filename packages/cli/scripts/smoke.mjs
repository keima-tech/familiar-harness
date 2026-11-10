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

  // edit tool round-trip: the result must carry a colored diff
  const aEdit = await run(
    ["run", "-p", "fix the typo @edit planets.txt Mars is the fourth. => Mars is the 4th planet.", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const editRes = aEdit.parsed.find((e) => e?.type === "tool.result" && e.name === "edit");
  assert(
    !!editRes && typeof editRes.diff === "string" && editRes.diff.includes("-Mars is the fourth.") && editRes.diff.includes("+Mars is the 4th planet."),
    "edit tool.result carries a unified diff",
    JSON.stringify(editRes).slice(0, 200),
  );

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

// ---------------------------------------------------------------------------
// Scenario H: curator garden cycle (phase-1 archive + consolidation staging)
// ---------------------------------------------------------------------------
console.log("— scenario H: curator —");
{
  // craft a 40-day-idle skill and a fresh one directly in the familiar home
  const skillsRoot = path.join(familiarHome, "skills");
  fs.mkdirSync(path.join(skillsRoot, "old-checklist"), { recursive: true });
  fs.mkdirSync(path.join(skillsRoot, "fresh-note"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsRoot, "old-checklist", "SKILL.md"),
    "---\nname: old-checklist\ndescription: shipping steps\n---\n\nProcedure: 1. lint 2. test 3. ship\n",
  );
  fs.writeFileSync(
    path.join(skillsRoot, "fresh-note", "SKILL.md"),
    "---\nname: fresh-note\ndescription: scratch notes\n---\n\nMade today.\n",
  );
  const now = Date.now();
  const day = 86_400_000;
  fs.writeFileSync(
    path.join(skillsRoot, ".usage.json"),
    JSON.stringify(
      {
        "old-checklist": { useCount: 2, createdMs: now - 60 * day, lastUsedMs: now - 40 * day },
        "fresh-note": { useCount: 0, createdMs: now },
      },
      null,
      2,
    ),
  );

  const h1 = await run(["curator", "run"], project, familiarHome);
  assert(
    h1.stdout.includes("archived 1"),
    "curator archives skill idle >= 30d",
    h1.stdout.slice(0, 240) + h1.stderr.slice(0, 240),
  );
  const hLedger = await run(["curator", "ledger"], project, familiarHome);
  assert(
    hLedger.stdout.includes("archive") && hLedger.stdout.includes("old-checklist"),
    "ledger records the archival",
    hLedger.stdout.slice(0, 240),
  );
  const h2 = await run(["curator", "list-archived"], project, familiarHome);
  assert(h2.stdout.includes("old-checklist"), "list-archived shows it", h2.stdout.slice(0, 200));

  // phase-2 consolidation (mock aux): deterministic umbrella staged as pending
  const h3 = await run(["curator", "run", "--consolidate"], project, familiarHome);
  assert(
    h3.stdout.includes("consolidation:") && h3.stdout.includes("1 staged"),
    "consolidation staged an umbrella proposal",
    h3.stdout.slice(0, 300) + h3.stderr.slice(0, 200),
  );
  const pend = await run(["skills", "pending"], project, familiarHome);
  assert(
    pend.stdout.includes("deploys-checklist"),
    "umbrella lands in skills pending",
    pend.stdout.slice(0, 240),
  );
  const sid2 = pend.stdout.match(/[0-9a-f]{8}/)?.[0] ?? "";
  await run(["skills", "approve", sid2], project, familiarHome);
  const cat = await run(["skills", "list"], project, familiarHome);
  assert(
    cat.stdout.includes("deploys-checklist"),
    "approved umbrella is in the catalog",
    cat.stdout.slice(0, 240),
  );

  const h4 = await run(["curator", "status"], project, familiarHome);
  assert(
    h4.stdout.includes("enabled: yes") && /snapshots: [1-9]/.test(h4.stdout),
    "curator status reflects the cycle",
    h4.stdout.slice(0, 260),
  );
}

// ---------------------------------------------------------------------------
// Scenario I: familiar serve web UI (static assets + WS event stream)
// ---------------------------------------------------------------------------
console.log("— scenario I: web ui transport —");
{
  const { createRequire } = await import("node:module");
  const { WebSocket } = createRequire(import.meta.filename)("ws");
  const PORT = 46219;
  const serve = spawn(process.execPath, [familiarBin, "serve", "--port", String(PORT)], {
    cwd: project,
    env: env(familiarHome),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serveLog = "";
  serve.stdout.on("data", (d) => (serveLog += d));
  serve.stderr.on("data", (d) => (serveLog += d));

  let health = false;
  for (let i = 0; i < 50 && !health; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      health = (await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json())).ok === true;
    } catch {
      health = false;
    }
  }
  assert(health, "serve /healthz responds");
  const page = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  assert(page.includes("app.js"), "web UI index served", page.slice(0, 120));
  const appJs = await fetch(`http://127.0.0.1:${PORT}/app.js`).then((r) => r.text());
  assert(appJs.includes("session.send"), "web UI app.js served");
  assert(
    page.includes('id="file-menu"') && page.includes('id="file-submenu"') &&
      page.includes('data-act="rename"') && page.includes('data-act="delete"'),
    "web UI ships the files-tab context menu (open/rename/delete)",
  );
  assert(
    appJs.includes("openFileMenu") && appJs.includes("showFileSubmenu") && appJs.includes("runFileOpen") &&
      appJs.includes("commitFileRename") && appJs.includes("deleteFileEntry"),
    "web UI app.js wires the files-tab context menu",
  );

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const frames = [];
  await new Promise((res) => ws.once("open", res));
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    if (f.type === "event") frames.push(f);
  });
  await new Promise((r) => setTimeout(r, 250));
  const created = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: {} }),
  }).then((r) => r.json());
  assert(!!created.result?.id, "session.create over HTTP", JSON.stringify(created.error ?? {}).slice(0, 120));
  // v1.1: session.update (rename + provider/model patch) over HTTP
  const upd = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "session.update",
      params: { id: created.result.id, title: "renamed by smoke" },
    }),
  }).then((r) => r.json());
  assert(upd.result?.title === "renamed by smoke", "session.update renames the session", JSON.stringify(upd));
  // v1.1: session.update cwd (working folder from the chat header)
  const updCwd = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 28,
      method: "session.update",
      params: { id: created.result.id, cwd: "/tmp" },
    }),
  }).then((r) => r.json());
  assert(updCwd.result?.cwd === "/tmp", "session.update sets the working folder", JSON.stringify(updCwd));
  const updCwdBad = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 29,
      method: "session.update",
      params: { id: created.result.id, cwd: "/no/such/dir-xyz" },
    }),
  }).then((r) => r.json());
  assert(!!updCwdBad.error, "session.update rejects a non-existent cwd", JSON.stringify(updCwdBad).slice(0, 140));
  // v1.1: fs.dirs (working-folder suggestions)
  const dirsOk = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 30, method: "fs.dirs", params: { path: "/tmp" } }),
  }).then((r) => r.json());
  assert(
    Array.isArray(dirsOk.result?.dirs) && typeof dirsOk.result?.home === "string",
    "fs.dirs lists directories",
    JSON.stringify(dirsOk).slice(0, 120),
  );
  const dirsBad = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 31, method: "fs.dirs", params: { path: "/no/such/dir-xyz" } }),
  }).then((r) => r.json());
  assert(!!dirsBad.error, "fs.dirs errors on a non-existent directory", JSON.stringify(dirsBad).slice(0, 140));
  // v1.1: fs.suggest (@file completion) + todo.list (task panel)
  const sug = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 32,
      method: "fs.suggest",
      params: { prefix: "/tm", cwd: "/tmp" },
    }),
  }).then((r) => r.json());
  assert(
    Array.isArray(sug.result?.items) && sug.result.items.length > 0 && sug.result.items[0]?.path.startsWith("/"),
    "fs.suggest returns matching paths",
    JSON.stringify(sug).slice(0, 140),
  );
  // v1.1: fs.rename / fs.delete (GUI file tree) + their safety guards
  const opsDir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-fsops-"));
  const origFile = path.join(opsDir, "before.txt");
  fs.writeFileSync(origFile, "hi\n");
  const rpcCall = (id, method, params) =>
    fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }).then((r) => r.json());
  const renamedFile = path.join(opsDir, "after.txt");
  const renameRes = await rpcCall(34, "fs.rename", { path: origFile, name: "after.txt" });
  assert(
    renameRes.result?.path === renamedFile && !fs.existsSync(origFile) && fs.existsSync(renamedFile),
    "fs.rename renames a file within its directory",
    JSON.stringify(renameRes).slice(0, 140),
  );
  const renameSep = await rpcCall(35, "fs.rename", { path: renamedFile, name: "../escape.txt" });
  assert(!!renameSep.error, "fs.rename refuses a name with separators", JSON.stringify(renameSep).slice(0, 140));
  const delRoot = await rpcCall(36, "fs.delete", { path: "/" });
  assert(
    /filesystem root/.test(String(delRoot.error?.message)),
    "fs.delete refuses a filesystem root",
    JSON.stringify(delRoot).slice(0, 140),
  );
  const deleteRes = await rpcCall(37, "fs.delete", { path: renamedFile });
  assert(
    deleteRes.result?.deleted === true && !fs.existsSync(renamedFile),
    "fs.delete removes a file",
    JSON.stringify(deleteRes).slice(0, 140),
  );
  fs.rmSync(opsDir, { recursive: true, force: true });
  const todos = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 33,
      method: "todo.list",
      params: { id: created.result.id },
    }),
  }).then((r) => r.json());
  assert(Array.isArray(todos.result?.items), "todo.list returns the task list", JSON.stringify(todos).slice(0, 120));
  // v1.1: config.provider.set (settings GUI writes kind / endpoint / key)
  const provSet = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 22,
      method: "config.provider.set",
      params: { name: "smoke-local", kind: "openai_compatible", base_url: "http://127.0.0.1:9999/v1", api_key: "smoke-secret-123" },
    }),
  }).then((r) => r.json());
  assert(provSet.result?.updated === true, "config.provider.set accepts a patch", JSON.stringify(provSet.error ?? {}).slice(0, 160));
  const cfgAfter = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 23, method: "config.get", params: {} }),
  }).then((r) => r.json());
  const smokePc = cfgAfter.result?.providers?.["smoke-local"];
  assert(!!smokePc, "provider appears in config.get after the patch", JSON.stringify(cfgAfter.result?.providers ?? {}).slice(0, 160));
  assert(smokePc?.base_url === "http://127.0.0.1:9999/v1", "provider base_url persisted");
  assert(smokePc?.auth?.source?.startsWith("file:"), "api key stored via api_key_file (never inline)", JSON.stringify(smokePc?.auth));
  assert(JSON.stringify(cfgAfter.result).indexOf("smoke-secret-123") < 0, "secret value never exposed by config.get");
  const provBad = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 24,
      method: "config.provider.set",
      params: { name: "bad!!", kind: "nope", base_url: "ftp://x" },
    }),
  }).then((r) => r.json());
  assert(!!provBad.error, "config.provider.set rejects invalid input", JSON.stringify(provBad).slice(0, 160));
  // v1.1: models.probe — list models from an endpoint that is NOT saved yet
  const probeOllama = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 25,
      method: "models.probe",
      params: { kind: "openai_compatible", base_url: "http://127.0.0.1:1" },
    }),
  }).then((r) => r.json());
  assert(
    Array.isArray(probeOllama.result?.models) && typeof probeOllama.result?.error === "string",
    "models.probe reports unreachable endpoints as errors, not empty lists",
    JSON.stringify(probeOllama).slice(0, 160),
  );
  const probeBad = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 26,
      method: "models.probe",
      params: { kind: "openai_compatible", base_url: "not-a-url" },
    }),
  }).then((r) => r.json());
  assert(!!probeBad.error, "models.probe rejects invalid base_url", JSON.stringify(probeBad).slice(0, 160));
  const sent = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.send",
      params: { id: created.result.id, text: "hi from the web ui" },
    }),
  }).then((r) => r.json());
  assert(!sent.error, "session.send accepted over HTTP", JSON.stringify(sent).slice(0, 120));
  await new Promise((r) => setTimeout(r, 400));
  const streamed = frames
    .filter((f) => f.sessionId === created.result.id && f.event.type === "text.delta")
    .map((f) => f.event.text)
    .join("");
  assert(
    streamed.includes("mock: hi from the web ui"),
    "turn events streamed over WS",
    JSON.stringify(frames.map((f) => f.event.type)).slice(0, 160),
  );
  // reasoning stream: the mock emits a reasoning chunk before its reply
  const reasoning = frames
    .filter((f) => f.sessionId === created.result.id && f.event.type === "reasoning.delta")
    .map((f) => f.event.text)
    .join("");
  assert(
    reasoning.startsWith("mock-thinking:"),
    "reasoning.delta events streamed over WS",
    JSON.stringify(reasoning).slice(0, 120),
  );
  const persisted = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 27,
      method: "session.get",
      params: { id: created.result.id },
    }),
  }).then((r) => r.json());
  const asst = (persisted.result?.messages ?? []).filter((m) => m.role === "assistant").pop();
  assert(
    typeof asst?.meta?.reasoning === "string" && asst.meta.reasoning.startsWith("mock-thinking:"),
    "reasoning persisted on the assistant message meta",
    JSON.stringify(asst?.meta ?? {}).slice(0, 120),
  );
  const del = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session.delete",
      params: { id: created.result.id },
    }),
  }).then((r) => r.json());
  assert(del.result?.deleted === true, "session.delete removes the session", JSON.stringify(del));
  const after = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session.list", params: {} }),
  }).then((r) => r.json());
  assert(
    !(after.result ?? []).some((s) => s.id === created.result.id),
    "deleted session disappears from session.list",
  );
  // "Full access" (permissionMode: yolo) must also stop risky commands from
  // asking: the loop folds the mode into the yolo flag the bash tool reads.
  const throwaway = path.join(tmpBase, "yolo-throwaway.txt");
  fs.writeFileSync(throwaway, "x");
  const yoloSession = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "session.create", params: {} }),
  }).then((r) => r.json());
  const yoloSend = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session.send",
      params: {
        id: yoloSession.result.id,
        text: `@bash rm -f ${throwaway}`,
        permissionMode: "yolo",
      },
    }),
  }).then((r) => r.json());
  const yoloRan = yoloSend.result?.toolCalls === 1 && !fs.existsSync(throwaway);
  assert(
    yoloRan,
    "permissionMode yolo runs a risky command without asking",
    JSON.stringify(yoloSend.result ?? yoloSend.error ?? {}).slice(0, 160),
  );

  ws.close();
  serve.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
}

// ---------------------------------------------------------------------------
// Scenario J: MCP dynamic tools (stdio server → mcp__mock__echo_text)
// ---------------------------------------------------------------------------
console.log("— scenario J: mcp —");
{
  const homeJ = path.join(tmpBase, "home-mcp");
  fs.mkdirSync(homeJ, { recursive: true });
  fs.writeFileSync(
    path.join(homeJ, "config.yaml"),
    BASE_CONFIG.replace(
      "server:",
      `mcp:\n  servers:\n    mock:\n      command: node\n      args: ["${repoRoot}/packages/cli/scripts/mock-mcp-server.mjs"]\n      read_only: true\n\nserver:`,
    ),
  );

  const j1 = await run(["mcp"], project, homeJ);
  assert(
    j1.stdout.includes("ready") && j1.stdout.includes("mcp__mock__echo_text"),
    "familiar mcp shows the discovered tool",
    j1.stdout.slice(0, 200) + j1.stderr.slice(0, 200),
  );
  const j2 = await run(["run", "-p", "@mcp hello world"], project, homeJ);
  assert(
    j2.stdout.includes("mcp-echo: HELLO WORLD"),
    "MCP tool executed inside the turn loop",
    j2.stdout.slice(-300) + j2.stderr.slice(-200),
  );
}

// ---------------------------------------------------------------------------
// Scenario K: lifecycle hooks (post_tool_use / turn_complete JSON on stdin)
// ---------------------------------------------------------------------------
console.log("— scenario K: hooks —");
{
  const homeK = path.join(tmpBase, "home-hooks");
  fs.mkdirSync(homeK, { recursive: true });
  fs.writeFileSync(
    path.join(homeK, "hook.js"),
    `import fs from "node:fs";\nlet c = "";\nprocess.stdin.on("data", (d) => (c += d));\nprocess.stdin.on("end", () => {\n  const e = JSON.parse(c);\n  fs.appendFileSync(\n    ${JSON.stringify(path.join(homeK, "hook.log"))},\n    e.event + ":" + (e.tool ?? "") + "\\n",\n  );\n});\n`,
  );
  fs.writeFileSync(
    path.join(homeK, "config.yaml"),
    BASE_CONFIG.replace(
      "server:",
      `hooks:\n  post_tool_use:\n    - node "${path.join(homeK, "hook.js")}"\n  turn_complete:\n    - node "${path.join(homeK, "hook.js")}"\n\nserver:`,
    ),
  );
  await run(["run", "-p", "@read planets.txt"], project, homeK);
  await new Promise((r) => setTimeout(r, 300));
  const hookLog = fs.existsSync(path.join(homeK, "hook.log"))
    ? fs.readFileSync(path.join(homeK, "hook.log"), "utf8")
    : "";
  assert(hookLog.includes("post_tool_use:read"), "post_tool_use hook fired", hookLog.slice(0, 120));
  assert(hookLog.includes("turn_complete"), "turn_complete hook fired", hookLog.slice(0, 160));
}

// ---------------------------------------------------------------------------
// Scenario L: cron once-at-boot job on familiar serve
// ---------------------------------------------------------------------------
console.log("— scenario L: cron —");
{
  const { spawn } = await import("node:child_process");
  const homeL = path.join(tmpBase, "home-cron");
  fs.mkdirSync(homeL, { recursive: true });
  fs.writeFileSync(
    path.join(homeL, "config.yaml"),
    BASE_CONFIG.replace(
      "server:",
      `cron:\n  jobs:\n    - name: boot-digest\n      every_minutes: 0\n      prompt: "cron nightly digest for the boot probe"\n\nserver:`,
    ),
  );
  const serveL = spawn(process.execPath, [familiarBin, "serve", "--port", "46232"], {
    cwd: project,
    env: env(homeL),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serveLLog = "";
  serveL.stdout.on("data", (d) => (serveLLog += d));
  serveL.stderr.on("data", (d) => (serveLLog += d));

  let cronSession = null;
  for (let i = 0; i < 60 && !cronSession; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const list = await fetch("http://127.0.0.1:46232/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list" }),
      }).then((r) => r.json());
      const s = (list.result ?? []).find((x) => x.title.startsWith("cron: boot-digest"));
      if (s) cronSession = s;
    } catch {
      /* serve not up yet */
    }
  }
  assert(!!cronSession, "cron job created its session at boot", serveLLog.slice(0, 240));

  const status = await fetch("http://127.0.0.1:46232/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "cron.status" }),
  }).then((r) => r.json());
  const job = status.result?.jobs?.[0];
  assert(
    status.result?.started === true && job?.ranOnce === true && job?.lastStatus === "ok",
    "cron.status shows the completed boot run",
    JSON.stringify(status.result ?? status.error).slice(0, 200),
  );
  serveL.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
}

// ---------------------------------------------------------------------------
// Scenario M: parallel subagents (@task-pair emits two task calls in one step)
// ---------------------------------------------------------------------------
console.log("— scenario M: task parallelization —");
{
  const m1 = await run(["run", "-p", "@task-pair alpha beta", "--json"], project, familiarHome);
  let taskCalls = 0;
  let sawAlpha = false;
  let sawBeta = false;
  for (const line of m1.stdout.split("\n")) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.event?.type === "tool.call" && parsed.event.toolCall?.name === "task") {
      taskCalls += 1;
    }
    if (parsed.event?.type === "tool.result") {
      const content = parsed.event.content ?? "";
      if (content.includes("research alpha")) sawAlpha = true;
      if (content.includes("research beta")) sawBeta = true;
    }
  }
  assert(
    taskCalls >= 2,
    "two task calls executed from one assistant step",
    JSON.stringify(taskCalls),
  );
  assert(
    sawAlpha && sawBeta,
    "both subagent final texts came back as tool results",
    `alpha=${String(sawAlpha)} beta=${String(sawBeta)}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario N: SOUL.md layered personas (M6: global → profile → project)
// ---------------------------------------------------------------------------
console.log("— scenario N: SOUL.md layering —");
{
  const homeN = path.join(tmpBase, "home-soul");
  fs.mkdirSync(path.join(homeN, "profiles", "dev"), { recursive: true });
  fs.writeFileSync(
    path.join(homeN, "config.yaml"),
    BASE_CONFIG,
  );
  fs.writeFileSync(
    path.join(homeN, "SOUL.md"),
    "# SOUL GLOBAL MARKER-n-global\nstay grounded and curious\n",
  );
  fs.writeFileSync(
    path.join(homeN, "profiles", "dev", "SOUL.md"),
    "# SOUL PROFILE MARKER-n-profile\ndev-mode persona\n",
  );
  const projN = path.join(tmpBase, "project-soul");
  fs.mkdirSync(path.join(projN, ".familiar"), { recursive: true });
  fs.writeFileSync(
    path.join(projN, ".familiar", "SOUL.md"),
    "# SOUL PROJECT MARKER-n-project\nkeep this repo tidy\n",
  );

  async function soulCheck(marker, extraArgs) {
    const r = await run(
      ["run", "-p", `@dump-prompt-soul ${marker}`, "--cwd", projN, "--json", "--yolo", ...extraArgs],
      projN,
      homeN,
    );
    const text = r.parsed
      .filter((ev) => ev?.type === "text.delta")
      .map((ev) => ev.text)
      .join("");
    return text;
  }
  assert(
    (await soulCheck("MARKER-n-global", [])).includes("SOUL-PRESENT"),
    "global ~/.familiar/SOUL.md is injected",
  );
  assert(
    (await soulCheck("MARKER-n-project", [])).includes("SOUL-PRESENT"),
    "project .familiar/SOUL.md is injected",
  );
  assert(
    (await soulCheck("MARKER-n-profile", ["--profile", "dev"])).includes("SOUL-PRESENT"),
    "profile SOUL.md is injected via --profile",
  );
}

// ---------------------------------------------------------------------------
// Scenario O: LSP diagnostics (mock stdio language server)
// ---------------------------------------------------------------------------
console.log("— scenario O: lsp_diagnostics —");
{
  const homeO = path.join(tmpBase, "home-lsp");
  fs.mkdirSync(homeO, { recursive: true });
  fs.writeFileSync(
    path.join(homeO, "config.yaml"),
    BASE_CONFIG.replace(
      "server:",
      `lsp:\n  servers:\n    mock:\n      command: node\n      args: ["${repoRoot}/packages/cli/scripts/mock-lsp-server.mjs"]\n      extensions: [txt]\n\nserver:`,
    ),
  );
  fs.writeFileSync(
    path.join(project, "notes.txt"),
    "first line\nFAIL: something bad here\nthird line\n",
  );
  fs.writeFileSync(path.join(project, "clean.txt"), "all fine\n");

  const o1 = await run(["run", "-p", "@lsp notes.txt", "--json", "--yolo"], project, homeO);
  const oText = o1.parsed
    .filter((ev) => ev?.type === "tool.result")
    .map((ev) => ev.content ?? "")
    .join("\n");
  assert(
    oText.includes("MOCK001") && oText.includes("[error]"),
    "lsp server reports the FAIL marker as an error",
    JSON.stringify(oText.slice(0, 200)),
  );
  assert(o1.code === 0, "run with lsp tool exits cleanly (children reaped)", `code=${o1.code}`);

  const o2 = await run(["run", "-p", "@lsp clean.txt", "--json", "--yolo"], project, homeO);
  const o2Text = o2.parsed
    .filter((ev) => ev?.type === "tool.result")
    .map((ev) => ev.content ?? "")
    .join("\n");
  assert(
    o2Text.includes("file is clean"),
    "clean file reports zero diagnostics",
    JSON.stringify(o2Text.slice(0, 200)),
  );

  const o3 = await run(["run", "-p", "@lsp no-server.rst", "--json", "--yolo"], project, homeO);
  const o3Text = o3.parsed
    .filter((ev) => ev?.type === "tool.result")
    .map((ev) => ev.content ?? "")
    .join("\n");
  assert(
    o3Text.includes("no language server configured"),
    "uncovered extension fails with a hint, not a crash",
    JSON.stringify(o3Text.slice(0, 200)),
  );
}

console.log("— scenario P: serve bearer-token auth (M2) —");
{
  const homeP = path.join(tmpBase, "home-auth");
  fs.mkdirSync(homeP, { recursive: true });
  const token = "smoke-token-abc123";
  const tokenFile = path.join(homeP, "server.token");
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(homeP, "config.yaml"),
    `version: 1
default_provider: mock
providers:
  mock:
    kind: mock
server:
  port: 46299
  bind: 127.0.0.1
  auth_token_file: ${tokenFile}
`,
  );
  const PORT = 46299;
  const serveP = spawn(process.execPath, [familiarBin, "serve", "--port", String(PORT)], {
    cwd: project,
    env: env(homeP),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const h = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json());
      up = h.ok === true && h.auth === "required" && typeof h.tokenFile === "string";
    } catch {
      up = false;
    }
  }
  assert(up, "serve /healthz reports auth required + tokenFile");
  const rpc = (headers) => fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
  });
  assert((await fetch(`http://127.0.0.1:${PORT}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 401, "POST /rpc without token -> 401");
  assert((await rpc({ authorization: `Bearer wrong-token` })).status === 401, "POST /rpc with wrong token -> 401");
  assert((await rpc({ authorization: `Bearer ${token}` })).status === 200, "POST /rpc with bearer token -> 200");
  assert((await rpc({ "x-familiar-token": token })).status === 401, "non-bearer header is not accepted");
  // browser navigation without a token serves the token ENTRY PAGE (200):
  // the UI itself stays protected — only the entry form is public
  const entryPage = await fetch(`http://127.0.0.1:${PORT}/`);
  assert(entryPage.status === 200, "GET / without token -> token entry page (200)");
  const entryHtml = await entryPage.text();
  assert(entryHtml.includes("access token") && !entryHtml.includes("composer"), "token entry page rendered (no UI leak)");
  assert((await fetch(`http://127.0.0.1:${PORT}/?token=${token}`)).status === 200, "GET /?token=... -> 200");
  const nope = await fetch(`http://127.0.0.1:${PORT}/?token=nope`);
  assert(nope.status === 200 && (await nope.text()).includes("invalid token"), "GET /?token=nope -> entry page with error");
  // the cookie issued on a valid ?token= load authenticates sub-resources
  const setCookie = (await fetch(`http://127.0.0.1:${PORT}/?token=${token}`)).headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  assert(cookie.startsWith("familiar_token="), "valid ?token= sets the familiar_token cookie");
  assert((await fetch(`http://127.0.0.1:${PORT}/app.js`, { headers: { cookie } })).status === 200, "GET /app.js with cookie -> 200");
  const secretLeak = await fetch(`http://127.0.0.1:${PORT}/?token=${token}`).then((r) => r.text());
  assert(!secretLeak.includes(token), "served UI never contains the token value");
  serveP.kill("SIGTERM");
}

// ---------------------------------------------------------------------------
// Scenario Q: bash approval tiers (allow / ask / deny)
// ---------------------------------------------------------------------------
console.log("— scenario Q: bash approval tiers —");
{
  // safe commands run with no approval at all now (mode: "allow")
  const q1 = await run(
    ["run", "-p", "@bash echo familiar-policy-ok", "--cwd", project, "--json"],
    project,
    familiarHome,
  );
  const r1 = q1.parsed.find((e) => e?.type === "tool.result" && e.name === "bash");
  assert(
    !!r1 && r1.isError !== true && String(r1.content).includes("familiar-policy-ok"),
    "safe commands run without approval",
    JSON.stringify(r1).slice(0, 200),
  );

  // destructive but approvable: headless (deny adapter) refuses…
  const q2 = await run(
    ["run", "-p", "@bash rm -rf /tmp/familiar-policy-nope", "--cwd", project, "--json"],
    project,
    familiarHome,
  );
  const r2 = q2.parsed.find((e) => e?.type === "tool.result" && e.name === "bash");
  assert(
    !!r2 && r2.isError === true && /denied by user\/policy/.test(String(r2.content)),
    "rm -rf asks (headless denies)",
    JSON.stringify(r2).slice(0, 200),
  );

  // …and --yolo approves it (it is not hard-blocked)
  const q3 = await run(
    ["run", "-p", "@bash rm -rf /tmp/familiar-policy-nope", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const r3 = q3.parsed.find((e) => e?.type === "tool.result" && e.name === "bash");
  assert(!!r3 && r3.isError !== true, "an approved rm -rf runs", JSON.stringify(r3).slice(0, 200));

  // catastrophic disk writes stay blocked even under --yolo
  const q4 = await run(
    ["run", "-p", "@bash mkfs.ext4 /dev/sda1", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const r4 = q4.parsed.find((e) => e?.type === "tool.result" && e.name === "bash");
  assert(
    !!r4 && r4.isError === true && /deny/.test(String(r4.content)),
    "unrecoverable commands are hard-blocked",
    JSON.stringify(r4).slice(0, 200),
  );

  // the compiled decision table: wiping the filesystem is denied even with
  // approval, while deeper targets stay approvable
  const { commandDecision } = await import(
    path.join(repoRoot, "packages/core/dist/tools/permissions.js")
  );
  const { DEFAULT_CONFIG } = await import(path.join(repoRoot, "packages/core/dist/config.js"));
  const bcfg = DEFAULT_CONFIG.permissions.bash;
  const table = [
    // [command, expected action]
    ["rm -rf /", "deny"],
    ["rm -rf /*", "deny"],
    ["rm -rf / --no-preserve-root", "deny"],
    ["sudo rm -rf /", "deny"],
    ["rm -rf /etc", "deny"],
    ["rm -rf /home", "deny"],
    ["rm -rf /usr /var", "deny"],
    ["rm -rf ~", "deny"],
    ["rm -rf ~/*", "deny"],
    ["rm -rf $HOME", "deny"],
    ["rm -rf C:\\", "deny"],
    ["rm -rf c:/", "deny"],
    ["find / -delete", "deny"],
    ["find / -exec rm -rf {} +", "deny"],
    ["find ~ -delete", "deny"],
    ["Remove-Item -Recurse -Force C:\\", "deny"],
    ["del /s /q C:\\", "deny"],
    ["rd /s /q D:\\", "deny"],
    ["dd if=/dev/zero of=/dev/sda", "deny"],
    ["mkfs.ext4 /dev/sda1", "deny"],
    ["echo x > /dev/sda", "deny"],
    // approvable: destructive but scoped
    ["rm -rf /tmp/build", "ask"],
    ["rm -rf /home/user/work/x", "ask"],
    ["rm -rf ~/work", "ask"],
    ["find /tmp -delete", "ask"],
    ["sudo apt update", "ask"],
    ["git push --force origin main", "ask"],
    ["rm -f a.txt", "ask"],
    // routine
    ["git status", "allow"],
    ["rm a.txt", "allow"],
    ["npm test", "allow"],
  ];
  // a user's own bash policy list must UNION with the built-in one: writing a
  // custom deny pattern used to drop the filesystem-wipe guards entirely
  const customHome = path.join(tmpBase, "home-custom-policy");
  fs.mkdirSync(customHome, { recursive: true });
  fs.writeFileSync(
    path.join(customHome, "config.yaml"),
    `version: 1\npermissions:\n  bash:\n    deny:\n      - "^echo MY_CUSTOM_DENY$"\n`,
  );
  const { loadConfig } = await import(path.join(repoRoot, "packages/core/dist/config.js"));
  const customCfg = loadConfig({ configFile: path.join(customHome, "config.yaml") }).permissions.bash;
  assert(
    commandDecision("echo MY_CUSTOM_DENY", customCfg).action === "deny" &&
      commandDecision("rm -rf /", customCfg).action === "deny" &&
      commandDecision("mkfs.ext4 /dev/sda1", customCfg).action === "deny" &&
      commandDecision("rm -rf /tmp/build", customCfg).action === "ask",
    "a custom policy list unions with the built-in one (wipes stay blocked)",
    JSON.stringify(customCfg.deny).slice(0, 200),
  );

  const bad = table.filter(([cmd, want]) => commandDecision(cmd, bcfg).action !== want);
  assert(
    bad.length === 0,
    `bash decision table (${table.length} cases)`,
    bad
      .map(([cmd, want]) => `${JSON.stringify(cmd)} want=${want} got=${commandDecision(cmd, bcfg).action}`)
      .join(" | "),
  );
}

// ---------------------------------------------------------------------------
// Scenario R: long turns auto-continue past the step window (no 続けて)
// ---------------------------------------------------------------------------
console.log("— scenario R: long turns auto-continue —");
{
  // the default ceiling is 100: a 28-tool-step turn crosses the 25-step
  // window and keeps going on its own
  const r1 = await run(["run", "-p", "@repeat 28", "--cwd", project, "--json"], project, familiarHome);
  assert(r1.code === 0, "a 28-step run exits 0", `code=${r1.code} stderr=${r1.stderr.slice(0, 200)}`);
  const continuing = r1.parsed.filter((e) => e?.type === "turn.continuing");
  assert(
    continuing.length === 1 &&
      continuing[0].kind === "steps" &&
      continuing[0].step === 25 &&
      continuing[0].ceiling === 100,
    "the turn auto-continues past the 25-step window",
    JSON.stringify(continuing).slice(0, 200),
  );
  const streamed = r1.parsed
    .filter((e) => e?.type === "text.delta")
    .map((e) => String(e.text))
    .join("");
  assert(
    streamed.includes("repeated 28 steps"),
    "the turn still ends with the model's final answer",
    JSON.stringify(r1.parsed.slice(-4)).slice(0, 200),
  );
  assert(
    !r1.parsed.some((e) => e?.type === "turn.ceiling"),
    "no ceiling marker when the work finishes first",
    "",
  );

  // a capped ceiling leaves a visible marker instead of stopping silently
  const homeR = path.join(tmpBase, "home-limit");
  fs.mkdirSync(homeR, { recursive: true });
  fs.writeFileSync(
    path.join(homeR, "config.yaml"),
    `version: 1\ndefault_provider: mock\nproviders:\n  mock:\n    kind: mock\nserver:\n  port: 1\n  bind: 127.0.0.1\ncontext:\n  max_turn_steps: 26\n`,
  );
  const r2 = await run(["run", "-p", "@repeat 40", "--cwd", project, "--json"], project, homeR);
  const ceiling = r2.parsed.find((e) => e?.type === "turn.ceiling");
  assert(
    !!ceiling && ceiling.step === 26,
    "hitting the configured ceiling emits a marker",
    JSON.stringify(r2.parsed.filter((e) => e?.type === "turn.ceiling" || e?.type === "turn.continuing")).slice(0, 200),
  );
}

// ---------------------------------------------------------------------------
// Scenario S: globally installed skills (like the shared agent-skills dir)
// ---------------------------------------------------------------------------
console.log("— scenario S: global skills from an extra root —");
{
  const globalRoot = path.join(tmpBase, "global-skills");
  const skillDir = path.join(globalRoot, "teleporter");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---
name: teleporter
description: >
  Folded description that spans multiple
  lines and must be preserved as one line.
---

# Teleporter
Do the thing globally.
`,
  );
  // a home that reads the global root (and no built-in globals)
  const homeS = path.join(tmpBase, "home-skills");
  fs.mkdirSync(homeS, { recursive: true });
  fs.writeFileSync(
    path.join(homeS, "config.yaml"),
    `version: 1\ndefault_provider: mock\nproviders:\n  mock:\n    kind: mock\nserver:\n  port: 1\n  bind: 127.0.0.1\nskills:\n  include_global: false\n  paths:\n    - ${globalRoot}\n`,
  );
  // familiar's own store: a shadowing copy of the global skill
  const familiarOwn = path.join(homeS, "skills", "teleporter");
  fs.mkdirSync(familiarOwn, { recursive: true });
  fs.writeFileSync(
    path.join(familiarOwn, "SKILL.md"),
    `---
name: teleporter
description: familiar-owned description wins
---

# Teleporter
Familiar's own copy.
`,
  );
  const s1 = await run(
    ["run", "-p", "@dump-skills", "--cwd", project, "--json", "--yolo"],
    project,
    homeS,
  );
  const sText = s1.parsed
    .filter((e) => e?.type === "text.delta")
    .map((e) => String(e.text))
    .join("");
  assert(
    /teleporter/.test(sText) && /familiar-owned description wins/.test(sText),
    "the familiar-local skill shadows the global one",
    JSON.stringify(sText).slice(0, 260),
  );
  // a familiar-home that has no copy → the global skill is listed, description folded
  fs.rmSync(familiarOwn, { recursive: true, force: true });
  const s2 = await run(
    ["run", "-p", "@dump-skills", "--cwd", project, "--json", "--yolo"],
    project,
    homeS,
  );
  const s2Text = s2.parsed
    .filter((e) => e?.type === "text.delta")
    .map((e) => String(e.text))
    .join("");
  assert(
    /teleporter/.test(s2Text) &&
      /Folded description that spans multiple lines and must be preserved as one line\./.test(s2Text),
    "global skills are catalogued with the folded description intact",
    JSON.stringify(s2Text).slice(0, 260),
  );
}

// ---------------------------------------------------------------------------
// Scenario T: office_create + permission modes
// ---------------------------------------------------------------------------
console.log("— scenario T: office_create + permission modes —");
{
  const { createOfficeCreateTool } = await import(
    path.join(repoRoot, "packages/core/dist/tools/office.js")
  );
  const { readDocx, readXlsx, readPptx } = await import(
    path.join(repoRoot, "packages/core/dist/tools/ooxml-read.js")
  );
  const officeDir = path.join(project, "office");
  fs.mkdirSync(officeDir, { recursive: true });

  // gate that records whether it was asked
  const mkCtx = (cwd, permissionMode, asked) => ({
    sessionId: "s",
    cwd,
    yolo: false,
    ...(permissionMode ? { permissionMode } : {}),
    config: {},
    approval: {
      request: async () => {
        asked.push(1);
        return true;
      },
    },
    backend: {
      path,
      mkdirp: async (d) => fs.mkdirSync(d, { recursive: true }),
      writeFile: async (f, data) => fs.writeFileSync(f, data),
    },
  });

  const tool = createOfficeCreateTool();
  const asked = [];

  const docx = await tool.execute(
    { kind: "docx", path: "memo.docx", title: "T", blocks: [{ heading: "見出し", level: 1 }, { text: "本文" }, { bullets: ["A", "B"] }, { table: [["k", "v"], ["a", "1"]] }] },
    mkCtx(officeDir, "yolo", asked),
  );
  assert(docx.isError !== true && /wrote .*memo\.docx/.test(docx.content), "office_create writes a docx", docx.content);
  const docxBuf = fs.readFileSync(path.join(officeDir, "memo.docx"));
  assert(
    docxBuf.subarray(0, 2).toString() === "PK" && docxBuf.includes(Buffer.from("word/document.xml")),
    "the docx is a zip with the OOXML part",
    `bytes=${docxBuf.length}`,
  );
  // reading it back (the GUI preview path) must reproduce the same structure
  const docxBack = readDocx(docxBuf);
  assert(
    docxBack[0]?.heading === "見出し" &&
      docxBack.some((b) => JSON.stringify(b.table) === JSON.stringify([["k", "v"], ["a", "1"]])),
    "the docx reads back as the same blocks",
    JSON.stringify(docxBack).slice(0, 200),
  );

  const xlsx = await tool.execute(
    { kind: "xlsx", path: "sheet.xlsx", title: "T", sheets: [{ name: "S", headers: ["月", "値"], rows: [["1月", 10], ["2月", 20]] }] },
    mkCtx(officeDir, "yolo", asked),
  );
  assert(
    xlsx.isError !== true && fs.readFileSync(path.join(officeDir, "sheet.xlsx")).includes(Buffer.from("xl/worksheets/sheet1.xml")),
    "office_create writes an xlsx",
    xlsx.content,
  );
  const sheetsBack = readXlsx(fs.readFileSync(path.join(officeDir, "sheet.xlsx")));
  assert(
    sheetsBack[0]?.name === "S" &&
      JSON.stringify(sheetsBack[0]?.rows) === JSON.stringify([["月", "値"], ["1月", "10"], ["2月", "20"]]),
    "the xlsx reads back with its sheet, headers and numeric cells",
    JSON.stringify(sheetsBack).slice(0, 200),
  );

  const pptx = await tool.execute(
    { kind: "pptx", path: "deck.pptx", title: "T", slides: [{ title: "S1", bullets: ["a", "b"] }, { title: "S2", bullets: ["c"] }] },
    mkCtx(officeDir, "yolo", asked),
  );
  const pptxBuf = fs.readFileSync(path.join(officeDir, "deck.pptx"));
  assert(
    pptx.isError !== true && pptxBuf.includes(Buffer.from("ppt/slides/slide2.xml")),
    "office_create writes a pptx with every slide",
    pptx.content,
  );
  const slidesBack = readPptx(pptxBuf);
  assert(
    slidesBack.length === 2 && slidesBack[0]?.title === "S1" &&
      JSON.stringify(slidesBack[1]) === JSON.stringify({ title: "S2", bullets: ["c"] }),
    "the pptx reads back with every slide",
    JSON.stringify(slidesBack).slice(0, 200),
  );

  // the extension follows kind even when the path says otherwise
  const coerced = await tool.execute({ kind: "xlsx", path: "wrong.docx", sheets: [{ rows: [[1]] }] }, mkCtx(officeDir, "yolo", asked));
  assert(/wrote .*wrong\.xlsx/.test(coerced.content), "the extension is forced to match kind", coerced.content);

  // permission modes: edit runs outside cwd without asking; ask asks;
  // yolo (mode) never asks
  asked.length = 0;
  await tool.execute({ kind: "docx", path: path.join(tmpBase, "outside-edit.docx"), blocks: [{ text: "x" }] }, mkCtx(officeDir, "edit", asked));
  assert(asked.length === 0, "'edit' mode writes outside cwd without approval", `asked=${asked.length}`);
  await tool.execute({ kind: "docx", path: path.join(tmpBase, "outside-ask.docx"), blocks: [{ text: "x" }] }, mkCtx(officeDir, "ask", asked));
  assert(asked.length === 1, "'ask' mode asks before writing outside cwd", `asked=${asked.length}`);
  await tool.execute({ kind: "docx", path: path.join(tmpBase, "outside-yolo.docx"), blocks: [{ text: "x" }] }, mkCtx(officeDir, "yolo", asked));
  assert(asked.length === 1, "'yolo' mode never asks", `asked=${asked.length}`);
}

// ---------------------------------------------------------------------------
// Scenario U: truncated tool-call arguments are repaired, not persisted
// ---------------------------------------------------------------------------
console.log("— scenario U: truncated tool arguments —");
{
  const { repairToolArguments } = await import(
    path.join(repoRoot, "packages/core/dist/providers/tool-args.js")
  );
  const cases = [
    ['{"path":"a.txt","content":"ok"}', "valid"],
    ['{"path":"a.txt","content":"line1\\nline2', "truncated string"],
    ['{"a":[1,2,{"b":"x', "truncated nested"],
    ['{"a":1,', "trailing comma"],
    ['{"a":"end\\\\', "trailing backslash"],
    ["totally not json", "garbage"],
  ];
  let allValid = true;
  for (const [raw, label] of cases) {
    const out = repairToolArguments(raw);
    try {
      JSON.parse(out);
    } catch {
      allValid = false;
      console.log(`FAIL ${label}: still invalid -> ${out}`);
    }
  }
  assert(allValid, "every repaired argument parses as JSON", "");
  assert(
    JSON.parse(repairToolArguments('{"path":"a.txt","content":"ok"}')).content === "ok",
    "valid arguments pass through unchanged",
    "",
  );
  assert(
    JSON.parse(repairToolArguments('{"path":"a.txt","content":"line1\\nline2')).content === "line1\nline2",
    "a truncated string keeps the recovered prefix",
    "",
  );
  assert(
    repairToolArguments("totally not json") === "{}",
    "unrepairable arguments fall back to an empty object",
    "",
  );

  // the store-level repair un-poisons an existing session and is idempotent
  const { SqliteSessionStore } = await import(
    path.join(repoRoot, "packages/core/dist/session/store.js")
  );
  const dbFile = path.join(tmpBase, "repair.db");
  const store = new SqliteSessionStore(dbFile);
  const sess = store.createSession({ provider: "mock", model: "mock-fast", cwd: project });
  store.appendMessage(sess.id, {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    toolCalls: [{ id: "c1", name: "write", arguments: '{"path":"b.txt","content":"half' }],
  });
  const changed = store.repairToolCallArguments(sess.id);
  const after = store.getMessages(sess.id)[0].toolCalls[0].arguments;
  let parses = true;
  try {
    JSON.parse(after);
  } catch {
    parses = false;
  }
  assert(changed === 1 && parses, "the store repairs a poisoned message", `changed=${changed} after=${after}`);
  assert(store.repairToolCallArguments(sess.id) === 0, "the repair is idempotent", "");

  // truncation undoes the messages a failed attempt appended (auto-retry path)
  store.appendMessage(sess.id, { id: "m2", role: "user", content: "second", createdAt: Date.now() });
  store.appendMessage(sess.id, { id: "m3", role: "assistant", content: "third", createdAt: Date.now() });
  assert(store.getMessages(sess.id).length === 3, "three messages before truncation", "");
  const removed = store.truncateMessages(sess.id, 1);
  const left = store.getMessages(sess.id);
  assert(
    removed === 2 && left.length === 1 && left[0].id === "m1",
    "truncateMessages keeps only the first N messages",
    `removed=${removed} left=${left.length}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario V: registered office templates drive the design
// ---------------------------------------------------------------------------
console.log("— scenario V: office templates —");
{
  const { createOfficeCreateTool } = await import(path.join(repoRoot, "packages/core/dist/tools/office.js"));
  const { readDocx, readXlsx, readPptx, unzip } = await import(
    path.join(repoRoot, "packages/core/dist/tools/ooxml-read.js")
  );
  const { zipArchive } = await import(path.join(repoRoot, "packages/core/dist/tools/zip.js"));
  const { importOfficeTemplate, listOfficeTemplates, resolveOfficeTemplate, deleteOfficeTemplate } =
    await import(path.join(repoRoot, "packages/core/dist/tools/office-templates.js"));

  const home = path.join(tmpBase, "tpl-home");
  fs.mkdirSync(home, { recursive: true });
  const work = path.join(tmpBase, "tpl-work");
  fs.mkdirSync(work, { recursive: true });

  const tool = createOfficeCreateTool();
  const ctx = {
    cwd: work,
    yolo: true,
    config: { homeDir: home },
    approval: { request: async () => true },
    backend: {
      path,
      mkdirp: async (d) => fs.mkdirSync(d, { recursive: true }),
      writeFile: async (f, data) => fs.writeFileSync(f, data),
    },
  };
  const make = async (kind, file, args) =>
    tool.execute({ kind, path: file, ...args }, ctx);

  // --- build synthetic templates from our own output, then add design markers
  const repack = (file, mutate) => {
    const parts = unzip(fs.readFileSync(file));
    mutate(parts);
    fs.writeFileSync(file, zipArchive([...parts.entries()].map(([name, data]) => ({ name, data })), { compress: true }));
  };

  // docx: a sentinel style + a distinctive page size
  const tplDocx = path.join(work, "tpl.docx");
  await make("docx", tplDocx, { title: "tpl", blocks: [{ text: "template body" }] });
  repack(tplDocx, (parts) => {
    const styles = parts.get("word/styles.xml").toString().replace(
      "</w:styles>",
      '<w:style w:type="paragraph" w:styleId="FamiliarSentinel"><w:name w:val="FamiliarSentinel"/></w:style></w:styles>',
    );
    parts.set("word/styles.xml", Buffer.from(styles));
    // replace the page setup (do not add a second sectPr — a real template has one)
    const doc = parts
      .get("word/document.xml")
      .toString()
      .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/, '<w:sectPr><w:pgSz w:w="5000" w:h="7000"/></w:sectPr>');
    parts.set("word/document.xml", Buffer.from(doc));
  });

  // xlsx: a column width + a styled data row (s="7")
  const tplXlsx = path.join(work, "tpl.xlsx");
  await make("xlsx", tplXlsx, { title: "tpl", sheets: [{ name: "S", rows: [["keep", "me"]] }] });
  repack(tplXlsx, (parts) => {
    const sh = parts.get("xl/worksheets/sheet1.xml").toString()
      .replace(/(<worksheet[^>]*>)/, '$1<cols><col min="1" max="2" width="42"/></cols>')
      .replace(/<c r="A1"/, '<c r="A1" s="7"');
    parts.set("xl/worksheets/sheet1.xml", Buffer.from(sh));
  });

  // pptx: a named layout with title/body placeholders + a sentinel theme colour
  const tplPptx = path.join(work, "tpl.pptx");
  await make("pptx", tplPptx, { title: "tpl", slides: [{ title: "x", bullets: ["y"] }] });
  repack(tplPptx, (parts) => {
    let layout = parts.get("ppt/slideLayouts/slideLayout1.xml").toString()
      .replace(/name="Blank"/, 'name="Title and Content"')
      .replace(
        "<p:grpSpPr/>",
        '<p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1" y="1"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>' +
          '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1" y="1"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>',
      );
    parts.set("ppt/slideLayouts/slideLayout1.xml", Buffer.from(layout));
  });

  // --- register
  const reg = importOfficeTemplate(home, { path: tplDocx, name: "brand" });
  assert(reg.kind === "docx" && reg.name === "brand", "a template is registered", JSON.stringify(reg));
  importOfficeTemplate(home, { path: tplXlsx, name: "brand" });
  importOfficeTemplate(home, { path: tplPptx, name: "brand" });
  const catalog = listOfficeTemplates(home);
  assert(
    catalog.length === 3 && catalog.every((t) => t.name === "brand"),
    "templates are listed per kind",
    JSON.stringify(catalog.map((t) => `${t.name}.${t.kind}`)),
  );
  let rejected = false;
  try {
    importOfficeTemplate(home, { dataBase64: Buffer.from("not a zip").toString("base64"), name: "bad.docx" });
  } catch {
    rejected = true;
  }
  assert(rejected, "a non-Office file is rejected", "");

  // --- docx: template styles and page setup survive, our content is there
  const outDocx = await make("docx", "out.docx", {
    template: "brand",
    title: "Familiar",
    blocks: [{ heading: "章", level: 1 }, { text: "本文" }, { bullets: ["A"] }, { table: [["k", "v"]] }],
  });
  assert(/using the template "brand"/.test(outDocx.content), "office_create reports the template used", outDocx.content);
  const docxParts = unzip(fs.readFileSync(path.join(work, "out.docx")));
  assert(
    docxParts.get("word/styles.xml").toString().includes("FamiliarSentinel"),
    "the docx keeps the template's styles",
    "",
  );
  assert(
    docxParts.get("word/document.xml").toString().includes('w:w="5000"'),
    "the docx keeps the template's page setup",
    "",
  );
  const docxBlocks = readDocx(fs.readFileSync(path.join(work, "out.docx")));
  assert(
    docxBlocks[0]?.heading === "章" && docxBlocks.some((b) => JSON.stringify(b.table) === JSON.stringify([["k", "v"]])),
    "the docx content is ours",
    JSON.stringify(docxBlocks).slice(0, 160),
  );

  // --- xlsx: existing rows kept, appended rows inherit the template style
  await make("xlsx", "out.xlsx", {
    template: "brand",
    title: "Familiar",
    sheets: [{ name: "S", rows: [["added", 1]] }],
  });
  const xlsxParts = unzip(fs.readFileSync(path.join(work, "out.xlsx")));
  const sheetXml = xlsxParts.get("xl/worksheets/sheet1.xml").toString();
  assert(sheetXml.includes('<col min="1" max="2" width="42"/>'), "the xlsx keeps the template's column widths", "");
  assert(sheetXml.includes("keep"), "the xlsx keeps the template's existing rows", "");
  assert(
    /<row r="2"><c r="A2" s="7"/.test(sheetXml),
    "appended rows inherit the template's cell style",
    sheetXml.slice(sheetXml.indexOf('<row r="2"'), 160),
  );

  // --- pptx: slides clone the layout's placeholders, theme kept
  await make("pptx", "out.pptx", {
    template: "brand",
    title: "Familiar",
    slides: [{ title: "表紙", bullets: ["背景", "課題"] }],
  });
  const pptxParts = unzip(fs.readFileSync(path.join(work, "out.pptx")));
  const slide = pptxParts.get("ppt/slides/slide1.xml").toString();
  assert(
    slide.includes('<p:ph type="title"') && slide.includes('<p:ph type="body" idx="1"'),
    "pptx slides use the template layout's placeholders",
    slide.slice(0, 200),
  );
  assert(
    pptxParts.get("ppt/theme/theme1.xml") !== undefined,
    "the pptx keeps the template's theme",
    "",
  );
  const pptxSlides = readPptx(fs.readFileSync(path.join(work, "out.pptx")));
  assert(
    pptxSlides.length === 1 && pptxSlides[0]?.title === "表紙" && pptxSlides[0]?.bullets.length === 2,
    "the pptx content is ours",
    JSON.stringify(pptxSlides).slice(0, 160),
  );

  // --- more input sheets than worksheets: reported, never silent
  const dropped = await make("xlsx", "dropped.xlsx", {
    template: "brand",
    title: "Familiar",
    sheets: [{ name: "first", rows: [["a"]] }, { name: "second", rows: [["b"]] }],
  });
  assert(
    /note:.*second.*not written/.test(dropped.content),
    "extra sheets beyond the template are reported",
    dropped.content,
  );

  // --- an unknown template name is an error, not a silent plain document
  const unknown = await make("docx", "unknown.docx", {
    template: "no-such-template",
    title: "T",
    blocks: [{ text: "x" }],
  });
  assert(
    unknown.isError === true && /template not found/.test(unknown.content),
    "an unknown template name is rejected",
    unknown.content,
  );

  // --- a `default.<ext>` template is used without the parameter
  assert(resolveOfficeTemplate(home, undefined, "docx") === undefined, "no implicit template without a default", "");
  importOfficeTemplate(home, { path: tplDocx, name: "default" });
  const implicit = resolveOfficeTemplate(home, undefined, "docx");
  assert(
    implicit !== undefined && implicit.endsWith("default.docx"),
    "a template named default is picked up automatically",
    String(implicit),
  );
  deleteOfficeTemplate(home, "default");
  assert(resolveOfficeTemplate(home, undefined, "docx") === undefined, "deleting a template removes it", "");
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
