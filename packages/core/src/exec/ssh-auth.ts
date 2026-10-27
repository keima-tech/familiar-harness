import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionRemote } from "@familiar/protocol";

/**
 * Password authentication for SSH targets, so a host that only offers a
 * password (no key installed yet) can be used without touching it.
 *
 * The password is stored per target in `<familiar home>/secrets/ssh-<hash>.pass`
 * (0600, same directory as provider keys) and handed to OpenSSH through
 * SSH_ASKPASS: ssh runs a tiny helper that cats the file, so the password
 * never appears in argv, the environment of the ssh process itself, or logs.
 * BatchMode is dropped for such targets (it would suppress askpass) and the
 * prompt count is pinned to one to avoid tripping server-side rate limits.
 */

function familiarHome(): string {
  return process.env["FAMILIAR_HOME"] || path.join(os.homedir(), ".familiar");
}

export function sshSecretPath(target: SessionRemote): string {
  const key = `${target.user ?? ""}@${target.host}:${target.port ?? 22}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(familiarHome(), "secrets", `ssh-${hash}.pass`);
}

export function hasSshSecret(target: SessionRemote): boolean {
  try {
    return fs.statSync(sshSecretPath(target)).size > 0;
  } catch {
    return false;
  }
}

export function writeSshSecret(target: SessionRemote, password: string): string {
  const file = sshSecretPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${password}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Returns true when a stored password was removed. */
export function deleteSshSecret(target: SessionRemote): boolean {
  try {
    fs.rmSync(sshSecretPath(target));
    return true;
  } catch {
    return false;
  }
}

const ASKPASS_BODY =
  process.platform === "win32" ? '@type "%FAMILIAR_ASKPASS_FILE%"\r\n' : '#!/bin/sh\ncat "$FAMILIAR_ASKPASS_FILE"\n';

let helperFile = "";

/** Path of the askpass helper (created once per process, 0700). */
export function askpassHelperPath(): string {
  if (helperFile !== "" && fs.existsSync(helperFile)) return helperFile;
  const dir = path.join(os.tmpdir(), "familiar-ssh-askpass");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
  fs.writeFileSync(file, ASKPASS_BODY, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  helperFile = file;
  return file;
}

/** Extra ssh argv for password targets (empty for key/agent targets). */
export function sshAuthArgs(target: SessionRemote): string[] {
  if (!hasSshSecret(target)) return [];
  return [
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "PreferredAuthentications=publickey,password", // skip multi-question kbd-interactive
  ];
}

/** Environment for ssh children so askpass can read the stored password. */
export function sshAuthEnv(target: SessionRemote): Record<string, string> {
  if (!hasSshSecret(target)) return {};
  return {
    SSH_ASKPASS: askpassHelperPath(),
    SSH_ASKPASS_REQUIRE: "force",
    FAMILIAR_ASKPASS_FILE: sshSecretPath(target),
  };
}
