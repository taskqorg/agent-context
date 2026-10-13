# agentq

agentq installs, routes and observes context optimization for Codex, Claude Code and Hermes on one host. One static binary per OS; no Node, npm or toolchain on the host. Decisions: [agentq.md](agentq.md). Product outcomes: [docs/spec/PRODUCT.md](docs/spec/PRODUCT.md).

## Install through an agent

Paste into a supported agent:

> Install agentq from https://github.com/taskqorg/agentq. Read INSTALL.md, run onboarding, and report what works and what still needs setup.

Native Windows and WSL are separate installs. Procedure: [INSTALL.md](INSTALL.md).

## Commands

- `agentq onboard` finds ready agents and a legacy install; writes nothing. `agentq onboard --yes [codex|claude|hermes..]` applies config edits, installs the service and prints what to verify by a real turn.
- `agentq langfuse` reads the Langfuse host and keys from hidden stdin into protected storage. `agentq telemetry status|verify` shows the queue and checks delivery.
- `agentq service status`, `agentq update [--check]`, `agentq selftest` check the install.
- `agentq doctor [--fix]` is decided (agentq.md § 1) and not shipped yet; until then use `service status` and `telemetry status`.
- `agentq uninstall --dry-run`, then `agentq uninstall`, restores owned edits and removes the service and install folder.

Releases: [taskqorg/agentq releases](https://github.com/taskqorg/agentq/releases), one `agentq-<ver>-<os>-<arch>` binary per platform plus `SHA256SUMS`.

## Legacy Node package

The Node package `@alexkirs/agent-context` (`bin/`, `src/`, `agent-context` CLI, gateway) is legacy under [agentq.md § 10](agentq.md#10-legacy-node-install). `agentq onboard --yes` removes it through its own uninstall; `agentq uninstall --legacy` does the same alone. Its code stays here until a separate task removes it.

Shared rules: [specq](https://github.com/taskqorg/specq).
