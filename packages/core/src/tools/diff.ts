/**
 * Minimal line diff (LCS) for the GUI tool cards. Produces unified-diff-style
 * hunks with limited context. Large inputs degrade to a plain "-old/+new"
 * pair so a huge rewrite can never produce a giant payload.
 */

interface DiffOptions {
  /** context lines around each hunk */
  context?: number;
  /** hard cap on emitted diff lines (0 = unlimited) */
  maxLines?: number;
}

interface LineOp {
  kind: " " | "-" | "+";
  text: string;
}

/** Longest-common-subsequence line diff. Inputs must not contain \r. */
function lineOps(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:] — bounded: caller caps input size
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", text: a[i++]! });
  while (j < m) ops.push({ kind: "+", text: b[j++]! });
  return ops;
}

/** Convert a plain "-old/+new" pair (no context) into diff text. */
export function simplePairDiff(oldText: string, newText: string): string {
  const lines = (s: string) => s.split("\n");
  const out: string[] = [];
  for (const l of lines(oldText)) out.push(`-${l}`);
  for (const l of lines(newText)) out.push(`+${l}`);
  return out.join("\n");
}

/**
 * Unified-style diff text. Returns "" when the texts are equal.
 * Falls back to simplePairDiff beyond ~2500 lines to stay cheap.
 */
export function unifiedDiff(before: string, after: string, opts: DiffOptions = {}): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 120;
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length + b.length > 5_000) {
    return simplePairDiff(before, after);
  }
  const ops = lineOps(a, b);
  // mark lines that belong to a change (non-context op) plus context window
  const keep = new Array<boolean>(ops.length).fill(false) as boolean[];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.kind !== " ") {
      for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
        keep[c] = true;
      }
    }
  }
  const out: string[] = ["@@"];
  let emitted = 0;
  let truncated = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) continue;
    if (maxLines > 0 && emitted >= maxLines) {
      truncated = true;
      break;
    }
    out.push(`${ops[k]!.kind}${ops[k]!.text}`);
    emitted++;
  }
  if (truncated) out.push("… (diff truncated)");
  return out.join("\n");
}
