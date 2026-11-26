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
import { fitWordmark, visibleWidth, wordmarkRows } from "../dist/ui/tui.js";

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
// Scenario: CLI startup wordmark
// ---------------------------------------------------------------------------
console.log("— scenario: CLI startup wordmark —");
{
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const familiar = wordmarkRows(false).map(stripAnsi);
  const full = wordmarkRows(true).map(stripAnsi);
  assert(familiar.length === 4 && full.length === 4, "wordmark has four rows");
  assert(familiar[0].includes(" ▀▀ "), "familiar f glyph is present");
  assert(familiar[0].includes("▀▀ ▀▀"), "familiar m glyph is present");
  assert(familiar[0].includes(" ▄  "), "familiar l glyph is present");
  assert(
    Math.max(...familiar.map(visibleWidth)) === 40 && Math.max(...full.map(visibleWidth)) === 75,
    "wordmark rows keep their expected display width",
  );
  const wide = fitWordmark(80);
  const narrow = fitWordmark(70);
  assert(wide?.width === 75 && wide.left >= 1, "wide terminals show both wordmark words");
  assert(narrow?.width === 40, "narrow terminals fall back to familiar only");
  assert(fitWordmark(40) === null, "too-narrow terminals omit the wordmark");
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
// Scenario B2: files.bounds read gate (read/glob/grep outside cwd)
// ---------------------------------------------------------------------------
console.log("— scenario B2: files.bounds read gate —");
{
  // inside cwd needs no approver
  const inside = await run(
    ["run", "-p", "@read planets.txt", "--cwd", project, "--json"],
    project,
    familiarHome,
  );
  const insideRes = inside.parsed.find((e) => e?.type === "tool.result" && e.name === "read");
  assert(
    !!insideRes && insideRes.isError !== true && String(insideRes.content).includes("Earth is the third planet"),
    "read inside cwd is allowed without an approver",
    JSON.stringify(insideRes).slice(0, 200),
  );

  // outside cwd → default read policy "ask" → headless deny-all refuses
  const outsideFile = path.join(familiarHome, "config.yaml");
  const outside = await run(
    ["run", "-p", `@read ${outsideFile}`, "--cwd", project, "--json"],
    project,
    familiarHome,
  );
  const outRes = outside.parsed.find((e) => e?.type === "tool.result" && e.name === "read");
  assert(
    !!outRes && outRes.isError === true && /outside the session folder/.test(String(outRes.content)),
    "read outside cwd is denied without an approver (bounds=cwd)",
    JSON.stringify(outRes).slice(0, 200),
  );

  // --yolo bypasses the gate (Full access)
  const yoloRead = await run(
    ["run", "-p", `@read ${outsideFile}`, "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const yoloRes = yoloRead.parsed.find((e) => e?.type === "tool.result" && e.name === "read");
  assert(
    !!yoloRes && yoloRes.isError !== true && String(yoloRes.content).includes("default_provider"),
    "--yolo allows reading outside cwd",
    JSON.stringify(yoloRes).slice(0, 200),
  );
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

  // Provider brand resolution is DOM-free and lives in a marked section so it
  // can be exercised without a browser.
  const brandStart = appJs.indexOf("// ---- provider-brand ----");
  const brandEnd = appJs.indexOf("// ---- end provider-brand ----");
  assert(brandStart >= 0 && brandEnd > brandStart, "provider brand section is marked");
  if (brandStart >= 0 && brandEnd > brandStart) {
    const entity = (name) => "&" + name + ";";
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => (
      {
        "&": entity("amp"),
        "<": entity("lt"),
        ">": entity("gt"),
        '"': entity("quot"),
        "'": entity("#39"),
      }[char]
    ));
    const brand = new Function(
      "esc",
      `${appJs.slice(brandStart, brandEnd)}; return { PROVIDER_MARKS, providerKnown, providerBrandId, providerTile };`,
    )(escapeHtml);
    const knownIds = ["openai", "anthropic", "google", "nvidia", "openrouter", "ollama"];
    const knownTiles = knownIds.map((id) => brand.providerTile(id, "#8a8a94"));
    assert(
      knownIds.every((id) => brand.providerBrandId(id) === id) &&
        knownTiles.every((tile) => tile.includes("<svg") && tile.includes('aria-hidden="true"') && tile.includes('focusable="false"')),
      "known provider IDs resolve to accessible local brand marks",
    );
    assert(
      new Set(knownIds.map((id) => brand.PROVIDER_MARKS[id])).size === knownIds.length,
      "known provider IDs use distinct brand mark paths",
    );
    const hostCases = [
      ["my-openai", "https://api.openai.com/v1", "openai"],
      ["my-anthropic", "https://api.anthropic.com/v1", "anthropic"],
      ["my-gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "google"],
      ["my-nvidia", "https://integrate.api.nvidia.com/v1", "nvidia"],
      ["my-openrouter", "https://openrouter.ai/api/v1", "openrouter"],
      ["my-ollama", "http://localhost:11434/v1", "ollama"],
    ];
    assert(
      hostCases.every(([id, url, expected]) => brand.providerBrandId(id, url) === expected),
      "custom provider IDs resolve their brand from base_url",
    );
    assert(
      brand.providerBrandId("my-default-openai", "", "openai_compatible") === "openai" &&
        brand.providerBrandId("my-default-anthropic", "", "anthropic") === "anthropic" &&
        brand.providerBrandId("my-mock", "", "mock") === null,
      "custom provider IDs resolve their brand from the effective kind endpoint",
    );
    assert(
      brand.providerBrandId("openai", "https://example.com/v1") === "openai" &&
        brand.providerBrandId("custom", "https://example.com/v1", "openai_compatible") === null,
      "explicit known IDs win while explicit custom endpoints override kind defaults",
    );
    const fallback = brand.providerTile("custom", "#8a8a94", "https://example.com/v1");
    assert(
      brand.providerBrandId("custom", "https://example.com/v1") === null &&
        brand.providerBrandId("spoof", "https://api.openai.com.evil.test/v1") === null &&
        !fallback.includes("<svg") && fallback.includes(">C<") &&
        fallback.includes("color:#151519") && fallback.includes('aria-hidden="true"'),
      "unknown providers use the accessible neutral monogram fallback",
    );
    const hostileFallback = brand.providerTile("&<img src=x>", "#8a8a94", "https://example.com/v1");
    assert(
      hostileFallback.includes(entity("amp")) && !hostileFallback.includes("&<"),
      "fallback provider initials are HTML-escaped",
    );
    assert(
      appJs.includes('class="mp-group">${providerTile(') &&
        appJs.includes("providerTile(name, color, hint, kind)") &&
        appJs.includes("providerTile(provider, known?.color"),
      "settings and model-picker provider marks are wired",
    );
  }

  // A cached document must revalidate when ANY asset changes. The ETag used to
  // track only app.js, so an index.html- or CSS-only update kept serving stale
  // markup (which is exactly how a stale logo survived a reload).
  const docPath = path.join(repoRoot, "packages/server/public/index.html");
  const docStat = fs.statSync(docPath);
  const docEtag = (await fetch(`http://127.0.0.1:${PORT}/`)).headers.get("etag");
  const revalidated = await fetch(`http://127.0.0.1:${PORT}/`, {
    headers: { "if-none-match": docEtag ?? "" },
  });
  let afterStatus = 0;
  let afterEtag = "";
  try {
    const bumped = new Date(Date.now() + 5000);
    fs.utimesSync(docPath, bumped, bumped);
    const after = await fetch(`http://127.0.0.1:${PORT}/`, {
      headers: { "if-none-match": docEtag ?? "" },
    });
    afterStatus = after.status;
    afterEtag = after.headers.get("etag") ?? "";
  } finally {
    fs.utimesSync(docPath, docStat.atime, docStat.mtime);
  }
  assert(
    revalidated.status === 304 && afterStatus === 200 && afterEtag !== docEtag,
    "HTML revalidates when index.html changes (not just app.js)",
    `304=${revalidated.status} after=${afterStatus} etag=${docEtag}`,
  );
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
  assert(
    page.includes('id="todo-progress"') &&
      !page.includes('data-tab="inbox"') && !page.includes('data-tab="todo"') &&
      page.includes('data-tab="files"') && page.includes('data-tab="ctx"'),
    "web UI ships the task-progress chip and only files/ctx pane tabs",
  );
  assert(
    appJs.includes("refreshTodoProgress") &&
      !appJs.includes("renderProposalsSection") && !appJs.includes("updateProposalsBadge"),
    "web UI: task progress wired; settings proposals section removed",
  );
  assert(
    page.includes('id="pane-toggle"') && /id="pane-toggle"[\s\S]{0,220}<svg/.test(page),
    "web UI: the file pane toggle uses an SVG folder icon",
  );
  assert(
    appJs.includes("skill-toolbar") && appJs.includes("skills.deleteSelectedConfirm") &&
      appJs.includes("skill-external") && appJs.includes("skillReadOnly") &&
      appJs.includes("editorBody.readOnly = external"),
    "web UI: skills filter/bulk wired; external skills are view-only",
  );
  assert(
    appJs.includes('id: "skills"') && appJs.includes('labelKey: "nav.skills"') &&
      appJs.includes('id: "connectors"') && !appJs.includes('id: "extensions"') &&
      appJs.includes("renderSkillsSection") && appJs.includes("buildMcpServersCard") &&
      appJs.includes("buildLspServersCard"),
    "web UI: Skills and Connectors replace the Extensions settings section",
  );
  assert(
    appJs.includes("buildConnectorGroup") && appJs.includes("connector-server-list") &&
      appJs.includes("connector-external-list") && appJs.includes("dataset.connectorGroup"),
    "web UI: Connectors separates MCP/LSP servers from external services",
  );
  assert(
    appJs.includes("serverForm") && appJs.includes("srvAddRow") &&
      appJs.includes('`${kind}.servers.set`') && appJs.includes('`${kind}.servers.delete`') &&
      appJs.includes("srv.advancedNote") && appJs.includes("srv.deleteConfirm"),
    "web UI: MCP/LSP servers can be added, edited and deleted in Connectors",
  );
  assert(
    appJs.includes("Plan ⇔ 直前の権限モード") &&
      appJs.includes("Toggle Plan and the previous permission mode") &&
      !appJs.includes("Build / Plan"),
    "web UI: Tab mode copy describes Plan and the previous permission mode, not Build/Plan",
  );
  assert(
    appJs.includes("permissions.websearch.set") && appJs.includes("nav.websearch") &&
      appJs.includes("perm.webDdg") && appJs.includes("perm.webSearxng") &&
      appJs.includes("perm.webUrl") && appJs.includes("perm.webNeedUrl") &&
      appJs.includes('id: "websearch"') && appJs.includes('labelKey: "nav.websearch"') &&
      appJs.includes("renderWebSearchSection") && appJs.includes("fillWebSearchCard"),
    "web UI: a standalone Web search section exposes the provider/endpoint editor",
  );
  assert(
    appJs.includes('id: "memory"') && appJs.includes('labelKey: "nav.memory"') &&
      appJs.includes("renderMemorySection") && appJs.includes("mem-textarea") &&
      appJs.includes("memory.file.get") && appJs.includes("memory.file.set"),
    "web UI: a Memory section edits the user-owned MEMORY.md",
  );
  assert(
    !page.includes('id="stop"') && appJs.includes("steerRunningTurn") &&
      appJs.includes('rpc("session.steer"') && appJs.includes("mobileComposer") &&
      appJs.includes("composer.phMobile"),
    "web UI: single button steers the running turn; mobile Enter=newline",
  );
  assert(
    appJs.includes('"/compact"') && appJs.includes("compactContext") &&
      appJs.includes('rpc("session.compact"') && appJs.includes("turn.noteCompactionForced"),
    "web UI: /compact command and the forced-compaction note are wired",
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
  // GUI server config: MCP/LSP set/delete, secret masking and validation
  const mcpSet = await rpcCall(240, "mcp.servers.set", {
    name: "smoke-mcp", command: "node", args: ["-e", "0"],
    env: { SMOKE_TOKEN: "super-secret-123" }, read_only: true, disabled: true,
  });
  assert(
    mcpSet.result?.updated === true && mcpSet.result?.name === "smoke-mcp",
    "mcp.servers.set accepts a server", JSON.stringify(mcpSet.error ?? {}).slice(0, 160),
  );
  const lspSet = await rpcCall(241, "lsp.servers.set", {
    name: "smoke-lsp", command: "node", args: ["-e", "0"], extensions: ["ts", "tsx"], disabled: true,
  });
  assert(
    lspSet.result?.updated === true && lspSet.result?.name === "smoke-lsp",
    "lsp.servers.set accepts a server", JSON.stringify(lspSet.error ?? {}).slice(0, 160),
  );
  const cfgServers = await rpcCall(242, "config.get", {});
  assert(
    cfgServers.result?.mcp?.servers?.["smoke-mcp"]?.command === "node" &&
      cfgServers.result?.lsp?.servers?.["smoke-lsp"]?.extensions?.join(",") === "ts,tsx",
    "configured servers appear in config.get", JSON.stringify(cfgServers.result).slice(0, 160),
  );
  assert(
    cfgServers.result?.mcp?.servers?.["smoke-mcp"]?.env?.SMOKE_TOKEN === "***" &&
      JSON.stringify(cfgServers.result).indexOf("super-secret-123") < 0,
    "MCP env values are masked and never exposed by config.get",
  );
  const mcpMasked = await rpcCall(243, "mcp.servers.set", {
    name: "smoke-mcp", command: "node", env: { SMOKE_TOKEN: "***" }, disabled: true,
  });
  assert(mcpMasked.result?.updated === true, "mcp.servers.set accepts a masked secret round-trip", JSON.stringify(mcpMasked.error ?? {}).slice(0, 160));
  const mcpFlagsOn = await rpcCall(250, "mcp.servers.set", {
    name: "smoke-mcp", command: "node", env: { SMOKE_TOKEN: "***" },
    disabled: true, read_only: true, args: ["x"], timeout_ms: 1500,
  });
  assert(mcpFlagsOn.result?.updated === true, "mcp.servers.set stores optional flags", JSON.stringify(mcpFlagsOn.error ?? {}).slice(0, 160));
  const mcpFlagsOff = await rpcCall(251, "mcp.servers.set", {
    name: "smoke-mcp", command: "node", env: { SMOKE_TOKEN: "***" },
    disabled: false, read_only: false, args: [], timeout_ms: null,
  });
  assert(mcpFlagsOff.result?.updated === true, "mcp.servers.set clears optional flags", JSON.stringify(mcpFlagsOff.error ?? {}).slice(0, 160));
  const cfgFlagsOff = await rpcCall(252, "config.get", {});
  const offEntry = cfgFlagsOff.result?.mcp?.servers?.["smoke-mcp"] ?? {};
  assert(
    offEntry.disabled === undefined && offEntry.read_only === undefined &&
      offEntry.timeout_ms === undefined && offEntry.args === undefined &&
      offEntry.env?.SMOKE_TOKEN === "***",
    "unchecking flags and clearing optional fields removes them from config.yaml",
    JSON.stringify(offEntry).slice(0, 160),
  );
  const yamlAfterServers = fs.readFileSync(path.join(familiarHome, "config.yaml"), "utf8");
  assert(yamlAfterServers.includes("super-secret-123"), "masked round-trip keeps the on-disk secret");
  const badMcpName = await rpcCall(244, "mcp.servers.set", { name: "bad!!", command: "node" });
  const badMcpEnv = await rpcCall(245, "mcp.servers.set", { name: "x", command: "node", env: { "bad-key": "v" } });
  const badLspExt = await rpcCall(246, "lsp.servers.set", { name: "x", command: "node", extensions: [] });
  assert(!!badMcpName.error && !!badMcpEnv.error && !!badLspExt.error, "server config methods reject invalid input");
  const mcpDel = await rpcCall(247, "mcp.servers.delete", { name: "smoke-mcp" });
  const lspDel = await rpcCall(248, "lsp.servers.delete", { name: "smoke-lsp" });
  assert(mcpDel.result?.deleted === true && lspDel.result?.deleted === true, "server config methods delete entries");
  const cfgAfterServers = await rpcCall(249, "config.get", {});
  assert(
    !cfgAfterServers.result?.mcp?.servers?.["smoke-mcp"] &&
      !cfgAfterServers.result?.lsp?.servers?.["smoke-lsp"],
    "deleted servers disappear from config.get",
  );
  // Web search settings: DuckDuckGo out of the box, SearXNG endpoint via GUI RPC
  const webDdg = await rpcCall(253, "permissions.websearch.set", { provider: "duckduckgo", base_url: "" });
  assert(
    webDdg.result?.ok === true && webDdg.result?.websearch?.provider === "duckduckgo",
    "permissions.websearch.set accepts the DuckDuckGo default", JSON.stringify(webDdg.error ?? {}).slice(0, 160),
  );
  const webSearxng = await rpcCall(254, "permissions.websearch.set", {
    provider: "searxng", base_url: "http://127.0.0.1:8080/",
  });
  assert(
    webSearxng.result?.websearch?.base_url === "http://127.0.0.1:8080",
    "permissions.websearch.set stores a SearXNG endpoint", JSON.stringify(webSearxng.error ?? {}).slice(0, 160),
  );
  const cfgWeb = await rpcCall(255, "config.get", {});
  assert(
    cfgWeb.result?.permissions?.websearch?.provider === "searxng" &&
      cfgWeb.result.permissions.websearch.base_url === "http://127.0.0.1:8080",
    "SearXNG settings appear in config.get",
  );
  const webBadProvider = await rpcCall(256, "permissions.websearch.set", { provider: "nope", base_url: "" });
  const webBadEmpty = await rpcCall(257, "permissions.websearch.set", { provider: "searxng", base_url: "" });
  const webBadUrl = await rpcCall(258, "permissions.websearch.set", { provider: "searxng", base_url: "ftp://x" });
  assert(!!webBadProvider.error && !!webBadEmpty.error && !!webBadUrl.error, "websearch.set rejects invalid input");
  const webBack = await rpcCall(259, "permissions.websearch.set", {
    provider: "duckduckgo", base_url: "http://ignored.example",
  });
  assert(webBack.result?.websearch?.base_url === "", "choosing DuckDuckGo clears the endpoint");
  // User-owned MEMORY.md: Settings editor RPC + per-turn prompt injection
  const memWrite = await rpcCall(260, "memory.file.set", { content: "# Decisions\nUse mock provider in tests.\n" });
  assert(
    memWrite.result?.ok === true && memWrite.result?.path?.endsWith("MEMORY.md"),
    "memory.file.set writes the user-owned MEMORY.md", JSON.stringify(memWrite.error ?? {}).slice(0, 160),
  );
  const memRead = await rpcCall(261, "memory.file.get", {});
  assert(
    memRead.result?.content?.includes("Use mock provider in tests."),
    "memory.file.get returns the edited MEMORY.md", JSON.stringify(memRead.result).slice(0, 160),
  );
  const memMode = fs.statSync(path.join(familiarHome, "MEMORY.md")).mode & 0o777;
  assert(memMode === 0o600, "MEMORY.md is written with mode 0600", memMode.toString(8));
  const memBad = await rpcCall(262, "memory.file.set", { content: 42 });
  assert(!!memBad.error, "memory.file.set rejects non-string content");
  const memTooBig = await rpcCall(264, "memory.file.set", { content: "x".repeat(65_537) });
  assert(!!memTooBig.error && /exceeds/.test(String(memTooBig.error?.message ?? "")), "memory.file.set rejects >64 KiB content");
  const memClear = await rpcCall(263, "memory.file.set", { content: "" });
  assert(memClear.result?.ok === true, "memory.file.set clears MEMORY.md");
  const memTmp = fs.readdirSync(familiarHome).filter((name) => name.startsWith("MEMORY.md.tmp-"));
  assert(memTmp.length === 0, "MEMORY.md writes leave no temp files");
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

  // /undo: session.undo reverts the previous turn's write/edit file changes
  const undoSession = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "session.create", params: {} }),
  }).then((r) => r.json());
  const undoFile = path.join(project, "undo-me.txt");
  if (fs.existsSync(undoFile)) fs.rmSync(undoFile);
  await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "session.send",
      params: { id: undoSession.result.id, text: `@write ${undoFile}`, permissionMode: "yolo" },
    }),
  }).then((r) => r.json());
  assert(fs.existsSync(undoFile), "undo: the write tool created the file", undoFile);
  const undoRes = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "session.undo",
      params: { id: undoSession.result.id },
    }),
  }).then((r) => r.json());
  assert(
    undoRes.result?.undone === true && !fs.existsSync(undoFile),
    "session.undo reverts the previous turn's writes",
    JSON.stringify(undoRes.result ?? undoRes.error ?? {}).slice(0, 200),
  );

  // cross-session full-text search (FTS5 trigram + LIKE fallback)
  const searchRes = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "session.search", params: { query: "MOCK-OK" } }),
  }).then((r) => r.json());
  assert(
    (searchRes.result?.hits ?? []).length > 0,
    "session.search finds text across sessions (FTS)",
    JSON.stringify(searchRes.result ?? searchRes.error ?? {}).slice(0, 200),
  );
  const shortRes = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "session.search", params: { query: "mo" } }),
  }).then((r) => r.json());
  assert(
    (shortRes.result?.hits ?? []).length > 0,
    "session.search handles short queries (LIKE fallback)",
    JSON.stringify(shortRes.result ?? shortRes.error ?? {}).slice(0, 200),
  );

  // export / import round-trip (JSON transcript)
  const exp = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 13, method: "session.export", params: { id: undoSession.result.id, format: "json" } }),
  }).then((r) => r.json());
  assert(
    typeof exp.result?.content === "string" && exp.result.content.includes('"messages"'),
    "session.export returns a JSON transcript",
    JSON.stringify(exp.result ?? exp.error ?? {}).slice(0, 160),
  );
  const imp = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 14, method: "session.import", params: { content: exp.result.content } }),
  }).then((r) => r.json());
  assert(
    imp.result?.imported > 0 && typeof imp.result.session?.id === "string",
    "session.import recreates the session",
    JSON.stringify(imp.result ?? imp.error ?? {}).slice(0, 200),
  );

  // permissions: rule tester (allow / ask / deny)
  const permTest = (id, command) =>
    fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "permissions.test", params: { command } }),
    }).then((r) => r.json());
  const pAllow = await permTest(15, "git status");
  const pAsk = await permTest(16, "rm -rf /tmp/familiar-x");
  const pDeny = await permTest(17, "mkfs.ext4 /dev/sda1");
  assert(pAllow.result?.action === "allow", "permissions.test: safe command → allow", JSON.stringify(pAllow.result ?? pAllow.error ?? {}).slice(0, 160));
  assert(pAsk.result?.action === "ask", "permissions.test: rm -rf → ask", JSON.stringify(pAsk.result ?? pAsk.error ?? {}).slice(0, 160));
  assert(pDeny.result?.action === "deny", "permissions.test: mkfs on a device → deny", JSON.stringify(pDeny.result ?? pDeny.error ?? {}).slice(0, 160));

  // steering: a message sent while a turn runs joins it at the next step
  const post = (id, method, params) =>
    fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }).then((r) => r.json());
  const steerSess = await post(40, "session.create", { cwd: project });
  const steerSend = post(41, "session.send", {
    id: steerSess.result.id,
    text: "@repeat 4 @slow 250 steered",
  });
  await new Promise((r) => setTimeout(r, 500)); // the turn is mid-run
  const steerAck = await post(42, "session.steer", { id: steerSess.result.id, text: "MIDTURN-MARKER" });
  assert(
    steerAck.result?.steered === true,
    "session.steer accepts a message for a running turn",
    JSON.stringify(steerAck).slice(0, 140),
  );
  await steerSend;
  const steerAfter = (await post(43, "session.get", { id: steerSess.result.id })).result;
  const steerMsgs = steerAfter.messages ?? [];
  const steerIdx = steerMsgs.findIndex((m) => m.role === "user" && String(m.content).includes("MIDTURN-MARKER"));
  assert(
    steerIdx >= 0 && steerMsgs.slice(steerIdx + 1).some((m) => m.role === "assistant"),
    "the steered message is appended mid-turn and read by the model",
    JSON.stringify({ idx: steerIdx, roles: steerMsgs.map((m) => m.role) }).slice(0, 200),
  );
  const steerIdle = await post(44, "session.steer", { id: steerSess.result.id, text: "too late" });
  assert(
    !!steerIdle.error,
    "session.steer errors when no turn is running",
    JSON.stringify(steerIdle).slice(0, 140),
  );

  // reactive guard: the provider rejects an over-long prompt once; the loop
  // force-compacts and retries within the same turn (no client retry needed)
  const heavySess = await post(50, "session.create", { cwd: project });
  await post(51, "session.send", { id: heavySess.result.id, text: "@repeat 4 seed" });
  const ovFrom = frames.length;
  const ov = await post(52, "session.send", { id: heavySess.result.id, text: "@overflow 1 hello" });
  assert(
    !ov.error && (ov.result?.steps ?? 0) >= 1,
    "a context-length 400 is force-compacted and retried in-turn",
    JSON.stringify(ov).slice(0, 160),
  );
  const forcedEvents = frames
    .slice(ovFrom)
    .map((f) => f.event)
    .filter((e) => e?.type === "compaction" && e.forced === true);
  assert(
    forcedEvents.length >= 1,
    "the reactive guard emits a forced compaction event",
    JSON.stringify(forcedEvents).slice(0, 200),
  );

  // manual /compact rewrites the stored history (persisted)
  const beforeCompact = (await post(53, "session.get", { id: heavySess.result.id })).result.messages.length;
  const manual = await post(54, "session.compact", { id: heavySess.result.id });
  const afterCompact = (await post(55, "session.get", { id: heavySess.result.id })).result.messages.length;
  assert(
    manual.result?.compacted === true && afterCompact < beforeCompact,
    "session.compact shrinks the stored history",
    JSON.stringify({ ...manual.result, beforeCompact, afterCompact }).slice(0, 200),
  );
  const manualAgain = await post(56, "session.compact", { id: heavySess.result.id });
  assert(
    !manualAgain.error,
    "session.compact is safe to call again",
    JSON.stringify(manualAgain).slice(0, 140),
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
  const j3 = await run(["mcp", "restart", "mock"], project, homeJ);
  assert(
    j3.code === 0 && j3.stdout.includes("restarted mock"),
    "familiar mcp restart reconnects a server",
    j3.stdout.slice(0, 200) + j3.stderr.slice(0, 200),
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
  const { DEFAULT_CONFIG, CONFIG_TEMPLATE, loadConfig: loadWebConfig } = await import(path.join(repoRoot, "packages/core/dist/config.js"));
  assert(
    DEFAULT_CONFIG.permissions.websearch.provider === "duckduckgo" &&
      /websearch:\s*\n\s*provider:\s*duckduckgo/.test(CONFIG_TEMPLATE),
    "runtime default and init template both use DuckDuckGo for web search",
  );
  const badWebFile = path.join(tmpBase, "websearch-invalid.yaml");
  fs.writeFileSync(badWebFile, "version: 1\npermissions:\n  websearch:\n    provider: weird\n    base_url: ftp://x\n");
  const badWebCfg = loadWebConfig({ configFile: badWebFile });
  assert(
    badWebCfg.permissions.websearch.provider === "duckduckgo" && badWebCfg.permissions.websearch.base_url === "",
    "invalid websearch config falls back to DuckDuckGo on load",
  );
  const { userMemorySection } = await import(
    path.join(repoRoot, "packages/core/dist/selfimprove/memory/user-memory.js")
  );
  const memHome = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-umem-home-"));
  const memProject = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-umem-proj-"));
  fs.mkdirSync(path.join(memProject, ".familiar"), { recursive: true });
  fs.writeFileSync(path.join(memHome, "MEMORY.md"), "Global decision\n");
  fs.writeFileSync(path.join(memProject, ".familiar", "MEMORY.md"), "Project decision\n");
  const memLayer = userMemorySection(memHome, memProject);
  assert(
    memLayer.text.includes("Global decision") && memLayer.text.includes("Project decision") &&
      memLayer.text.indexOf("Global decision") < memLayer.text.indexOf("Project decision"),
    "MEMORY.md layers are injected with the project layer last",
  );
  fs.writeFileSync(path.join(memHome, "MEMORY.md"), "x".repeat(900));
  const memCap = userMemorySection(memHome, memProject, 500);
  assert(memCap.truncated === true && memCap.text.includes("[truncated"), "MEMORY.md injection enforces its char cap");
  fs.rmSync(memHome, { recursive: true, force: true });
  fs.rmSync(memProject, { recursive: true, force: true });

  // End-to-end: a real turn reads MEMORY.md from disk, not from session creation.
  const memFile = path.join(familiarHome, "MEMORY.md");
  const memBefore = fs.existsSync(memFile) ? fs.readFileSync(memFile, "utf8") : null;
  const marker = "USERMEMORY-SMOKE-MARKER-42";
  fs.writeFileSync(memFile, `# Decisions\n${marker}\n`);
  const dumpedText = (res) => res.parsed
    .filter((ev) => ev?.type === "text.delta")
    .map((ev) => ev.text)
    .join("");
  const freshSession = await run(
    ["run", "-p", `@dump-prompt ${marker}`, "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  assert(
    dumpedText(freshSession).includes("PROMPT-PRESENT"),
    "MEMORY.md is injected into a fresh session's system prompt",
    dumpedText(freshSession).slice(0, 120),
  );
  const sessionId = freshSession.lines.find((line) => typeof line.sessionId === "string")?.sessionId;
  assert(!!sessionId, "the run reported its session id", JSON.stringify(freshSession.lines).slice(0, 120));
  const existingSession = await run(
    ["run", "--session", sessionId, "-p", `@dump-prompt ${marker}`, "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  assert(
    dumpedText(existingSession).includes("PROMPT-PRESENT"),
    "MEMORY.md is injected on a pre-existing session's next turn",
    dumpedText(existingSession).slice(0, 120),
  );
  if (memBefore === null) fs.rmSync(memFile, { force: true });
  else fs.writeFileSync(memFile, memBefore);

  // ZIP attachments: list/read entries in memory, no extraction or unzip binary
  const {
    defaultToolRegistry,
    createZipListTool: makeZipList,
    createZipReadTool: makeZipRead,
    zipArchive: makeZip,
    crc32,
  } = await import(path.join(repoRoot, "packages/core/dist/tools/index.js"));
  assert(
    !!defaultToolRegistry().get("ziplist") && !!defaultToolRegistry().get("zipread"),
    "zip tools are registered in the default toolset",
  );
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-zip-"));
  const zipPath = path.join(zipDir, "notes.zip");
  fs.writeFileSync(zipPath, makeZip([
    { name: "notes.txt", data: Buffer.from("hello from zip\nsecond line\n") },
    { name: "sub/data.bin", data: Buffer.from([0, 1, 2, 3]) },
  ], { compress: true }));
  const zipCtx = {
    sessionId: "s",
    cwd: zipDir,
    yolo: true,
    config: {},
    approval: { request: async () => true },
    backend: { path, readFile: async (p) => fs.readFileSync(p) },
  };
  const listed = await makeZipList().execute({ path: zipPath }, zipCtx);
  assert(
    listed.isError !== true && listed.content.includes("notes.txt") && listed.content.includes("sub/data.bin"),
    "ziplist lists archive entries", listed.content,
  );
  const unzipped = await makeZipRead().execute({ path: zipPath, entry: "notes.txt" }, zipCtx);
  assert(unzipped.isError !== true && unzipped.content.includes("hello from zip"), "zipread returns entry text", unzipped.content);
  const zipBinary = await makeZipRead().execute({ path: zipPath, entry: "sub/data.bin" }, zipCtx);
  assert(zipBinary.isError === true && /binary/.test(zipBinary.content), "zipread refuses binary entries");
  const zipMissing = await makeZipRead().execute({ path: zipPath, entry: "nope.txt" }, zipCtx);
  assert(zipMissing.isError === true, "zipread reports a missing entry");
  const zipListTool = makeZipList();
  const zipReadTool = makeZipRead();
  assert(zipListTool.read_only === true && zipReadTool.read_only === true, "zip tools are read-only");
  const asked = [];
  const outsideCtx = {
    ...zipCtx,
    yolo: false,
    config: { permissions: { files: { bounds: "cwd", read: "ask" } } },
    approval: { request: async () => { asked.push(1); return false; } },
  };
  const outside = await zipReadTool.execute(
    { path: path.join(zipDir, "..", "outside.zip"), entry: "notes.txt" }, outsideCtx,
  );
  assert(outside.isError === true && asked.length === 1, "zipread asks approval for outside-cwd files and honours denial");
  const bigCtx = { ...zipCtx, backend: { ...zipCtx.backend, stat: async () => ({ size: 65 * 1024 * 1024 }) } };
  const huge = await zipListTool.execute({ path: zipPath }, bigCtx);
  assert(huge.isError === true && /64 MB/.test(huge.content), "zip tools reject >64 MB before reading the file");
  // Data-descriptor ZIP (local sizes zero) with a prepended SFX stub.
  const descriptorZip = (entries) => {
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const [name, text] of entries) {
      const nb = Buffer.from(name);
      const data = Buffer.from(text);
      const crc = crc32(data);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(0x0008, 6);
      h.writeUInt32LE(0, 14); h.writeUInt32LE(0, 18); h.writeUInt32LE(0, 22);
      h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(data.length, 8);
      desc.writeUInt32LE(data.length, 12);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0008, 8);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(nb.length, 28);
      c.writeUInt32LE(off, 42);
      locals.push(h, nb, data, desc);
      centrals.push(c, nb);
      off += h.length + nb.length + data.length + desc.length;
    }
    const cd = Buffer.concat(centrals);
    const localBuf = Buffer.concat(locals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
    return Buffer.concat([localBuf, cd, eocd]);
  };
  const sfxPath = path.join(zipDir, "sfx.zip");
  fs.writeFileSync(sfxPath, Buffer.concat([
    Buffer.from("SFX-STUB"),
    descriptorZip([["first.txt", "one\n"], ["second.txt", "two\n"]]),
  ]));
  const sfxRead = await zipReadTool.execute({ path: sfxPath, entry: "second.txt" }, zipCtx);
  assert(
    sfxRead.isError !== true && sfxRead.content.includes("two"),
    "zipread handles data-descriptor archives with a prepended SFX stub", sfxRead.content,
  );
  fs.rmSync(zipDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Scenario: exec timeout kills the whole process tree (grandchildren included)
// ---------------------------------------------------------------------------
console.log("— scenario: exec process-tree kill on timeout —");
if (process.platform !== "win32") {
  const { runSpawn } = await import(
    path.join(repoRoot, "packages", "core", "dist", "exec", "local.js")
  );
  const marker = path.join(tmpBase, "grandchild-survived.txt");
  const res = await runSpawn("bash", ["-c", `( sleep 4; echo alive > '${marker}' ) & sleep 30`], {
    cwd: project,
    timeoutMs: 800,
  });
  assert(res.timedOut === true, "runSpawn reports the timeout", JSON.stringify(res).slice(0, 200));
  await new Promise((r) => setTimeout(r, 5000));
  assert(
    !fs.existsSync(marker),
    "the backgrounded grandchild was killed with the tree (no orphan)",
    fs.existsSync(marker) ? "grandchild survived" : "",
  );
}

// ---------------------------------------------------------------------------
// Scenario: token budget guard (warn + enforce)
// ---------------------------------------------------------------------------
console.log("— scenario: token budget guard —");
{
  const { createRequire } = await import("node:module");
  const { WebSocket } = createRequire(import.meta.filename)("ws");
  const PORT = 46229;
  const budgetHome = path.join(tmpBase, "home-budget");
  fs.mkdirSync(budgetHome, { recursive: true });
  fs.writeFileSync(
    path.join(budgetHome, "config.yaml"),
    `version: 1
default_provider: mock
providers:
  mock:
    kind: mock
budget:
  max_tokens_per_session: 1
  max_tokens_per_day: 0
  warn_ratio: 0.5
  enforce: true
server:
  port: ${PORT}
  bind: 127.0.0.1
`,
  );
  const serve = spawn(process.execPath, [familiarBin, "serve", "--port", String(PORT)], {
    cwd: project,
    env: env(budgetHome),
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
  assert(health, "budget server /healthz responds", serveLog.slice(0, 200));
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const frames = [];
  await new Promise((res) => ws.once("open", res));
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    if (f.type === "event") frames.push(f);
  });
  await new Promise((r) => setTimeout(r, 200));
  const bpost = (id, method, params) =>
    fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }).then((r) => r.json());
  const s = await bpost(1, "session.create", {});
  const first = await bpost(2, "session.send", { id: s.result.id, text: "hello budget" });
  assert(!first.error, "first turn runs under the budget", JSON.stringify(first.error ?? {}).slice(0, 160));
  await new Promise((r) => setTimeout(r, 300));
  assert(
    frames.some((f) => f.event?.type === "budget.warning"),
    "budget.warning emitted after the turn",
    JSON.stringify(frames.map((f) => f.event?.type)).slice(0, 200),
  );
  const second = await bpost(3, "session.send", { id: s.result.id, text: "again" });
  assert(
    /budget exceeded/.test(second.error?.message ?? ""),
    "enforce refuses the next turn past the limit",
    JSON.stringify(second.error ?? {}).slice(0, 200),
  );
  ws.close();
  serve.kill("SIGTERM");
}

// ---------------------------------------------------------------------------
// Scenario: cron management (list / enable / run + persistence)
// ---------------------------------------------------------------------------
console.log("— scenario: cron management —");
{
  const PORT = 46239;
  const cronHome = path.join(tmpBase, "home-cron");
  fs.mkdirSync(cronHome, { recursive: true });
  fs.writeFileSync(
    path.join(cronHome, "config.yaml"),
    `version: 1
default_provider: mock
providers:
  mock:
    kind: mock
cron:
  jobs:
    - name: nightly
      every_minutes: 1440
      prompt: "summarize the day"
      enabled: false
server:
  port: ${PORT}
  bind: 127.0.0.1
`,
  );
  const serve = spawn(process.execPath, [familiarBin, "serve", "--port", String(PORT)], {
    cwd: project,
    env: env(cronHome),
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
  assert(health, "cron server /healthz responds", serveLog.slice(0, 200));
  const cpost = (id, method, params) =>
    fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }).then((r) => r.json());
  const st = await cpost(1, "cron.status", {});
  assert(
    (st.result?.jobs ?? []).some((j) => j.name === "nightly"),
    "cron.status lists the configured job",
    JSON.stringify(st.result ?? st.error ?? {}).slice(0, 200),
  );
  const en = await cpost(2, "cron.setEnabled", { name: "nightly", enabled: true });
  assert(en.result?.enabled === true, "cron.setEnabled enables a job", JSON.stringify(en.result ?? en.error ?? {}).slice(0, 160));
  const cfgAfter = fs.readFileSync(path.join(cronHome, "config.yaml"), "utf8");
  assert(/enabled:\s*true/.test(cfgAfter), "cron.setEnabled persists to config.yaml", cfgAfter.slice(0, 220));
  const run = await cpost(3, "cron.run", { name: "nightly" });
  assert(run.result?.started === true, "cron.run runs a job now", JSON.stringify(run.result ?? run.error ?? {}).slice(0, 160));
  serve.kill("SIGTERM");
}

// ---------------------------------------------------------------------------
// Scenario: familiar doctor (environment diagnostics)
// ---------------------------------------------------------------------------
console.log("— scenario: doctor —");
{
  const d = await run(["doctor"], project, familiarHome);
  assert(
    d.code === 0,
    "familiar doctor exits 0 on a healthy install",
    d.stdout.slice(-300) + d.stderr.slice(-200),
  );
  assert(d.stdout.includes("state.db integrity ok"), "doctor checks state.db integrity", d.stdout.slice(0, 500));
  assert(/port \d+ is (free|in use)/.test(d.stdout), "doctor checks the serve port", d.stdout.slice(0, 500));
}

// ---------------------------------------------------------------------------
// Scenario: tool-result compression + handles (result_read / result_search)
// ---------------------------------------------------------------------------
console.log("— scenario: tool-result compression + handles —");
{
  // (a) a large read is compressed to a head/tail digest carrying a handle
  const big = path.join(project, "big.txt");
  fs.writeFileSync(
    big,
    Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n"),
  );
  const comp = await run(
    ["run", "-p", "@read big.txt", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const res = comp.parsed.find((e) => e?.type === "tool.result" && e.name === "read");
  assert(
    !!res && /tool result compressed/.test(String(res.content)) && /handle: tr_/.test(String(res.content)),
    "a large tool result is compressed to a digest + handle",
    String(res?.content ?? "").slice(0, 200),
  );

  // (b) result_read / result_search fetch the elided slice back
  const { createResultReadTool, createResultSearchTool } = await import(
    path.join(repoRoot, "packages/core/dist/tools/tool-results.js")
  );
  const { SqliteSessionStore } = await import(
    path.join(repoRoot, "packages/core/dist/session/store.js")
  );
  const store = new SqliteSessionStore(":memory:");
  const body = `${"A".repeat(200)}\nNEEDLE_IN_MIDDLE\n${"B".repeat(200)}`;
  const handle = store.putToolResult("s1", "c1", "read", body);
  const ctx = { resultStore: { get: (id) => store.getToolResult(id) } };
  const rr = await createResultReadTool().execute({ handle, offset: 190, limit: 40 }, ctx);
  assert(
    rr.isError !== true && rr.content.includes("NEEDLE_IN_MIDDLE"),
    "result_read returns the elided slice",
    rr.content.slice(0, 120),
  );
  const rs = await createResultSearchTool().execute({ handle, pattern: "NEEDLE" }, ctx);
  assert(
    rs.isError !== true && /@\d+:/.test(rs.content) && rs.content.includes("NEEDLE"),
    "result_search finds matches with character offsets",
    rs.content.slice(0, 120),
  );
  store.close();
}

// ---------------------------------------------------------------------------
// Scenario: memory ranking (relevance vs recent)
// ---------------------------------------------------------------------------
console.log("— scenario: memory ranking —");
{
  const { memorySection } = await import(
    path.join(repoRoot, "packages/core/dist/selfimprove/memory/inject.js")
  );
  const now = Date.now();
  const entries = [
    { id: "mnew", content: "always use pnpm in this repo", tags: [], createdAt: now, updatedAt: now },
    {
      id: "mold",
      content: "the deploy pipeline runs on github actions",
      tags: ["deploy"],
      createdAt: now - 9000,
      updatedAt: now - 9000,
    },
  ];
  const ranked = memorySection(entries, 4000, { query: "how does the deploy pipeline work?", ranking: "relevance" });
  assert(
    ranked.text.indexOf("deploy pipeline") < ranked.text.indexOf("pnpm"),
    "relevance ranking surfaces the entry matching the instruction first",
    ranked.text.slice(0, 160),
  );
  const recent = memorySection(entries, 4000, { ranking: "recent" });
  assert(
    recent.text.indexOf("pnpm") < recent.text.indexOf("deploy pipeline"),
    "recent ranking keeps newest-first order",
    recent.text.slice(0, 160),
  );
}

// ---------------------------------------------------------------------------
// Scenario: unconfigured connector tools are not advertised (tool budget)
// ---------------------------------------------------------------------------
console.log("— scenario: tool budget (connectors) —");
{
  const t = await run(
    ["run", "-p", "@dump-prompt-tools", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const names = t.parsed
    .filter((e) => e?.type === "text.delta")
    .map((e) => e.text)
    .join("");
  assert(
    names.includes("read") && names.includes("result_read"),
    "core tools are advertised",
    names.slice(0, 160),
  );
  assert(
    !names.includes("github_issues") && !names.includes("jira_issues") && !names.includes("gmail_list"),
    "unconfigured connector tools are hidden from the prompt",
    names.slice(0, 300),
  );

  // the system prompt should nudge the model to batch independent tool calls
  const p = await run(
    ["run", "-p", "@dump-prompt Batch independent tool calls", "--cwd", project, "--json", "--yolo"],
    project,
    familiarHome,
  );
  const ptext = p.parsed.filter((e) => e?.type === "text.delta").map((e) => e.text).join("");
  assert(
    ptext.includes("PROMPT-PRESENT"),
    "the system prompt advises batching tool calls (fewer round trips)",
    ptext.slice(0, 120),
  );
}

// ---------------------------------------------------------------------------
// Scenario: per-turn cost estimate (pricing config)
// ---------------------------------------------------------------------------
console.log("— scenario: cost estimate —");
{
  const priceHome = path.join(tmpBase, "home-price");
  fs.mkdirSync(priceHome, { recursive: true });
  fs.writeFileSync(
    path.join(priceHome, "config.yaml"),
    `version: 1
default_provider: mock
providers:
  mock:
    kind: mock
pricing:
  mock:
    input: 1000
    output: 1000
server:
  port: 1
  bind: 127.0.0.1
`,
  );
  const pr = await run(
    ["run", "-p", "hello pricing", "--cwd", project, "--json", "--yolo"],
    project,
    priceHome,
  );
  const end = pr.parsed.find((e) => e?.type === "turn.end");
  assert(
    typeof end?.usage?.costUsd === "number" && end.usage.costUsd > 0,
    "pricing config produces a per-turn cost estimate",
    JSON.stringify(end?.usage ?? {}).slice(0, 200),
  );
}

// ---------------------------------------------------------------------------
// Scenario: Anthropic prompt caching (system + tools get cache_control)
// ---------------------------------------------------------------------------
console.log("— scenario: anthropic prompt caching —");
{
  const { AnthropicProvider } = await import(
    path.join(repoRoot, "packages/core/dist/providers/anthropic.js")
  );
  const origFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_url, opts) => {
    captured = JSON.parse(String(opts.body));
    return new Response('data: {"type":"message_stop"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const p = new AnthropicProvider(
      { kind: "anthropic", base_url: "http://anthropic.test", default_model: "m" },
      "sk-test",
      "anthropic",
    );
    await p.chat(
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        system: "SYS",
        tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
        promptCache: true,
      },
      () => {},
    );
  } finally {
    globalThis.fetch = origFetch;
  }
  const sysText = Array.isArray(captured?.system)
    ? captured.system.map((b) => b.text ?? "").join("")
    : String(captured?.system ?? "");
  assert(
    sysText.includes("SYS"),
    "anthropic actually sends the system prompt (ChatParams.system)",
    sysText.slice(0, 80),
  );
  assert(
    Array.isArray(captured?.system) && captured.system[0]?.cache_control?.type === "ephemeral",
    "anthropic caches the system prompt",
    JSON.stringify(captured?.system ?? null).slice(0, 160),
  );
  assert(
    captured?.tools?.[0]?.cache_control?.type === "ephemeral",
    "anthropic caches the tool block",
    JSON.stringify(captured?.tools ?? null).slice(0, 160),
  );
}

// ---------------------------------------------------------------------------
// Scenario: privacy mode (privacy.local_only blocks non-local providers)
// ---------------------------------------------------------------------------
console.log("— scenario: privacy mode —");
{
  const privHome = path.join(tmpBase, "home-priv");
  fs.mkdirSync(privHome, { recursive: true });
  fs.writeFileSync(
    path.join(privHome, "config.yaml"),
    `version: 1
default_provider: mock
providers:
  mock:
    kind: mock
  remote:
    kind: openai_compatible
    base_url: https://api.example.com/v1
    default_model: m
    auth: { env: NONE }
privacy:
  local_only: true
server:
  port: 1
  bind: 127.0.0.1
`,
  );
  const okRun = await run(
    ["run", "-p", "hello local", "--cwd", project, "--json", "--yolo"],
    project,
    privHome,
  );
  assert(
    okRun.code === 0,
    "privacy.local_only allows a local (mock) provider",
    `code=${okRun.code} ${okRun.stderr.slice(0, 140)}`,
  );
  const blocked = await run(
    ["run", "-p", "hello remote", "--cwd", project, "--json", "--yolo", "--provider", "remote"],
    project,
    privHome,
  );
  const blob = `${blocked.stdout}\n${blocked.stderr}`;
  assert(
    blocked.code !== 0 && /privacy\.local_only/.test(blob),
    "privacy.local_only blocks a non-local provider",
    blob.slice(0, 200),
  );
}

// ---------------------------------------------------------------------------
// Scenario: familiar demo (offline walkthrough of the differentiators)
// ---------------------------------------------------------------------------
console.log("— scenario: demo —");
{
  const demo = await run(["demo"], project, familiarHome);
  const blob = `${demo.stdout}\n${demo.stderr}`;
  assert(demo.code === 0, "familiar demo exits 0", blob.slice(-300));
  assert(
    demo.stdout.includes("self-review staged"),
    "demo shows the reviewer staging a lesson instead of applying it",
    blob.slice(0, 300),
  );
  assert(
    demo.stdout.includes("MEMORY-PRESENT"),
    "demo shows the approved lesson being inherited by the next turn",
    blob.slice(0, 300),
  );
  assert(
    demo.stdout.includes("session(s) in the same store"),
    "demo shows one core engine serving the frontends",
    blob.slice(0, 300),
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
