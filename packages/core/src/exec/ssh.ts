import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath, { type PlatformPath } from "node:path";
import type { SessionRemote } from "@familiar/protocol";
import { resolveExecutable } from "./resolve.js";
import {
  OutputCollector,
  SKIP_DIR_NAMES,
  type DirEntry,
  type ExecBackend,
  type ExecOptions,
  type ExecResult,
  type StatInfo,
} from "./types.js";

/** Remote reads are capped so a huge file cannot stall a turn. */
const REMOTE_READ_CAP = 8 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 60_000;
const BATCH_TIMEOUT_MS = 120_000;
const STDOUT_CAP = 48 * 1024 * 1024;

function sshBin(): string {
  return process.env["FAMILIAR_SSH_BIN"] || resolveExecutable("ssh");
}

// ---------------------------------------------------------------------------
// Failure backoff. Repeated auth/host-key failures (typing in the folder
// picker, retried tests) trigger server-side rate limits such as fail2ban —
// after one ssh-level failure we pause attempts to that host for a while.
// ---------------------------------------------------------------------------

const COOLDOWN_MS = 60_000;
const cooldowns = new Map<string, { until: number; reason: string }>();

export function sshTargetKey(target: SessionRemote): string {
  return `${target.user ?? ""}@${target.host}:${target.port ?? 22}`;
}

/** Message when recent failures paused this host, else null. */
export function sshCooldownError(target: SessionRemote): string | null {
  const key = sshTargetKey(target);
  const entry = cooldowns.get(key);
  if (!entry) return null;
  const left = Math.ceil((entry.until - Date.now()) / 1000);
  if (left <= 0) {
    cooldowns.delete(key);
    return null;
  }
  return (
    `ssh ${target.host}: recent failures paused connection attempts for ~${left}s ` +
    `(protects against server-side rate limits such as fail2ban). ` +
    `Fix the cause (host key / key authorization) and retry.`
  );
}

