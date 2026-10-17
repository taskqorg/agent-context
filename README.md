# agentq

agentq installs, routes and observes context optimization for Codex, Claude Code and Hermes on one host. One static binary per OS; no Node, npm or toolchain on the host. Decisions: [agentq.md](agentq.md). Product outcomes: [docs/spec/PRODUCT.md](docs/spec/PRODUCT.md).

## Install through an agent

Paste into a supported agent:

> Install agentq from https://github.com/taskqorg/agentq. Read INSTALL.md, run onboarding, and report what works and what still needs setup.

Native Windows and WSL are separate installs. Procedure: [INSTALL.md](INSTALL.md).

## Commands

- `agentq compress <agent>` reads one tool-result JSON object (`adapter`, `tool`, `text`) and returns `text` and a recovery `ref`. Unqualified hook/provider recipes pass unchanged. `agentq stats [--json]` shows local call outcomes and bytes; missing or corrupt records are unknown.
- `agentq profile [--json]` ranks compression and export operations by time, failure rate and variance against their budgets over the last 7 days; operations without readable samples, and proxy requests, read unknown. `agentq profile trace on [<minutes>]|off` records per-step traces for at most 60 minutes.
- `agentq onboard` finds ready agents and a legacy install; writes nothing. `agentq onboard --yes [codex|claude|hermes..]` applies config edits, installs the service and prints what to verify by a real turn.
- `agentq langfuse` reads the Langfuse host and keys from hidden stdin into protected storage. `agentq telemetry status|verify` shows the queue and checks delivery.
- `agentq service status`, `agentq update [--check]`, `agentq selftest` check the install.
- `agentq doctor` reads installation, service, routing intent, engines and local telemetry health. Intentional detach is distinct from drift; runtime verification remains separate.
- `agentq uninstall --dry-run`, then `agentq uninstall`, restores owned edits and removes the service and install folder.

Releases: [taskqorg/agentq releases](https://github.com/taskqorg/agentq/releases), one `agentq-<ver>-<os>-<arch>` binary per platform plus `SHA256SUMS`. Check a download with `sha256sum -c SHA256SUMS --ignore-missing`; trace it to the workflow run that built it with `gh attestation verify <file> --repo taskqorg/agentq`.

## Temporarily disable optimization or integrations

Available in 0.8.0. Isolated Mac CLI checks prove Codex pause/resume, cached-session continuity and Direct-baseline restore, plus Claude auto-mode pause/resume and disable/enable in one active session. Actual Linux systemd disable/reboot/enable and original retention passed. Desktop, Mac/Windows service lifecycle and Codex routed service-baseline restoration remain unqualified. Exact artifacts and open gates: [qualification record](docs/spec/INTEGRATION-CONTROL-PLAN.md#implementation-candidate-and-remaining-qualification). Contract: [temporary controls](agentq.md#temporary-controls).

```sh
agentq status
agentq status --json
agentq optimization off             # host compression switch; integrations keep working
agentq optimization off claude      # only Claude's compression preference
agentq optimization on              # preserve individually disabled agents
agentq optimization on claude       # remove Claude's individual pause
agentq disable codex --dry-run      # preview owned changes and affected aliases
agentq disable codex                # detach Codex routing, MCP and hooks
agentq enable codex                 # restore only the saved supported integration
```

`disable` and `enable` without an agent select this installation. Other targets are `claude`, `hermes` and `claude-desktop` (Desktop Chat: integration only). CLI/Desktop aliases sharing a profile switch together; workers using that installation/profile follow it. No command selects one worker or discovers sibling installations.

Compression switches affect new results without a restart. Full detach preserves installation, data, originals, credentials, grants and queued observations under their retention limits. Enable preserves a prior Direct state, absent optional registrations and compression preferences; a later foreign edit is kept and reported. Repeating a command never replaces its original recovery baseline. Only enable clears disable intent; onboarding, configure and service activation cannot reconnect it.

Old clients may retain their provider, hooks or MCP connection. Status shows requested integration, observed configuration, effective compression reason and `pending_reload`/`pending_drain` separately. Close or reload affected clients normally and repeat disable to finish. An idle socket or elapsed timeout is insufficient proof to stop transport, and unknown inventory remains pending. A stopped service still permits local status and enable. Claude auto mode compresses successful Bash results through PostToolUse without changing the command or permissions; failures remain native. Older PreToolUse-only auto profiles require explicit hook configuration; enable preserves their saved registrations. `direct` remains a routing-only emergency bypass: it does not disable Claude's compression hook.

An unidentified Python, Node or Electron process can hold a client session. Unless it is an owned service child, the dependency inventory stays unknown and automatic service shutdown waits. Native service-registration read failures also remain unknown. Enable preserves whether the saved service was loaded, including an idle service with no live process.

## Check installed client compression

With Python 3.9+, cargo, the installed client and its usual login:

```sh
agentq check compression both
agentq check compression codex --fixture pytest
# Or: codex / claude. --codex PATH / --claude PATH select a specific version.
# The source checker remains scripts/check-client-compression.py.
```

This opt-in live check uses the current client settings and paid model access. It creates a temporary dependency-free crate (180 passing tests and one intentional failure), asks each real CLI to run ordinary `cargo test` once, and checks session-correlated compression stats, a model-visible recovery reference and complete original recovery. It never asks the client to invoke `agentq run` manually or changes routing, hooks, credentials or services.

For a read-only Codex CLI, use `--fixture pytest` with real pytest on PATH. The same 180 passing tests and one failure run without pytest cache writes. The checker never installs dependencies or changes sandbox policy. When code-mode tool calls are absent from CLI stdout, it reads only that session's native local transcript; missing evidence stays unknown.

Exit 0: both integrations proved compression. Exit 1: failed or unproved; `report.json` distinguishes `fail` (native tool ran without compression proof) from `unknown` (missing prerequisite, client did not run, timeout or unreadable stats). The managed Headroom Python is reused when present. Windows can locate Codex's embedded CLI; this does not qualify the Desktop UI. Private logs and fixture stay in the printed directory. `--output DIR` selects it; each client has a 120 s deadline (`--timeout 30..300`). A green `selftest`, healthy service or proxy traffic alone cannot pass this check. Ordinary CI runs only the verdict checks, never paid clients.

## Local telemetry

Collection needs no Langfuse/server connection. Compression events, bounded profiling and existing producer events live in installation-local SQLite/WAL. `agentq stats --records` exports compression metadata for qualification; `agentq telemetry export` emits versioned JSONL for analysis. `agentq profile --json` ranks retained durations and failures. Local completeness and missing native usage remain unknown; byte reduction is not billed-token savings. Legacy files are preserved for migration/rollback. See [transition](docs/spec/TELEMETRY-QUALIFICATION.md#agentq-sqlite-transition).

## Legacy Node package

The Node package `@alexkirs/agent-context` (`agent-context` CLI, gateway) is retired under [agentq.md § 10](agentq.md#10-legacy-node-install); its code is gone from this repository. `agentq onboard --yes` removes an installed copy through its own uninstall; `agentq uninstall --legacy` does the same alone.

Shared rules: [specq](https://github.com/taskqorg/specq).

Compression qualification: [benchmark and native-client checks](docs/spec/COMPRESSION-BENCHMARK.md).
