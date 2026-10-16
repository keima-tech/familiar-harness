import { createBashTool } from "./bash.js";
import { createEditTool, createGlobTool, createGrepTool, createReadTool, createWriteTool } from "./fs-tools.js";
import { createWebFetchTool } from "./webfetch.js";
import { createWebSearchTool } from "./websearch.js";
import { createTodoTool } from "./todo.js";
import { createTaskTool } from "./task.js";
import { createToolRegistry, type ToolRegistry } from "./registry.js";

export * from "./registry.js";
export * from "./permissions.js";
export { createBashTool, resolveShellCommand } from "./bash.js";
export * from "./fs-tools.js";
export * from "./webfetch.js";
export * from "./websearch.js";
export * from "./todo.js";
export * from "./task.js";

/** M1 default toolset. */
export function defaultToolRegistry(): ToolRegistry {
  return createToolRegistry([
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
    createWebFetchTool(),
    createWebSearchTool(),
    createTodoTool(),
    createTaskTool(),
  ]);
}
