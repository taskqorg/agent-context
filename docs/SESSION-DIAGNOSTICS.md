# Find a failed agent request

Use native IDs, not display names. Keep queries bounded; never print credentials or whole transcripts.

1. Record agent, host, native/WSL runtime and error time in UTC. Codex: `CODEX_THREAD_ID` is the current session ID. Claude: use native `session_id` from hook/transcript metadata. Hermes: use its native session ID. Do not infer an ID from the OS username.
2. Run `node <home>/.agent-context/launcher.mjs doctor --live`. Read selected package separately from running front/worker versions and delivery status. This is health evidence, not request success.
3. Find the exact Codex transcript with `rg --files <home>/.codex/sessions` filtered by session ID; Claude transcripts live under `<home>/.claude/projects`. Inspect only the relevant turn/time range. Never rerun a failed model request just to find logs.
4. Query Langfuse with `langfuse-cli api observations list --session-id <native-id> --fields core,basic,trace_context,metadata,usage,model --limit 100 --json`. Read credentials programmatically from `<home>/.codex/langfuse.json`; use its `agent_context_base_url` upstream when `base_url` is loopback. Keep keys in subprocess environment; do not print them. The result list is `body.data`. Narrow by agent/host/runtime and time; distinguish native model usage, RTK estimates and retries.
5. Locate the owned proxy via `<home>/.agent-context/services/<agent>.json` and matching `proxies/*/ready.json` PID. Read the matching `proxy.log`, local `incidents` and queue statistics. Do not dump service state: it contains a control token. Retained native/export events are evidence; do not delete queues, clear exporter progress or blindly replay history.
6. Return: exact session/turn/time, active version, observed status, request/trace IDs where present, evidence and next action. Missing records or status means unknown. An OpenAI-shaped 503 body and adjacency to native compaction alone do not prove where the error originated. Native Desktop errors may not appear in the proxy log; use the client's diagnostic logs and report the gap.

The service already carries native session/turn IDs and a per-request `agent_context.request_id` when available. This recipe does not add a new recorder, claim complete transport-error coverage, or claim every native exporter was reloaded after an update.
