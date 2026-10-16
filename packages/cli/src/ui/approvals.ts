import readline from "node:readline";
import type { ApprovalAdapter, ApprovalRequest } from "@familiar/core";

/** Interactive y/n prompt for risky actions (CLI REPL mode). */
export class CliApprovalAdapter implements ApprovalAdapter {
  constructor(private readonly stdout: NodeJS.WriteStream = process.stdout) {}

  async request(req: ApprovalRequest): Promise<boolean> {
    if (process.stdin.destroyed || !process.stdout.isTTY) return false;
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
