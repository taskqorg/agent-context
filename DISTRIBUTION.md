# Distribution and project adoption

Agent Context is developer tooling: a local integration layer for coding agents' context management. It is independent of game/application code, TaskQ queue orchestration and LangGraph services. New integrations belong here only when they share the same local lifecycle and supported agent adapter contract.

Canonical source: https://github.com/taskqorg/agent-context

## Release

One Git tag identifies one reviewed recipe. Test on native macOS, Windows and Linux; separately record actual Codex/Claude/Hermes usage, since mock and subprocess tests do not prove client loading. Package via `npm pack`, attach the tgz and SHA256 to a GitHub release. Candidate releases remain prereleases and must not feed a stable automatic updater. Never modify an existing released asset/tag to change code.

GitHub releases are sufficient for initial public distribution; publishing to npm is optional and not configured. The package's `private` flag prevents accidental npm publication.

Developers clone the public repo, run `npm ci --ignore-scripts`, `npm test`, `npm pack`, install the tgz globally and run `agent-context install`, `doctor`, and `verify`. A project onboarding document links to this one canonical recipe instead of copying hook scripts/config/key instructions into every repository.

## Project pin and future automatic updates

Recommended project declaration, once a manifest-aware updater is implemented:

```json
{
  "schema": 1,
  "repository": "taskqorg/agent-context",
  "compatible": "0.1.x",
  "updateChannel": "stable"
}
```

This is a design contract, not a manifest consumed by 0.1.2. Current updates are explicit; no automatic updater is enabled or claimed.

One updater per OS user should check approved stable releases at most daily/on agent startup, not on every tool call and not once per project/agent. Install candidates in an immutable version directory, verify the archive digest and compatibility, run isolated self-tests, then atomically select that version through a stable launcher. Keep the previous package and config transaction for rollback. Current MCP sessions retain their loaded version until a supported reload; never kill active clients automatically.

Only compatible patch updates should apply automatically within 0.x. A new minor/major, changed hook permissions, config drift or failed self-test requires explicit migration. Failed update retains the last working version. Projects requiring incompatible versions must be reported; do not silently switch global state back and forth on project entry.

Windows-native and WSL are separate installations. Resolve runtime/platform from the executing agent, not the project storage path. Additional agent profiles are explicit installations, not assumed global coverage.

## Maintenance

Keep runtime health separate from aggregate telemetry: compression succeeds without the LangGraph/statistics backend. Local events have bounded metadata only. Incident reports group by recipe + agent + failure category; never attach keys or source context automatically. No automatic upstream patching or retry storm.

Use project bootstrap/readiness checks to diagnose installation, compatibility and stale client versions. Avoid silently modifying every developer's global settings during `npm install` of an unrelated application.
