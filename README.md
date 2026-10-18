# Familiar

A client/server agent harness with a terminal UI, a Web UI and a desktop app sharing one core engine.
Inspired by OpenCode, HermEs Agent and Claude Code — **MIT licensed**, runs on Node.js 24+ (Linux / Windows / macOS).

日本語の README は [README.ja.md](README.ja.md) にあります。

## Highlights

- **Client/server separation** — `familiar serve` runs the agent core as a daemon (JSON-RPC over HTTP + WebSocket); the CLI, Web UI and desktop app are thin clients. A CLI started while `serve` is alive attaches to it automatically.
- **Provider abstraction** — OpenAI-compatible APIs (OpenAI / OpenRouter / NVIDIA / vLLM / llama.cpp …), Anthropic, and keyless local endpoints (Ollama, LAN servers). If the configured default provider has no credentials, Familiar falls back to the first usable one automatically.
- **OpenCode-style TUI** — splash + frameless layout, `/models` and `/sessions` pickers, bracketed paste, CJK-IME friendly caret, in-TUI tool approvals (`y/N`), Esc to stop a turn, tok/s readouts.
- **Web UI** — served by `familiar serve` (default `http://127.0.0.1:46210`): sessions, provider/model pickers, context gauge, tok/s, diff cards.
- **Agent toolset** — read/write/edit, glob/grep, bash, webfetch/websearch, todos, sub-agent `task` (parallel), git worktrees, MCP servers (stdio, hot-loaded).
- **Self-improvement loop** — persistent memory, `SKILL.md` procedures with a curator (usage stats, staleness, archival), background self-review, and staged writes with human approval.
- **Safety** — every risky tool call goes through an approval adapter; `plan` mode restricts tools to read-only; secrets live in env vars or `~/.familiar/secrets/*.key`, never in config files.
- **Windows + Linux** first-class (paths, shell resolution, PowerShell support); desktop installers via electron-builder (deb / AppImage / NSIS).

## Install

Requirements: **Node.js ≥ 24** (`node --version` to check).

**Linux / macOS — one-liner** (downloads the latest release tarball, no npm needed):

```bash
curl -fsSL https://example.invalid:3000/owner/familiar-harness/raw/branch/main/install.sh | sh
```

- Installs to `~/.local/lib/familiar` and symlinks `~/.local/bin/familiar` (both overridable via `FAMILIAR_INSTALL_DIR` / `FAMILIAR_BIN_DIR`).
- The installer reads the Forgejo instance from `FAMILIAR_FORGEJO` (default `https://example.invalid:3000`) and repo from `FAMILIAR_REPO` (default `owner/familiar-harness`).
- A specific version: pass it as the first argument (`install.sh 0.1.0` when piping, e.g. `curl ... | sh -s -- 0.1.0`).

**From source (any platform):**

```bash
git clone https://example.invalid:3000/owner/familiar-harness.git
cd familiar-harness
npm install
npm run build
cd packages/cli && npm link   # puts `familiar` on your PATH
```

**Desktop app (Electron):**

```bash
npm run -w packages/desktop pack:linux   # deb + AppImage
npm run -w packages/desktop pack:win     # NSIS (run on Windows)
```

## Quick start

```bash
# full-screen TUI (opencode-style)
familiar chat

# one-shot, headless
familiar run -p "List the TODOs in this repo"

# plan mode (read-only tools)
familiar run -p "Draft an implementation plan for feature X" --plan

# pick a provider/model explicitly
familiar run -p "hi" --provider ollama --model qwen2.5-coder:3b

# Web UI + API daemon (http://127.0.0.1:46210)
familiar serve
```

In the TUI: `Ctrl+P` opens the command palette, `/models` picks provider/model, `Tab` toggles Build/Plan, `Esc` stops a running turn, `/help` lists everything.

With no API keys configured, Familiar automatically defaults to the first provider that can actually be called — a keyless local endpoint (Ollama, LAN LLM server) — so `familiar chat` works out of the box with a local model. Set `default_provider` in the config to pin it.

## Configuration

`~/.familiar/config.yaml` — providers, defaults, server settings:

```yaml
version: 1

# Optional: pin the default. When omitted, Familiar picks the first provider
# that can actually be called (key present, or keyless local endpoint).
default_provider: openai
default_model: gpt-5.2

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }      # never put tokens in this file
    default_model: gpt-5.2
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: { env: none }
    default_model: qwen2.5-coder:3b
```

- Secrets resolve as `api_key` → `api_key_file` → `env`; API keys set through the GUI are stored as `~/.familiar/secrets/<provider>.key` (0600) and referenced by file.
- `stream_options: false` on a provider disables the `include_usage` request (some compat servers reject it; Familiar retries without it automatically).
- Full reference: [docs/spec/05-config.md](docs/spec/05-config.md).

## Remote access

`familiar serve` binds to `127.0.0.1` by default — no port forwarding needed on your router. From another machine use an SSH tunnel:

```bash
ssh -L 46210:127.0.0.1:46210 user@server
# then open http://localhost:46210 locally
```

For LAN-only exposure use `familiar serve --bind 0.0.0.0` **together with** token auth (`familiar token --write`); put a TLS reverse proxy in front for anything public.

## Architecture

```
packages/
  protocol/   shared RPC + event/data types
  core/       agent loop, tools, providers, session store (UI-agnostic)
  server/     JSON-RPC over HTTP+WebSocket daemon + static Web UI
  cli/        familiar command (TUI, REPL, headless run, serve)
  desktop/    Electron shell for the same core
docs/spec/    detailed specs (architecture, protocol, tools, config, roadmap)
```

## Development

```bash
npm install
npm run build       # tsc -b (project references)
npm run typecheck
npm run smoke       # headless end-to-end with a mock provider (no network)
npm run mdtest      # markdown renderer fixtures
```

`familiar serve` keeps running the built `packages/*/dist` — restart it after code changes (static Web UI assets reload without a restart).

## Releasing (maintainers)

```bash
scripts/release.sh              # build + pack familiar-vX.Y.Z.tar.gz (dry run)
FORGEJO_TOKEN=... scripts/release.sh --publish   # create the release + upload
```

## License

[MIT](LICENSE)
