# Interim implementation

User-authorized delivery track, 2026-10-12. PRODUCT R11 clean-build experiment remains saved for later; this candidate retains the existing installer, updater, proxy transport and telemetry.

Default recipe becomes local-tools: native RTK for qualified test/build/log commands, context-mode MCP for explicit large-reference lookup. Proxy performs no broad content shortening. Claude uses a narrowly scoped native PreToolUse rewrite; Codex uses explicit native command routing, no compression hook. Code/JSON/dense/short inputs remain normal. Actual coverage must be reported, not claimed automatic on every Codex command.

Keep normal login/model/approval and native telemetry trust. Install private pinned tools under managed package state; uninstall removes these private dependencies through existing ownership cleanup. Do not install upstream broad routing hooks or make unrelated tools unavailable.

Gate: existing npm test + npm pack, native protected/error cases, live Codex CLI, Claude CLI and Claude Desktop Code, then qualified fleet rollout without interrupting active sessions. Store per-run RTK estimates separately from actual model usage; context-mode lookup is not automatically net savings.

R9 statistics reader correction (user-authorized): ServiceQ and its read-only agent
report consume legacy compression and native-tool observations separately. Deduplicate
native events by stable event ID within device identity; fall back to observation ID
when unavailable. Show RTK estimated input/output, sample count, session/call linkage,
explicit production/qualification/unknown origin and native command exits separately
from compression failures. Unknown origin must not become production. Missing sizes
remain unavailable; preserve negative reductions. Legacy character counts are never
added to token estimates or model usage. Existing native spans use delivery time;
state this limitation, not an invented operation timestamp. Bound all source reads,
show truncation and exclude synthetic roots. Host/agent/session filters use the same
reader for the UI and agent JSON report; neither returns raw commands/conversations
or credentials. Model usage retains per-model input/cache/output/reasoning fields,
each with its own sample count; overlapping fields are not added together. Reported
cost is separate from savings and invoices. Do not change native routing, hooks or
histories in this reader fix.
Acceptance: mixed units, missing IDs/sizes/origin, replay with a new span ID,
nonzero command exit, zero/negative reduction, empty/incomplete windows and private
metadata; check rendered UI and actual Langfuse readback before ServiceQ adoption.

Stable interface: one agent_context MCP, three tools (index_document/search_document/get_original); tools run CLI accepts native command arguments. Engines remain internal. Never inject tools through proxy. Preserve normal client sandbox; use bounded temporary run state when managed state is protected. Report unavailable telemetry and expired recovery references.

Release hardening (R4/R6/R8–R10), revised by user: native OS manager owns a small supervisor and permanent TCP ingress; versioned workers own the request logic. Stage a worker on a separate local port, verify identity/readiness, atomically select it for new TCP connections. Existing HTTP/SSE/WebSocket connections retain their worker. Keep at most two workers; serialize updates. Retain previous worker for rollback within the initial 15-minute retirement window. After that window request graceful exit, allow 30 seconds, then terminate the remaining owned process tree and record an incident. Installation owns the telemetry queue; a cross-process lease gives one sender per queue. Monitor actual active/retiring versions, connections, retirement deadline, backlog and errors. Qualify long requests, idle sockets, native Codex/Claude reconnection, failed stage/worker, rollback and queue preservation. A one-time legacy-listener migration is distinct from subsequent updates. Use standard Node TCP piping, not a custom HTTP stack or replacement for systemd.

Native Stop hooks enqueue locally and return promptly. Our service owns conversion/export retries, bounded durable queues and recorded failures. Existing OTLP collector remains the outbound delivery boundary. Native IDs and actual usage survive; confirmed acknowledgements, queued conversion, collector acceptance and Langfuse readback are distinct. Do not repeatedly parse/export a whole growing conversation in the synchronous hook. Preserve original rollout data and native hook trust. No unbounded retries, raw error/secret export or restart loop for permission/auth/configuration failures.

R9 Stop output uses Codex's shared hook response fields (`continue: true`, `suppressOutput: true`); internal queue receipts are not hook responses. Qualification covers the actual CLI stdout as well as retained queue state.

R9 native turn snapshots use a private per-job sessions root with the exporter's expected YYYY/MM/DD layout. Exporter discovery stays inside that snapshot root; it must not walk the installation's parents. Snapshot cleanup removes only the worker-owned temporary root, never pending jobs or native progress.

Final rollout: qualify CLI and isolated transports before Mac/Windows/FRA adoption; do not test or stage changes in busy Claude Desktop. Install only the final qualified package there. Audit supported client profiles and remove confirmed obsolete owned registrations, hooks, services and dependencies; preserve login, credentials, unrelated settings and active work. Windows uses pinned WinSW with native UAC/credential entry and the installation owner account. Direct and gateway OTLP exports select Langfuse v4 ingestion; verify observations through API v2.

R9 telemetry correction: ingress and worker share the installation control token. Failed native-event delivery records a sanitized incident and retains the event for retry; acknowledgement prevents resubmission. Claude SDK uses LANGFUSE_FLUSH_AT=1 to avoid oversized multi-span batches at the 4 MiB collector boundary. This does not guarantee acceptance of an oversized individual span or recover historical failed exports. Gate: installer configuration, 403 retention/incident/retry, shared-token transport, npm test and npm pack.

R6 qualification fixture correction: packaged Python collector tests create their own launcher in the temporary installation home before invoking the real Windows ACL-protected outbox writer. Test isolation must not depend on the working installation; failed qualification keeps the active package and queues unchanged.

R9 Codex exporter batching: use128spans per batch instead of1 to keep a flush of the default2048span SDK queue below its30 concurrent export limit. The existing4MiB collector limit and retry retention remain; batching does not guarantee export of an oversized individual span. Qualify a retained native turn that reproduced the concurrency failure.

Lifecycle notice correction: a Claude launcher route override describes routing and unverified proxy telemetry only. Local RTK/MCP coverage is independent; no broad proxy compression or automatic child-process coverage is claimed. Codex routing and hook behavior remain unchanged. Retire only confirmed experimental registrations with protected backups; preserve unrelated hooks and cached active sessions.

R9 oversized batch correction: Codex exporter fails closed and retries a retained turn with128,32,8span batches only after an explicit SDK HTTP413. At most3exports per queue attempt; authentication,concurrency andother errors do not trigger payload retries. Existing retrybackoff/nativeprogress remain. An oversized individual span or SDKconcurrency at the smallest batch stays needs_attention; no truncation or eventdrop.

Exhausted HTTP413 retries expose payload_too_large through the shared diagnostics. Deploy the gateway metric validator and ServiceQ reader before advertising0.4.14 clients.

R9 collector retry survival (FD1/FD5): an outbox/lease filesystem failure records the existing safe queue_unreadable category and retains packets. The existing five-second sender loop remains alive after the failure; restored access allows the next ordinary attempt to send identical bytes. Cancellation still stops the loop. Do not change ACLs, force a lease, restart active sessions or bypass acknowledgement. Qualify a sender.lock open failure followed by ordinary recovery; this does not establish the cause of a historical Windows updater failure.

R6/R9 patch compatibility: candidate integrity manifests must remain acceptable to the installed stable validator and launcher. ServiceQ runtime belongs in `src/` (already hash-checked by 0.4.15); `scripts/serve-serviceq.js` remains a thin compatible entrypoint. Do not add a manifest path rejected by the previous validator or weaken its checks. Qualify the packed archive with the actual 0.4.15 `checkPackage` before stable promotion; a candidate checking itself does not prove upgrade compatibility.
