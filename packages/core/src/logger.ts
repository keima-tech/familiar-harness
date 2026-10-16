/** Minimal stderr logger. Honour FAMILIAR_DEBUG for verbose output. */

const debugEnabled = /^1|true$/i.test(process.env["FAMILIAR_DEBUG"] ?? "");

function write(level: string, args: unknown[]): void {
  const parts = args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a, null, 2) ?? String(a),
  );
  process.stderr.write(`[familiar] ${level}: ${parts.join(" ")}\n`);
}

export const log = {
  debug: (...args: unknown[]) => {
    if (debugEnabled) write("debug", args);
  },
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};
