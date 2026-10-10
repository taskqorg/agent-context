# Distribution and project adoption

Agent Context is developer tooling: a local integration layer for coding agents' context management. It is independent of game/application code, TaskQ queue orchestration and LangGraph services. New integrations belong here only when they share the same local lifecycle and supported agent adapter contract.

Canonical source: https://github.com/taskqorg/agent-context

## Release

One Git tag identifies one reviewed recipe. Test on native macOS, Windows and Linux; separately record actual Codex/Claude/Hermes usage, since mock and subprocess tests do not prove client loading. Package via `npm pack`, attach the tgz and SHA256 to a GitHub release. Candidate releases remain prereleases and must not feed a stable automatic updater. Never modify an existing released asset/tag to change code.

GitHub releases are sufficient for initial public distribution; publishing to npm is optional and not configured. The package's `private` flag prevents accidental npm publication.

User onboarding and full removal are defined in [INSTALL.md](INSTALL.md). Developers clone the public repo, run `npm ci --ignore-scripts`, `npm test`, `npm pack`, then qualify `setup` and `uninstall` in an isolated profile. A project onboarding document links to this one canonical recipe instead of copying hook scripts/config/key instructions into every repository. GitHub source installation is an explicit candidate adoption, separate from stable release qualification.

## Project pin and automatic updates

Recommended project declaration, once a manifest-aware updater is implemented:

```json
{
  "schema": 1,
  "repository": "taskqorg/agent-context",
  "compatible": "0.1.x",
  "updateChannel": "stable"
}
```

The project manifest remains a design contract, not a consumed file. Version 0.1.5 implements user-level automatic stable patch updates through the fixed taskqorg/agent-context source; project-specific compatibility arbitration is not implemented.

One updater per OS user checks approved stable releases at most daily on MCP/hook startup, not on every tool call or once per project/agent. Install candidates in an immutable version directory, verify the archive digest and compatibility, run isolated self-tests, then atomically select that version through a stable launcher. Keep the previous package and config transaction for rollback. Current MCP sessions retain their loaded version until a supported reload; never kill active clients automatically.

Only compatible patch updates should apply automatically within 0.x. A new minor/major, changed hook permissions, config drift or failed self-test requires explicit migration. Failed update retains the last working version. Projects requiring incompatible versions must be reported; do not silently switch global state back and forth on project entry.

Windows-native and WSL are separate installations. Resolve runtime/platform from the executing agent, not the project storage path. Additional agent profiles are explicit installations, not assumed global coverage.

## Maintenance

Keep runtime health separate from aggregate telemetry: compression succeeds without the LangGraph/statistics backend. Local events have bounded metadata only. Incident reports group by recipe + agent + failure category; never attach keys or source context automatically. No automatic upstream patching or retry storm.

Use project bootstrap/readiness checks to diagnose installation, compatibility and stale client versions. Avoid silently modifying every developer's global settings during `npm install` of an unrelated application.

## Qualification asset

Publish `recipe.json` only after CI on all three OS platforms and actual-client qualification. Candidate/prerelease assets never qualify as stable. Example schema (replace version, archive and digest with the reviewed release):

```json
{"schema":1,"version":"0.1.5","launcherSchema":1,"adapterContract":1,"platforms":["win32","darwin","linux"],"clients":["codex","claude","hermes"],"archive":"alexkirs-agent-context-0.1.5.tgz","sha256":"<archive-sha256>"}
```

The fixed launcher is not rewritten automatically. Changes to its schema require an explicit installer migration. Failed staging directories are preserved for diagnosis; automatic garbage collection is not enabled. Rollback pauses updates and keeps configuration untouched.

Full `uninstall` is separate from either rollback: it reverses retained completed installation journals, preserves later unrelated owner settings, stops only verified idle owned services, removes the managed directory and its Python environment, and uninstalls an identified global npm package. It refuses ambiguous state; shared credentials, agent login, external traces/issues and user/npm-owned download caches remain. Restoring a configuration snapshot may restore prior third-party integrations; the onboarding/removal procedure discloses this.
