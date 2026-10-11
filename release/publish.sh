#!/usr/bin/env bash
# Owner release step: merge a release PR, publish the tagged release from main, start recipe signing.
# Usage: ./release/publish.sh <version> <pr-number>     e.g. ./release/publish.sh 0.1.14 10
set -euo pipefail
VERSION=${1:?version}; PR=${2:?pr number}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$PR" =~ ^[0-9]+$ ]] || { echo "bad arguments"; exit 1; }
REPO=taskqorg/agent-context; TAG=v$VERSION; ARCHIVE=alexkirs-agent-context-$VERSION.tgz
cd "$(git rev-parse --show-toplevel)"

echo "1/4 Merge PR #$PR after checks"
gh pr checks "$PR" --repo "$REPO" --watch --fail-fast
gh pr merge "$PR" --repo "$REPO" --merge

echo "2/4 Build from main"
git fetch -q origin && git checkout -q main && git pull -q --ff-only
[[ "$(node -p "require('./package.json').version")" == "$VERSION" ]] || { echo "main is not $VERSION"; exit 1; }
npm ci --silent && npm test >/dev/null
rm -rf release/out && mkdir -p release/out
npm pack --pack-destination release/out >/dev/null
node -e "
const fs=require('fs'),c=require('crypto');
const sha=c.createHash('sha256').update(fs.readFileSync('release/out/$ARCHIVE')).digest('hex');
fs.writeFileSync('release/out/recipe.json',JSON.stringify({schema:1,version:'$VERSION',launcherSchema:1,adapterContract:1,platforms:['darwin'],clients:['codex','claude','hermes'],archive:'$ARCHIVE',sha256:sha}));"

echo "3/4 Publish $TAG (macOS rollout only)"
gh release create "$TAG" --repo "$REPO" --target main --title "Agent Context $VERSION" --generate-notes \
  "release/out/$ARCHIVE" release/out/recipe.json

echo "4/4 Sign recipe — approve the 'release' environment run in GitHub"
gh workflow run sign-recipe.yml --repo "$REPO" --ref main -f tag="$TAG"
echo "https://github.com/$REPO/actions/workflows/sign-recipe.yml"
