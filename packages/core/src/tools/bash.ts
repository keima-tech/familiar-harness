import type { Tool } from "./registry.js";
import { approveOrDeny } from "./permissions.js";
import { resolveShellCommand } from "../exec/index.js";

/** Windows-first shell resolution is re-exported for compatibility; the
 * actual execution goes through the session's ExecBackend (local or ssh). */
export { resolveShellCommand };
export type { ResolvedShellCommand } from "../exec/local.js";

const DEFAULT_TIMEOUT_MS = 30_000;

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
      const p = ctx.backend.path;
      let cwd = ctx.cwd;
      if (typeof args.cwd === "string" && args.cwd !== "") {
        cwd = p.isAbsolute(args.cwd) ? p.normalize(args.cwd) : p.resolve(ctx.cwd, args.cwd);
        const inside = cwd === ctx.cwd || cwd.startsWith(ctx.cwd.endsWith(p.sep) ? ctx.cwd : ctx.cwd + p.sep);
        if (!inside) {
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
        const why = outcome.reason ? ` (${outcome.reason})` : "";
        return {
          content: `[denied by user/policy]${why} ${command}`,
          isError: true,
        };
      }

      const result = await ctx.backend.exec(command, { cwd, timeoutMs });
      return { content: result.output, isError: result.exitCode !== 0 };
    },
  };
}
