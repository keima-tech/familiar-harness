import type { SessionRemote } from "@familiar/protocol";
import { LocalBackend } from "./local.js";
export { resolveExecutable } from "./resolve.js";
import { SshBackend } from "./ssh.js";

export type {
  DirEntry,
  ExecBackend,
  ExecOptions,
  ExecResult,
  StatInfo,
} from "./types.js";
export { LocalBackend, resolveShellCommand } from "./local.js";
export { noteSshOutcome, sshCooldownError } from "./ssh.js";
export {
  askpassHelperPath,
  deleteSshSecret,
  hasSshSecret,
  sshAuthEnv,
  sshSecretPath,
  writeSshSecret,
} from "./ssh-auth.js";
export { sshArgs, sshStdioSpec } from "./ssh.js";
export { SshBackend } from "./ssh.js";

/** The execution boundary for a session: local, or a remote host over ssh. */
export function createBackend(remote?: SessionRemote | null): LocalBackend | SshBackend {
  return remote ? new SshBackend(remote) : new LocalBackend();
}
