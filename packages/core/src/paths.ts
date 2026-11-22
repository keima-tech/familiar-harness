import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Filesystem layout of the Familiar home directory (~/.familiar).
 * Tests can point this elsewhere via FAMILIAR_HOME.
 */
export function familiarHome(): string {
  const env = process.env["FAMILIAR_HOME"];
  if (env !== undefined && env !== "") return env;
  return path.join(os.homedir(), ".familiar");
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
