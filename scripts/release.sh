#!/bin/sh
# Build the release artifacts and (optionally) publish them.
# The repository is developed on Forgejo and mirrored to GitHub. A publish
# creates the Forgejo release and, when a GitHub token is available, mirrors
# the same assets to the GitHub release so public installs can use it.
#
#   scripts/release.sh                        # CLI tarball only (dry run)
#   scripts/release.sh --desktop              # also build deb + AppImage
#   scripts/release.sh --publish              # release = tarball + desktop
#   scripts/release.sh --publish --no-desktop # tarball-only release
#   scripts/release.sh --publish --attach EXTRA.exe   # attach extra assets
#   scripts/release.sh --publish --github     # require the GitHub mirror
#   scripts/release.sh --publish --no-github  # Forgejo only
#
# Publishing needs a token with repo write access:
#   FORGEJO_TOKEN=... scripts/release.sh --publish
#   (or FORGEJO_TOKEN_FILE=~/.config/forgejo.token)
# For the GitHub mirror, GITHUB_TOKEN (or GITHUB_TOKEN_FILE) is used; with
# --github and no token, `gh auth token` is asked. Without either, a publish
# only updates Forgejo and says so.
# Re-publishing an existing tag is idempotent: the release is reused and
# same-name assets are replaced.
set -eu
cd "$(dirname "$0")/.."

REPO_HOST="${FAMILIAR_FORGEJO:-https://example.invalid:3000}"
REPO_SLUG="${FAMILIAR_REPO:-owner/familiar-harness}"
GITHUB_SLUG="${FAMILIAR_GITHUB_REPO:-keima-tech/familiar-harness}"
GITHUB_API_HOST="${FAMILIAR_GITHUB_API:-https://api.github.com}"
GITHUB_UPLOAD_HOST="${FAMILIAR_GITHUB_UPLOAD:-https://uploads.github.com}"
PUBLISH=0
DESKTOP=-1 # unset — decided by --publish below
GITHUB=-1  # unset — decided by the token below
ATTACH_FILES=""
PENDING_ATTACH=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --desktop) DESKTOP=1 ;;
    --no-desktop) DESKTOP=0 ;;
    --github) GITHUB=1 ;;
    --no-github) GITHUB=0 ;;
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

# --- GitHub token -----------------------------------------------------------
GH_TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$GH_TOKEN" ] && [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
  GH_TOKEN="$(tr -d '\r\n' < "$GITHUB_TOKEN_FILE")"
fi
if [ -z "$GH_TOKEN" ] && [ "$GITHUB" -eq 1 ] && command -v gh >/dev/null 2>&1; then
  GH_TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ "$GITHUB" -eq -1 ]; then
  if [ -n "$GH_TOKEN" ]; then GITHUB=1; else GITHUB=0; fi
fi
if [ "$GITHUB" -eq 1 ] && [ -z "$GH_TOKEN" ]; then
  echo "error: --github needs GITHUB_TOKEN, GITHUB_TOKEN_FILE or an authenticated gh" >&2
  exit 1
fi

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
echo "install:   curl -fsSL https://github.com/keima-tech/familiar-harness/raw/main/install.sh | sh"

# --- GitHub mirror ----------------------------------------------------------
if [ "$GITHUB" -eq 1 ]; then
  echo "== mirroring the assets to GitHub Releases (v$VERSION) =="
  GH_AUTH="Authorization: Bearer $GH_TOKEN"
  GH_ACCEPT="Accept: application/vnd.github+json"
  # The tag must already be mirrored; GitHub would otherwise create it from
  # the default branch, which may not be the released commit.
  if ! curl -fsS "$GITHUB_API_HOST/repos/$GITHUB_SLUG/git/ref/tags/v$VERSION" \
      -H "$GH_AUTH" -H "$GH_ACCEPT" >/dev/null; then
    echo "error: tag v$VERSION is not on GitHub yet — wait for the mirror to push it" >&2
    exit 1
  fi
  GH_RELEASE_ID="$(
    curl -fsS -X POST "$GITHUB_API_HOST/repos/$GITHUB_SLUG/releases" \
      -H "$GH_AUTH" -H "$GH_ACCEPT" -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/json" \
      -d "{\"tag_name\":\"v${VERSION}\",\"name\":\"v${VERSION}\",\"body\":\"Familiar Harness v${VERSION} — see README.md for install instructions.\",\"draft\":false,\"prerelease\":false}" 2>/dev/null |
      json_field 'v.id'
  )" || GH_RELEASE_ID=""
  if [ -z "$GH_RELEASE_ID" ]; then
    # already released — reuse it (idempotent re-publish)
    GH_RELEASE_ID="$(curl -fsS "$GITHUB_API_HOST/repos/$GITHUB_SLUG/releases/tags/v$VERSION" \
      -H "$GH_AUTH" -H "$GH_ACCEPT" | json_field 'v.id')"
  fi
  [ -n "$GH_RELEASE_ID" ] || { echo "error: cannot create or find the GitHub release v$VERSION" >&2; exit 1; }
  echo "github release id: $GH_RELEASE_ID"
  for f in $ARTIFACTS $ATTACH_FILES; do
    name="$(basename "$f")"
    old_id="$(curl -fsS "$GITHUB_API_HOST/repos/$GITHUB_SLUG/releases/$GH_RELEASE_ID/assets" \
      -H "$GH_AUTH" -H "$GH_ACCEPT" | json_field '(v.find(a=>a.name===process.argv[2])||{}).id' "$name")" || old_id=""
    if [ -n "$old_id" ]; then
      curl -fsS -X DELETE "$GITHUB_API_HOST/repos/$GITHUB_SLUG/releases/assets/$old_id" \
        -H "$GH_AUTH" -H "$GH_ACCEPT" >/dev/null || true
      echo "  - replaced $name (github)"
    fi
    curl -fsS -X POST "$GITHUB_UPLOAD_HOST/repos/$GITHUB_SLUG/releases/$GH_RELEASE_ID/assets?name=$name" \
      -H "$GH_AUTH" -H "$GH_ACCEPT" -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$f" >/dev/null
    echo "  + $name (github)"
  done
  echo "github:    https://github.com/$GITHUB_SLUG/releases/tag/v${VERSION}"
else
  echo "github:    skipped (set GITHUB_TOKEN or pass --github to mirror the assets)"
fi
