import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  deleteSshSecret,
  hasSshSecret,
  log,
  noteSshOutcome,
  resolveExecutable,
  sshArgs,
  sshAuthEnv,
  sshCooldownError,
  writeSshSecret,
} from "@familiar/core";

/**
 * Server-side SSH connections, so the browser WebUI (no desktop shell) can
 * manage hosts and switch to a remote `familiar serve` through a tunnel.
 *
 * Profile storage is shared with the desktop shell (`~/.familiar/desktop.json`,
 * 0600, no credentials): both read/write the same file, so a host registered
 * in either UI appears in the other. The desktop keeps its own copy of the
 * connection mechanics (see packages/desktop/ssh.js) because it swaps the
 * Electron window; this module is the equivalent for HTTP clients.
 *
 * Serve mode: start `familiar serve --port 0 --print-ready` on the host over one
 * ssh, forward a free local port to it with a second ssh, and hand the caller
 * the tunnel URL + bearer token. The token is streamed over ssh stdin into a
 * 0600 temp file and never lands in argv/env/logs.
 */

const READY_TIMEOUT_MS = Number.parseInt(process.env["FAMILIAR_SSH_TIMEOUT_MS"] ?? "", 10) || 45_000;
const TUNNEL_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 2_000;
const TUNNEL_TTL_MS =
  Number.parseInt(process.env["FAMILIAR_TUNNEL_TTL_MS"] ?? "", 10) || 12 * 60 * 60 * 1000;

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** "serve" (default): remote familiar serve over a tunnel; "proxy": tools over ssh */
  mode?: "serve" | "proxy";
  /** "password" when the host authenticates with a stored password (no key) */
  auth?: "password";
  identityFile?: string;
  remoteBin: string;
}

export interface ActiveTunnel {
  id: string;
  name: string;
  host: string;
  hostname: string;
  platform: string;
  version: string;
  url: string;
  stop: string;
  startedAt: number;
}

export interface ProbeResult {
  ok: true;
  hostname: string;
  platform: string;
  home: string;
  /** installed familiar version on the host, "" when not found */
  familiar: string;
}

function familiarHome(): string {
  return process.env["FAMILIAR_HOME"] || path.join(os.homedir(), ".familiar");
}

function profilesFile(): string {
  return path.join(familiarHome(), "desktop.json");
}

function sshBin(): string {
  return process.env["FAMILIAR_SSH_BIN"] || resolveExecutable("ssh");
}

function keyscanBin(): string {
  return process.env["FAMILIAR_SSH_KEYSCAN_BIN"] || resolveExecutable("ssh-keyscan");
}

/** known_hosts location (overridable for tests / non-standard homes). */
export function knownHostsPath(): string {
  return process.env["FAMILIAR_SSH_KNOWN_HOSTS"] || path.join(os.homedir(), ".ssh", "known_hosts");
}

