#!/bin/sh
# Build the release artifacts and (optionally) publish a Forgejo release.
#
#   scripts/release.sh                        # CLI tarball only (dry run)
#   scripts/release.sh --desktop              # also build deb + AppImage
#   scripts/release.sh --publish              # release = tarball + desktop
#   scripts/release.sh --publish --no-desktop # tarball-only release
#   scripts/release.sh --publish --tauri      # also build the Tauri deb
#   scripts/release.sh --publish --attach EXTRA.exe   # attach extra assets
#
# Publishing needs a token with repo write access:
#   FORGEJO_TOKEN=... scripts/release.sh --publish
#   (or FORGEJO_TOKEN_FILE=~/.config/forgejo.token)
# Re-publishing an existing tag is idempotent: the release is reused and
# same-name assets are replaced.
set -eu
cd "$(dirname "$0")/.."

REPO_HOST="${FAMILIAR_FORGEJO:-https://example.invalid:3000}"
REPO_SLUG="${FAMILIAR_REPO:-owner/familiar-harness}"
PUBLISH=0
DESKTOP=-1 # unset — decided by --publish below
TAURI=0    # opt-in: the size-optimized Tauri shell (needs the Rust toolchain)
ATTACH_FILES=""
PENDING_ATTACH=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --desktop) DESKTOP=1 ;;
    --no-desktop) DESKTOP=0 ;;
    --tauri) TAURI=1 ;;
    --attach) PENDING_ATTACH=1 ;;
    *)
      if [ "$PENDING_ATTACH" -eq 1 ]; then
        ATTACH_FILES="$ATTACH_FILES $arg"
        PENDING_ATTACH=0
      else
        echo "unknown option: $arg"; exit 1
      fi
      ;;
  esac
done
[ "$DESKTOP" -eq -1 ] && DESKTOP=$PUBLISH # publishing includes desktop by default
[ "$PENDING_ATTACH" -eq 0 ] || { echo "error: --attach needs a file argument"; exit 1; }

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
cp README.md README.ja.md LICENSE install.sh "$STAGING/" 2>/dev/null || true

echo "== npm ci --omit=dev (staging) =="
( cd "$STAGING" && npm ci --omit=dev >/dev/null 2>&1 )

echo "== smoke-check the staged CLI =="
node "$STAGING/packages/cli/dist/familiar.js" --version

ARTIFACTS="$TARBALL"

if [ "$DESKTOP" -eq 1 ]; then
  echo "== desktop installers (deb + AppImage) =="
  npm run -w packages/desktop pack:linux >/dev/null 2>&1
  for f in packages/desktop/release/familiar-"${VERSION}"-linux-*; do
    [ -f "$f" ] || continue
    ARTIFACTS="$ARTIFACTS $f"
  done
fi

if [ "$TAURI" -eq 1 ]; then
  echo "== tauri installer (deb; system webview + bundled Node) =="
  # stages the Node runtime + familiar tree, then cargo tauri build (needs cargo)
  npm run -w packages/desktop-tauri build >/dev/null 2>&1
  debdir="packages/desktop-tauri/src-tauri/target/release/bundle/deb"
  src="$(ls "$debdir"/*.deb 2>/dev/null | head -1)"
  if [ -n "$src" ]; then
    out="familiar-${VERSION}-linux-tauri-amd64.deb"
    cp "$src" "$out" # rename away the spaces in "Familiar Harness_….deb"
    ARTIFACTS="$ARTIFACTS $out"
  fi
fi

tar -czf "$TARBALL" -C "$STAGING" .
echo "artifacts:"
for f in $ARTIFACTS; do
  ls -lh "$f" | awk '{print "  " $NF " (" $5 ")"}'
done

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

json_field() { # stdin: JSON; $1 = JS expr over `v`; $2 = optional extra as process.argv[2]
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const out=eval(process.argv[1]);console.log(out===undefined||out===null?"":String(out))}catch{console.log("")}})' "$1" "${2:-}"
}

echo "== creating (or reusing) release v$VERSION =="
RELEASE_ID="$(
  curl -fsS -X POST "$API/releases" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"v${VERSION}\",\"name\":\"v${VERSION}\",\"body\":\"Familiar Harness v${VERSION} — see README.md for install instructions.\",\"draft\":false,\"prerelease\":false}" |
    json_field 'v.id'
)"
if [ -z "$RELEASE_ID" ]; then
  # tag already released — reuse it (idempotent re-publish)
  RELEASE_ID="$(curl -fsS "$API/releases/tags/v${VERSION}" -H "$AUTH" | json_field 'v.id')"
fi
[ -n "$RELEASE_ID" ] || { echo "error: cannot create or find release v$VERSION"; exit 1; }
echo "release id: $RELEASE_ID"

for f in $ARTIFACTS $ATTACH_FILES; do
  name="$(basename "$f")"
  # replace a same-name asset (idempotent re-publish)
  old_id="$(curl -fsS "$API/releases/$RELEASE_ID/assets" -H "$AUTH" | json_field '(v.find(a=>a.name===process.argv[2])||{}).id' "$name")" || old_id=""
  if [ -n "$old_id" ]; then
    curl -fsS -X DELETE "$API/releases/$RELEASE_ID/assets/$old_id" -H "$AUTH" >/dev/null || true
    echo "  - replaced $name"
  fi
  curl -fsS -X POST "$API/releases/$RELEASE_ID/assets?name=$name" \
    -H "$AUTH" -F "attachment=@$f" >/dev/null
  echo "  + $name"
done
echo "published: $REPO_HOST/$REPO_SLUG/releases/tag/v${VERSION}"
echo "install:   curl -fsSL $REPO_HOST/$REPO_SLUG/raw/branch/main/install.sh | sh"
