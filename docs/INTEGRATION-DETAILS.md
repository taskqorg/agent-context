# Подробности интеграций

One managed package for agent integration, compression, telemetry and recovery. Automatic mode uses local Headroom proxies with the paid SuperCompress adapter. Node 22+ and Python 3.11–3.13; macOS, native Windows and Linux/WSL. Version 0.1.11 is a qualification candidate, not a published release.

Сведения о квалификации 0.1.11 и прежних ручных адаптерах. Текущая установка/удаление: [INSTALL.md](../INSTALL.md).

Public source: https://github.com/taskqorg/agent-context. Release/adoption and future update policy: [DISTRIBUTION.md](../DISTRIBUTION.md). Compatible qualified stable patch updates are checked on agent startup, at most daily.

## Install

```sh
npm exec --yes --package ./alexkirs-agent-context-0.1.11.tgz -- agent-context setup
```

Absent agent directories are reported and skipped. Run verification only for installed agents. GUI agents use absolute Node and package paths, so shell PATH is not required. Normal Codex/Claude login is unchanged.

`install` takes private backups and journals changes under `~/.agent-context/backups`. It replaces only the SuperCompress MCP entry, legacy compression hooks and the owned compression instruction section. Other integrations and settings remain. Hermes legacy plugin files are moved to the private transaction backup outside its active plugin directory; rollback restores them. Unknown config layouts and symlinks are refused. No process is killed or restarted.

Reload the agent's MCP connection or restart that agent after installation. Current loaded connections may still run the previous module. A successful doctor is configuration evidence, not runtime evidence.

## Credentials

Reads `~/.supercompress/config.json` (`api_key`) or `SUPERCOMPRESS_API_KEY`. Conflicting values stop compression instead of silently using an old key. A shell-only export does not configure Finder-launched applications.

For a new key, use private stdin, not a command argument. In zsh:

```sh
read -rs 'SC_SETUP_KEY?SuperCompress key: '; printf '\n'
printf '%s' "$SC_SETUP_KEY" | agent-context set-key
unset SC_SETUP_KEY
```

This writes the existing config without changing unrelated values and keeps a private previous copy. It never prints the key. If doctor reports `key_conflict`, reconcile the inherited environment separately; the installer does not rewrite shell/login environments. Key rotation is separate from integration rollback.

## Legacy manual adapters (`install`)

`setup` installs automatic routing: Codex native provider + SessionStart, Claude base URL + SessionStart, Hermes native pre-request plugin. Retrieval MCP retains originals. Normal subscription login remains with the agent. Public sanitized reporting is disclosed during setup; use `setup --no-report` to opt out. `install` retains the older manual integration below.

## Adapters

| Agent | Installed path | Behavior |
|---|---|---|
| Codex | `~/.codex/config.toml`, `AGENTS.md` | MCP; legacy compression hooks removed. No automatic replacement of native tool output is claimed. |
| Claude Code | `~/.claude.json`, `~/.claude/settings.json`, `CLAUDE.md` | MCP for other context; one Bash PostToolUse hook replaces stdout only, preserving stderr and response fields. |
| Hermes | `~/.hermes/config.yaml` | Native MCP; policy arrives with the discovered tool description. Legacy SC hooks/plugin disabled with backup. |

Hermes does not load `~/.hermes/AGENTS.md` globally. Installation removes only this package's obsolete marker block there, with backup and rollback; it preserves unrelated text, SOUL, personalities and private prompts. Tool metadata makes the integration policy available wherever MCP is loaded; it does not force the model to call the tool.

The automatic Claude hook processes stdout of at least 2048 characters. It does not intercept user prompts or MCP results. MCP instructions explicitly avoid recompressing hook-managed Bash output. Hash deduplication is scoped to agent + session + context + query; unrelated sessions never share a global digest. There is no rolling context replay or global inbox.

Global means one OS user and the default agent profile. Additional profiles/project overrides require their own inventory. A Windows agent reading a WSL project still uses the Windows adapter; an agent running inside WSL needs a separate Linux installation. No project path is hardcoded.

## Compression contract

- Explicit CCR/compiler (`ccr: true`), never silently labelled Neural Keep.
- One HTTP request, 15-second timeout, no retry loop; outer Claude hook timeout 360 seconds.
- Maximum 100,000 context characters per request. Larger input bypasses compression unchanged.
- Query stays unchanged. Only new compressed context is returned.
- Errors, invalid replies, missing key, conflicting key, busy session and no gain preserve original context.
- Exact input lines beginning ERROR/FATAL/Traceback must survive. This is a bounded log check, not a guarantee that all prose facts survive.
- Failed input is not marked seen. Successful repeats return `already_seen` and empty new text.
- State stores only hashes, up to 256 successful digests per session. Stale crash locks are reported, not forcibly removed.
- Bounded local metadata log: agent, recipe, latency, status and sizes/token counts. No raw context, query, key or compressed response. Text savings are not total model-input savings.

