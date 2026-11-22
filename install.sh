#!/bin/sh
# Familiar installer — https://github.com/keima-tech/familiar-harness
#
#   curl -fsSL https://github.com/keima-tech/familiar-harness/raw/main/install.sh | sh
#
# Downloads the latest release tarball from GitHub Releases and installs the
# `familiar` CLI into ~/.local (no npm required; Node.js >= 24 must be on the
# PATH). The project develops on Forgejo and mirrors to GitHub; while GitHub
# Releases does not yet carry the tarball, the Forgejo instance is used as a
# fallback.
set -eu

GITHUB_API="${FAMILIAR_GITHUB_API:-https://api.github.com}"
GITHUB_REPO="${FAMILIAR_GITHUB_REPO:-keima-tech/familiar-harness}"
INSTALL_LIB="${FAMILIAR_INSTALL_DIR:-$HOME/.local/lib/familiar}"
INSTALL_BIN="${FAMILIAR_BIN_DIR:-$HOME/.local/bin}"

log() { printf '%s\n' "$*" >&2; }
fail() { log "error: $*"; exit 1; }

# --- prerequisites ----------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is required (>= 24). Install it first: https://nodejs.org or your package manager."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || fail "Node.js >= 24 is required, found $(node --version)."

DOWNLOAD=""
command -v curl >/dev/null 2>&1 && DOWNLOAD="curl -fsSL"
[ -n "$DOWNLOAD" ] || command -v wget >/dev/null 2>&1 && DOWNLOAD="wget -qO-"
[ -n "$DOWNLOAD" ] || fail "curl or wget is required."
# shellcheck disable=SC2086
fetch() { $DOWNLOAD "$1"; }

# --- resolve the latest release asset ---------------------------------------
VERSION="${1:-}"
# GitHub and Forgejo both expose releases with the same asset fields
# (browser_download_url); only the API base differs. Try GitHub first, then
# the in-house instance (used while the public repository is unpublished).
SOURCE_API=""
ASSET_URL=""
resolve_release() {
  if [ -n "$VERSION" ]; then url="$GITHUB_API/repos/$GITHUB_REPO/releases/tags/v$VERSION"; else url="$GITHUB_API/repos/$GITHUB_REPO/releases"; fi
  json="$(fetch "$url" 2>/dev/null)" || return 1
  asset="$(
    printf '%s' "$json" |
      tr -d ' \n\r\t' |
      grep -o '"browser_download_url":"[^"]*familiar-[^"]*\.tar\.gz"' |
      head -1 |
      cut -d'"' -f4
  )" || asset=""
  if [ -n "$asset" ]; then
    SOURCE_API="$url"
    ASSET_URL="$asset"
    return 0
  fi
  return 1
}

if [ -n "$VERSION" ]; then
  log "installing familiar v$VERSION"
else
  log "resolving the latest familiar release (github.com/$GITHUB_REPO)…"
fi
resolve_release || fail "cannot reach GitHub or find a familiar-*.tar.gz asset"
log "source: $SOURCE_API"
log "asset: $ASSET_URL"

# --- download + install ------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
log "downloading..."
fetch "$ASSET_URL" > "$TMP/familiar.tar.gz" || fail "download failed."
mkdir -p "$INSTALL_LIB"
tar -xzf "$TMP/familiar.tar.gz" -C "$INSTALL_LIB"

mkdir -p "$INSTALL_BIN"
ln -sf "$INSTALL_LIB/packages/cli/dist/familiar.js" "$INSTALL_BIN/familiar"
chmod +x "$INSTALL_LIB/packages/cli/dist/familiar.js" 2>/dev/null || true

# --- Web UI: start the server now + keep it running (systemd user unit) ---
if command -v systemctl >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ] && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/familiar-serve.service <<UNIT
[Unit]
Description=Familiar Harness web UI server
After=network.target

[Service]
ExecStart=$INSTALL_BIN/familiar serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now familiar-serve >/dev/null 2>&1 || true
  log "web UI: systemd user service enabled (auto-starts on login)"
else
  # no systemd user session: start the server in the background if not running
  if fetch "http://127.0.0.1:46210/healthz" >/dev/null 2>&1; then
    log "web UI already running: http://localhost:46210/"
  else
    mkdir -p "$HOME/.familiar"
    ( setsid "$INSTALL_LIB/packages/cli/dist/familiar.js" serve > "$HOME/.familiar/serve.log" 2>&1 < /dev/null & )
    sleep 2
    log "web UI started in the background: http://localhost:46210/ (log: ~/.familiar/serve.log)"
  fi
fi

# --- verify ------------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_BIN:"*) ;;
  *)
    log ""
    log "NOTE: $INSTALL_BIN is not on your PATH. Add this to your shell profile:"
    log "  export PATH=\"$INSTALL_BIN:\$PATH\""
    ;;
esac
log ""
"$INSTALL_BIN/familiar" --version 2>/dev/null || "$INSTALL_LIB/packages/cli/dist/familiar.js" --version || true
log "familiar installed to $INSTALL_LIB"
log "next: familiar   (TUI)   |   familiar serve   (Web UI on http://127.0.0.1:46210)   |   familiar update"
