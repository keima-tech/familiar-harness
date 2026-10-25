import type { SessionRemote } from "@familiar/protocol";
import { LocalBackend } from "./local.js";
import { SshBackend } from "./ssh.js";

export type {
  DirEntry,
  ExecBackend,
  ExecOptions,
  ExecResult,
  StatInfo,
} from "./types.js";
export { OUTPUT_CAP, SKIP_DIR_NAMES } from "./types.js";
export { LocalBackend, resolveShellCommand, walkLocal } from "./local.js";
export { SshBackend } from "./ssh.js";

/** The execution boundary for a session: local, or a remote host over ssh. */
export function createBackend(remote?: SessionRemote | null): LocalBackend | SshBackend {
  return remote ? new SshBackend(remote) : new LocalBackend();
}