## Check and rollback

`doctor` checks configuration, installed recipe hashes, credential conflict, stale locks and compression references in common config files of the current project. It cannot inspect every plugin, live client process or remote API condition. Run it from the project being checked.

In automatic mode `verify <agent>` checks the owned proxy service, a synthetic compression through the same bridge the proxy uses, and (Codex, Claude) a `headroom_retrieve` handshake with the configured retrieval MCP; it is not a model-session proof. In legacy mode it uses the configured native MCP executable/args with synthetic context, checks an exact error and a duplicate. Claude also runs the configured equivalent hook command, preserving stderr and exit code. It does not run a paid model turn or prove that the GUI client has reloaded. Finish acceptance with a real hook/MCP call in each running client.

Claude Desktop and other launchers may set their own `ANTHROPIC_BASE_URL` over `settings.json` env. Such a session bypasses the proxy: the SessionStart hook then shows a warning and tells the model that tool results are not compressed. Use the `claude` CLI for compressed sessions.

Headroom `/stats` and `headroom_stats` count model requests only: Hermes compresses through `/v1/compress`, and Codex WebSocket frames are not exported as Langfuse spans, so both can show near-zero there while compressing. Check `SC result` lines in the service `proxy.log` or Langfuse `headroom.compression.*` spans instead. The proxy raises Headroom's fixed 5s Codex WebSocket frame budget to 15s, the SuperCompress request timeout, so a completed paid call is not discarded.

```sh
agent-context rollback
agent-context doctor
```

Rollback restores exact previous file bytes and legacy Hermes plugin files for the latest installation. It refuses if a touched config or backup has changed, before applying any restoration. Reconcile such changes privately; do not force overwrite. Repeated no-op install retains the previous rollback point. Rollback also requires MCP reload; old config may intentionally fail our doctor afterwards.

Install and rollback share one transaction lock. A lock left by a crashed installer is reported; inspect its journal before manually clearing it. No automatic forced unlock.

## Update

Install only a reviewed package version. Test candidate in an isolated user home, verify native adapters, then install and run doctor/verify. The package is independent of `supercompress-proxy`; its npm update cannot overwrite this code. Re-running upstream setup/plugin may rewrite registrations; doctor detects that drift. Qualified stable patch updates are checked automatically; TaskQ queue state is never changed.

```sh
npm ci --ignore-scripts
npm test
npm pack
```

Two pinned config parsers are the only dependencies. `npm test` regenerates local source hashes; `prepack` checks them. The transferred archive SHA256 is the distribution pin; local hashes detect accidental file drift, not malicious tampering.

Sources: [SuperCompress agents](https://docs.supercompress.dev/coding-agents), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks), [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/).

## Automatic updates and rollback

Installation seeds a private version directory and a stable launcher under `~/.agent-context`. Agent startup schedules one bounded background check at most daily. No daemon, task queue or app restart is involved. Existing sessions keep their loaded version; new launches use the selected version. A Node installation with npm is required for staging updates.

Only stable releases from `taskqorg/agent-context` with matching GitHub SHA256 asset digests and a qualified `recipe.json` are eligible. The recipe must match the platform, all three client qualifications and launcher/adapter contract 1. The archive is installed with lifecycle scripts disabled and passes integrity plus isolated tests before atomic activation. A failed check keeps the old version. Minor/major changes require a migration. Downloaded releases are trusted maintainer code; digest checks establish integrity, not independent code review.

```sh
agent-context update status
agent-context update
agent-context update rollback
agent-context update enable
agent-context update disable
```

Package rollback validates and selects the retained previous runtime, then pauses automatic updates. Re-enable only after diagnosing the bad release. `agent-context rollback` is different: it restores the configuration transaction and preserves later edits by refusing drift. Both require client reload for already loaded connections.

Experimental Headroom + SuperCompress subscription tests and isolated commands: [qualification](https://github.com/taskqorg/agentq/blob/9612eeefcff773edd9c959f093fb76cf56acbc2c/docs/HEADROOM-QUALIFICATION.md).

Incident collection and recovery follow the [shared draft contract](INCIDENTS.md), aligned with TaskQ #612. `incidents report` delivers allowlisted metadata to an anonymous relay by default (server-side deduplication, counters and threshold-based issues; see `relay/`); `incidents enable --gh` instead posts through the user's own GitHub authorization. `incidents show` prints the exact pending packets. Fingerprints group by component, operation, category, agent, platform and release line. `doctor --fix` restores missing owned registrations, restarts owned services and rolls back corrupted managed code when a verified previous version exists. `doctor --live` checks owned proxy health; it is not model proof. Agent-assisted repair and the TaskQ native implementation remain pending.
