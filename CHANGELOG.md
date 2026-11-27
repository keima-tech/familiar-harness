# Changelog

## v0.1.0 (2026-11-27)

- **Three frontends, one core.** Terminal UI, web UI (`familiar serve`) and an
  Electron desktop app (deb / AppImage / Windows NSIS) all share the same agent
  engine, sessions and settings.
- **Skills and Connectors settings.** The old “Extensions” section was replaced
  by independent **Skills** and **Connectors** sections. Connectors separates
  framed **Servers** (MCP / LSP) from **External services**.
- **MCP / LSP servers in the GUI.** Add, edit, delete and reconnect servers from
  Connectors without editing `config.yaml` by hand.
- **Web search.** Works out of the box with DuckDuckGo. A dedicated **Web search**
  settings section lets you point it at your own SearXNG instance.
- **MEMORY.md.** Keep decisions and premises in `~/.familiar/MEMORY.md` (all
  sessions) or `<cwd>/.familiar/MEMORY.md` (one project). Both are loaded into
  every turn and are never rewritten by the agent.
- **ZIP attachments.** Attach a `.zip`; the agent can list and read text files
  inside it without extracting it or installing `unzip`.
- **Official service names.** Connector titles keep their real casing
  (GitHub, GitLab, Jira, Microsoft Teams …).
- **Safer defaults.** Non-loopback binds require an authentication token;
  privileged settings/RPC changes are restricted; `/healthz` no longer exposes
  private paths; web fetches are checked against private IP ranges.
- **Illustrated user guide.** A screenshot-based guide in English and Japanese,
  linked from both READMEs.
