import crypto from "node:crypto";
import type { ApprovalAdapter, ApprovalRequest } from "@familiar/core";

/**
 * Approval bridge for serve mode (M2):
 *  - request() → broadcast `permission.request`, await UI, timeout = deny
 *  - respond() → called via the `permission.respond` RPC method
 */
export class RpcApprovalAdapter implements ApprovalAdapter {
  private readonly pending = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly broadcast: (event: unknown) => void,
    private readonly timeoutMs = 300_000,
  ) {}

  request(req: ApprovalRequest): Promise<boolean> {
    if (this.pending.size >= 50) {
      return Promise.resolve(false); // flood guard: deny rather than queue forever
    }
    const requestId = crypto.randomUUID();
    this.broadcast({
      type: "permission.request",
      requestId,
      tool: req.tool,
      summary: req.summary,
      detail: req.detail,
    });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false); // safe default
      }, this.timeoutMs);
      timer.unref?.(); // do not hold the event loop open for a pending prompt
      this.pending.set(requestId, { resolve, timer });
    });
  }

  respond(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer); // or the 300s timer outlives the resolved prompt
    entry.resolve(approved);
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
