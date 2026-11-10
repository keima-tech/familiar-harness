import type { PlatformPath } from "node:path";

/**
 * Execution boundary for tools. `local` touches this machine; `ssh` runs
 * everything on a remote host over the system `ssh` binary — the remote needs
 * nothing but a POSIX shell (no familiar installation).
 */
export interface ExecOptions {
  /** Working directory for the command (absolute, on the backend's host). */
  cwd?: string;
  timeoutMs?: number;
  input?: string | Buffer;
}

export interface ExecResult {
  exitCode: number;
  /** combined stdout+stderr, head+tail capped (same policy as the bash tool) */
  output: string;
  timedOut: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export interface StatInfo {
  mtimeMs: number;
  size: number;
  isDir: boolean;
  isFile: boolean;
}

export interface ExecBackend {
  readonly kind: "local" | "ssh";
  /** Path flavor for cwd math — posix for ssh even on a Windows client. */
  readonly path: PlatformPath;
  /** Human label for prompts/UI, e.g. "local" or "user@host". */
  readonly label: string;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(file: string, maxBytes?: number): Promise<Buffer>;
  writeFile(file: string, data: string | Buffer): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  stat(file: string): Promise<StatInfo>;
  /** All entries (hidden included); callers filter. Sorted by name. */
  listDir(dir: string): Promise<DirEntry[]>;
  /** Recursive file walk skipping vendor/hidden dirs. */
  walk(root: string): AsyncGenerator<string>;
  /** mtime+size for many files in as few round trips as possible. */
  statMany(files: string[]): Promise<Map<string, StatInfo>>;
  /** Binary-safe read of up to maxBytes per file (grep-style scans). */
  readMany(files: string[], maxBytes: number): Promise<Map<string, Buffer>>;
  /** Recursively delete a directory (best-effort callers pass safe paths). */
  removeTree(dir: string): Promise<void>;
  /** Rename/move a file or directory on the backend's host. */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file or directory (recursive); throws if the target is gone. */
  remove(target: string): Promise<void>;
  /** Host home directory (remote $HOME for ssh). */
  home(): Promise<string>;
  dispose(): Promise<void>;
}

/** Directories the file walkers always skip (mirrors the original walker). */
export const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);

export const OUTPUT_CAP = 256 * 1024; // keep head 128KB + tail 128KB
export const HEAD_KEEP = 128 * 1024;
export const TAIL_KEEP = 128 * 1024;

/** Append a chunk to a head/tail buffer pair (shared by both backends). */
export class OutputCollector {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private overflowed = false;

  append(chunk: Buffer): void {
    if (!this.overflowed) {
      this.head = Buffer.concat([this.head, chunk]);
    } else {
      this.tail = Buffer.concat([this.tail, chunk]);
    }
    if (!this.overflowed && this.head.length > OUTPUT_CAP) {
      this.overflowed = true;
      this.tail = this.head.subarray(HEAD_KEEP);
      this.head = this.head.subarray(0, HEAD_KEEP);
    }
    if (this.overflowed && this.tail.length > TAIL_KEEP) {
      this.tail = this.tail.subarray(this.tail.length - TAIL_KEEP);
    }
  }

  text(): string {
    let output = this.head.toString("utf8");
    if (this.overflowed) {
      output += `\n[output truncated]${this.tail.length > 0 ? "\n" + this.tail.toString("utf8") : ""}`;
    }
    return output;
  }
}
