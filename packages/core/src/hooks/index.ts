import { execFile } from "node:child_process";
import { log } from "../logger.js";
import { resolveShellCommand } from "../tools/bash.js";
import type { ResolvedConfig } from "../config.js";

/**
 * M5: lifecycle shell hooks (config `hooks.<event>: [command, ...]`).
 * Each command receives a JSON payload on stdin and runs through
 * resolveShellCommand() (bash on Linux / PowerShell on Windows).
 * Failures are logged ONLY — a hook can never break a turn.
 */
export type HookEvent = "session_start" | "pre_tool_use" | "post_tool_use" | "turn_complete";

export interface HookPayload {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  timestamp: number;
  turnId?: string;
  tool?: string;
  args?: unknown;
  isError?: boolean;
  durationMs?: number;
  title?: string;
  provider?: string;
  model?: string;
}

const HOOK_TIMEOUT_MS = 10_000;

export class HookRunner {
  constructor(private readonly cfg: ResolvedConfig) {}

  private commandsFor(event: HookEvent): string[] {
    const list = this.cfg.hooks?.[event];
    if (!Array.isArray(list)) return [];
    return list.filter((c): c is string => typeof c === "string" && c.trim() !== "");
  }

  async run(event: HookEvent, payload: HookPayload): Promise<void> {
    const commands = this.commandsFor(event);
    if (commands.length === 0) return;
    const stdin = `${JSON.stringify(payload)}\n`;
    for (const command of commands) {
      await new Promise<void>((resolve) => {
        try {
          const shell = resolveShellCommand(command);
          let done = false;
          const finish = (err: unknown): void => {
            if (done) return;
            done = true;
            if (err) {
              log.warn(
                `hook ${event} (${command.slice(0, 80)}) failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            resolve();
          };
          const child = execFile(
            shell.file,
            shell.args,
            { timeout: HOOK_TIMEOUT_MS, cwd: payload.cwd, maxBuffer: 1_000_000 },
            (err) => finish(err),
          );
          child.stdin?.end(stdin);
          child.on("error", (err) => finish(err));
        } catch (err) {
          resolve();
          log.warn(
            `hook ${event} (${command.slice(0, 80)}) failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }
  }
}
