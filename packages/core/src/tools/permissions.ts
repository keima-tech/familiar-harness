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
  | { action: "ask"; reason?: string };

function buildRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

const REGEX_META = /[\\^$.*+?()[\]{}|]/;

/** First pattern that matches (documented as "prefix match OR regex"), if any. */
function firstMatch(command: string, patterns: string[] | undefined): string | null {
  for (const p of patterns ?? []) {
    if (command.startsWith(p)) return p;
    if (REGEX_META.test(p)) {
      const re = buildRegex(p);
      if (re && re.test(command)) return p;
    }
  }
  return null;
}

function matchesAny(command: string, patterns: string[] | undefined): boolean {
  return firstMatch(command, patterns) !== null;
}

/**
 * bash command policy. `deny` is a hard block (never approvable), `ask` needs
 * the human, and `mode` decides what happens to everything else: "allow"
 * (default) runs it, "ask" keeps the legacy every-command-needs-approval
 * behavior.
 */
export function commandDecision(
  command: string,
  cfg: BashPermissionConfig,
): CommandDecision {
  const denied = firstMatch(command, cfg.deny);
  if (denied !== null) {
    return { action: "deny", reason: `blocked by permissions.bash.deny: ${denied}` };
  }
  const risky = firstMatch(command, cfg.ask);
  if (risky !== null) {
    return { action: "ask", reason: `needs approval (risky pattern: ${risky})` };
  }
  if (matchesAny(command, cfg.allow)) return { action: "allow" };
  return cfg.mode === "ask"
    ? { action: "ask", reason: "needs approval (permissions.bash.mode: ask)" }
    : { action: "allow" };
}

export interface ApprovalOutcome {
  approved: boolean;
  via: "policy-allow" | "policy-deny" | "yolo" | "adapter";
  /** why the policy decided this (deny reason / risky pattern) */
  reason?: string;
}

/** Shared gate: policy → yolo → human adapter. */
export async function approveOrDeny(
  tool: string,
  request: ApprovalRequest,
  opts: { command: string; bashCfg?: BashPermissionConfig; yolo: boolean; approval: ApprovalAdapter },
): Promise<ApprovalOutcome> {
  let askRequest = request;
  if (opts.bashCfg) {
    const decision = commandDecision(opts.command, opts.bashCfg);
    if (decision.action === "allow") return { approved: true, via: "policy-allow" };
    if (decision.action === "deny") {
      return { approved: false, via: "policy-deny", reason: decision.reason };
    }
    // tell the human *why* this one is being asked
    if (decision.reason !== undefined && request.detail === undefined) {
      askRequest = { ...request, detail: decision.reason };
    }
  }
  if (opts.yolo) return { approved: true, via: "yolo" };
  const approved = await opts.approval.request(askRequest);
  return { approved, via: "adapter" };
}
