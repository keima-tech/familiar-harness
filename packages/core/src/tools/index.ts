import { createBashTool } from "./bash.js";
import { createEditTool, createGlobTool, createGrepTool, createReadTool, createWriteTool } from "./fs-tools.js";
import { createToolRegistry, type ToolRegistry } from "./registry.js";

export * from "./registry.js";
export * from "./permissions.js";
export { createBashTool, resolveShellCommand } from "./bash.js";
export * from "./fs-tools.js";

/** M1 default toolset. */
export function defaultToolRegistry(): ToolRegistry {
  return createToolRegistry([
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
  ]);
}
