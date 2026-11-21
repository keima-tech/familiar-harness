# How Familiar compares

Checked against the vendors' own documentation on **2026-11-21**. This page is
about defaults and built-in capability, not about which agent is "best".

| | Familiar | Claude Code | Codex CLI | opencode | Hermes Agent |
|---|:--:|:--:|:--:|:--:|:--:|
| Memory/skills written by the agent, **approval by default** | **yes** | no (auto-memory saves silently) | manual only (`AGENTS.md`) | — | opt-in (`write_approval`) |
| Skill curation with ledger + snapshots | **yes** | — | — | — | yes |
| Shared daemon, several frontends | yes | yes | yes | yes | yes |
| Remote run with nothing installed remotely | **built in** | run the CLI there | cloud only | third-party plugin | — |
| Core size | `yaml`, `ws`, `node:sqlite` | closed source | Rust monorepo | large Bun app | large Python app |

## Where Familiar is behind

- **No OS-enforced sandbox.** Codex CLI ships one by default; Familiar relies on the
  approval flow and `plan` mode.
- **No managed cloud execution.** Claude Code, Codex and Cursor can run a session
  in their own sandbox; Familiar's SSH mode is your machine talking to your machine.
- **Smaller extension surface.** MCP, `SKILL.md` and hooks — no plugin marketplace
  or skills hub.

## Sources

- Claude Code: [memory](https://code.claude.com/docs/en/memory),
  [permissions](https://code.claude.com/docs/en/permissions/),
  [features](https://code.claude.com/docs/en/features-overview), and the open
  requests for an auto-memory adjudication step
  ([#38118](https://github.com/anthropics/claude-code/issues/38118),
  [#78398](https://github.com/anthropics/claude-code/issues/78398)).
- Codex CLI: [sandboxing](https://learn.chatgpt.com/docs/sandboxing),
  [approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).
- opencode: [CLI / shared background server](https://opencode.ai/docs/cli/),
  [web UI](https://opencode.ai/docs/cli/web/).
- Hermes Agent: [curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator).
