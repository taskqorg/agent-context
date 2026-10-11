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
BUILT=$(git rev-parse HEAD)
rm -rf release/out && mkdir -p release/out
npm pack --pack-destination release/out >/dev/null
node -e "
const fs=require('fs'),c=require('crypto');
const sha=c.createHash('sha256').update(fs.readFileSync('release/out/$ARCHIVE')).digest('hex');
fs.writeFileSync('release/out/recipe.json',JSON.stringify({schema:1,version:'$VERSION',launcherSchema:1,adapterContract:1,platforms:['darwin'],clients:['codex','claude','hermes'],archive:'$ARCHIVE',sha256:sha}));"

echo "3/4 Publish $TAG (macOS rollout only)"
gh release create "$TAG" --repo "$REPO" --target "$BUILT" --title "Agent Context $VERSION" --generate-notes \
  "release/out/$ARCHIVE" release/out/recipe.json

echo "4/4 Sign recipe"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run sign-recipe.yml --repo "$REPO" --ref main -f tag="$TAG"
# The 'release' environment keeps its owner-reviewer gate; this owner script approves it with the owner's own gh login.
# Approve only the run this script started: the built commit, dispatched after STARTED, titled with this tag, exactly one.
for _ in $(seq 30); do
  RUNS=$(gh run list --repo "$REPO" --workflow sign-recipe.yml --event workflow_dispatch --branch main --limit 20 \
    --json databaseId,status,displayTitle,createdAt,headSha \
    -q ".[] | select(.status==\"waiting\" and .displayTitle==\"Sign $TAG\" and .createdAt>=\"$STARTED\" and .headSha==\"$BUILT\") | .databaseId")
  [[ -n "$RUNS" ]] && break; sleep 5
done
[[ -n "${RUNS:-}" && $(wc -l <<<"$RUNS") -eq 1 ]] || { echo "no single signing run for $TAG awaiting approval; check https://github.com/$REPO/actions/workflows/sign-recipe.yml"; exit 1; }
RUN=$RUNS
ENV_ID=$(gh api "repos/$REPO/environments/release" -q .id)
gh api -X POST "repos/$REPO/actions/runs/$RUN/pending_deployments" -F "environment_ids[]=$ENV_ID" -f state=approved -f comment="Owner release $VERSION via publish.sh" >/dev/null
gh run watch "$RUN" --repo "$REPO" --exit-status >/dev/null
gh release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name' | grep -qx recipe.json.sig || { echo "recipe.json.sig missing"; exit 1; }
echo "Signed $TAG"
