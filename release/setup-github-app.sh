#!/usr/bin/env bash
# Owner step: finish the relay GitHub App from the manifest code, install it, and configure the Worker.
# Usage: ./release/setup-github-app.sh [code]   (without code: read from the active Chrome tab)
set -euo pipefail
CODE=${1:-}
if [[ -z "$CODE" ]]; then
  # Take ?code= from the active Chrome tab (the example.com redirect after "Create GitHub App").
  URL=$(osascript -e 'tell application "Google Chrome" to get URL of active tab of front window' 2>/dev/null || true)
  CODE=$(sed -n 's/.*[?&]code=\([^&#]*\).*/\1/p' <<<"$URL")
fi
[[ "$CODE" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "No code: open the example.com/?code=... tab in Chrome (front window) or pass the code."; exit 1; }
cd "$(git rev-parse --show-toplevel)/relay"
APP=$(gh api -X POST "/app-manifests/$CODE/conversions")
APP_ID=$(jq -r .id <<<"$APP"); SLUG=$(jq -r .slug <<<"$APP")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
jq -r .pem <<<"$APP" > "$TMP/app.pem"
openssl pkcs8 -topk8 -nocrypt -in "$TMP/app.pem" -out "$TMP/app-pkcs8.pem"
echo "App $SLUG (id $APP_ID) created. Install it on taskqorg/agent-context only:"
echo "  https://github.com/apps/$SLUG/installations/new"
read -r -p "Press Enter after installing..." _
INSTALLATION_ID=$(gh api "/repos/taskqorg/agent-context/installation" --jq .id 2>/dev/null || true)
[[ -n "$INSTALLATION_ID" ]] || read -r -p "Installation id (from the installation URL): " INSTALLATION_ID
gh label create incident --repo taskqorg/agent-context --color B60205 --description "Aggregated incident from relay" 2>/dev/null || true
sed -i.bak -e "s/^GITHUB_APP_ID = .*/GITHUB_APP_ID = \"$APP_ID\"/" -e "s/^GITHUB_INSTALLATION_ID = .*/GITHUB_INSTALLATION_ID = \"$INSTALLATION_ID\"/" wrangler.toml && rm wrangler.toml.bak
npx --yes wrangler@3 secret put GITHUB_APP_PRIVATE_KEY < "$TMP/app-pkcs8.pem"
openssl rand -hex 32 | npx --yes wrangler@3 secret put SOURCE_SALT
npx --yes wrangler@3 deploy
echo "Done. Add a Cloudflare rate-limiting rule on /v1/incidents (30 req/min per IP) in the dashboard."
