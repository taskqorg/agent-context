# Agent Context

One local, versioned SuperCompress recipe. No service, provider proxy, daemon, TaskQ dependency or edits to upstream npm files. Node 22+; macOS, native Windows and Linux/WSL.

Public source: https://github.com/taskqorg/agent-context. Release/adoption and future update policy: [DISTRIBUTION.md](DISTRIBUTION.md). Automatic updates are not implemented in this release.

## Install

```sh
npm install -g ./alexkirs-agent-context-0.1.2.tgz
agent-context install codex claude hermes
agent-context doctor
agent-context verify codex
agent-context verify claude
agent-context verify hermes
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

## Adapters

| Agent | Installed path | Behavior |
|---|---|---|
| Codex | `~/.codex/config.toml`, `AGENTS.md` | MCP; legacy compression hooks removed. No automatic replacement of native tool output is claimed. |
| Claude Code | `~/.claude.json`, `~/.claude/settings.json`, `CLAUDE.md` | MCP for other context; one Bash PostToolUse hook replaces stdout only, preserving stderr and response fields. |
| Hermes | `~/.hermes/config.yaml`, `AGENTS.md` | Native MCP; legacy SC hooks/plugin disabled with backup. No invented Hermes hook API. |

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

`verify <agent>` uses the configured native MCP executable/args with synthetic context, checks an exact error and a duplicate. Claude also runs the configured equivalent hook command, preserving stderr and exit code. It does not run a paid model turn or prove that the GUI client has reloaded. Finish acceptance with a real hook/MCP call in each running client.

```sh
agent-context rollback
agent-context doctor
```

Rollback restores exact previous file bytes and legacy Hermes plugin files for the latest installation. It refuses if a touched config or backup has changed, before applying any restoration. Reconcile such changes privately; do not force overwrite. Repeated no-op install retains the previous rollback point. Rollback also requires MCP reload; old config may intentionally fail our doctor afterwards.

Install and rollback share one transaction lock. A lock left by a crashed installer is reported; inspect its journal before manually clearing it. No automatic forced unlock.

## Update

Install only a reviewed package version. Test candidate in an isolated user home, verify native adapters, then install and run doctor/verify. The package is independent of `supercompress-proxy`; its npm update cannot overwrite this code. Re-running upstream setup/plugin may rewrite registrations; doctor detects that drift. No auto-update or automatic queue resume.

```sh
npm ci --ignore-scripts
npm test
npm pack
```

Two pinned config parsers are the only dependencies. `npm test` regenerates local source hashes; `prepack` checks them. The transferred archive SHA256 is the distribution pin; local hashes detect accidental file drift, not malicious tampering.

Sources: [SuperCompress agents](https://docs.supercompress.dev/coding-agents), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks), [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/).
