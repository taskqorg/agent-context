# ServiceQ v1 — 0.2.5

Shared Langfuse project `Agents` (`tight-hermes`), dashboard `ServiceQ`.

## Operational overview

The readable overview lives at `https://langfuse.ufobe.com/serviceq`. It reads
Langfuse on the server; project keys never reach the browser. It shows the latest
snapshot for each device, freshness (ten minutes), service problems separately
from unknown status, observed model activity and compression outcomes for the
selected period. Mac, Windows, WSL and FRA are the expected pilot hosts; other
observed hosts are discovered automatically. Devices keep their newest runtime
identity, so corrected WSL labels do not duplicate a host.

Compression successes, normal skips and failures are disjoint. Character reduction
is displayed only when every counted call contains before/after measurements.
It is not model-token savings or a full-traffic compression ratio. Process counters
have a separate disclosure and retain their restart/reset semantics. Historical
incidents are deduplicated and never presented as unresolved current failures.
Missing measurements remain missing. A read failure marks the previous snapshot
as unconfirmed; a capped query is explicitly marked incomplete.

Run `scripts/serve-serviceq.js` with `AGENT_CONTEXT_LANGFUSE_CONFIG` pointing to
the existing private Langfuse config or gateway config. The server binds only
`127.0.0.1:18881`. Deploy `/serviceq` and `/serviceq/*` **after** the existing
Langfuse UI `forward_auth` guard and before its final reverse proxy. Never route
the overview under `/api/public`, never bypass the guard and never expose its
loopback port. This shares the existing UI audience; it is not a new public portal.

The page refreshes every minute; the server coalesces reads for thirty seconds.
Queries are bounded to 24 hours for health/history and 30 minutes, 2 hours or
24 hours for activity/compression, with cursor pagination and a 10,000-row cap
per source. It fetches metadata only, never conversation or tool content.
No new agent configuration, monitor restart or database is needed for this UI.
Rollback removes the guarded Caddy route and stops `serviceq-overview.service`.

The monitor reads existing ContextQ proxy health, native telemetry queue metadata,
local incident summaries and fresh ServerQ reports. It does not run or duplicate
ServerQ checks. TaskQ without an explicit fresh status snapshot is unknown.
Existing FRA host-health reports can supply Hermes gateway and Langfuse health.
No prompts, tool results, raw errors or private reports enter monitoring snapshots.

`agent-context monitor tick` sends one snapshot. `monitor serve` collects every
five minutes. New proxy supervisors also start monitoring. A private shared lock
prevents duplicate ticks. Existing busy proxies need no restart: use the separate
monitor process with the same profile. Remove its service registration on rollback.

Optional private `~/.agent-context/monitor-config.json`:

```json
{
  "serverq": {"report": "/home/hermes/.serverq/report.json", "maxAgeSeconds": 7200},
  "hostHealthReport": "/home/hermes/.local/state/tight-host-health/state.json"
}
```

TaskQ integration accepts `taskq: {report: absolutePath, maxAgeSeconds: 600}`.
Its report contract is `{checkedAt: ISO8601, state: ok|warning|error|unknown}`.
This first release does not implement a native TaskQ status producer.

Client and gateway queues survive restart (1000 packets / 20 MiB each).
Client acknowledgements mean accepted by gateway, not yet exported to Langfuse.
Gateway exports every 15 seconds; partial rejection keeps the packet for retry.
Packets expire after seven days. Historical packets older than ten minutes do
not produce fresh health scores. Revoked devices cannot export queued packets.

Dashboard provisioning: `node scripts/apply-monitor-dashboard.js`, with private
Langfuse config via `AGENT_CONTEXT_LANGFUSE_CONFIG` or `~/.codex/langfuse.json`.
Uses Langfuse CLI and updates matching widget names. API is unstable; deployment
qualified against Langfuse 4.56.0. Select a recent period; counts are samples,
not unique agents. Unknown is shown as WARNING with an explicit reason and never
gets a healthy score. No-data detection and alert destinations are not configured.

Compression counters reset with proxy process restart and only cover measured
router tool blocks. They do not prove all Codex WebSocket frames, model token
savings or semantic quality. Old proxy processes keep their old instrumentation;
monitor version is the exporter version, not a claim that every proxy upgraded.

Pilot deployment: immutable package on FRA, gateway rollback by restoring its
previous unit, independent monitor service; Mac uses a separate launch agent.
Windows qualification remains required before broad stable promotion.

0.2.4: Windows updater now survives launcher exit (`detached: true`),
proved by an isolated native Windows reproduction. Portable gates check actual
Windows ACLs, path separators and WSL runtime rather than POSIX-only assumptions.

0.2.5: Windows private files belong to the current user SID, not the profile
directory owner. Administrator-owned homes no longer require elevation. Existing
profile ACLs are preserved; new secret files grant only user/SYSTEM/admin access.
