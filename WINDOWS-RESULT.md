# Windows qualification — 2026-10-10

Agent Context 0.1.1 installed globally for current user. Standalone local Git repository; no public registry/repository publication. Upstream SuperCompress source files no longer own this integration.

- 21 tests passed: selector, unchanged query, exact-error guard, HTTP failure/timeout fallback, no repeat API request, session concurrency, metadata privacy, Claude response preservation, all three config adapters, exact-byte rollback, later-edit refusal, Hermes legacy-plugin preservation/restore, instruction migration, project override detection, install/rollback concurrency and native JSONL/Content-Length MCP framing.
- Doctor healthy: recipe integrity verified, Codex/Claude configured, current key available without environment conflict, zero stale session locks. Hermes absent on Windows; adapter covered by isolated config/protocol tests.
- Configured Codex MCP subprocess: 1850 ms, 630 → 198 tokens; exact ERROR ECONNREFUSED db.internal:5432 retained, identical repeat skipped.
- Configured Claude MCP subprocess: 1664 ms, 630 → 198 tokens; error retained, repeat skipped.
- Claude hook command: stdout 3875 → 1125 characters; stderr, exitCode and exact error preserved.
- Earlier generic hook query produced a lossy CCR response. Guard rejected it and kept original stdout. The final recipe explicitly requests verbatim ERROR/FATAL/Traceback lines; final hook proof passed. Quality guard remains necessary.
- Installation transaction `1791639612201-20236` retains original configs and instructions privately. Replacing package code at the same installed path did not create a new config transaction. Rollback command: `agent-context rollback`; drift is refused, not overwritten.
- TaskQ heartbeat status confirmed PAUSED. No tick, queue dispatch, production operation, app restart or paid model turn was run.

Not proved: reloaded GUI MCP connections, full Claude model-session hooks, live Hermes client and actual total model-input savings. Native subprocess tests do not establish those claims. Mac qualification is delegated separately.

Raw sanitized native results remain in the local ignored `evidence/` directory. Credentials and private config backups are never distributed with the package.
