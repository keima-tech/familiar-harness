// SSH connections for the desktop shell.
//
// A "connection profile" is just a host/user pair (no secrets). Connecting
// means: start `familiar serve --port 0 --print-ready` on the remote machine over
// one SSH session, then open a second SSH session that forwards a free local
// port to the reported remote port. The renderer then talks to the remote
// server through http://127.0.0.1:<localPort> exactly like the local one.
//
// The bearer token is generated here, written to a 0600 temp file locally and
// streamed over SSH stdin into a 0600 remote temp file. It never appears in
// argv, the environment, or the profile store.
"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const READY_TIMEOUT_MS = Number.parseInt(process.env.FAMILIAR_SSH_TIMEOUT_MS ?? "", 10) || 45_000;
const TUNNEL_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 2_000;

function familiarHome() {
  return process.env.FAMILIAR_HOME || path.join(os.homedir(), ".familiar");
}

function profilesFile() {
  return path.join(familiarHome(), "desktop.json");
}

function sshBin() {
  return process.env.FAMILIAR_SSH_BIN || "ssh";
}

// ---------------------------------------------------------------------------
// profiles (~/.familiar/desktop.json, 0600; no credentials)
// ---------------------------------------------------------------------------

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesFile(), "utf8"));
    const list = Array.isArray(parsed?.connections) ? parsed.connections : [];
    return { version: 1, connections: list.map((p) => sanitizeProfile(p, p)).filter(Boolean) };
  } catch {
    return { version: 1, connections: [] };
  }
}

function writeStore(store) {
  const file = profilesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

function clean(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Validate/normalize one profile. Returns null for unusable input. */
function sanitizeProfile(input, existing) {
  if (!input || typeof input !== "object") return null;
  const host = clean(input.host, 255);
  if (!host || /[\s/]/.test(host) || host.startsWith("-")) return null;
  const user = clean(input.user, 64);
  if (user && !/^[A-Za-z0-9._-]+$/.test(user)) return null;
  const portRaw = Number.parseInt(String(input.port ?? 22), 10);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 22;
  const identityFile = clean(input.identityFile, 4096);
  const remoteBin = clean(input.remoteBin, 4096) || "familiar";
  // serve: start `familiar serve` on the host over a tunnel (needs familiar there)
  // proxy: nothing installed remotely — every tool call runs over ssh
  const mode = input.mode === "proxy" ? "proxy" : "serve";
  const name = clean(input.name, 80) || `${user ? `${user}@` : ""}${host}`;
  const id = clean(existing?.id ?? input.id, 64) || crypto.randomUUID();
  return {
    id: /^[A-Za-z0-9._-]+$/.test(id) ? id : crypto.randomUUID(),
    name,
    host,
    port,
    user,
    ...(mode === "proxy" ? { mode } : {}),
    ...(identityFile ? { identityFile } : {}),
    remoteBin,
  };
}

function listProfiles() {
  return readStore().connections;
}

function getProfile(id) {
  return listProfiles().find((p) => p.id === id) ?? null;
}

/** Create or update a profile. Returns the stored (sanitized) profile. */
function saveProfile(input) {
  const store = readStore();
  const existing = input?.id ? store.connections.find((p) => p.id === input.id) : null;
  const profile = sanitizeProfile(input, existing);
  if (!profile) throw new Error("invalid connection profile (host is required)");
  if (existing) {
    store.connections = store.connections.map((p) => (p.id === profile.id ? profile : p));
  } else {
    store.connections.push(profile);
  }
  writeStore(store);
  return profile;
}

function deleteProfile(id) {
  const store = readStore();
  const before = store.connections.length;
  store.connections = store.connections.filter((p) => p.id !== id);
  if (store.connections.length !== before) writeStore(store);
  return store.connections.length !== before;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a local port"))));
    });
  });
}

function sshBaseArgs(profile) {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes", // keys/agent only — never hang on a password prompt
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-o",
    "LogLevel=ERROR",
  ];
  if (profile.port && profile.port !== 22) args.push("-p", String(profile.port));
  if (profile.identityFile) args.push("-i", profile.identityFile);
  if (profile.user) args.push("-l", profile.user);
  args.push(profile.host);
  return args;
}

/** POSIX remote bootstrap: stash the token from stdin, run serve, clean up.
 * No `exec` so the EXIT trap survives to remove the token file when the
 * session goes away. */
function remoteCommand(remoteBin) {
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

function healthz(port, token, timeoutMs = HEALTH_TIMEOUT_MS) {
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
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed?.ok === true ? parsed : null);
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

function waitForHealth(port, token, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = async () => {
      const info = await healthz(port, token);
      if (info) return resolve(info);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 150);
    };
    void tick();
  });
}

