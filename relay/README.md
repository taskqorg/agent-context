# Incident relay

Anonymous intake for `agent-context incidents report`. Clients hold no secrets.

- Validates the allowlisted packet (≤ 8 KB), rejects anything else.
- One Durable Object per fingerprint: occurrences, unique machines (hashed), versions, platforms.
- Unique machines = distinct salted IP hashes (Sybil-resistant; client machine ids are only for idempotency).
- One accepted report per machine and per source per hour per fingerprint; one report adds ≤ 100 occurrences; per-fingerprint state capped at 1000 sources.
- At most 10 new issues per day globally.
- At ≥ 3 unique machines opens one GitHub issue (label `incident`, `fp:<id>`); the body table refreshes at most hourly. No comment per report.
- `KILL_SWITCH=1` pauses intake (clients keep their local queue).

## Deploy (owner)

1. Create a GitHub App: repository permission **Issues: read & write** only; install it on `taskqorg/agentq` only.
2. Create label `incident` in the repository.
3. `cd relay && npx wrangler deploy`
4. Set `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` in `wrangler.toml` vars; `npx wrangler secret put GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM: `openssl pkcs8 -topk8 -nocrypt -in app.pem`) and `npx wrangler secret put SOURCE_SALT` (random string).
5. Add a Cloudflare rate-limiting rule on `/v1/incidents` (for example 30 requests/min per IP).
6. If the deployed URL differs from `defaultRelay` in `src/incidents.js`, update it there and release.

Triage: sort issues labelled `incident` by the machine count in the body.
