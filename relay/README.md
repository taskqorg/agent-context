# Incident relay

Anonymous intake for `agent-context incidents report`. Clients hold no secrets.

- Validates the allowlisted packet (≤ 8 KB), rejects anything else.
- One Durable Object per fingerprint: occurrences, unique machines (hashed), versions, platforms.
- One accepted report per machine per hour per fingerprint.
- At ≥ 3 unique machines opens one GitHub issue (label `incident`, `fp:<id>`); the body table refreshes at most hourly. No comment per report.
- `KILL_SWITCH=1` pauses intake (clients keep their local queue).

## Deploy (owner)

1. Create a GitHub App: repository permission **Issues: read & write** only; install it on `taskqorg/agent-context` only.
2. Create label `incident` in the repository.
3. `cd relay && npx wrangler deploy`
4. Set `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` in `wrangler.toml` vars; `npx wrangler secret put GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM: `openssl pkcs8 -topk8 -nocrypt -in app.pem`).
5. If the deployed URL differs from `defaultRelay` in `src/incidents.js`, update it there and release.

Triage: sort issues labelled `incident` by the machine count in the body.
