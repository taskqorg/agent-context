# Install and remove through an agent

This file is the procedure for Codex, Claude Code and Hermes when a user asks to install or remove agentq. Decisions: [agentq.md](agentq.md). Keep the user's login, model, approvals and sandbox. Never print keys, login files or whole configs.

## Install

1. Find the OS and runtime of the agent's user. Native Windows and WSL are separate installs; a Windows project opened in WSL does not make the Windows agent a Linux one.
2. Read `https://github.com/taskqorg/agentq/releases/latest/download/latest.json`. Download the file for the platform (`macos-aarch64`, `macos-x86_64`, `linux-x86_64`, `linux-aarch64`, `windows-x86_64`) and `SHA256SUMS` from `https://github.com/taskqorg/agentq/releases/latest/download/<name>` into a new temporary folder. Check the sha256; a mismatch stops the install. On macOS and Linux run `chmod +x`.
3. Run `<binary> onboard`. It lists ready agents, a legacy Node install and writes nothing. Detection is not installation.
4. Tell the user which agents were found and what changes, then ask once: "Found Codex and Claude Code. Connect both?" Skip the question if the user already named the agents.
5. On consent run `<binary> onboard --yes [codex|claude|hermes..]`. A legacy install is shown by its own dry run and removed only after the user answers `y` (agentq.md § 10). The command installs agentq into `~/.local/share/agentq` (Windows `%LOCALAPPDATA%\agentq`), applies agentq.md § 4 and installs the service. A named conflict stops that file; never replace a foreign optimizer or custom provider by guess.
6. Optional Langfuse: the user runs `agentq langfuse` in a local terminal and types the host and keys there; never ask for keys in chat. Then `agentq telemetry verify`.
7. Check `agentq service status` and `agentq telemetry status`. Start a new session of each selected agent and call `agent_context` `search_document`; reload clients normally, never kill other sessions.
8. Report: connected agents and version, service state, conflicts, telemetry, and what was verified by a real turn. Configured is not verified; unknown stays unknown.

## Remove

A user request to remove agentq allows this step.

1. Ask the user to close other sessions that use agentq.
2. Run `agentq uninstall --dry-run` and show what it restores and removes.
3. Run `agentq uninstall`. It restores owned edits whose value is unchanged, keeps later foreign edits and reports conflicts, removes the service, engines, data and install folder. Logins, shared keys and exported history stay. A second run prints `already removed`.
4. A legacy Node install is removed by `agentq uninstall --legacy [--dry-run]`, which runs its own uninstall.
