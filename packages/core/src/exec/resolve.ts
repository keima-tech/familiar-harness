import fs from "node:fs";
import path from "node:path";

/**
 * Resolve an executable through PATH without dying on stale entries.
 *
 * A PATH entry pointing at a dead FUSE mount (e.g. `/tmp/.mount_*` left
 * behind by a terminated AppImage) makes the kernel fail exec with ENOTCONN
 * instead of ENOENT; node's spawn then throws before ever reaching /usr/bin.
 * Looking the file up with fs.existsSync (which treats such a directory as
 * empty) and spawning the absolute path avoids the poisoned entries.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (name.includes("/") || name.includes("\\")) return name;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const dirs = (env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin").split(path.delimiter);
  for (const dir of dirs) {
    if (dir === "") continue;
    for (const ext of exts) {
      try {
        const full = path.join(dir, `${name}${ext}`);
        if (fs.existsSync(full)) return full;
      } catch {
        /* unreadable/unmounted PATH entry — try the next one */
      }
    }
  }
  return name; // let spawn produce its usual error (ENOENT) if truly absent
}
