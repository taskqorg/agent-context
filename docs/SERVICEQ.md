# ServiceQ v1 — 0.2.5

> **Superseded by [dashq](https://github.com/taskqorg/dashq)** at `https://dash.ufobe.com`, behind the same Langfuse Access guard (agentq.md § 8). Use `dashq report` instead of `--report`. This page stays until the `/serviceq` panel is removed.

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

## Native RTK accounting

The reader also fetches `agent-context.native-tool`. Native RTK is a separate
table: estimates, sample/link counts, command exits and explicit origin. Existing
events without an origin remain unknown, including historical qualification
controls. The combined RTK estimate is not a production-only saving. No chars or
model tokens are inferred from RTK estimates. Recovery-reference overhead is not
included in those estimates. Existing native span timestamps represent delivery.
Stable event IDs are deduplicated within device/host/runtime/agent identity;
old events without device/event IDs use observation IDs only.

The same read-only JSON report is available to agents without browser login:

```sh
AGENT_CONTEXT_LANGFUSE_CONFIG=/private/existing/config.json node scripts/serve-serviceq.js --report --period=86400 --host=windows/native --agent=codex --session=NATIVE_ID
```

Use the existing operator credentials locally; never send them to an agent/client
or print their values. Filters are optional; periods remain 1800/7200/86400 seconds.
The guarded `/serviceq/data` accepts the same `host`, `agent`, `session` filters.
Session filters limit activity/compression; service-health snapshots retain their
host scope and are not session health. A report contains aggregates and evidence
trace IDs, never raw commands, prompts or tool results. Query caps and unknown
links remain explicit. Filters do not reconstruct missing native identities.
Model usage is grouped by the observed model with sample counts for each original
input/cache/output/reasoning field. Overlapping fields are not summed into an invented
total. Missing costs remain null; reported cost is not invoice or subscription savings.

## Safe native failure receipts and time

The current problems panel and JSON report expose the last retained native failure
receipt: job ID, actual wrapper version, stage, typed Node/exit/signal, captured
output byte counts, elapsed time and known SDK phase/status. Arbitrary messages,
stacks and stderr/stdout are never persisted or returned. Missing values are null;
old clients without receipts stay compatible. This is one observed failure, not
the cause of every pending job. Recovery clears a retained receipt only after the
existing acknowledgement path removes its job.

Retry/recovery durations explicitly belong to the displayed snapshot time (BKK).
They are not a live countdown or evidence that a retry has occurred/stalled.
Gateway validation and ServiceQ must adopt this receipt schema before clients.
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

## Обновления хостов (0.2.6)

Панель показывает выбранную версию пакета для новых сессий, последний стабильный релиз, реально работающие версии монитора и прокси, состояние подписки и updater. Старый активный proxy отмечается как ожидающий новых сессий; выбранный пакет не выдаётся за версию активного агента. Устаревший снимок не подтверждает ни подключение подписки, ни успешное применение.

## Native Headroom counters (0.3.0 candidate)

The monitor reads the public loopback `/stats` endpoint of the verified local
Codex proxy. Only eight numeric `codex_ws_*` fields leave the host: attempted,
compressed and failed frame counts, bytes before/after, estimated removed tokens,
and average/maximum processing time. Request logs and configuration are discarded.
A timeout, incompatible response or invalid number yields `native_stats_unavailable`;
missing counters are never reported as zero. Legacy proxies keep their old collector.

The panel shows these separately under process counters. Frames are protocol
messages, not user turns. They reset on restart and can include repeated context.
Estimated removed tokens do not account for cache pricing or later CCR retrieval
and are not paid savings. These aggregates supplement per-turn native traces.
Update the gateway and panel before candidate clients: older gateways reject the
new metric names/reason rather than silently discard them.


Telemetry contract: see [TELEMETRY-DELIVERY.md](TELEMETRY-DELIVERY.md#telemetry-contract-v1).
The dashboard template no longer charts process counters or queue ages as Scores.
Those remain available in snapshot metadata and the ServiceQ panel. Existing
Langfuse dashboards require reprovisioning; existing mixed historical Scores are
preserved and must be excluded from new operational charts.

The runtime is `src/serviceq-server.js`, covered by the existing stable integrity validator. `scripts/serve-serviceq.js` preserves the server/report entrypoint without expanding the installed validator allowlist.
