import type { BashPermissionConfig } from "../config.js";

/** Request presented to the human (or auto-adapter) before a risky action. */
export interface ApprovalRequest {
  tool: string;
  /** One-line human readable summary, e.g. `bash: git push origin main` */
  summary: string;
  /** Additional detail for a confirmation dialog (optional). */
  detail?: string;
}

export interface ApprovalAdapter {
  request(req: ApprovalRequest): Promise<boolean>;
}

/** Always allow (used by --yolo). Never used silently in non-interactive mode. */
export class AllowAllApprovalAdapter implements ApprovalAdapter {
  async request(): Promise<boolean> {
    return true;
  }
}

/** Deny by default (headless runs without --yolo). */
export class DenyApprovalAdapter implements ApprovalAdapter {
  async request(): Promise<boolean> {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command policy for the bash tool
// ---------------------------------------------------------------------------

export type CommandDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "ask" };

function buildRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

const REGEX_META = /[\\^$.*+?()[\]{}|]/;

function matchesAny(command: string, patterns: string[]): boolean {
  for (const p of patterns) {
    // documented as "prefix match OR regular expression"
    if (command.startsWith(p)) return true;
    if (REGEX_META.test(p)) {
      const re = buildRegex(p);
      if (re && re.test(command)) return true;
    }
  }
  return false;
}

/**
 * bash command policy. Deny wins over allow; anything unmatched wants a human.
 */
export function commandDecision(
  command: string,
  cfg: BashPermissionConfig,
): CommandDecision {
  if (matchesAny(command, cfg.deny)) {
    return { action: "deny", reason: "command matches deny pattern" };
  }
  if (matchesAny(command, cfg.allow)) return { action: "allow" };
  return { action: "ask" };
}

export interface ApprovalOutcome {
  approved: boolean;
  via: "policy-allow" | "policy-deny" | "yolo" | "adapter";
}

/** Shared gate: policy → yolo → human adapter. */
export async function approveOrDeny(
  tool: string,
  request: ApprovalRequest,
  opts: { command: string; bashCfg?: BashPermissionConfig; yolo: boolean; approval: ApprovalAdapter },
): Promise<ApprovalOutcome> {
  if (opts.bashCfg) {
    const decision = commandDecision(opts.command, opts.bashCfg);
    if (decision.action === "allow") return { approved: true, via: "policy-allow" };
    if (decision.action === "deny") return { approved: false, via: "policy-deny" };
  }
  if (opts.yolo) return { approved: true, via: "yolo" };
  const approved = await opts.approval.request(request);
  return { approved, via: "adapter" };
}
