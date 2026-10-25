/**
 * M6: `lsp_diagnostics` — run a configured language server on a file and
 * return its published diagnostics (errors / warnings / hints).
 * Read-only: usable in plan mode, needs no approval.
 */
import type { Tool, ToolOutput, ToolContext } from "./registry.js";
import { getLspHub, getSshLspHub, severityName, type LspRange } from "../lsp/index.js";
import type { ToolSchema } from "@familiar/protocol";

const SCHEMA: ToolSchema["parameters"] = {
  type: "object",
  properties: {
    path: { type: "string", description: "Source file to diagnose (relative to cwd or absolute)." },
  },
  required: ["path"],
};

function rangeText(range: LspRange | undefined): string {
  const line = range?.start?.line ?? 0;
  const ch = range?.start?.character ?? 0;
  return `${line + 1}:${ch + 1}`;
}

export function createLspTool(_cwdHint?: string): Tool {
  const tool: Tool = {
    name: "lsp_diagnostics",
    description:
      "Run a configured language server (LSP) on a source file and return its diagnostics " +
      "(type errors, syntax problems, warnings). Use this after editing code to catch issues " +
      "before finishing. Requires an lsp.servers entry in the config whose extensions cover the file. " +
      "Returns one line per diagnostic: `<file>:<line>:<col> [severity] message`.",
    parameters: SCHEMA,
    read_only: true,
    async execute(args, ctx: ToolContext): Promise<ToolOutput> {
      const p = String(args["path"] ?? "").trim();
      if (p === "") {
        return { content: "lsp_diagnostics: 'path' is required", isError: true };
      }
      // Proxy sessions spawn the language server on the ssh host over stdio;
      // local sessions keep the process-wide local hub.
      const hub =
        ctx.backend.kind === "ssh" && ctx.remote
          ? getSshLspHub(ctx.config, ctx.remote, ctx.backend)
          : getLspHub(ctx.config);
      if (!hub) {
        return {
          content:
            "no language servers configured — add an lsp.servers entry to ~/.familiar/config.yaml " +
            '(e.g. typescript: { command: typescript-language-server, args: ["--stdio"], extensions: [ts, tsx] })',
          isError: true,
        };
      }
      const bpath = ctx.backend.path;
      const abs = bpath.isAbsolute(p) ? bpath.normalize(p) : bpath.resolve(ctx.cwd, p);
      try {
        const result = await hub.diagnose(abs);
        const rel = bpath.relative(ctx.cwd, abs) || abs;
        if (result.timedOut && result.diagnostics === null) {
          return {
            content: `no diagnostics received from "${result.language}" within timeout (file may be clean, or the server publishes diagnostics only on demand)`,
          };
        }
        const lines = (result.diagnostics ?? []).map((d) => {
          const sev = severityName(d.severity);
          const code = d.code !== undefined ? ` (${d.code})` : "";
          return `${rel}:${rangeText(d.range)} [${sev}] ${d.message}${code}`;
        });
        const head = `${result.diagnostics?.length ?? 0} diagnostic(s) from ${result.language} (${result.server})`;
        return { content: [head, ...(lines.length > 0 ? lines : ["no diagnostics — file is clean ✓"])].join("\n") };
      } catch (err) {
        return { content: `lsp_diagnostics failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
  return tool;
}
