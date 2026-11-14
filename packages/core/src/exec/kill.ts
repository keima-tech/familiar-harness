import { execFileSync } from "node:child_process";

/**
 * Best-effort kill of a process and its whole descendant tree. A timeout that
 * only reaps the direct child leaves backgrounded grandchildren running as
 * orphans (`bash -c "sleep 1000 & wait"`), so enumerate and kill them too.
 *
 * POSIX: `ps -eo pid=,ppid=` builds the tree (Linux + macOS). Windows:
 * `taskkill /T` walks the tree natively. Never throws — the target may already
 * be gone.
 */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      // /T = tree, /F = force (Windows has no SIGTERM/SIGKILL distinction).
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  // Kill descendants first so a dying shell cannot reparent them away.
  for (const p of listDescendants(pid)) {
    try {
      process.kill(p, signal);
    } catch {
      /* already gone */
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** All descendant pids of `root` (excluding root), best effort. */
function listDescendants(root: number): number[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const child = Number(m[1]);
    const parent = Number(m[2]);
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }
  const result: number[] = [];
  const seen = new Set<number>([root]);
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const child of children.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      stack.push(child);
    }
  }
  return result;
}
