#!/usr/bin/env zsh
set -euo pipefail 2>/dev/null || setopt ERR_EXIT PIPE_FAIL NO_UNSET

# ---------------------------------------------------------------------------
# release.sh — build, test, publish to npm, tag + push
#
# Usage (run from a real terminal):
#   bash scripts/release.sh [patch|minor|major|<version>]
#
# NPM token pulled from Bitwarden via wrapper (Touch ID, no manual unlock needed):
#   item  : "npmjs.com"
#   field : "opencode-omniroute-plugin"
#
# Requires: /Users/mourad.maatoug/.config/zsh/bitwarden_session_wrapper.zsh
#
# Requires: bw, bun, npm, git
# ---------------------------------------------------------------------------

BUMP=${1:-patch}
REPO_ROOT="$(cd "$(dirname "${(%):-%x}")/.." && pwd)"
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

# ── 2. load bitwarden wrapper ───────────────────────────────────────────────
BW_WRAPPER="$HOME/.config/zsh/bitwarden_session_wrapper.zsh"
if [[ ! -f "$BW_WRAPPER" ]]; then
  echo "✗ Bitwarden wrapper not found: $BW_WRAPPER"
  exit 1
fi
# shellcheck source=/dev/null
source "$BW_WRAPPER"
echo "✓ Bitwarden wrapper loaded (Touch ID session management)"

# ── 3. fetch npm token ───────────────────────────────────────────────────────
echo "→ fetching npm token from Bitwarden"
NPM_TOKEN=$(bw get item "npmjs.com" \
  | jq -r '.fields[] | select(.name=="opencode-omniroute-plugin") | .value')

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
echo -n "  npm 2FA OTP: "
read -r OTP </dev/tty
NODE_AUTH_TOKEN="$NPM_TOKEN" npm publish --access public --otp="$OTP"

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
