import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../paths.js";

/**
 * Runtime settings override (~/.familiar/settings.json).
 * Values here win over config.yaml defaults; CLI toggles write here so we
 * never have to rewrite the user's YAML.
 */
export class Settings {
  private readonly file: string;

  constructor(home: string) {
    this.file = path.join(home, "settings.json");
  }

  get(key: string): boolean | undefined {
    const data = this.read();
    const v = data[key];
    return typeof v === "boolean" ? v : undefined;
  }

  set(key: string, value: boolean): void {
    ensureDir(path.dirname(this.file));
    const data = this.read();
    data[key] = value;
    fs.writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }

  private read(): Record<string, unknown> {
    if (!fs.existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
}
