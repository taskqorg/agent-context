# Fleet diagnostics and bounded recovery

User-requested extension of the incremental rollout. Reuse incidents, monitor outbox,
gateway and ServiceQ; no separate log platform or conversation capture.

- FD1: Every owned failure boundary records a stable safe error code, component,
  operation, host/runtime/agent, actual process version, first/last occurrence,
  count and correlation IDs when available. Never serialize arbitrary exceptions,
  credentials, prompts or tool output into central events.
- FD2: Preserve concurrent problems. A single service reason must not hide other
  failures. Separate current active problems, recovered problems, historical
  incidents and unknown/stale observations; silence is not recovery.
- FD3: ServiceQ shows an affected host/agent, failed stage, safe explanation,
  queue size/oldest age, retry attempt/next eligibility, actual supervisor/worker
  versions and the next supported action. It links related metadata evidence.
- FD4: Local doctor and central dashboard consume the same structured diagnostics.
  A diagnostic snapshot remains available locally during central outages;
  the existing bounded monitor outbox retries delivery.
- FD5: Recovery uses existing guarded operations only: retry retained delivery,
  recover an owned stopped process and stage/rollback qualified workers.
  Record attempt, outcome and eligibility; apply bounded backoff and stop repeated
  ineffective repairs. Never interrupt active sessions, reset native progress,
  remove pending events or change login/model/approval/trust.
- FD6: Oversized payload, invalid configuration, missing dependency, credentials,
  trust and storage exhaustion become explicit needs_attention. No speculative
  cleanup, reinstall or permission changes.

First slice: replace generic native_export delivery_failed with stable cause/stage
diagnostics; propagate these through monitor and render current problems in ServiceQ.
Keep the existing incident protocol compatible; classify causes at their source.

Acceptance: reproduce exporter concurrency, timeout, unavailable collector and
missing acknowledgement; each has a distinct safe diagnostic visible locally and
centrally. An outage retains events, recovery is explicit, concurrent failures stay
visible and stale hosts remain unknown. Verify no secrets/raw conversation enter
the packet. Existing npm test + npm pack, native Windows qualification, then signed
canary rollout without stopping active sessions.

## First implementation

Native queue jobs retain only allowlisted failure codes. Current counts, attempts,
next retry eligibility and the last successful retry age form the shared doctor/monitor
summary. Queue removal after acknowledgement clears active failures; the separate
recovery receipt means exporter acknowledgement, not central delivery. Old jobs
without a cause remain unknown until retry. The existing incident timeline remains
historical and is not used to infer active failure.

Rollout order: qualify and deploy the gateway validator and ServiceQ reader before
advertising client0.4.12. Their metric allowlist grows while old snapshots remain
valid. No new producer metrics may be enabled against the old gateway validator.
First slice observes existing retries; it does not add automatic repair actions.

## Safe failure receipts and snapshot time (user-authorized)

FD1/FD4: On an ordinary native export failure, retain a bounded typed receipt:
job ID, actual wrapper version, occurrence time, stage, known Node error code or
numeric exit code, whitelisted signal, killed flag, captured stdout/stderr byte
counts, output-cap flag, elapsed time and known SDK conversion/flush phase.
An SDK HTTP status may be inferred only from its known flush-error format.
Missing information remains null/unknown. Never retain or export arbitrary error
messages, stacks, stdout/stderr, headers, prompts or tool results. Captured bytes
are not total emitted bytes after truncation. Local doctor and the monitor expose
the same last-failure receipt; ServiceQ labels it as the last observed failure,
not an explanation of every queued job. Preserve concurrent cause counts.

FD2/FD3: Retry and recovery ages belong to their source snapshot. Display their
source time and explicitly snapshot-relative wording; an elapsed eligibility
estimate does not prove a retry occurred or that the worker stalled. Stale
snapshots remain unknown. Keep existing queue IDs, retry/backoff, limits,
acknowledgements and native progress unchanged; no replay or speculative repair.

Acceptance: isolated numeric exit, spawn error, output cap, deadline and SDK
conversion/flush failures produce distinct safe receipts without private text.
Old jobs/snapshots without receipts remain readable. Reject unknown receipt
keys/values at the gateway, preserve nulls, and qualify the gateway/ServiceQ before
new client receipts. A delayed snapshot must not claim a current future retry.
Existing npm test/npm pack, all-OS CI, exact-SHA review, immutable signed patch;
use the next ordinary retained-job retry for actual-cause evidence. Do not
investigate native503 or change native trust/login/active sessions.

FD1/FD4 SDK diagnostic refinement: SDK flush receipts may include optional allowlisted `sdkErrorType` and `sdkFailure` fields. Classify only the root exception directly following the fixed flush/shutdown logger marker, including its inspected error-array layout. Map exact known public SDK messages to stable timeout/concurrency/export categories; unknown messages remain unknown. Never retain the message or infer timeout from duration. Older 15-field receipts remain valid. Qualify root-marker anchoring, unrelated-output rejection, privacy and old/new transport readback. Gateway/ServiceQ accept optional fields before new clients; retry policy, flush deadlines and exporter behavior stay unchanged.
