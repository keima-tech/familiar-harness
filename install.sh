#!/bin/sh
# Familiar installer — https://github.com/... (Forgejo instance)
#
#   curl -fsSL <repo-raw-url>/install.sh | sh
#
# Downloads the latest release tarball from the Forgejo release assets and
# installs the `familiar` CLI into ~/.local (no npm required; Node.js >= 24
# must be on the PATH).
set -eu

REPO_HOST="${FAMILIAR_FORGEJO:-https://example.invalid:3000}"
REPO_SLUG="${FAMILIAR_REPO:-owner/familiar-harness}"
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
# Forgejo and GitHub both expose releases with the same asset fields
# (browser_download_url); only the API base differs
case "$REPO_HOST" in
  *github.com*)
    API="${FAMILIAR_GITHUB_API:-https://api.github.com}/repos/$REPO_SLUG/releases"
    ;;
  *)
    API="$REPO_HOST/api/v1/repos/$REPO_SLUG/releases"
    ;;
esac
if [ -n "$VERSION" ]; then
  API="$API/tags/v$VERSION"
  log "installing familiar v$VERSION"
else
  log "resolving the latest familiar release..."
fi
RELEASE_JSON="$(fetch "$API" 2>/dev/null)" || fail "cannot reach $API — is the repository public?"
# first asset named familiar-*.tar.gz (jq is not a hard dependency)
ASSET_URL="$(
  printf '%s' "$RELEASE_JSON" |
    tr -d ' \n\r\t' |
    grep -o '"browser_download_url":"[^"]*familiar-[^"]*\.tar\.gz"' |
    head -1 |
    cut -d'"' -f4
)"
[ -n "$ASSET_URL" ] || fail "no familiar-*.tar.gz asset found in the latest release."
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
