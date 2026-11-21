<div align="center">

# Familiar Harness

A self-hosted coding agent: one core engine, a terminal UI, a web UI and a desktop app.
**MIT** · Node.js 24+ · Linux / Windows / macOS

[日本語版はこちら / Japanese](README.ja.md)

</div>

---

## What it is

Familiar runs a model in a tool loop — read/write/edit, bash, glob/grep, MCP servers,
sub-agents — and keeps every session in SQLite. `familiar serve` exposes that core as
a daemon (JSON-RPC over HTTP + WebSocket); the TUI, the browser UI and the desktop
app are clients of it, so a session opened in one is visible in the others.

After each turn a second agent reviews what happened and proposes durable lessons.
Proposals are staged and only take effect when you approve them.

## Quick start

Requires Node.js 24+.

```bash
# Linux / macOS
curl -fsSL https://github.com/keima-tech/familiar-harness/raw/main/install.sh | sh
```

```bash
familiar            # full-screen TUI
familiar run -p "List the TODOs in this repo"
familiar serve      # web UI + JSON-RPC on http://127.0.0.1:46210
familiar demo       # offline walkthrough of the self-improvement loop, no API key
```

With no API keys configured, Familiar uses the first provider it can actually call —
by default a keyless local endpoint (Ollama, a LAN LLM server). Pin a provider and
model in `~/.familiar/config.yaml`.

Inside the TUI: `Ctrl+P` command palette, `/models` provider/model picker, `Tab`
plan/build, `Esc` stop a running turn, `/help` for everything else.

## The self-improvement loop

1. A turn finishes.
2. A reviewer agent reads it and proposes a **memory** (a fact worth loading every
   time) or a **skill** (a procedure worth loading on demand).
3. The proposal is staged — `familiar memory pending`, `familiar skills pending` — and is
   applied only after `familiar memory approve <id>` / `familiar skills approve <id>`.
4. The next turn's prompt carries the approved memory; skills load when a task
   matches their description.

A curator moves unused skills through `active → stale → archived`, appends every
mutation to a ledger, and snapshots the skill tree before a consolidation pass
(`familiar curator rollback <id>`). `familiar demo` runs this whole loop offline against
a throw-away home directory.

## Features

- **Approvals.** Risky tool calls go through an approval adapter; `--plan` limits a
  run to read-only tools; commands that could wipe the machine are refused outright.
- **Providers.** OpenAI-compatible APIs (OpenAI, OpenRouter, NVIDIA, vLLM,
  llama.cpp …), Anthropic, and keyless local endpoints.
- **Frontends.** Full-screen TUI; web UI with session list, model pickers, diff
  cards, permission modes, context gauge and file preview (images, audio, video,
  PDF, Markdown, CSV/JSON, Word/Excel/PowerPoint); Electron app as deb / AppImage /
  NSIS.
- **Remote machines.** An SSH proxy runs bash and file tools on a host without
  installing anything there, MCP servers and language servers included; or start
  the daemon on that host and point the app at it.
- **Context and cost.** Per-turn token composition, estimated USD cost, a token
  budget guard, and large tool results compressed behind handles.
- **Office documents.** Word / Excel / PowerPoint generation with no extra
  dependencies.
- **Small surface.** `yaml` + `ws`, storage on Node's built-in `node:sqlite`, no
  native modules.

## Install

### Installer (Linux / macOS)

```bash
curl -fsSL https://github.com/keima-tech/familiar-harness/raw/main/install.sh | sh
```

Installs to `~/.local/lib/familiar` with a symlink at `~/.local/bin/familiar`
(`FAMILIAR_INSTALL_DIR` / `FAMILIAR_BIN_DIR` override both). A specific version:
`curl … | sh -s -- 0.1.0`.

### From source (any platform)

```bash
git clone https://github.com/keima-tech/familiar-harness.git
cd familiar-harness
npm install
npm run build
cd packages/cli && npm link   # puts `familiar` on your PATH
```

On Windows, use the source install or the desktop installer below.

### Desktop app

Ready-made binaries are attached to each
[release](https://github.com/keima-tech/familiar-harness/releases):
`familiar-<version>-linux-amd64.deb`, `familiar-<version>-linux-x86_64.AppImage`,
`familiar-<version>-win-x64.exe` (NSIS) and `familiar-<version>-win-x64-portable.exe`.

```bash
npm run -w packages/desktop pack:linux   # deb + AppImage
npm run -w packages/desktop pack:win     # NSIS (needs wine when cross-built on Linux)
```

### Updating and uninstalling

`familiar update` fetches the newest release tarball and swaps it in place
(`--check` for a dry run; it reads GitHub Releases, falling back to the project's
Forgejo instance while GitHub is unpublished). From a checkout:
`git pull && npm run build`.

```bash
# uninstall an installer-based install
systemctl --user disable --now familiar-serve 2>/dev/null
rm -f ~/.config/systemd/user/familiar-serve.service && systemctl --user daemon-reload
rm -rf ~/.local/lib/familiar ~/.local/bin/familiar
rm -rf ~/.familiar      # optional: config, sessions, memory/skills, stored keys
```

Desktop: delete the AppImage / portable exe, or uninstall via your package manager.

## Configuration

`~/.familiar/config.yaml` holds providers, defaults and server settings:

```yaml
version: 1
default_provider: openai
default_model: gpt-6.1-sol

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }      # tokens never go in this file
    default_model: gpt-6.1-sol
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: { env: none }
    default_model: qwen2.5-coder:3b
```

- Secrets resolve as `api_key` → `api_key_file` → `env`. Keys entered in the GUI are
  stored in `~/.familiar/secrets/<provider>.key` (0600) and referenced by file.
- Bash runs without a prompt unless a command looks destructive or leaks data
  (`permissions.bash.ask`); machine-wiping commands are blocked regardless of mode.
- Remote hosts, SSH proxy / familiar-server modes, tunnels and tokens are covered in
  [docs/spec/05-config.md](docs/spec/05-config.md).

## Docs

| | |
|---|---|
| [overview](docs/spec/00-overview.md) | scope and goals |
| [architecture](docs/spec/01-architecture.md) | packages, turn flow, persistence |
| [protocol](docs/spec/02-protocol.md) | JSON-RPC methods and events |
| [tools](docs/spec/03-tools.md) | tool set and approval rules |
| [self-improvement](docs/spec/04-self-improvement.md) | memory, skills, curator |
| [config](docs/spec/05-config.md) | configuration reference |
| [comparison](docs/comparison.md) | how it differs from other harnesses (dated) |
| [roadmap](docs/spec/06-roadmap.md) | implementation history and notes |

The specs are written in Japanese; the code and CLI are in English.

## Development

```bash
npm install
npm run build       # tsc -b (project references)
npm run typecheck
npm run smoke       # headless end-to-end with a mock provider, no network
npm run mdtest      # markdown renderer fixtures
```

`familiar serve` keeps running the built `packages/*/dist`; restart it after code
changes (the static web assets reload on their own).

Maintainers: `scripts/release.sh --publish` builds the tarball and desktop
installers and publishes them to Forgejo; with `GITHUB_TOKEN` (or `--github`)
the same assets are mirrored to GitHub Releases.

## License

[MIT](LICENSE)
