import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * `familiar worktree` — thin wrapper around git worktree (M2).
 *
 *   familiar worktree list
 *   familiar worktree add <name> [--root DIR]
 *   familiar worktree remove <name> [--force]
 *   familiar worktree prune
 */

interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`git ${args[0]} failed: ${message} (is ${cwd} inside a git repo?)`);
  }
}

function listWorktrees(cwd: string): WorktreeEntry[] {
  const out = git(["worktree", "list", "--porcelain"], cwd);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      entries.push(current);
    } else if (line.startsWith("head ") && current) {
      current.head = line.slice("head ".length);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    }
  }
  return entries;
}

function defaultRoot(cwd: string): string {
  return path.join(path.dirname(cwd), `.${path.basename(cwd)}-worktrees`);
}

export async function cmdWorktree(
  flags: Record<string, string | boolean>,
  positionals: string[],
  cwd: string,
): Promise<void> {
  const sub = positionals[0] ?? "list";

  if (sub === "list") {
    const entries = listWorktrees(cwd);
    for (const e of entries) {
      process.stdout.write(`${e.path}  [${e.branch ?? e.head ?? "?"}]\n`);
    }
    return;
  }

  if (sub === "add" || sub === "create") {
    const name = positionals[1];
    if (!name) throw new Error("usage: familiar worktree add <name> [--root DIR]");
    if (name.includes("/") || name.includes("..") || name.includes("\\") || name.includes(" ")) {
      throw new Error(`invalid worktree name: ${name}`);
    }
    const root =
      flags["root"] !== undefined && typeof flags["root"] === "string" ? flags["root"] : defaultRoot(cwd);
    const target = path.join(root, name);
    const branch = `familiar/${name}`;
    // Prefer a dedicated branch; fall back to a plain add on error.
    let created = false;
    try {
      execFileSync("git", ["worktree", "add", "-b", branch, target], { cwd, stdio: "pipe" });
      created = true;
    } catch {
      try {
        execFileSync("git", ["worktree", "add", target], { cwd, stdio: "pipe" });
        created = true;
      } catch (err) {
        const message = err instanceof Error ? err.message.split("\n").slice(-3).join(" ").trim() : String(err);
        throw new Error(`git worktree add failed: ${message}`);
      }
    }
    if (created) {
      process.stdout.write(`created worktree: ${target}\nbranch: ${branch} (if newly created)\n`);
      process.stdout.write(`  cd ${target}   # then: familiar run/chat in that directory\n`);
    }
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const name = positionals[1];
    if (!name) throw new Error("usage: familiar worktree remove <name> [--force]");
    const entries = listWorktrees(cwd);
    const target =
      entries.find((e) => e.path === name || path.basename(e.path) === name)?.path ?? path.resolve(cwd, name);
    const args = ["worktree", "remove", target];
    if (flags["force"] === true) args.push("--force");
    try {
      execFileSync("git", args, { cwd, stdio: "pipe" });
      process.stdout.write(`removed worktree: ${target}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n").slice(-3).join(" ").trim() : String(err);
      throw new Error(`git worktree remove failed: ${message}`);
    }
    return;
  }

  if (sub === "prune") {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe" });
    process.stdout.write("pruned stale worktrees\n");
    return;
  }

  throw new Error(`unknown worktree subcommand: ${sub} (list | add | remove | prune)`);
}
