import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Filesystem layout of the Familiar home directory (~/.familiar).
 * Tests can point this elsewhere via FAMILIAR_HOME.
 *
 * The product uses the "Familiar" name; an existing ~/.familiar
 * directory is still honoured (read and written) when ~/.familiar does not
 * exist yet, so upgrading installations keep their sessions, secrets and
 * settings without a manual migration.
 */
export function familiarHome(): string {
  const env = process.env["FAMILIAR_HOME"];
  if (env !== undefined && env !== "") return env;
  const home = path.join(os.homedir(), ".familiar");
  if (fs.existsSync(home)) return home;
  const legacy = path.join(os.homedir(), ".familiar");
  if (fs.existsSync(legacy)) return legacy;
  return home;
}

export const familiarPaths = {
  home: familiarHome,
  config: (): string => path.join(familiarHome(), "config.yaml"),
  stateDb: (): string => path.join(familiarHome(), "state.db"),
  profiles: (): string => path.join(familiarHome(), "profiles"),
  skills: (): string => path.join(familiarHome(), "skills"),
  memories: (): string => path.join(familiarHome(), "memories"),
  pendingMemory: (): string => path.join(familiarHome(), "pending", "memory"),
  pendingSkills: (): string => path.join(familiarHome(), "pending", "skills"),
};

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
