import { spawn } from "node:child_process";
import path from "node:path";
import type { Tool } from "./registry.js";
import type { ToolContext, ToolOutput } from "./registry.js";
import { approveOrDeny, type ApprovalRequest } from "./permissions.js";

const OUTPUT_CAP = 256 * 1024; // keep head 128KB + tail 128KB
const HEAD_KEEP = 128 * 1024;
const TAIL_KEEP = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

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

export function createBashTool(): Tool {
  return {
    name: "bash",
    description:
      "Run a shell command and capture combined stdout/stderr. " +
      "The working directory is the session cwd. Long-running commands must respect timeout_ms. " +
      "Destructive commands go through an approval prompt unless --yolo.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run", minLength: 1 },
        timeout_ms: { type: "number", description: "Timeout in ms (default 30000, max 600000)" },
        cwd: { type: "string", description: "Subdirectory of the session cwd to run in" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) return { content: "argument 'command' is required", isError: true };

      let timeoutMs = DEFAULT_TIMEOUT_MS;
      if (Number.isFinite(args.timeout_ms) && Number(args.timeout_ms) > 0) {
        timeoutMs = Math.min(Number(args.timeout_ms), ctx.config.permissions.bash.max_timeout_ms);
      }
      let cwd = ctx.cwd;
      if (typeof args.cwd === "string" && args.cwd !== "") {
        cwd = path.isAbsolute(args.cwd) ? path.normalize(args.cwd) : path.resolve(ctx.cwd, args.cwd);
        if (cwd !== ctx.cwd && !cwd.startsWith(ctx.cwd + path.sep)) {
          return { content: `cwd must stay inside ${ctx.cwd}`, isError: true };
        }
      }

      const outcome = await approveOrDeny(
        "bash",
        { tool: "bash", summary: `bash: ${command.slice(0, 160)}` },
        {
          command,
          bashCfg: ctx.config.permissions.bash,
          yolo: ctx.yolo,
          approval: ctx.approval,
        },
      );
      if (!outcome.approved) {
        return {
          content: `[denied by user/policy] ${command}`,
          isError: true,
        };
      }

      const shell = resolveShellCommand(command);
      const result = await runShell(shell.file, shell.args, cwd, timeoutMs);
      return { content: result.output, isError: result.exitCode !== 0 };
    },
  };
}

interface ShellRunResult {
  exitCode: number;
  output: string;
}

function runShell(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env: { ...process.env } });

    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let overflowed = false;

    const append = (chunk: Buffer) => {
      if (!overflowed) {
        head = Buffer.concat([head, chunk]);
      } else {
        tail = Buffer.concat([tail, chunk]);
      }
      if (!overflowed && head.length > OUTPUT_CAP) {
        overflowed = true;
        tail = head.subarray(HEAD_KEEP);
        head = head.subarray(0, HEAD_KEEP);
      }
      if (overflowed && tail.length > TAIL_KEEP) {
        tail = tail.subarray(tail.length - TAIL_KEEP);
      }
    };

    child.stdout.on("data", (d: Buffer) => append(d));
    child.stderr.on("data", (d: Buffer) => append(d));

    let settled = false;
    const finalize = (exitCode: number, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      let output = head.toString("utf8");
      if (overflowed) {
        output += `\n[output truncated]${tail.length > 0 ? "\n" + tail.toString("utf8") : ""}`;
      }
      if (timedOut) output += `\n[familiar: command timed out after ${timeoutMs}ms]`;
      resolve({ exitCode, output: output.trimEnd() || "(no output)" });
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }, 3000);
      } catch {
        /* already dead */
      }
      finalize(-1, true);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      settled = true;
      resolve({ exitCode: -1, output: `failed to spawn ${file}: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finalize(code ?? -1, false);
    });
  });
}
