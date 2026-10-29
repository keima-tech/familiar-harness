<div align="center">

# Familiar Harness

A client/server agent harness with a full-screen terminal UI, a Web UI and a desktop app sharing one core engine.
**MIT licensed**, runs on Node.js 24+ (Linux / Windows / macOS).

[日本語版はこちら / Japanese README](README.ja.md)

</div>

---

## Familiar Harness

### What is Familiar Harness?

`familiar serve` runs the agent core as a daemon (JSON-RPC over HTTP + WebSocket). The CLI with its full-screen TUI, the Web UI, and the Electron desktop app are all thin clients of that same core — start a CLI while `serve` is alive and it attaches to it automatically.

### Highlights

- **Client/server separation** — one core engine, three frontends; sessions persist server-side in SQLite.
- **Provider abstraction** — OpenAI-compatible APIs (OpenAI / OpenRouter / NVIDIA / vLLM / llama.cpp …), Anthropic, and keyless local endpoints (Ollama, LAN LLM servers). If the configured default provider has no credentials, Familiar falls back to the first usable one automatically, so `familiar chat` works out of the box with a local model.
- **Full-screen TUI** — splash + frameless layout, `/models` and `/sessions` pickers, bracketed paste, CJK-IME friendly caret, in-TUI tool approvals (`y/N`), Esc to stop a turn, tok/s readouts, context sizes per model.
- **Web UI** — served by `familiar serve` (default `http://127.0.0.1:46210`): sessions, provider/model pickers, context gauge, tok/s, diff cards, settings.
- **Agent toolset** — read/write/edit, glob/grep, bash, webfetch/websearch, todos, sub-agent `task` (parallel), git worktrees, MCP servers (stdio, hot-loaded).
- **Self-improvement loop** — persistent memory, `SKILL.md` procedures with a curator (usage stats, staleness, archival), background self-review, and staged writes with human approval.
- **Safety** — every risky tool call goes through an approval adapter; `plan` mode restricts tools to read-only; secrets live in env vars or `~/.familiar/secrets/*.key`, never in config files.
- **Windows + Linux first-class** (paths, shell resolution, PowerShell support); desktop installers via electron-builder (deb / AppImage / NSIS).

### Install

Requirements: **Node.js ≥ 24** (`node --version` to check).

**Linux / macOS — one-liner** (downloads the latest release tarball, no npm needed):

```bash
curl -fsSL https://example.invalid:3000/owner/familiar-harness/raw/branch/main/install.sh | sh
```

- Installs to `~/.local/lib/familiar` and symlinks `~/.local/bin/familiar` (both overridable via `FAMILIAR_INSTALL_DIR` / `FAMILIAR_BIN_DIR`).
- The installer reads the Forgejo instance from `FAMILIAR_FORGEJO` (default `https://example.invalid:3000`) and repo from `FAMILIAR_REPO` (default `owner/familiar-harness`).
- A specific version: pass it as the first argument (`curl ... | sh -s -- 0.1.0`).

**From source (any platform):**

```bash
git clone https://example.invalid:3000/owner/familiar-harness.git
cd familiar-harness
npm install
npm run build
cd packages/cli && npm link   # puts `familiar` on your PATH
```

**Desktop app (Electron):**

