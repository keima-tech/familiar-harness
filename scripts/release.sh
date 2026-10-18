#!/bin/sh
# Build the CLI release tarball and (optionally) publish a Forgejo release.
#
#   scripts/release.sh                 # build + pack only (dry run)
#   scripts/release.sh --publish       # also create the release + upload
#
# Publishing needs a token with repo write access:
#   FORGEJO_TOKEN=... scripts/release.sh --publish
#   (or FORGEJO_TOKEN_FILE=~/.config/forgejo.token)
set -eu
cd "$(dirname "$0")/.."

REPO_HOST="${FAMILIAR_FORGEJO:-https://example.invalid:3000}"
REPO_SLUG="${FAMILIAR_REPO:-owner/familiar-harness}"
PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

VERSION="$(node -p 'require("./package.json").version')"
TARBALL="familiar-v${VERSION}.tar.gz"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "== building (tsc -b) =="
npm run build

echo "== staging $TARBALL =="
# runtime layout: workspace packages + public assets; npm ci --omit=dev
# restores the two runtime deps (yaml, ws) and the @familiar/* links.
mkdir -p "$STAGING/packages"
cp package.json package-lock.json "$STAGING/"
for pkg in cli core protocol server; do
  mkdir -p "$STAGING/packages/$pkg"
  cp "packages/$pkg/package.json" "$STAGING/packages/$pkg/"
  cp -r "packages/$pkg/dist" "$STAGING/packages/$pkg/dist"
done
cp -r packages/server/public "$STAGING/packages/server/public"
cp README.md LICENSE install.sh "$STAGING/" 2>/dev/null || true

echo "== npm ci --omit=dev (staging) =="
( cd "$STAGING" && npm ci --omit=dev >/dev/null 2>&1 )

echo "== smoke-check the staged CLI =="
node "$STAGING/packages/cli/dist/familiar.js" --version

tar -czf "$TARBALL" -C "$STAGING" .
ls -lh "$TARBALL"

if [ "$PUBLISH" -ne 1 ]; then
  echo "dry run — re-run with --publish to create the Forgejo release"
  exit 0
fi

# --- publish -----------------------------------------------------------------
TOKEN="${FORGEJO_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -n "${FORGEJO_TOKEN_FILE:-}" ]; then
  TOKEN="$(tr -d '\r\n' < "$FORGEJO_TOKEN_FILE")"
fi
[ -n "$TOKEN" ] || { echo "error: FORGEJO_TOKEN (or FORGEJO_TOKEN_FILE) is required for --publish"; exit 1; }
AUTH="Authorization: token $TOKEN"
API="$REPO_HOST/api/v1/repos/$REPO_SLUG"

echo "== creating release v$VERSION =="
RELEASE_ID="$(
  curl -fsS -X POST "$API/releases" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"v${VERSION}\",\"name\":\"v${VERSION}\",\"body\":\"Familiar v${VERSION} — see README.md for install instructions.\",\"draft\":false,\"prerelease\":false}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'
)"
echo "release id: $RELEASE_ID"

echo "== uploading $TARBALL =="
curl -fsS -X POST "$API/releases/$RELEASE_ID/assets?name=$TARBALL" \
  -H "$AUTH" -F "attachment=@$TARBALL" >/dev/null
echo "published: $REPO_HOST/$REPO_SLUG/releases/tag/v${VERSION}"
echo "install:   curl -fsSL $REPO_HOST/$REPO_SLUG/raw/branch/main/install.sh | sh"