/** Classify an ssh outcome and start/clear the host cooldown. */
export function noteSshOutcome(target: SessionRemote, exitCode: number, stderr: string): void {
  const key = sshTargetKey(target);
  if (
    exitCode === 255 &&
    /Permission denied|publickey|kex_exchange_identification|Connection reset by peer|Connection refused|Host key verification failed|No .* host key is known/i.test(
      stderr,
    )
  ) {
    cooldowns.set(key, { until: Date.now() + COOLDOWN_MS, reason: stderr.split("\n")[0] ?? "" });
    return;
  }
  if (exitCode !== 255) cooldowns.delete(key);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Base ssh argv for a target (`-T` + BatchMode + strict host keys). POSIX
 * clients also get ControlMaster multiplexing so per-call round trips reuse
 * one TCP/auth connection; OpenSSH for Windows has no mux and connects anew.
 */
export function sshArgs(target: SessionRemote): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-o",
    "LogLevel=ERROR",
  ];
  if (process.platform !== "win32") {
    try {
      const dir = nodePath.join(os.tmpdir(), "familiar-ssh-mux");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      args.push(
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPath=${nodePath.join(dir, "%C")}`,
        "-o",
        "ControlPersist=120",
      );
    } catch {
      /* fall back to per-call connections */
    }
  }
  if (target.port && target.port !== 22) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  if (target.user) args.push("-l", target.user);
  args.push(target.host);
  return args;
}

/** Spawn spec for a stdio child process (`MCP`, language servers) on a host. */
export interface StdioSpec {
  file: string;
  args: string[];
}

/**
 * Wrap any stdio program so it runs on the ssh host: the child we spawn is
 * the ssh client, its stdio is the remote program's stdio, and the remote
 * login shell expands the command line.
 */
export function sshStdioSpec(
  target: SessionRemote,
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): StdioSpec {
  const parts: string[] = [command, ...args];
  if (opts.env && Object.keys(opts.env).length > 0) {
    const envParts = Object.entries(opts.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
    parts.unshift("env", ...envParts);
  }
  const line = parts.map(shellQuote).join(" ");
  const remote = opts.cwd ? `cd ${shellQuote(opts.cwd)} && exec ${line}` : `exec ${line}`;
  return { file: sshBin(), args: [...sshArgs(target), "--", remote] };
}

/**
 * Tools-on-SSH execution: every call spawns the system `ssh` client, so the
 * remote needs nothing but a POSIX shell. A ControlMaster socket (POSIX
 * clients) turns the per-call round trips into one reused TCP connection.
 */
export class SshBackend implements ExecBackend {
  readonly kind = "ssh" as const;
  readonly path: PlatformPath = nodePath.posix;
  readonly label: string;
  private homeDir = "";

  constructor(private readonly target: SessionRemote) {
    this.label = `${target.user ? `${target.user}@` : ""}${target.host}`;
  }

  private baseArgs(): string[] {
    return sshArgs(this.target);
  }

  /** ssh command string: change into cwd (remote-side) then run the script. */
  private remoteCommand(script: string, cwd?: string): string {
    const exec = `exec sh -c ${shellQuote(script)}`;
    return cwd ? `cd ${shellQuote(cwd)} && ${exec}` : exec;
  }

  /** Run a script, capturing stdout as a Buffer and stderr as text. */
  private run(
    script: string,
    opts: { input?: string | Buffer; cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
    const paused = sshCooldownError(this.target);
    if (paused) return Promise.resolve({ exitCode: 255, stdout: Buffer.alloc(0), stderr: paused });
    return new Promise((resolve) => {
      const child = spawn(
        sshBin(),
        [...this.baseArgs(), "--", this.remoteCommand(script, opts.cwd)],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const stdout: Buffer[] = [];
      let stdoutLen = 0;
      let stderr = "";
      let settled = false;
      const timeoutMs = opts.timeoutMs ?? HELPER_TIMEOUT_MS;
      const finalize = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, stdout: Buffer.concat(stdout), stderr });
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        finalize(-1);
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutLen < STDOUT_CAP) {
          stdout.push(chunk);
          stdoutLen += chunk.length;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        stderr += `failed to spawn ${sshBin()}: ${err.message}`;
        finalize(-1);
      });
      child.on("close", (code) => {
        if ((code ?? -1) !== -1) noteSshOutcome(this.target, code ?? -1, stderr);
        finalize(code ?? -1);
      });
      if (opts.input !== undefined) {
        try {
          child.stdin.end(opts.input);
        } catch {
          /* already gone */
        }
      } else {
        child.stdin.end();
      }
    });
  }

  private async mustRun(
    script: string,
    opts: { input?: string | Buffer; cwd?: string; timeoutMs?: number } = {},
  ): Promise<Buffer> {
    const paused = sshCooldownError(this.target);
    if (paused) throw new Error(paused);
    const res = await this.run(script, opts);
    if (res.exitCode !== 0) {
      throw new Error(
        `ssh ${this.label}: command failed (${res.exitCode})${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`,
      );
    }
    return res.stdout;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const paused = sshCooldownError(this.target);
    if (paused) return { exitCode: 255, output: paused, timedOut: false };
    return new Promise((resolve) => {
      const child = spawn(
        sshBin(),
        [...this.baseArgs(), "--", this.remoteCommand(command, opts.cwd)],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const out = new OutputCollector();
      let stderrText = "";
      let settled = false;
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const finalize = (exitCode: number, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitCode !== -1) noteSshOutcome(this.target, exitCode, stderrText);
        const text = out.text();
        resolve({
          exitCode,
          output:
            (timedOut ? `${text}\n[familiar: command timed out after ${timeoutMs}ms]` : text).trimEnd() ||
            "(no output)",
          timedOut,
        });
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        finalize(-1, true);
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => out.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrText.length < 2000) stderrText += chunk.toString("utf8");
        out.append(chunk);
      });
      child.on("error", (err) => {
        out.append(Buffer.from(`failed to spawn ${sshBin()}: ${err.message}`));
        finalize(-1, false);
      });
      child.on("close", (code) => finalize(code ?? -1, false));
      if (opts.input !== undefined) {
        try {
          child.stdin.end(opts.input);
        } catch {
          /* already gone */
        }
      } else {
        child.stdin.end();
      }
    });
  }

  async readFile(file: string, maxBytes?: number): Promise<Buffer> {
    const cap = maxBytes ?? REMOTE_READ_CAP;
    return this.mustRun(`head -c ${cap} ${shellQuote(file)}`, { timeoutMs: BATCH_TIMEOUT_MS });
  }

  async writeFile(file: string, data: string | Buffer): Promise<void> {
    const dir = nodePath.posix.dirname(file);
    await this.mustRun(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(file)}`, {
      input: data,
      timeoutMs: BATCH_TIMEOUT_MS,
    });
  }

  async mkdirp(dir: string): Promise<void> {
    await this.mustRun(`mkdir -p ${shellQuote(dir)}`);
  }

  async exists(file: string): Promise<boolean> {
    const res = await this.run(`test -e ${shellQuote(file)}`);
    return res.exitCode === 0;
  }

  async stat(file: string): Promise<StatInfo> {
    const out = await this.mustRun(
      [
        `f=${shellQuote(file)}`,
        'if [ -d "$f" ]; then t=d; elif [ -f "$f" ]; then t=f; else t=o; fi',
        "s=$(stat -c '%Y %s' \"$f\" 2>/dev/null) || s=$(stat -f '%m %z' \"$f\" 2>/dev/null) || exit 1",
        `printf '%s %s' "$t" "$s"`,
      ].join("\n"),
    );
    const m = /^([dfo]) (\d+) (\d+)$/.exec(out.toString("utf8").trim());
    if (!m) throw new Error(`ssh ${this.label}: cannot stat ${file}`);
    return {
      mtimeMs: Number(m[2]) * 1000,
      size: Number(m[3]),
      isDir: m[1] === "d",
      isFile: m[1] === "f",
    };
  }

  async listDir(dir: string): Promise<DirEntry[]> {
    const out = await this.mustRun(
      [
        `d=${shellQuote(dir)}`,
        `[ -d "$d" ] || exit 1`,
        'for f in "$d"/* "$d"/.[!.]*; do',
        '  [ -e "$f" ] || continue',
        '  b=${f##*/}',
        '  if [ -d "$f" ]; then t=d; s=0',
        '  elif [ -f "$f" ]; then t=f; s=$(wc -c < "$f" 2>/dev/null || printf 0)',
        "  else t=o; s=0; fi",
        `  printf '%s\\0%s\\0%s\\0' "$t" "$s" "$b"`,
        "done",
      ].join("\n"),
    );
    const parts = out.toString("utf8").split("\0");
    const entries: DirEntry[] = [];
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const type = parts[i] ?? "";
      const size = Number(parts[i + 1] ?? "0") || 0;
      const name = parts[i + 2] ?? "";
      if (name === "") continue;
      entries.push({
        name,
        path: nodePath.posix.join(dir, name),
        dir: type === "d",
        size: type === "f" ? size : 0,
      });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return entries;
  }

  async *walk(root: string): AsyncGenerator<string> {
    const skips = [...SKIP_DIR_NAMES].filter((n) => !n.startsWith("."));
    const pruneNames = ["'.*'", ...skips.map((n) => shellQuote(n))].join(" -o -name ");
    const out = await this.mustRun(
      `find ${shellQuote(root)} -mindepth 1 \\( -type d \\( -name ${pruneNames} \\) \\) -prune -o -type f -print0`,
      { timeoutMs: BATCH_TIMEOUT_MS },
    );
    for (const line of out.toString("utf8").split("\0")) {
      if (line !== "") yield line;
    }
  }

  async statMany(files: string[]): Promise<Map<string, StatInfo>> {
    const stats = new Map<string, StatInfo>();
    if (files.length === 0) return stats;
    const out = await this.mustRun(
      [
        "while IFS= read -r f; do",
        '  [ -n "$f" ] || continue',
        "  s=$(stat -c '%Y %s' \"$f\" 2>/dev/null) || s=$(stat -f '%m %z' \"$f\" 2>/dev/null) || s=''",
        '  [ -n "$s" ] || continue',
        `  printf '%s\\t%s\\n' "$s" "$f"`,
        "done",
      ].join("\n"),
      { input: `${files.join("\n")}\n`, timeoutMs: BATCH_TIMEOUT_MS },
    );
    for (const line of out.toString("utf8").split("\n")) {
      const m = /^(\d+) (\d+)\t(.+)$/.exec(line);
      if (!m) continue;
      stats.set(m[3] ?? "", {
        mtimeMs: Number(m[1]) * 1000,
        size: Number(m[2]),
        isDir: false,
        isFile: true,
      });
    }
    return stats;
  }

  async readMany(files: string[], maxBytes: number): Promise<Map<string, Buffer>> {
    const outMap = new Map<string, Buffer>();
    if (files.length === 0) return outMap;
    const out = await this.mustRun(
      [
        "while IFS= read -r f; do",
        '  [ -n "$f" ] || continue',
        '  [ -f "$f" ] || continue',
        `  printf '%s\\0' "$f"`,
        `  head -c ${maxBytes} "$f" 2>/dev/null | base64 | tr -d '\\n'`,
        "  printf '\\0'",
        "done",
      ].join("\n"),
      { input: `${files.join("\n")}\n`, timeoutMs: BATCH_TIMEOUT_MS },
    );
    const parts = out.toString("utf8").split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const file = parts[i] ?? "";
      if (file === "") continue;
      const b64 = parts[i + 1] ?? "";
      outMap.set(file, b64 === "" ? Buffer.alloc(0) : Buffer.from(b64, "base64"));
    }
    return outMap;
  }

  async removeTree(dir: string): Promise<void> {
    // Callers only pass `<home>/.familiar/uploads/<bucket>`; ignore failures.
    await this.run(`rm -rf -- ${shellQuote(dir)}`, { timeoutMs: BATCH_TIMEOUT_MS });
  }

  async home(): Promise<string> {
    if (this.homeDir === "") {
      const out = await this.mustRun(`printf '%s' "$HOME"`);
      this.homeDir = out.toString("utf8").trim();
    }
    return this.homeDir;
  }

  async dispose(): Promise<void> {
    /* ControlPersist closes the mux socket on its own */
  }
}
