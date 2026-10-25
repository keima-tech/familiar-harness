import type { ToolSchema } from "@familiar/protocol";
import type { ResolvedConfig } from "../config.js";
import type { ExecBackend } from "../exec/index.js";
import type { ApprovalAdapter } from "./permissions.js";

export interface ToolContext {
  sessionId: string;
  cwd: string;
  /** Where files/commands actually live: this machine or an ssh host. */
  backend: ExecBackend;
  yolo: boolean;
  config: ResolvedConfig;
  approval: ApprovalAdapter;
  /** M2: session todo store (absent in bare CLI contexts / subagents without one) */
  todos?: import("@familiar/protocol").TodoStore;
  /** M2: run a subagent task and return its final text (server-injected) */
  taskRunner?: (args: {
    description: string;
    prompt: string;
    sessionId: string;
    yolo: boolean;
  }) => Promise<string>;
  /** M3: self-improvement stores; absent → memory/skill tools self-disable */
  selfImprove?: import("../selfimprove/context.js").SelfImproveContext;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
  /** Optional unified-diff text (edit/write) shown as a colored block in the GUI. */
  diff?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolSchema["parameters"];
  /** Read-only tools are available in plan mode (M2). */
  read_only?: boolean;
  /** All approval logic lives inside execute() (single approval path per tool). */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}

/** Minimal JSON-Schema- subset validation (type/required/enum/minLength). */
export function validateToolArgs(
  schema: ToolSchema["parameters"],
  args: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  // Leniency for small models: coerce numeric/boolean args that arrive as strings.
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) continue;
    if (typeof value === "string") {
      if ((prop.type === "number" || prop.type === "integer") && value.trim() !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) args[key] = n;
      } else if (prop.type === "boolean") {
        if (value === "true") args[key] = true;
        else if (value === "false") args[key] = false;
      }
    }
  }
  const required = schema.required ?? [];
  const errors: string[] = [];
  for (const key of required) {
    if (args[key] === undefined) errors.push(`missing required argument: ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) continue; // unknown extra args are tolerated
    const t = prop.type;
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const ok =
      (t === "string" && actual === "string") ||
      (t === "number" && actual === "number") ||
      (t === "integer" && actual === "number" && Number.isInteger(value)) ||
      (t === "boolean" && actual === "boolean") ||
      (t === "array" && actual === "array") ||
      (t === "object" && actual === "object" && value !== null);
    if (!ok) {
      errors.push(`argument "${key}" must be ${t} (got ${actual})`);
      continue;
    }
    if (prop.type === "string" && typeof value === "string") {
      if (prop.minLength !== undefined && value.length < prop.minLength) {
        errors.push(`argument "${key}" too short (minLength ${prop.minLength})`);
      }
    }
    if (prop.enum && !prop.enum.includes(value as string | number)) {
      errors.push(`argument "${key}" must be one of: ${prop.enum.join(", ")}`);
    }
  }
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true };
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return reg;
}
