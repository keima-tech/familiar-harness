import { createBashTool } from "./bash.js";
import {
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  createZipListTool,
  createZipReadTool,
} from "./fs-tools.js";
import { createWebFetchTool } from "./webfetch.js";
import { createWebSearchTool } from "./websearch.js";
import { createConnectorTools } from "./connectors.js";
import { createTodoTool } from "./todo.js";
import { createTaskTool } from "./task.js";
import { createLspTool } from "./lsp.js";
import { createOfficeCreateTool } from "./office.js";
import { createMemoryManageTool } from "../selfimprove/memory/tool.js";
import { createSkillManageTool, createSkillViewTool } from "../selfimprove/skills/tool.js";
import { createResultReadTool, createResultSearchTool } from "./tool-results.js";
import { createToolRegistry, type ToolRegistry } from "./registry.js";

export * from "./registry.js";
export * from "./permissions.js";
export { createBashTool, resolveShellCommand } from "./bash.js";
export * from "./fs-tools.js";
export * from "./zip-read.js";
export * from "./webfetch.js";
export * from "./websearch.js";
export * from "./connectors.js";
export * from "./todo.js";
export * from "./task.js";
export * from "./lsp.js";
export * from "./office.js";
export * from "./office-templates.js";
export * from "./zip.js";
export * from "./ooxml-read.js";

/** Tool names managed by the self-improvement loop (M3). */
export const SELF_IMPROVE_TOOLS = ["memory_manage", "skill_view", "skill_manage"] as const;

/** M1+M2+M3 default toolset + M6 LSP diagnostics. */
export function defaultToolRegistry(): ToolRegistry {
  return createToolRegistry([
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createOfficeCreateTool(),
    createGlobTool(),
    createGrepTool(),
    createZipListTool(),
    createZipReadTool(),
    createBashTool(),
    createWebFetchTool(),
    createWebSearchTool(),
    ...createConnectorTools(),
    createTodoTool(),
    createTaskTool(),
    createLspTool(),
    createMemoryManageTool(),
    createSkillViewTool(),
    createSkillManageTool(),
    createResultReadTool(),
    createResultSearchTool(),
  ]);
}
