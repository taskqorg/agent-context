# Distribution and project adoption

Agent Context is developer tooling: a local integration layer for coding agents' context management. It is independent of game/application code, TaskQ queue orchestration and LangGraph services. New integrations belong here only when they share the same local lifecycle and supported agent adapter contract.

Canonical source: https://github.com/taskqorg/agentq

## Release

One Git tag identifies one reviewed recipe. Test on native macOS, Windows and Linux; separately record actual Codex/Claude/Hermes usage, since mock and subprocess tests do not prove client loading. Package via `npm pack`, attach the tgz and SHA256 to a GitHub release. Candidate releases remain prereleases and must not feed a stable automatic updater. Never modify an existing released asset/tag to change code.

GitHub releases are sufficient for initial public distribution; publishing to npm is optional and not configured. The package's `private` flag prevents accidental npm publication.

User onboarding and full removal are defined in [INSTALL.md](INSTALL.md). Developers clone the public repo, run `npm ci --ignore-scripts`, `npm test`, `npm pack`, then qualify `setup` and `uninstall` in an isolated profile. A project onboarding document links to this one canonical recipe instead of copying hook scripts/config/key instructions into every repository. GitHub source installation is an explicit candidate adoption, separate from stable release qualification.

## Project pin and automatic updates

Recommended project declaration, once a manifest-aware updater is implemented:

```json
{
  "schema": 1,
  "repository": "taskqorg/agentq",
  "compatible": "0.1.x",
  "updateChannel": "stable"
}
```

The project manifest remains a design contract, not a consumed file. Version 0.1.5 implements user-level automatic stable patch updates through the fixed taskqorg/agentq source; project-specific compatibility arbitration is not implemented.

One updater per OS user checks approved stable releases hourly through the persistent monitor, including idle hosts. The monitor holds an outbound HTTPS long poll to the team gateway; publishing and signing an approved stable release wakes connected hosts. A new version notification can trigger one early check; retries retain backoff and explicit disable is respected. MCP/hook startup also provides the hourly fallback. Install candidates in an immutable version directory, verify the archive digest and compatibility, run isolated self-tests, then atomically select that version through a stable launcher. Keep the previous package and config transaction for rollback. Retain all older runtime directories: busy proxies can still invoke their compression bridges after several updates. Current MCP sessions retain their loaded version until a supported reload; never kill active clients automatically.

Only compatible patch updates should apply automatically within 0.x. A new minor/major, changed hook permissions, config drift or failed self-test requires explicit migration. Failed update retains the last working version. Projects requiring incompatible versions must be reported; do not silently switch global state back and forth on project entry.

Windows-native and WSL are separate installations. Resolve runtime/platform from the executing agent, not the project storage path. Additional agent profiles are explicit installations, not assumed global coverage.

## Maintenance

Keep runtime health separate from aggregate telemetry: compression succeeds without the LangGraph/statistics backend. Local events have bounded metadata only. Incident reports group by recipe + agent + failure category; never attach keys or source context automatically. No automatic upstream patching or retry storm.

Use project bootstrap/readiness checks to diagnose installation, compatibility and stale client versions. Avoid silently modifying every developer's global settings during `npm install` of an unrelated application.

## Qualification asset

Publish `recipe.json` only after CI on all three OS platforms and actual-client qualification. Then run the `Sign release recipe` workflow for the tag: it attaches `recipe.json.sig` (Ed25519, key in the `AGENT_CONTEXT_RELEASE_SIGNING_KEY` secret). Clients from 0.1.13 refuse unsigned recipes. The recipe may set `paused: true` (kill switch) or `rolloutPercent` (staged rollout). Candidate/prerelease assets never qualify as stable. Example schema (replace version, archive and digest with the reviewed release):

```json
{"schema":1,"version":"0.1.5","launcherSchema":1,"adapterContract":1,"platforms":["win32","darwin","linux"],"clients":["codex","claude","hermes"],"archive":"alexkirs-agent-context-0.1.5.tgz","sha256":"<archive-sha256>"}
```

From 0.2.6, `setup` registers a persistent per-user monitor using the stable launcher (LaunchAgent, Windows logon task, Linux user systemd). Existing pilots need reviewed `update bootstrap --migrate` and `monitor install --migrate`; these migrate the package and monitor without rewriting agent login/config or interrupting active proxies. Linux starts with the user manager; it requires lingering for operation after logout. GitHub Actions notifies the gateway after signing and stable publication; the gateway independently verifies the release signature and archive descriptor, with a 60-second source check as fallback. Source pushes and prereleases never trigger installation. The monitor reloads a newly selected verified runtime within five seconds; existing agent sessions retain their loaded version. ServiceQ shows selected package, available stable release, monitor/proxy versions, subscription and update state separately. No inbound ports or service keys on staff machines are required for notifications.

The fixed launcher is not rewritten automatically. Changes to its schema require an explicit installer migration. Failed staging directories are preserved for diagnosis; automatic garbage collection is not enabled. Rollback pauses updates and keeps configuration untouched.

Full `uninstall` is separate from either rollback: it reverses retained completed installation journals, preserves later unrelated owner settings, stops only verified idle owned services, removes the managed directory and its Python environment, and uninstalls an identified global npm package. It refuses ambiguous state; shared credentials, agent login, external traces/issues and user/npm-owned download caches remain. Restoring a configuration snapshot may restore prior third-party integrations; the onboarding/removal procedure discloses this.

From 0.2.9 the gateway and clients read `/releases/latest/download/recipe.json` directly, pin its signature and archive downloads to the recipe version, and verify the Ed25519 signature and signed archive SHA-256. Update discovery/download never calls the REST API or needs a GitHub token. Publish all signed assets before promoting a release to stable/latest. Background gateway discovery shares a one-hour cache; release notifications refresh it early, bounded to once per 10 seconds. Client hourly fallback remains independent.