/** OpenSSH "SHA256:…" fingerprint of a base64 key blob. */
export function sha256Fingerprint(blobB64: string): string {
  const digest = crypto.createHash("sha256").update(Buffer.from(blobB64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export interface HostKeyInfo {
  /** the verbatim `known_hosts` line (host type blob) */
  line: string;
  host: string;
  type: string;
  fingerprint: string;
}

export interface HostKeyScan {
  host: string;
  port: number;
  keys: HostKeyInfo[];
  knownHosts: string;
}

function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code: child.exitCode ?? 0, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      finish(new Error(`${file} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 2000) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT" ? `${file} not found` : err.message;
      finish(new Error(msg));
    });
    child.on("exit", () => finish());
  });
}

/** Fetch a host's public keys with ssh-keyscan (no connection, no auth). */
export async function scanHostKeys(host: string, port = 22): Promise<HostKeyScan> {
  const args = ["-T", "5", ...(port !== 22 ? ["-p", String(port)] : []), host];
  const res = await runCommand(keyscanBin(), args, 20_000);
  const keys: HostKeyInfo[] = [];
  for (const raw of res.stdout.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [keyHost = "", type = "", blob = ""] = parts;
    if (!/^(ssh-|ecdsa-|sk-)/.test(type) || !/^[A-Za-z0-9+/=]+$/.test(blob)) continue;
    keys.push({ line: `${keyHost} ${type} ${blob}`, host: keyHost, type, fingerprint: sha256Fingerprint(blob) });
  }
  if (keys.length === 0) {
    throw new Error(
      `no host key received from ${host}${res.stderr.trim() ? ` (${res.stderr.trim().slice(0, 200)})` : ""}`,
    );
  }
  return { host, port, keys, knownHosts: knownHostsPath() };
}

export interface HostKeyTrustResult {
  added: number;
  skipped: number;
  knownHosts: string;
}

/**
 * Append scanned keys to known_hosts after the user verified the
 * fingerprints. Refuses when the host already has a *different* key of the
 * same type (possible MITM / rebuilt host) — never silently replaces one.
 */
export function trustHostKeys(host: string, port: number, lines: string[]): HostKeyTrustResult {
  const wanted: HostKeyInfo[] = [];
  for (const raw of lines.slice(0, 20)) {
    const line = String(raw).trim();
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [keyHost = "", type = "", blob = ""] = parts;
    const hostOk = keyHost === host || keyHost === `[${host}]:${port === 22 ? 22 : port}`;
    if (!hostOk || !/^(ssh-|ecdsa-|sk-)/.test(type) || !/^[A-Za-z0-9+/=]+$/.test(blob)) {
      throw new Error(`invalid host key line for ${host}: ${line.slice(0, 120)}`);
    }
    wanted.push({ line: `${keyHost} ${type} ${blob}`, host: keyHost, type, fingerprint: sha256Fingerprint(blob) });
  }
  if (wanted.length === 0) throw new Error("no host key given");

  const file = knownHostsPath();
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  const entries = existing
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("|1|"))
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 3)
    .map((p) => ({ host: p[0] ?? "", type: p[1] ?? "", blob: p[2] ?? "" }));

  let added = 0;
  let skipped = 0;
  const toAppend: string[] = [];
  for (const key of wanted) {
    const same = entries.filter((e) => e.host === key.host && e.type === key.type);
    if (same.some((e) => e.blob === key.line.split(/\s+/)[2])) {
      skipped += 1;
      continue;
    }
    const different = same.find((e) => e.blob !== key.line.split(/\s+/)[2]);
    if (different) {
      throw new Error(
        `host key CHANGED for ${key.host} (${key.type}): known_hosts has ${sha256Fingerprint(different.blob)}, ` +
          `the host offers ${key.fingerprint}. Refusing to auto-trust — verify the server manually.`,
      );
    }
    toAppend.push(key.line);
    added += 1;
  }
  if (toAppend.length > 0) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(file, `${prefix}${toAppend.join("\n")}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
  return { added, skipped, knownHosts: file };
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// profiles (shared file; same shape as the desktop shell)
// ---------------------------------------------------------------------------

function clean(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function sanitizeProfile(input: unknown, existing?: SshProfile | null): SshProfile | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const host = clean(o["host"], 255);
  if (!host || /[\s/]/.test(host) || host.startsWith("-")) return null;
  const user = clean(o["user"], 64);
  if (user && !/^[A-Za-z0-9._-]+$/.test(user)) return null;
  const portRaw = Number.parseInt(String(o["port"] ?? 22), 10);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 22;
  const rawIdentity = clean(o["identityFile"], 4096);
  // Only a simple absolute / ~-relative path: no "..", no shell metacharacters.
  const identityFile =
    /^(?:\/|~\/|\.\/|[A-Za-z]:[\\/])[A-Za-z0-9._/\\-]+$/.test(rawIdentity) &&
    !rawIdentity.includes("..")
      ? rawIdentity
      : "";
  // The remote launcher must be Familiar itself (a bare name or an explicit
  // familiar* path); never an arbitrary executable such as a shell.
  const requestedBin = clean(o["remoteBin"], 4096);
  const base = requestedBin.includes("/") ? requestedBin.split("/").pop() ?? "" : requestedBin;
  const remoteBin =
    /^(familiar|familiar-harness|familiar-[A-Za-z0-9._-]+)$/.test(base) &&
    !requestedBin.includes("..") &&
    (requestedBin.startsWith("/") || requestedBin.startsWith("~/") ||
      !requestedBin.includes("/") || !requestedBin.includes("\\"))
      ? requestedBin
      : "familiar";
  const mode = o["mode"] === "proxy" ? "proxy" : "serve";
  const auth = o["auth"] === "password" ? "password" : "key";
  const name = clean(o["name"], 80) || `${user ? `${user}@` : ""}${host}`;
  const id = clean(existing?.id ?? o["id"], 64) || crypto.randomUUID();
  return {
    id: /^[A-Za-z0-9._-]+$/.test(id) ? id : crypto.randomUUID(),
    name,
    host,
    port,
    user,
    ...(mode === "proxy" ? { mode } : {}),
    ...(auth === "password" ? { auth } : {}),
    ...(identityFile ? { identityFile } : {}),
    remoteBin,
  };
}

function readStore(): SshProfile[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesFile(), "utf8")) as { connections?: unknown };
    const list = Array.isArray(parsed?.connections) ? parsed.connections : [];
    return list.map((p) => sanitizeProfile(p, p as SshProfile)).filter((p): p is SshProfile => p !== null);
  } catch {
    return [];
  }
}

function writeStore(connections: SshProfile[]): void {
  const file = profilesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, connections }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

// ---------------------------------------------------------------------------
// ssh helpers
// ---------------------------------------------------------------------------

function freeLocalPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a local port"))));
    });
  });
}

