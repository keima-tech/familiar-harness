import type {
  MemoryEntry,
  PendingWrite,
  SkillCatalogEntry,
} from "@familiar/protocol";

import type { MemoryStore } from "./memory/store.js";
import type { PendingMemoryStore } from "./memory/approval.js";
import type { SkillStore } from "./skills/store.js";
import type { PendingSkillStore } from "./skills/approval.js";
import type { Settings } from "./settings.js";

/**
 * Everything the self-improvement loop needs, constructed by the server
 * (or tests) and handed to the agent loop / tools through ToolContext.
 */
export interface SelfImproveContext {
  memories: MemoryStore;
  pendingMemories: PendingMemoryStore;
  skills: SkillStore;
  pendingSkills: PendingSkillStore;
  settings: Settings;
}

export type PendingMemoryItem = Required<MemoryEntry> & { pendingId?: string };

// Re-exported shapes used by RPC layer (keep protocol as source of truth).
export type { MemoryEntry, PendingWrite, SkillCatalogEntry };
