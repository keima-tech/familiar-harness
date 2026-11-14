import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import nodePath, { type PlatformPath } from "node:path";
import { killProcessTree } from "./kill.js";
import {
  OutputCollector,
  SKIP_DIR_NAMES,
  type DirEntry,
  type ExecBackend,
  type ExecOptions,
  type ExecResult,
  type StatInfo,
} from "./types.js";

export interface ResolvedShellCommand {
  file: string;
  args: string[];
  shellName: string;
}

/** Windows-first shell resolution (AGENTS.md: go through this, never spawn raw). */
export function resolveShellCommand(command: string): ResolvedShellCommand {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      shellName: "powershell",
    };
  }
  return { file: "bash", args: ["-c", command], shellName: "bash" };
}

/** Iterative file walker skipping build/vendor/hidden directories. */
export async function* walkLocal(root: string, extraSkip?: string): AsyncGenerator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable/unmountable
    }
    for (const ent of entries) {
      const full = nodePath.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".") || SKIP_DIR_NAMES.has(ent.name) || ent.name === extraSkip) {
          continue;
        }
        stack.push(full);
      } else if (ent.isFile()) {
        yield full;
      }
    }
  }
}

/** The original, unchanged local execution path (node fs + child_process). */
export class LocalBackend implements ExecBackend {
  readonly kind = "local" as const;
  /** Local path flavor: the platform one (Windows drive letters etc.). */
  readonly path: PlatformPath = nodePath;
  readonly label = "local";

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const shell = resolveShellCommand(command);
    return runSpawn(shell.file, shell.args, opts);
  }

  async readFile(file: string, maxBytes?: number): Promise<Buffer> {
    const buf = await fsp.readFile(file);
    return maxBytes !== undefined && buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }

  async writeFile(file: string, data: string | Buffer): Promise<void> {
    await fsp.writeFile(file, data);
  }

  async mkdirp(dir: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
  }

  async exists(file: string): Promise<boolean> {
    try {
      await fsp.access(file);
      return true;
    } catch {
      return false;
    }
  }

  async stat(file: string): Promise<StatInfo> {
    const st = await fsp.stat(file);
    return { mtimeMs: st.mtimeMs, size: st.size, isDir: st.isDirectory(), isFile: st.isFile() };
  }

  async listDir(dir: string): Promise<DirEntry[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const ent of entries) {
      const full = nodePath.join(dir, ent.name);
      let size = 0;
      if (ent.isFile()) {
        try {
          size = (await fsp.stat(full)).size;
        } catch {
          /* unreadable */
        }
      }
      out.push({ name: ent.name, path: full, dir: ent.isDirectory(), size });
    }
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return out;
  }

  walk(root: string): AsyncGenerator<string> {
    return walkLocal(root);
  }

  async statMany(files: string[]): Promise<Map<string, StatInfo>> {
    const out = new Map<string, StatInfo>();
    for (const file of files) {
      try {
        const st = await fsp.stat(file);
        out.set(file, { mtimeMs: st.mtimeMs, size: st.size, isDir: st.isDirectory(), isFile: st.isFile() });
      } catch {
        /* raced away */
      }
    }
    return out;
  }

  async readMany(files: string[], maxBytes: number): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    for (const file of files) {
      try {
        const buf = await fsp.readFile(file);
        out.set(file, buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf);
      } catch {
        /* unreadable */
      }
    }
    return out;
  }

  async removeTree(dir: string): Promise<void> {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  }

  async remove(target: string): Promise<void> {
    await fsp.rm(target, { recursive: true, force: true });
  }

  async home(): Promise<string> {
    return os.homedir();
  }

  async dispose(): Promise<void> {
    /* nothing to clean up */
  }
}

/** spawn + head/tail capture + timeout (shared by exec and tests). */
export function runSpawn(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: { ...process.env } });
    const out = new OutputCollector();
    child.stdout?.on("data", (d: Buffer) => out.append(d));
    child.stderr?.on("data", (d: Buffer) => out.append(d));

    const timeoutMs = opts.timeoutMs ?? 30_000;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const text = out.text();
      resolve({
        exitCode: timedOut ? -1 : (code ?? -1),
        output: (timedOut ? `${text}\n[familiar: command timed out after ${timeoutMs}ms]` : text).trimEnd() || "(no output)",
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole tree (backgrounded grandchildren included), not just the
      // direct child; 'close' then settles with the final output. Escalate to
      // SIGKILL and force-settle if the process ignores SIGTERM.
      killProcessTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child.pid, "SIGKILL");
        finalize(-1);
      }, 3000);
      killTimer.unref?.();
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: -1, output: `failed to spawn ${file}: ${err.message}`, timedOut: false });
    });
    child.on("close", (code) => finalize(code));

    if (opts.input !== undefined && child.stdin) {
      try {
        child.stdin.end(opts.input);
      } catch {
        /* process already gone */
      }
    }
  });
}
