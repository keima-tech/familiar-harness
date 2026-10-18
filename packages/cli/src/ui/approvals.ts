import readline from "node:readline";
import type { ApprovalAdapter, ApprovalRequest } from "@familiar/core";

/** Interactive y/n prompt for risky actions (CLI REPL mode). */
export class CliApprovalAdapter implements ApprovalAdapter {
  constructor(private readonly stdout: NodeJS.WriteStream = process.stdout) {}

  async request(req: ApprovalRequest): Promise<boolean> {    if (process.stdin.destroyed || !process.stdout.isTTY) return false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "",
      terminal: true,
    });
    const answer = await new Promise<string>((resolve) => {
      this.write(`\napprove ${req.tool}: ${req.summary}? [y/N] `);
      rl.question("", (input) => {
        resolve(input.trim().toLowerCase());
      });
      // EOF (ctrl-d) resolves with ""
      rl.on("close", () => resolve(""));
    });
    rl.close();
    this.write("\n");
    return answer === "y" || answer === "yes";
  }

  private write(s: string): void {
    this.stdout.write(s);
  }
}

/**
 * Full-screen-TUI adapter: surface the request in the prompt panel and wait
 * for y/N keys (the readline prompt used by the line CLI would fight the
 * alt-screen TUI over stdin and wedge the transcript).
 */
export class TuiApprovalAdapter implements ApprovalAdapter {
  constructor(private readonly push: (req: { tool: string; summary: string }) => Promise<boolean>) {}

  async request(req: ApprovalRequest): Promise<boolean> {
    if (process.stdin.destroyed || !process.stdout.isTTY) return false;
    return this.push({ tool: req.tool, summary: req.summary });
  }
}
