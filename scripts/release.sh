#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# release.sh — build, test, publish to npm, tag + push
#
# Usage:
#   ./scripts/release.sh [patch|minor|major|<version>]
#
# NPM token pulled from Bitwarden:
#   item  : "npmjs.com"
#   field : "opencode-omniroute-plugin" (type: hidden)
#
# Requires: bw, bun, npm, git
# ---------------------------------------------------------------------------

BUMP=${1:-patch}
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 1. preflight ────────────────────────────────────────────────────────────
echo "→ preflight checks"
command -v bw  >/dev/null || { echo "✗ bw not found"; exit 1; }
command -v bun >/dev/null || { echo "✗ bun not found"; exit 1; }
command -v npm >/dev/null || { echo "✗ npm not found"; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ working tree dirty — commit or stash changes first"
  exit 1
fi

# ── 2. unlock bitwarden ─────────────────────────────────────────────────────
BW_STATUS=$(bw status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','locked'))" 2>/dev/null || echo "locked")

if [[ "$BW_STATUS" == "locked" ]]; then
  echo "→ unlocking Bitwarden vault"
  BW_SESSION=$(bw unlock --raw)
  export BW_SESSION
elif [[ "$BW_STATUS" == "unauthenticated" ]]; then
  echo "→ logging in to Bitwarden"
  bw login
  BW_SESSION=$(bw unlock --raw)
  export BW_SESSION
fi

# ── 3. fetch npm token ───────────────────────────────────────────────────────
echo "→ fetching npm token from Bitwarden"
NPM_TOKEN=$(bw get item "npmjs.com" 2>/dev/null \
  | python3 -c "
import sys, json
item = json.load(sys.stdin)
for f in item.get('fields', []):
    if f.get('name') == 'opencode-omniroute-plugin':
        print(f.get('value', ''))
        break
" 2>/dev/null)

if [[ -z "$NPM_TOKEN" ]]; then
  echo "✗ could not retrieve npm token from Bitwarden"
  echo "  item: 'npmjs.com'"
  echo "  field: 'opencode-omniroute-plugin'"
  exit 1
fi
echo "✓ npm token retrieved"

# ── 4. bump version ──────────────────────────────────────────────────────────
echo "→ bumping version ($BUMP)"
npm version "$BUMP" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
echo "✓ version → $VERSION"

# ── 5. build ─────────────────────────────────────────────────────────────────
echo "→ building"
bun run build

# ── 6. test ──────────────────────────────────────────────────────────────────
echo "→ testing"
bun test tests/

# ── 7. publish ───────────────────────────────────────────────────────────────
echo "→ publishing @mrmm/opencode-omniroute-plugin@$VERSION to npm"
NPM_TOKEN="$NPM_TOKEN" npm publish --access public

# ── 8. commit + tag + push ───────────────────────────────────────────────────
echo "→ committing version bump"
git add package.json
git commit -m "chore(release): v$VERSION"

echo "→ tagging v$VERSION"
git tag "v$VERSION"

echo "→ pushing"
git push origin main
git push origin "v$VERSION"

echo ""
echo "✓ released @mrmm/opencode-omniroute-plugin@$VERSION"
echo "  https://www.npmjs.com/package/@mrmm/opencode-omniroute-plugin"