/** Core ssh argv (BatchMode for key targets, askpass args for password ones). */
function sshBaseArgs(profile: SshProfile): string[] {
  return sshArgs({
    host: profile.host,
    port: profile.port,
    ...(profile.user ? { user: profile.user } : {}),
    ...(profile.identityFile ? { identityFile: profile.identityFile } : {}),
  });
}

function sshEnv(profile: SshProfile): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...sshAuthEnv({
      host: profile.host,
      port: profile.port,
      ...(profile.user ? { user: profile.user } : {}),
    }),
  };
}

/** POSIX remote bootstrap: stash the token from stdin, run serve, clean up. */
function remoteCommand(remoteBin: string): string {
  const bin = shellQuote(remoteBin || "familiar");
  return [
    "umask 077",
    't=$(mktemp "${TMPDIR:-/tmp}/familiar-token.XXXXXX") || exit 1',
    'trap \'rm -f "$t"\' EXIT',
    'cat > "$t" || exit 1',
    `b=${bin}`,
    'if ! command -v "$b" >/dev/null 2>&1; then',
    '  for c in "$HOME/.local/bin/familiar" /usr/local/bin/familiar; do',
    '    if [ -x "$c" ]; then b="$c"; break; fi',
    "  done",
    "fi",
    '"$b" serve --port 0 --bind 127.0.0.1 --print-ready --token-file "$t"',
  ].join("\n");
}

