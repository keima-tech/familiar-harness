import type { Tool, ToolContext } from "../../tools/registry.js";
import { slugifyName } from "./store.js";
import { lintSkillBody } from "./lint.js";

/** skill_view — lazy-load the full procedure of a catalogued skill. */
export function createSkillViewTool(): Tool {
  return {
    name: "skill_view",
    description:
      "Load the full procedure of a skill from the catalog (name + description only are in your prompt). " +
      "Call it whenever the task matches one of the listed skills, before acting on it.",
    read_only: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the catalog", minLength: 1 },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const si = ctx.selfImprove;
      if (!si) return { content: "skill store unavailable in this context", isError: true };
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return { content: "argument 'name' is required", isError: true };
      const skill = si.skills.view(name);
      if (!skill) {
        const known = si.skills.list().map((s) => s.name).join(", ");
        return { content: `skill not found: ${name} (catalog: ${known || "empty"})`, isError: true };
      }
      const warns = skill.warnings.length > 0 ? `\n[lint warns] ${skill.warnings.join("; ")}` : "";
      return {
        content: `# ${skill.name}\n\n${skill.body}${warns}`,
        isError: false,
      };
    },
  };
}

/** skill_manage — create or maintain SKILL.md files (staged by default). */
export function createSkillManageTool(): Tool {
  return {
    name: "skill_manage",
    description:
      "Create or maintain reusable skills (procedures, SKILL.md + optional scripts/references). " +
      "Writes are staged for user approval by default. Rules: lessons, not logs; one skill = one repeatable procedure; the description must make the catalog self-explanatory.",
    read_only: false,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "edit", "list", "remove"],
          description: "create: new SKILL.md / edit: replace body+description / remove: archive / list: show catalog",
        },
        name: { type: "string", description: "skill name (kebab-case; auto-slugified)" },
        description: { type: "string", description: "one-line description for the catalog" },
        body: { type: "string", description: "SKILL.md body (markdown procedure); a scaffold is generated when omitted on create" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const si = ctx.selfImprove;
      if (!si) return { content: "skill store unavailable in this context", isError: true };
      const action = String(args.action);
      const approvalOn =
        si.settings.get("skills_write_approval") ?? ctx.config?.skills?.write_approval !== false;

      if (action === "list") {
        const catalog = si.skills.list();
        const pending = si.pendingSkills.count();
        const lines = catalog.map(
          (s) =>
            `- ${s.name}: ${s.description} (used ${s.useCount}x${s.lastUsedAt ? `, last ${new Date(s.lastUsedAt).toISOString().slice(0, 10)}` : ""})`,
        );
        return {
          content: `${catalog.length} skills, ${pending} staged for approval\n${lines.join("\n") || "(none — create one with skill_manage)"}`,
          isError: false,
        };
      }

      const rawName = typeof args.name === "string" ? args.name.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";

      if (action === "create" || action === "edit") {
        const name = slugifyName(rawName);
        if (!name) {
          return { content: `invalid skill name: ${rawName || "(empty)"} (use kebab-case)`, isError: true };
        }
        const body = typeof args.body === "string" && args.body.trim() !== "" ? args.body : scaffoldBody(name);

        if (action === "edit") {
          const existing = si.skills.get(name);
          if (!existing) return { content: `skill not found: ${name}`, isError: true };
          const finalDesc = description || existing.description;
          if (approvalOn) {
            const { id } = si.pendingSkills.stage({
              name,
              kind: "patch",
              description: finalDesc,
              body,
              snapshotBodyHash: si.skills.bodyHash(name),
              reason: `staged by agent (${ctx.sessionId.slice(0, 8)})`,
              warnings: lintSkillBody({ body }),
            });
            return { content: `staged for approval (#${id}, kind=patch ${name}).`, isError: false };
          }
          const { warnings } = si.skills.write(name, finalDesc, body);
          return { content: `edited skill ${name}${warnPrefix(warnings)}`, isError: false };
        }

        // create
        if (si.skills.get(name)) {
          return { content: `skill ${name} already exists (use action=edit)`, isError: true };
        }
        if (!description) {
          return { content: "argument 'description' is required for create", isError: true };
        }
        if (approvalOn) {
          const { id } = si.pendingSkills.stage({
            name,
            kind: "create",
            description,
            body,
            reason: `staged by agent (${ctx.sessionId.slice(0, 8)})`,
            warnings: lintSkillBody({ body }),
          });
          return { content: `staged for approval (#${id}, kind=create ${name}).`, isError: false };
        }
        const { warnings } = si.skills.write(name, description, body);
        return { content: `created skill ${name}${warnPrefix(warnings)}`, isError: false };
      }

      if (action === "remove") {
        const name = slugifyName(rawName);
        const existing = name ? si.skills.get(name) : undefined;
        if (!existing) return { content: `skill not found: ${rawName}`, isError: true };
        if (approvalOn) {
          const { id } = si.pendingSkills.stage({
            name: existing.name,
            kind: "remove",
            snapshotBodyHash: si.skills.bodyHash(existing.name),
            reason: `staged by agent (${ctx.sessionId.slice(0, 8)})`,
          });
          return {
            content: `staged for approval (#${id}, kind=remove ${existing.name}; archives the directory)`,
            isError: false,
          };
        }
        const ok = si.skills.archive(existing.name);
        return { content: ok ? `archived ${existing.name}` : "not found", isError: !ok };
      }

      return { content: `unknown action: ${action} (create|edit|list|remove)`, isError: true };
    },
  };
}

function scaffoldBody(name: string): string {
  return (
    `# ${name}\n\n` +
    "## When to use\n\n(describe the trigger situation precisely)\n\n" +
    "## Procedure\n\n1. ...\n\n## Why this works\n\n(one sentence)\n"
  );
}

function warnPrefix(warnings: string[]): string {
  return warnings.length > 0 ? ` (warns: ${warnings.join("; ")})` : "";
}