function waitForExit(child, ms) {
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
// connection
// ---------------------------------------------------------------------------

class SshConnection {
  constructor(profile) {
    const normalized = sanitizeProfile(profile, profile);
    if (!normalized) throw new Error("invalid connection profile");
    this.profile = normalized;
    this.token = "";
    this.localPort = 0;
    this.remotePort = 0;
    this.url = "";
    this.info = {};
    this.serverChild = null;
    this.tunnelChild = null;
    this.tmpDir = "";
    this.closing = false;
    this.lost = false;
    this.lostListeners = [];
    this.logTail = [];
  }

  onLost(cb) {
    this.lostListeners.push(cb);
    return () => {
      this.lostListeners = this.lostListeners.filter((f) => f !== cb);
    };
  }

  emitLost(reason) {
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

  noteStderr(chunk) {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.logTail.push(line.slice(0, 400));
    }
    while (this.logTail.length > 12) this.logTail.shift();
  }

  async connect() {
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-ssh-"));
    const tokenFile = path.join(this.tmpDir, "token");
    this.token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(tokenFile, `${this.token}\n`, { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600);

    try {
      const ready = await this.startRemoteServer(tokenFile);
      this.remotePort = ready.port;
      const localPort = await freeLocalPort();
      await this.startTunnel(localPort);
      const info = await waitForHealth(localPort, this.token, TUNNEL_TIMEOUT_MS);
      if (!info) throw new Error("tunnel opened but the remote server did not answer on /healthz");
      this.localPort = localPort;
      this.url = `http://127.0.0.1:${localPort}`;
      this.info = {
        hostname: typeof info.hostname === "string" ? info.hostname : this.profile.host,
        platform: typeof info.platform === "string" ? info.platform : "unknown",
        home: typeof info.home === "string" ? info.home : "",
        version: typeof info.version === "string" ? info.version : "",
      };
      return this;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  startRemoteServer(tokenFile) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      const args = [...sshBaseArgs(this.profile), remoteCommand(this.profile.remoteBin)];
      const child = spawn(sshBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
      this.serverChild = child;
      const finish = (err, value) => {
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
          resolve(value);
        }
      };
      const timer = setTimeout(
        () => finish(new Error(`remote 'familiar serve' did not report ready within ${READY_TIMEOUT_MS / 1000}s`)),
        READY_TIMEOUT_MS,
      );

      child.on("error", (err) => {
        const msg = err?.code === "ENOENT" ? `ssh not found (${sshBin()})` : String(err?.message ?? err);
        finish(new Error(msg));
      });
      child.stderr.on("data", (chunk) => this.noteStderr(chunk));
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 64 * 1024) stdout = stdout.slice(-32 * 1024);
        const match = /^FAMILIAR_READY (\{.*\})$/m.exec(stdout);
        if (!match) return;
        let parsed;
        try {
          parsed = JSON.parse(match[1]);
        } catch {
          return finish(new Error("remote server emitted an unreadable ready line"));
        }
        const port = Number(parsed?.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          return finish(new Error("remote server reported an invalid port"));
        }
        finish(null, { port, url: parsed.url, tokenFile: parsed.tokenFile });
      });
      child.on("exit", (code, signal) => {
        if (!settled) {
          const how = signal ? `signal ${signal}` : `exit ${code}`;
          finish(new Error(`remote command ended before it was ready (${how})`));
        } else if (!this.closing) {
          this.emitLost("remote server exited");
        }
      });

      // The remote bootstrap reads the token from stdin until EOF.
      try {
        child.stdin.write(this.token);
        child.stdin.end("\n");
      } catch (err) {
        finish(new Error(`could not send the token over SSH: ${err?.message ?? err}`));
      }
    });
  }

  startTunnel(localPort) {
    return new Promise((resolve, reject) => {
      const args = [
        ...sshBaseArgs(this.profile),
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `127.0.0.1:${localPort}:127.0.0.1:${this.remotePort}`,
      ];
      const child = spawn(sshBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
      this.tunnelChild = child;
      let settled = false;
      const finish = (err) => {
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
      // Give ssh a moment to fail fast (bad forward, auth) before polling.
      const timer = setTimeout(() => finish(new Error("SSH tunnel did not start in time")), TUNNEL_TIMEOUT_MS);
      child.on("error", (err) => finish(new Error(`SSH tunnel failed: ${err?.message ?? err}`)));
      child.stderr.on("data", (chunk) => this.noteStderr(chunk));
      child.on("exit", (code, signal) => {
        if (!settled) {
          finish(new Error(`SSH tunnel exited (${signal ?? code})`));
        } else if (!this.closing) {
          this.emitLost("SSH tunnel closed");
        }
      });
      // Wait until the local forwarded port accepts connections.
      const deadline = Date.now() + TUNNEL_TIMEOUT_MS;
      const probe = () => {
        const sock = net.connect({ host: "127.0.0.1", port: localPort });
        sock.once("connect", () => {
          sock.destroy();
          if (!this.tunnelChild) return;
          finish(null);
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

  async close() {
    if (this.closing) return;
    this.closing = true;
    const children = [this.tunnelChild, this.serverChild].filter(Boolean);
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

module.exports = {
  SshConnection,
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  sanitizeProfile,
  healthz,
};