function healthz(port: number, token: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        method: "GET",
        timeout: timeoutMs,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            resolve(parsed["ok"] === true ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function waitForHealth(port: number, token: string, ms: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = async (): Promise<void> => {
      const info = await healthz(port, token);
      if (info) return resolve(info);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(() => void tick(), 150);
    };
    void tick();
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// remote serve + tunnel
// ---------------------------------------------------------------------------

class SshConnection {
  readonly profile: SshProfile;
  token = "";
  url = "";
  info: { hostname: string; platform: string; home: string; version: string } = {
    hostname: "",
    platform: "",
    home: "",
    version: "",
  };
  private remotePort = 0;
  private serverChild: ChildProcess | null = null;
  private tunnelChild: ChildProcess | null = null;
  private tmpDir = "";
  private closing = false;
  private lost = false;
  private lostListeners: Array<(reason: string) => void> = [];
  private logTail: string[] = [];

  constructor(profile: SshProfile, private readonly tunnelHost: string) {
    this.profile = profile;
  }

  onLost(cb: (reason: string) => void): void {
    this.lostListeners.push(cb);
  }

  private emitLost(reason: string): void {
    if (this.closing || this.lost) return;
    this.lost = true;
    for (const cb of this.lostListeners.splice(0)) {
      try {
        cb(reason);
      } catch {
        /* listener errors must not mask the disconnect */
      }
    }
  }

  private noteStderr(chunk: Buffer): void {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.logTail.push(line.slice(0, 400));
    }
    while (this.logTail.length > 12) this.logTail.shift();
  }

  async connect(): Promise<this> {
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-ssh-"));
    const tokenFile = path.join(this.tmpDir, "token");
    this.token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(tokenFile, `${this.token}\n`, { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600);
    try {
      this.remotePort = await this.startRemoteServer(tokenFile);
      const localPort = await freeLocalPort(this.tunnelHost);
      await this.startTunnel(localPort);
      const info = await waitForHealth(localPort, this.token, TUNNEL_TIMEOUT_MS);
      if (!info) throw new Error("tunnel opened but the remote server did not answer on /healthz");
      this.url = `http://${this.tunnelHost}:${localPort}`;
      this.info = {
        hostname: typeof info["hostname"] === "string" ? info["hostname"] : this.profile.host,
        platform: typeof info["platform"] === "string" ? info["platform"] : "unknown",
        home: typeof info["home"] === "string" ? info["home"] : "",
        version: typeof info["version"] === "string" ? info["version"] : "",
      };
      return this;
    } catch (err) {
      noteSshOutcome(
        { host: this.profile.host, port: this.profile.port, ...(this.profile.user ? { user: this.profile.user } : {}) },
        255,
        `${this.logTail.join("\n")}\n${err instanceof Error ? err.message : err}`,
      );
      await this.close();
      throw err;
    }
  }

  private startRemoteServer(tokenFile: string): Promise<number> {
    void tokenFile;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      const child = spawn(sshBin(), [...sshBaseArgs(this.profile), remoteCommand(this.profile.remoteBin)], {
        stdio: ["pipe", "pipe", "pipe"],
        env: sshEnv(this.profile),
      });
      this.serverChild = child;
      const finish = (err: Error | null, port = 0): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          const tail = this.logTail.join(" | ");
          reject(new Error(`SSH launch failed: ${err.message}${tail ? ` — ${tail}` : ""}`));
        } else {
          resolve(port);
        }
      };
      const timer = setTimeout(
        () => finish(new Error(`remote 'familiar serve' did not report ready within ${READY_TIMEOUT_MS / 1000}s`)),
        READY_TIMEOUT_MS,
      );
      child.on("error", (err) => {
        const msg = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ssh not found (${sshBin()})` : err.message;
        finish(new Error(msg));
      });
      child.stderr?.on("data", (chunk: Buffer) => this.noteStderr(chunk));
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 64 * 1024) stdout = stdout.slice(-32 * 1024);
        const match = /^FAMILIAR_READY (\{.*\})$/m.exec(stdout);
        if (!match) return;
        let parsed: { port?: unknown };
        try {
          parsed = JSON.parse(match[1] ?? "{}") as { port?: unknown };
        } catch {
          return finish(new Error("remote server emitted an unreadable ready line"));
        }
        const port = Number(parsed.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          return finish(new Error("remote server reported an invalid port"));
        }
        finish(null, port);
      });
      child.on("exit", (code, signal) => {
        if (!settled) {
          const how = signal ? `signal ${signal}` : `exit ${code}`;
          finish(new Error(`remote command ended before it was ready (${how})`));
        } else if (!this.closing) {
          this.emitLost("remote server exited");
        }
      });
      try {
        child.stdin?.write(this.token);
        child.stdin?.end("\n");
      } catch (err) {
        finish(new Error(`could not send the token over SSH: ${err instanceof Error ? err.message : err}`));
      }
    });
  }

  private startTunnel(localPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        ...sshBaseArgs(this.profile),
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `${this.tunnelHost}:${localPort}:127.0.0.1:${this.remotePort}`,
      ];
      const child = spawn(sshBin(), args, { stdio: ["ignore", "pipe", "pipe"], env: sshEnv(this.profile) });
      this.tunnelChild = child;
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => finish(new Error("SSH tunnel did not start in time")), TUNNEL_TIMEOUT_MS);
      child.on("error", (err) => finish(new Error(`SSH tunnel failed: ${err.message}`)));
      child.stderr?.on("data", (chunk: Buffer) => this.noteStderr(chunk));
      child.on("exit", (code, signal) => {
        if (!settled) {
          finish(new Error(`SSH tunnel exited (${signal ?? code})`));
        } else if (!this.closing) {
          this.emitLost("SSH tunnel closed");
        }
      });
      const deadline = Date.now() + TUNNEL_TIMEOUT_MS;
      const probe = (): void => {
        const sock = net.connect({ host: this.tunnelHost === "0.0.0.0" ? "127.0.0.1" : this.tunnelHost, port: localPort });
        sock.once("connect", () => {
          sock.destroy();
          if (!this.tunnelChild) return;
          finish();
        });
        sock.once("error", () => {
          sock.destroy();
          if (settled) return;
          if (Date.now() > deadline) return finish(new Error("SSH tunnel port never became reachable"));
          setTimeout(probe, 150);
        });
      };
      probe();
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const children = [this.tunnelChild, this.serverChild].filter((c): c is ChildProcess => c !== null);
    this.tunnelChild = null;
    this.serverChild = null;
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await Promise.all(children.map((c) => waitForExit(c, 1500)));
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    if (this.tmpDir && fs.existsSync(this.tmpDir)) {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    }
    this.tmpDir = "";
  }
}

// ---------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------

interface ActiveEntry {
  conn: SshConnection;
  profile: SshProfile;
  stop: string;
  startedAt: number;
  timer: NodeJS.Timeout;
}

export class SshConnectionManager {
  private active: ActiveEntry | null = null;

  constructor(private readonly tunnelHost: string) {}

  listProfiles(): SshProfile[] {
    return readStore();
  }

  /** Profiles plus a `hasPassword` flag (never the secret itself). */
  listProfilesPublic(): Array<SshProfile & { hasPassword: boolean }> {
    return readStore().map((p) => ({ ...p, hasPassword: hasSshSecret(p) }));
  }

  getProfile(id: string): SshProfile | null {
    return readStore().find((p) => p.id === id) ?? null;
  }

  saveProfile(input: unknown): SshProfile {
    const profiles = readStore();
    const o = (input ?? {}) as Record<string, unknown>;
    const id = typeof o["id"] === "string" ? o["id"] : undefined;
    const existing = id ? profiles.find((p) => p.id === id) : undefined;
    const profile = sanitizeProfile(input, existing ?? null);
    if (!profile) throw new Error("invalid connection profile (host is required)");
    const next = existing
      ? profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...profiles, profile];
    writeStore(next);
    // password: a string stores it (0600), null clears it, absent = unchanged
    if (typeof o["password"] === "string" && o["password"] !== "") {
      writeSshSecret(profile, o["password"]);
    } else if (o["password"] === null) {
      deleteSshSecret(profile);
    }
    return profile;
  }

  /** Drop the stored password of a profile (on delete). */
  forgetPassword(profile: SshProfile): boolean {
    return deleteSshSecret(profile);
  }

  deleteProfile(id: string): boolean {
    const profiles = readStore();
    const next = profiles.filter((p) => p.id !== id);
    if (next.length === profiles.length) return false;
    writeStore(next);
    return true;
  }

  /** Lightweight connectivity/identity probe (no remote serve needed). */
  async probe(profile: SshProfile): Promise<ProbeResult> {
    const target = { host: profile.host, port: profile.port, ...(profile.user ? { user: profile.user } : {}) };
    const paused = sshCooldownError(target);
    if (paused) throw new Error(paused);
    const script =
      "printf '%s\\n' \"$HOME\"; hostname; uname -s; " +
      "if command -v familiar >/dev/null 2>&1; then familiar --version 2>/dev/null; else printf '%s\\n' -; fi";
    const out = await this.runSsh(profile, script, 20_000);
    const lines = out.split("\n");
    const [home = "", hostname = "", platformRaw = "", familiarRaw = "-"] = lines;
    const platformMap: Record<string, string> = { Linux: "linux", Darwin: "darwin", FreeBSD: "freebsd" };
    return {
      ok: true,
      hostname: hostname.trim() || profile.host,
      platform: platformMap[platformRaw.trim()] ?? platformRaw.trim().toLowerCase(),
      home: home.trim(),
      familiar: familiarRaw.trim() === "-" ? "" : familiarRaw.trim().replace(/^familiar\s+/, ""),
    };
  }

  private runSsh(profile: SshProfile, script: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const target = { host: profile.host, port: profile.port, ...(profile.user ? { user: profile.user } : {}) };
      const child = spawn(sshBin(), [...sshBaseArgs(profile), "--", `exec sh -c ${shellQuote(script)}`], {
        stdio: ["ignore", "pipe", "pipe"],
        env: sshEnv(profile),
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(stdout);
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        finish(new Error(`ssh ${profile.host}: probe timed out`));
      }, timeoutMs);
      child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < 2000) stderr += c.toString("utf8");
      });
      child.on("error", (err) => {
        const msg = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ssh not found (${sshBin()})` : err.message;
        finish(new Error(msg));
      });
      child.on("exit", (code) => {
        if (settled) return;
        noteSshOutcome(target, code ?? -1, stderr);
        if (code === 0) finish();
        else finish(new Error(`ssh ${profile.host}: ${stderr.trim() || `command failed (${code})`}`));
      });
    });
  }

  /** Start the remote serve + tunnel for a familiar-server profile. */
  async connect(profile: SshProfile): Promise<{ tunnel: ActiveTunnel; token: string }> {
    if (profile.mode === "proxy") {
      throw new Error("SSH proxy profiles create sessions from the new-session dialog (no tunnel)");
    }
    const target = { host: profile.host, port: profile.port, ...(profile.user ? { user: profile.user } : {}) };
    const paused = sshCooldownError(target);
    if (paused) throw new Error(paused);
    await this.disconnect();
    const conn = new SshConnection(profile, this.tunnelHost);
    await conn.connect();
    const stop = crypto.randomBytes(16).toString("hex");
    const timer = setTimeout(() => {
      log.info(`ssh: closing idle tunnel to ${profile.host} (TTL ${Math.round(TUNNEL_TTL_MS / 60000)}min)`);
      void this.disconnect();
    }, TUNNEL_TTL_MS);
    timer.unref?.();
    const entry: ActiveEntry = { conn, profile, stop, startedAt: Date.now(), timer };
    conn.onLost((reason) => {
      if (this.active !== entry) return;
      log.warn(`ssh: tunnel to ${profile.host} lost (${reason})`);
      void this.disconnect();
    });
    this.active = entry;
    return {
      tunnel: {
        id: profile.id,
        name: profile.name,
        host: profile.host,
        hostname: conn.info.hostname,
        platform: conn.info.platform,
        version: conn.info.version,
        url: conn.url,
        stop,
        startedAt: entry.startedAt,
      },
      token: conn.token,
    };
  }

  /** Stop whatever tunnel is active. Returns true when one was closed. */
  async disconnect(): Promise<boolean> {
    const entry = this.active;
    if (!entry) return false;
    this.active = null;
    clearTimeout(entry.timer);
    await entry.conn.close().catch(() => {});
    return true;
  }

  /** Capability stop used by remote UIs (`/tunnel/stop?stop=...`). */
  stopById(stop: string): boolean {
    if (!this.active || stop === "" || this.active.stop !== stop) return false;
    void this.disconnect();
    return true;
  }

  status(): ActiveTunnel | null {
    const entry = this.active;
    if (!entry) return null;
    return {
      id: entry.profile.id,
      name: entry.profile.name,
      host: entry.profile.host,
      hostname: entry.conn.info.hostname,
      platform: entry.conn.info.platform,
      version: entry.conn.info.version,
      url: entry.conn.url,
      stop: entry.stop,
      startedAt: entry.startedAt,
    };
  }

  dispose(): void {
    void this.disconnect();
  }
}