- Ready-made binaries are attached to each [release](https://example.invalid:3000/owner/familiar-harness/releases):
  `familiar-<version>-linux-amd64.deb` / `familiar-<version>-linux-x86_64.AppImage` and
  for Windows `familiar-<version>-win-x64.exe` (NSIS installer) or
  `familiar-<version>-win-x64-portable.exe` (download and run, no install needed).
- Or build them yourself:

```bash
npm run -w packages/desktop pack:linux   # deb + AppImage
npm run -w packages/desktop pack:win     # NSIS (needs wine when cross-built on Linux)
```

### Updating

- **release installs** (via the one-liner): `familiar update` — checks the Forgejo releases, downloads the newest `familiar-*.tar.gz` and swaps it in place (`--check` for a dry run, `--forgejo`/`--repo` to override the registry). Requires Node's fetch to trust the endpoint's certificate; self-signed instances get an automatic unverified retry with a warning (`FAMILIAR_TLS_STRICT=1` to abort instead).
- **from source**: `git pull && npm run build`.

### Uninstall

**curl installer:**

```bash
# stop the auto-started web UI service (installed with systemd user units)
systemctl --user disable --now familiar-serve 2>/dev/null
rm -f ~/.config/systemd/user/familiar-serve.service
systemctl --user daemon-reload 2>/dev/null

rm -rf ~/.local/lib/familiar      # the application
rm -f ~/.local/bin/familiar       # the symlink
rm -rf ~/.familiar                # optional — also deletes config, session history,
                               # memory/skills and stored API keys (~/.familiar/secrets)
```

**From source (`npm link`):**

```bash
cd familiar-harness/packages/cli
npm unlink                     # removes the global `familiar` symlink
# then delete the repository checkout if you no longer need it
```

**Desktop app:** delete the AppImage file, or `sudo apt remove familiar-harness` (deb). Windows: delete the portable exe, or uninstall "Familiar Harness" from the Apps settings (NSIS install).

### Quick start

```bash
# full-screen TUI — same as `familiar chat`
familiar

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

### Configuration

`~/.familiar/config.yaml` — providers, defaults, server settings:

```yaml
version: 1

# Optional: pin the default. When omitted, Familiar picks the first provider
# that can actually be called (key present, or keyless local endpoint).
default_provider: openai
default_model: gpt-6.1-sol

providers:
  openai:
    kind: openai_compatible
    base_url: https://api.openai.com/v1
    auth: { env: OPENAI_API_KEY }      # never put tokens in this file
    default_model: gpt-6.1-sol
  ollama:
    kind: openai_compatible
    base_url: http://127.0.0.1:11434/v1
    auth: { env: none }
    default_model: qwen2.5-coder:3b
```

- Secrets resolve as `api_key` → `api_key_file` → `env`; API keys set through the GUI are stored as `~/.familiar/secrets/<provider>.key` (0600) and referenced by file.
- `stream_options: false` on a provider disables the `include_usage` request (some compat servers reject it; Familiar retries without it automatically).
- Bash runs without a prompt unless the command looks destructive or leaks data (`permissions.bash.ask`): `rm -rf`, `sudo`, `curl -d`, force-push and friends still ask, and only unrecoverable commands (`> /dev/sd*`, `mkfs` on a device) are blocked outright. Set `permissions.bash.mode: ask` for the old "approve everything" behavior.
- Model names move fast — check your provider's model list (`/models` in the TUI, or `curl $BASE_URL/models`).
- Full reference: [docs/spec/05-config.md](docs/spec/05-config.md).

### Remote access

`familiar serve` binds to `127.0.0.1` by default — no port forwarding needed on your router. From another machine use an SSH tunnel:

```bash
ssh -L 46210:127.0.0.1:46210 user@server
# then open http://localhost:46210 locally
```

For LAN-only exposure use `familiar serve --bind 0.0.0.0` **together with** token auth (`familiar token --write`); put a TLS reverse proxy in front for anything public.

**Desktop app:** *Settings → Connections* stores SSH hosts (no secrets, just host/user/port/identity file + connection mode). Pick one under *"+" → Runs on* in the new-session dialog:

- *familiar server* — the app starts `familiar serve` on that machine over SSH (keys/ssh-agent only, strict host-key checking), forwards a free local port, and switches the window to that host. Needs the same Familiar version and a `known_hosts` entry; *Back to local* returns.
- *SSH proxy* — nothing is installed remotely: the session stays local while `bash/read/write/edit/glob/grep` execute on the host over ssh (ControlMaster-multiplexed on Linux/macOS). Remote folders are browsed from the dialog, and dragged non-image files are uploaded to the remote host and referenced as `@path` (deleted with the session; leftovers auto-prune after `uploads.retention_days`). MCP servers and language servers are spawned on the host over ssh — set a per-server `remote: { command, args }` override when the host needs a different binary.

The WebUI works without the desktop shell too: the same profiles appear under *Settings → Connections* (server RPCs), proxy sessions run straight from the browser, and familiar-server hosts are tunneled by the server itself — the browser tab switches to the remote UI and returns through a capability stop endpoint (tunnels also expire after 12h; the listening address follows `server.bind`).

Host keys are strict; on first contact use *Check host key…* in the connection form to review the `ssh-keyscan` fingerprints and add them to `known_hosts` (a changed key is never auto-trusted).

Auth is key/ssh-agent by default, or **password** per connection profile — nothing needs to be installed or changed on the host. Passwords live in `~/.familiar/secrets/ssh-<hash>.pass` (0600) and reach ssh through `SSH_ASKPASS`, never argv/logs/the session DB. Repeated failures pause that host for 60s to avoid triggering server-side rate limits (fail2ban).

### Architecture

```
packages/
  protocol/   shared RPC + event/data types
  core/       agent loop, tools, providers, session store (UI-agnostic)
  server/     JSON-RPC over HTTP+WebSocket daemon + static Web UI
  cli/        familiar command (TUI, REPL, headless run, serve)
  desktop/    Electron shell for the same core
docs/spec/    detailed specs (architecture, protocol, tools, config, roadmap)
```

### Development

```bash
npm install
npm run build       # tsc -b (project references)
npm run typecheck
npm run smoke       # headless end-to-end with a mock provider (no network)
npm run mdtest      # markdown renderer fixtures
```

`familiar serve` keeps running the built `packages/*/dist` — restart it after code changes (static Web UI assets reload without a restart).

### Releasing (maintainers)

```bash
scripts/release.sh              # build + pack familiar-vX.Y.Z.tar.gz (dry run)
FORGEJO_TOKEN=... scripts/release.sh --publish   # create the release + upload
```

### License

[MIT](LICENSE)