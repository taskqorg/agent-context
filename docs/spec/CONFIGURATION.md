# Client integration configuration

Accepted target under agentq.md §§ 4/6/8 and PRODUCT R1–R5/R7/R9. Extends [enrollment](ENROLLMENT.md) with separately authorized typed configuration; observation enrollment remains unchanged. DashQ owns the [consumer interface](https://github.com/taskqorg/dashq/blob/main/docs/design/agentq-settings.md). Not a claim that remote management is shipped.

## A1. Scope and ownership

Manage existing Codex, Claude Code, Claude Desktop Chat and Hermes integrations: owned routing, agent_context MCP, supported hooks/plugin and qualified tool-result optimization. Exclude client login, model/provider selection, sandbox/approvals, foreign instructions, TaskQ work/admission and arbitrary commands. Engine versions and qualified recipes remain release-pinned, not client choices.

Reuse discovery, ownership journal, lifecycle lock and existing apply/restore functions. Discover actual configuration roots locally; use stable opaque profile IDs without exporting paths. Clients sharing a configuration root are aliases of one target: display every affected alias in review, never promise isolation between them. Project overrides are reported read-only; conflicts with foreign providers/optimizers block affected writes.

Codex Direct removes owned routing and bypasses its provider compression while retaining MCP/telemetry. Claude Code Direct retains the qualified command hook. Hermes uses its plugin rather than provider routing. Desktop Chat supports MCP only. Unsupported fields are explicit, not off/zero. Per-agent compression defaults remain; profile overrides must be additive and capability/version gated, never silently alter sibling profiles or host-wide enabled/min_bytes/stats settings.

## A2. Extended snapshot

Add an optional versioned profile-configuration projection to schema 1; keep existing routing/engine/queue/resource fields compatible. Older producers have unknown configuration capability. Export only bounded typed fields:

- installation/runtime, source observation time, profile schema version and configuration revision;
- profiles: opaque ID, known client kind/aliases, sanitized owner-approved display label, supported operations and unavailable reasons;
- observed routing enum, MCP registration, supported hook/plugin state, optimization preference and effective adapter/state; distinguish configured from verified;
- ownership/conflict flags and fixed reason codes, required client reload and affected target IDs; no raw config or free-text errors;
- release-pinned engine version/readiness, host-wide compression defaults as read-only context;
- per-profile verification: state, observed time, adapter, configuration revision and safe evidence ID, or unknown/reason. No verification inferred from config bytes or service liveness.

Revision covers the actual relevant settings and ownership/conflict state; it changes after out-of-band edits. Missing, stale and future/clock-uncertain observations remain unknown. Use § 5's 90-second status freshness, preserving source time through delivery. Cap profiles and strings, flag truncation/incomplete discovery and disable writes on incomplete targets. Do not export paths, prompts, logs, credentials, arbitrary instructions or model content. The sender reuses its existing queue/cadence.

## A3. Plan and guarded apply

One AgentQ-owned typed operation family plans/applies configuration for one installation and selected profile IDs. Allowed changes: supported routing AgentQ/Direct, optimization enabled preference and explicit setup of owned MCP/hooks/plugin. No caller-supplied file, executable, shell, provider, URL or engine pin. Discovery/setup cannot silently invoke legacy removal, uninstall, incident publication or unrelated service/configuration changes.

The host computes a bounded plan with old→new values, affected aliases, owned edits, conflicts, reload requirements and expected configuration revision. Browser review confirms that exact plan. An edit, different target or changed revision invalidates confirmation. The host re-reads settings under the lifecycle lock immediately before mutation, verifies target/capability/revision and preserves unrelated settings. A changed or stale plan is rejected with the draft retained.

Apply uses the existing ownership journal and crash-recoverable atomic writes. Persist one immutable operation ID, actor/target/plan digest and result outside the telemetry-pruned queue, bounded in the existing installation state. Duplicate deliveries return the same result; changed payload under the same ID is rejected. Interrupted/partial writes reconcile or restore owned values without overwriting later foreign edits; expose partial/unknown state, never a false success. Do not reapply an ambiguous operation blindly.

After apply, read actual configuration and effective routing/adapter state from the selected host. A matching readback makes it configured, not verified. A new real client turn through that profile/adapter must produce evidence correlated to the applied revision before verified. Required reload remains visible; do not fabricate activity or disrupt an active conversation to obtain proof. Disabled optimization or Direct can verify their intended bypass behavior without claiming compression. Verification failure preserves original output/client access and reports its cause.

## A4. Authorization and transport

Use the enrolled service's existing outbound HTTPS loop and DashQ's existing store for bounded typed requests/results; no listener, remote shell, extra daemon or second scheduler. Publish the operation envelope and conformance fixtures before the consumer adapter. Keep machine result delivery distinct from authority to request mutations.

Require a separately approved `agentq.configure` capability bound to actor/workspace, installation and profile scope; an observation credential cannot grant or broaden it. Reuse the authenticated consent boundary with explicit configuration effects. Revoke, expiry and destination/generation changes invalidate unapplied operations. The host accepts only authenticated operations for its active installation/generation and locally supported scope. Unenrolled standalone use remains unchanged.

Operations expire after five minutes unless execution began with valid authorization; offline expired operations never apply later. Persist accepted/result state for reconciliation; do not prune unresolved mutations or claim cancellation/revocation undoes an already committed change. Test both race orderings and return the actual outcome. Refuse acceptance if durable control storage is unavailable/full. Bound payload to 16 KiB and one outstanding mutation per installation; subsequent requests retain drafts. Errors and audit data use safe codes, actor/target/revision/operation IDs, never config contents or secrets.

## A5. Qualification and release

1. Projection: old/new schema, missing/stale/partial/conflicting profiles, shared aliases and privacy leak fixtures; prove config revisions track external edits.
2. Host executor: supported/unsupported clients, exact diff, conflict/CAS rejection, scope isolation, duplicate/lost receipt, expiry/revoke, crash/partial rollback and effective readback. Existing local commands reuse the same authority.
3. Installed clients: configured vs verified, reload, real native turn, Direct and optimization-off behavior, original-output fallback, unchanged login/model/approvals and active work. Cover macOS, Linux, Windows and WSL where supported; Desktop Chat MCP-only and Hermes plugin-only behavior are explicit.
4. End to end: actual browser grant, wrong workspace/profile, read-only device, host action and correlated fresh readback/evidence with exact AgentQ/DashQ versions. Restore the approved baseline after qualification. Test failure is a gap, never a simulated pass.

Release projection/read-only UI independently. Enable writes only after the typed contract, host qualification and consumer security gates pass. Prototype approval does not authorize changing installed profiles or deploying a candidate.
