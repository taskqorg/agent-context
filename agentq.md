# agentq contract

agentq installs, routes and observes context optimization for Codex, Claude Code and Hermes on one host. This file holds every decision for the Rust rewrite on [coreq](https://github.com/taskqorg/coreq). It follows the [specq release contract](https://github.com/taskqorg/specq/blob/main/engineering/release-contract.md) and [taskq.md](https://github.com/taskqorg/taskq/blob/main/taskq.md) § 4 and § 8 as the reference consumer. Product outcomes stay in [docs/spec/PRODUCT.md](docs/spec/PRODUCT.md) revision 2; § 11 maps each requirement here.

Status: decisions for implementation. The legacy Node package `@alexkirs/agent-context` is gone from this repository; installed copies keep working until § 10 removes them on a host.

## Principles

- **Spec first.** A change that alters a decision edits this file first; code, README and INSTALL follow. Only the owner accepts a decision change. AGENTS.md points here.
- **One static binary.** `agentq`, built from an empty Rust codebase (PRODUCT R11). No Node, npm or toolchain on the host. Python only for the headroom engine (§ 3).
- **Client only.** The client holds no relay, GitHub App, gateway server, serviceq panel or dashboard. Server duties belong to [dashq](https://github.com/taskqorg/dashq) (§ 6, § 8).
- **Unverified means unknown.** Configured is not verified. Stale or missing values say so with a reason, never zero or success.
- **Never break the agent.** Any agentq failure keeps the original tool output and the client's own login, model, approvals and sandbox.

## 1. Commands

| Command | Does |
|---|---|
| `agentq onboard [agent..]` | Read-only discovery: ready Codex, Claude Code, Claude Desktop, Hermes profiles per runtime; missing input; legacy install (§ 10); other optimizers. No writes. |
| `agentq onboard --yes [agent..]` | Apply § 4 for the selected agents, install the service, run `doctor`, print what to verify by a real turn. Repeat is safe. |
| `agentq enroll <https url>` | DashQ provider-backed browser approval; protected observation grant and projected snapshot receipt (§ 6). Accepted target, not shipped. |
| `agentq langfuse` | Standalone mode: read Langfuse host and keys from hidden stdin into protected storage (§ 6). |
| `agentq run -- <cmd> [args..]` | Run a native command through RTK when qualified, else unchanged (§ 3). Exit code and stderr preserved. |
| `agentq compress <agent>`, `agentq stats [--json]` | Tool-result compression core entry and its local stats (§ 3). |
| `agentq mcp <agent>` | Stdio MCP server `agent_context` (§ 2). |
| `agentq hook <agent> <event>` | Hook handler for § 4 events; JSON on stdin, JSON on stdout; 5 s budget, failure returns `{}`. |
| `agentq direct [agent..]` | Restore direct provider access: remove routing edits only, keep MCP and telemetry; works when the service is down (PRODUCT R4). `onboard --yes` routes again. |
| `agentq doctor` | Read-only: install, service, engines, owned edits count, telemetry queue and keys, legacy install, running legacy pids and files left in a retired legacy folder; exit 1 on a problem. Ports and routing drift join when the service owns them (§ 5); `onboard --yes` reapplies owned edits. |
| `agentq telemetry status\|verify [agent]` | Queue backlog and last delivery; `verify` sends one synthetic span and reads it back; a miss names the query and Langfuse's last answer. |
| `agentq incidents [list\|show]` | Local incident reports and what would be sent (§ 7). |
| `agentq update [--check]`, `agentq selftest` | coreq update steps; selftest checks the binary, built-in fixtures and engine pins; on Windows it retires a locked legacy fixture in the OS temp dir (§ 10). |
| `agentq service install\|run\|pause\|resume\|status\|restart\|stop\|uninstall\|list` | coreq service (§ 5). |
| `agentq uninstall [--dry-run]` | § 9. |
| `agentq uninstall --legacy [--dry-run]` | § 10: removes the legacy install; none left: `already removed`. |

- Output: one line per outcome; errors `Error: <problem>` then `Next: <action>`, at most 2 lines. `--json` prints the same data as JSON.
- Dropped from the Node CLI: `install`, `rollback`, `set-key`, `provider`, `headroom`, `gateway`, `monitor`, `proxy`, `retrieval`, `probe`, `plugin-path`, `verify`, `connect`, `set-langfuse`, `lifecycle`, `native-hook`, `tools`, `incidents report|enable|disable`. Their duties live in the commands above or are dropped in § 11.

## 2. MCP tools

- Server name `agent_context`; tools `index_document`, `search_document`, `get_original`. Names, input schemas and the managed instruction block keep their current text, so client registrations and trust survive the rewrite (PRODUCT R2).
- `index_document`: UTF-8 file or text at most 1 MiB; stores the original and splits it into chunks.
- `search_document`: term-match ranking over chunks of one index; returns passages with their index ref. `ponytail:` plain term scoring in the binary; swap in an engine behind the same tools when a paired task test shows a gain.
- `get_original`: returns the retained bytes for a ref unchanged; an expired ref says `expired` and names the source.
- Limits: 100 originals per profile, 7 days, 256 MiB; oldest go first. context-mode is no longer an engine (§ 11).

## 3. Managed engines

Engine pins (version, per-platform URL, sha256) are built into the binary; no config changes them. An engine downloads into `<install>/engines/<name>-<ver>/` on install and on an update that changes its pin, is checked by sha256 and `--version`, and is never fetched by an install script.

- Engines install in `service install` before the unit loads and on each `service run` start, so a release with a new pin installs it; an engine already checked is reused. A failed engine never fails the command: its line names the reason and agents keep working without it.
- **RTK.** Prebuilt binary from `rtk-ai/rtk` releases, current pin 0.51.0. `agentq run` passes only commands on the built-in qualified list (`pytest`, `cargo test|build|check`, `go test`) to `rtk`; others run natively. Native RTK execution keeps command semantics; no generic post-filter. Raw output of each run is retained in `data/runs/<id>/` for `get_original` with ref `rtk:<id>` and the hash of RTK's recovery hint (500 runs, 7 days, 512 MiB). Read-only sandbox without writable storage or no checked RTK: run natively, no compression.
- **headroom.** Loopback model proxy for routing and usage observation; its request compression stays off, the core below calls only its text compressor. Current pin `headroom-ai[proxy]` 0.40.0. Installed with `pip --require-hashes --only-binary :all:` from the lock `agentq/headroom.lock` built into the binary into a private venv `<install>/engines/headroom-<ver>/` from Python 3.11–3.13 found on the host (`AGENTQ_PYTHON` overrides); checked by `headroom --version`. The pin's wheels need macOS 14+ on arm64 and do not exist for macOS x64. No Python or no wheels: agents run unrouted, `doctor` says why. It never injects tools, never rewrites transmitted prefixes and never switches provider.
- Code, complete JSON, dense constraints and short results pass through (PRODUCT R3). Codex gets no compression hook; its adapter is the loopback provider.

### Tool-result compression

Accepted results target: [ACCOUNTING O1–O4](docs/spec/ACCOUNTING.md) defines outcome populations, paired byte measurements, coverage and whole-task evidence for PRODUCT R9/R10. This adds no optimizer, capture permission or universal savings claim.

One core in the binary decides, compresses, retains and counts; adapters only translate. A new agent needs an adapter, never a new core path.

- **Core.** Input: `agent`, `adapter` (`run`, `hook`, `provider`), `tool` (tool name), `command` (shell tools only; matched to a runner, never stored), `text`, native IDs when known. Steps: config off for the agent, under `min_bytes`, code or complete JSON: pass through (R3). Then only the built-in qualified list of that adapter selects an engine; anything off the list passes with reason `not_qualified`, so no generic post-filter. A result that is not smaller, an error or 3 s without an answer: the original text. A compressed result keeps the original under a `get_original` ref (`<engine>:<id>`, store and limits of `data/runs/`) and ends with one line naming that ref. Every call writes one stats record.
- **Qualified lists.** Built into the binary, per adapter, changed only by a release; no config adds a tool. The runner set is the RTK list above.
  - `run` (Claude Code through its hook, any agent calling `agentq run`): a command whose runner is on the RTK list goes to RTK, which executes it.
  - `provider` (Codex `exec_command`, `shell`) and `hook` (Hermes `terminal`): the command already ran, so RTK cannot; output of a command whose runner is on the RTK list goes to headroom's text compressor. This is its own recipe, never counted as RTK; each entry ships enabled only with a paired whole-task test that shows equal quality and lower usage (R3), else it passes with `not_qualified`.
  - Every other tool of every adapter (file reads, search, web, MCP results, other commands) passes unchanged.
- **Entries.** In process for `agentq run`; `agentq compress <agent>` reads one input as JSON on stdin and prints `{"text": .., "ref": ..}` for any agent with a result hook; the service calls the core for the loopback provider.
- **Config.** One section `compression` in `data/config.json`: `{"enabled": true, "min_bytes": 2048, "agents": {"<agent>": false}, "stats": "queue"}`; absent keys take these defaults. `stats` is the sink: `queue` sends each record through § 6, `off` keeps it local only.
- **Stats record.** One JSON object, same keys everywhere: `schema` (1), `event_id`, `time`, `agent`, `adapter`, `tool`, `runner` (or null), `engine` (`rtk`, `headroom`, `none`), `outcome` (`compressed`, `passed`, `failed`), `reason` (`disabled`, `short`, `code`, `json`, `not_qualified`, `not_smaller`, `no_engine`, `timeout`, `error`), `bytes_in`, `bytes_out`, `est_tokens_in`, `est_tokens_out` (labeled `estimate`, § 6), `duration_ms`, `ref`, `session`, `turn`, `tool_call`, plus `exit_code` for `run`. Local copy: one line per record in `data/stats/<YYYY-MM-DD>.jsonl`, 7 days; `agentq stats [--json]` prints per agent and engine the call count, outcomes and bytes in and out. Sink `queue`: one `agentq.compress` span with each key as `agentq.<key>`; it replaces `agentq.run` when the core lands.
- **Adapter contract.** An adapter maps the native result to the core input, writes the returned text back in the native shape and keeps the original on any failure (Principles). It never holds thresholds, engine choice, retention, a retrieval tool, stats, telemetry, config or network calls of its own.
- **Claude Code:** the § 4 `PreToolUse` rewrite to `agentq run` is the adapter; other tools pass unchanged.
- **Codex:** the loopback provider sends each new `function_call_output` (string, typed or nested content) of a listed tool through the core once per call ID, keeps the returned bytes per session and replays them on later requests, so the transmitted prefix stays byte-identical; other items pass unchanged.
- **Hermes:** the shipped plugin `agent-context` registers only `transform_tool_result`, runs `agentq compress hermes` for `terminal`, the only Hermes tool on the core list, and unwraps its `output` field; other tools return before any call. No proxy URL, own retrieval tool, lifecycle call or query memory: retrieval is MCP `get_original`, as for every agent.

## 4. Hooks and config edits per runtime

Accepted configuration target: [CONFIGURATION A1–A5](docs/spec/CONFIGURATION.md) owns extended profile projection and separately authorized typed management with revision checks, journaled apply, host readback and real-client verification. Observation enrollment grants no configuration authority; existing client/model/login/approval and ownership rules remain binding. Not yet released.

Each edit is recorded in the ownership journal (§ 9) before it is written. Existing foreign optimizers or custom providers stop the edit for that file with a named conflict; nothing is replaced by guess. Loopback port per agent and runtime is fixed at install and kept across updates.

| Runtime | Files and edits |
|---|---|
| Codex CLI and Desktop | `config.toml`: `model_provider = "agent_context"`, `[model_providers.agent_context]` loopback `/v1`, `wire_api = "responses"`, websockets; `[mcp_servers.agent_context]` runs `<install>/agentq mcp codex`, `enabled_tools` the three tools, `index_document` `approval_mode = "approve"` unless the user set one. `hooks.json`: `SessionStart` and `Stop` run `agentq hook codex <event>`. Observability plugin config points its exporter at the loopback OTLP port. |
| Claude Code CLI and Desktop Code | `settings.json`: `env.ANTHROPIC_BASE_URL` loopback, telemetry env pointing at the loopback OTLP port, `SessionStart` hook, `PreToolUse` matcher `Bash` hook that rewrites a qualified command to `agentq run -- <cmd>`. `~/.claude.json`: `mcpServers.agent_context`. |
| Claude Desktop Chat | `claude_desktop_config.json`: `mcpServers.agent_context` only; no routing (PRODUCT R1). |
| Hermes | `config.yaml`: `mcp_servers.agent_context`, `plugins.enabled` `agent-context` with the shipped plugin files; Langfuse plugin tags; `.env` loopback telemetry URL. |
| Instructions | Global `AGENTS.md`/`CLAUDE.md` block between `<!-- agent-context:start -->` and `<!-- agent-context:end -->`, now naming `agentq run` and `agentq doctor`. |

- Legacy entries `supercompress`, `headroom`, `context_mode` MCP servers and launcher-owned hooks are removed only when the journal or the legacy uninstall (§ 10) owns them.
- Config roots: the client's own env (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HERMES_HOME`), else the default home folder; project-level overrides are reported, never edited. Native Windows and WSL are separate installs.
- A JSON config that starts with a UTF-8 BOM is parsed without it; the edit writes it without the BOM and its `edited:` line says `UTF-8 BOM stripped`. Uninstall restores the original bytes, BOM included.
- Desktop clients that override `ANTHROPIC_BASE_URL` bypass routing; the `SessionStart` hook tells the model so and `doctor` reports it.

## 5. Install layout and service

coreq owns layout, update, launcher, rollback, service units and `status.json`; agentq passes tool name `agentq`, install folder and release repository `taskqorg/agentq`.

- Install: `~/.local/share/agentq`, Windows `%LOCALAPPDATA%\agentq`: `releases/<ver>/agentq`, `current`, `previous`, launcher `<install>/agentq`, `engines/`, `data/` (§ 8), `status.json`.
- Release: CI on a `v*` tag builds `agentq-<ver>-<os>-<arch>` for macOS arm64/x64, Windows x64, Linux x64/arm64 (static musl), plus `SHA256SUMS` and `latest.json`; a failing selftest publishes nothing. Each binary and `SHA256SUMS` carry a GitHub build provenance attestation (`gh attestation verify <file> --repo taskqorg/agentq`); installers and self-update check only the sha256. Trust is HTTPS plus who can push tags; the Node Ed25519 recipe signature and staged rollout are dropped (§ 11).
- Service: one OS unit per host and runtime (coreq project `host`: `com.agentq.host`, `AgentQ-host`, `agentq-host.service`) runs `<install>/agentq service run` in `<install>`. It owns the loopback ports, headroom workers, OTLP intake, the queue sender, update checks and `status.json`. No other resident process.
- Single instance: a `service run` process is one whose command line runs a binary under `<install>/releases/` (the Windows launcher that supervises it is not counted). `service status` reports more than one as an error naming every pid. On Windows `schtasks /End` ends only the launcher, so `stop`, `uninstall` and `restart` end every such process tree, orphans included; `restart` ends the task first, starts the service only through the `AgentQ-host` task and succeeds only when exactly one `service run` remains and `status.json` names its pid within 90 s. `selftest` checks the count on a built-in Windows process list.
- `service install` copies the running binary to `releases/<ver>/` and to the launcher only where the bytes differ: Windows refuses to overwrite a running exe (os error 32). A running launcher of an older version that cannot be replaced stays and says so; it only reads `current`. `selftest` checks the skip against its own running binary and the BOM strip on a built-in fixture.
- Update: coreq steps, hourly; each update keeps only `current` and `previous` under `releases/`; a dashq release notice may trigger an early check. An engine pin change starts a new headroom worker on a new port, routes new connections to it, keeps open ones on the old worker, retires the old one after 15 min plus 30 s grace, then kills its process tree with an incident; at most two workers. An `agentq` re-exec waits for no open proxied connection, at most 15 min.
- `status.json` lives at `<install>/status.json`, written every 30 s; `service status` treats it as unknown after 90 s. It adds to the coreq keys: `agents`, per agent with a config root its `routing` (routed, direct, bypassed, unknown) and `reason`, `mcp`, `hooks`, `engines` (per engine its pin and `ready` or `unavailable`), queue `{pending, oldest_age, last_delivery, dropped}`, newest incident.
- Compatibility N/N-1: data in `data/` changes only additively.

## 6. Telemetry to Langfuse

- Target: Langfuse project `Agents` over OTLP HTTP JSON, `<host>/api/public/otel/v1/traces` with Basic auth. Native exporters (Codex observability plugin, Claude Code Langfuse env, Hermes Langfuse plugin) send to the loopback OTLP port; agentq adds its own events and queues all of them. The loopback OTLP intake is a separate task; until it lands native exporters keep their own configuration.
- Standalone mode: `agentq langfuse` reads host, public key and secret key (three lines, secret without echo) and the queue posts straight to Langfuse. The host is `https://`, or `http://` on loopback only.
- Team mode: accepted [connection contract](docs/spec/ENROLLMENT.md) amends §§ 1/5/6/8. Coreq enrollment uses DashQ’s actual identity provider; its existing service sends allowlisted snapshots and eligible events. DashQ projection works without Langfuse; forwarding credentials stay server-side. Standalone behavior remains available.
- agentq events, one OTLP span each, span name = event name: `agentq.run` (RTK, `agentq run`; becomes `agentq.compress`, § 3), `agentq.retrieval` (one MCP tool call), `agentq.installation` (hourly heartbeat of `status.json` fields), `agentq.incident` (with § 7), `agentq.resource` (resource samples below). Attributes on every event: `agentq.schema` (1), `agentq.event_id` (also the trace ID, so a resend is idempotent), time (span start), `agentq.stage`, `agentq.installation` (unique ID kept in `data/installation`), `host.name`, `agentq.runtime` (`macos`, `linux`, `wsl`, `windows`), `agentq.version`; engine versions, profile, agent and native session, turn and tool IDs when known, else `agentq.ids_unknown` with a reason. Metadata only: `agentq.run` comes only from a qualified command and names only its runner (`cargo test`, `go test`, `pytest`) and engine (`rtk` or why native), never arguments; no raw content, keys or paths. Estimates carry an `estimate` label and never count as observed usage.
- dashq reads `agentq.*` observations for its Agents view in its own task; its current reads use the legacy Node names.
- Queue: one file per event under `data/queue/`, named `<unix seconds>-<event id>.json`; one sender thread in the service posts batches of at most 100 and deletes them after a standalone 2xx, or an explicit durable acceptance receipt when enrolled; caps 64 MiB and 7 days, enforced on each write and send; overflow drops oldest events and counts them in `dropped`. Writers never wait for the network: an outage, missing keys or an unwritable queue never blocks or fails agent work, and the queue drains on the next successful pass. `agentq telemetry status` prints pending, oldest age, last delivery, dropped and the last error; `verify` queues one `agentq.verify` event, sends now and reads its span back for 60 s through `GET <host>/api/public/v2/observations?traceId=<id>` (Langfuse v4 events-only servers answer 404 on `/api/public/traces`); a miss prints that query and its last answer (no observation: not ingested yet; 401: keys).
- Secrets live in OS protected storage (Keychain via `security`, Secret Service via `secret-tool`) or a 0600 file `data/langfuse` where neither tool works (Windows until a Credential Manager binding lands); never in config, argv, logs or telemetry. curl gets them through its stdin config.

### Resource samples

Contract for dashq, `agentq.schema` 1, additive: consumers that ignore unknown span names keep working.

- Producer: the service's telemetry sender (§ 5), so one sampler per installation, on Linux, macOS, Windows and WSL. Native Windows and WSL are separate installations with their own `agentq.runtime` (§ 4) and describe different scopes: `windows` is the whole host, `wsl` is the WSL 2 VM, whose CPU, memory and virtual disk the Windows host already counts inside its own numbers. Consumers never add a `wsl` installation to the `windows` one on the same `host.name`. WSL uses the Linux probes and excludes Windows drives (`drvfs`, `9p`), so no filesystem is counted twice. WSL 1 (kernel release containing `Microsoft`) has no VM: its `/proc` mirrors the Windows host, so CPU and memory are unknown with `wsl1 mirrors the Windows host`, and its `lxfs`/`wslfs` root is not a local filesystem. Standalone samples use Langfuse. Enrolled samples use the same queue and DashQ durable ingestion/history; no additional sampler, local queue or client database.
- Cadence: one sample per 300 s wall-clock bucket `floor(unix / 300)`, taken by the first sender pass (30 s pace) in a bucket; a service start waits for the next bucket. Event ID = first 32 hex of SHA-256 of `<installation>:resource:<bucket>`: a resend, a second sampler or a clock step back into a used bucket replaces that trace, never adds one; the queue keeps one file per ID.
- Span `agentq.resource`, stage `sample`, start = end = wall time of the reads (source timestamp). Besides the common attributes:
  - `agentq.resource.cpu_percent` (double, 0–100, step 0.1): busy share of all CPUs over the interval since the previous read in this service run; `agentq.resource.cpu_interval_ms` (int) is its monotonic length. Linux `/proc/stat`: busy = user + nice + system + irq + softirq + steal of total = busy + idle + iowait (guest is inside user). macOS `HOST_CPU_LOAD_INFO`: busy = user + system + nice of total = busy + idle. Windows `GetSystemTimes`: busy = kernel − idle + user of total = kernel + user (kernel time includes idle).
  - `agentq.resource.memory_total_bytes`, `memory_available_bytes`, `memory_used_bytes` (int bytes, used = total − available). Linux `/proc/meminfo` `MemTotal`, `MemAvailable`. macOS `hw.memsize`; used = (internal − purgeable + wired + compressor) pages × page size, Activity Monitor's Memory Used. Windows `GlobalMemoryStatusEx` `ullTotalPhys`, `ullAvailPhys` (Task Manager's In use = total − available).
  - `agentq.resource.disks` (string: JSON array, one object per filesystem): `id`, `role` (`root` for `/` or the Windows system drive, else `other`), `fstype`, `used_bytes`, `free_bytes`, `total_bytes`: total = blocks × block size, free = blocks available to unprivileged users, used = total − all free blocks; reserved blocks make used + free < total. Linux matches `df`; macOS APFS counts the whole container (Finder, `diskutil apfs list`), where `df` Used shows only the volume. A filesystem whose stat fails has null numbers and `unknown` with the reason.
- Unknown is never zero: a failed, denied or missing probe omits its numbers and sets `agentq.resource.cpu_unknown`, `memory_unknown` or `disk_unknown` to a short reason. CPU: the service reads a baseline at start, no state survives a restart; an interval under 10 s gives `warmup`; counters that went backwards (32-bit macOS tick wrap) give `counter reset`.
- Filesystems are re-read on every sample; a mount change adds or drops an entry in the next one, never a zero. Linux reads `/proc/self/mountinfo` and keeps local block filesystems (`ext2`, `ext3`, `ext4`, `xfs`, `btrfs`, `f2fs`, `zfs`, `bcachefs`, `jfs`, `vfat`, `exfat`, `ntfs3`), one per device number, the shortest mount point first (bind mounts, btrfs subvolumes); pseudo (`proc`, `sysfs`, `tmpfs`, `overlay`, `squashfs`, ...), network and FUSE filesystems are excluded. macOS keeps `getfsstat` mounts flagged `MNT_LOCAL` without `MNT_DONTBROWSE`: `/` (its APFS container) and browsable external volumes. Windows keeps drive letters of type `DRIVE_FIXED` (`GetLogicalDriveStringsW`, `GetDriveTypeW`), fstype from `GetVolumeInformationW` (`unknown` when it fails, e.g. a locked BitLocker volume), numbers from `GetDiskFreeSpaceExW`: free = available to the caller, used = total − total free; removable, network, optical and RAM drives and folder mounts are excluded. WSL 2's `/` is its virtual disk: total is the disk's maximum size, while the Windows drive that holds it bounds real free space.
- Identity and privacy: `agentq.installation` names the install; a filesystem `id` is the first 16 hex of HMAC-SHA-256 over mount point and fstype, keyed with `data/resource-key` (32 random bytes, never exported): stable while the mount stays, not reversible to a path. No mount path, device or volume name, username, process or command output is exported.
- Clocks: bucket and timestamp use the wall clock, intervals the monotonic clock. When wall and monotonic deltas differ by over 2 s (clock step, suspend), `agentq.resource.clock_step_ms` holds wall − monotonic.
- Freshness and window: dashq shows the newest sample as stale after 900 s (three buckets) and draws a graph only from three or more samples, else says too few samples. A query spans at most 7 days (the queue cap); older history lasts as long as the Langfuse project retains traces. An outage delays samples within the queue caps; they arrive with their source timestamps.
- Overhead: a sample is a few file reads or syscalls and one span of about 1 KiB: 288 spans per host per day; a test bounds one sample at 50 ms.

## 7. Incidents via coreq

- coreq incident reports, option A: an issue in `taskqorg/agentq`, label `incident`, through the user's existing github.com login; dedup by fingerprint; no relay and no GitHub App.
- Only faults of the built-in catalog report: engine start, update, routing, queue overflow, worker kill. Payload is coreq's allowlist JSON, at most 4 KiB, enumerated values only.
- No login, offline or unknown delivery: kept in `data/incidents/<fingerprint>.json` for manual submission. Opt-out: `incident_reports = false` in `config.json` or env `AGENTQ_INCIDENT_REPORTS=off`; setup discloses destination, visibility and account before any send.
- A report never changes agent work or an exit code.

## 8. State

`<install>/data/`: `owned.json` (ownership journal), `config.json` (incident opt-out, mode, ports, `compression`), `installation`, `resource-key` (§ 6), `langfuse` (fallback only, § 6), `originals/`, `runs/`, `stats/` (§ 3), `queue/` (with `state.json`: last delivery, last error, dropped), `incidents/`. Plain files with atomic rename and one lifecycle lock; no database. Interrupted transactions resume or roll back from the journal on next start.

Dashboard duties (fleet view, versions, last seen, health, usage, incidents, access control) move to dashq, which reads optional Langfuse events and authenticated snapshots under the accepted connection contract. agentq ships no panel and no dashboard JSON.

## 9. Ownership and uninstall

- The journal records each created or reused component and each edit (file, key path, before value, after value) before mutation.
- `uninstall --dry-run` prints every restore and removal. `uninstall` restores owned values whose current value still equals the recorded after value, keeps later foreign edits and reports conflicts, stops and removes the service unit, engines, data and install folder. Logins, shared keys, reused components and exported history stay. A second run says `already removed`.

## 10. Legacy Node install

- `onboard` detects `~/.agent-context` and the global npm package `@alexkirs/agent-context`. The install is `<legacy>/launcher.mjs`: a folder without it (a still-running legacy process recreates `incidents/` and `machine-id.json`) counts as removed, as does a folder with `<legacy>/.retired`. `onboard`, `doctor` and `uninstall --legacy` name the pids of processes whose command line holds `<legacy>/` (Windows: `<legacy>\`, case-insensitive, read from `Win32_Process`).
- `uninstall --legacy [--dry-run]` removes the legacy install without Node; `<legacy>` is `$AGENT_CONTEXT_HOME/.agent-context`, else `~/.agent-context`, and its parent is the home of the configs it edited. The Node journals (`<legacy>/backups/*/journal.json`) give the file list only, limited to the known Codex, Claude Code and Hermes files: a user edit made after the journal never blocks.
  - Each listed file is copied to `<legacy>/config-backup/` (a rerun keeps the first copy), then only legacy entries are stripped: hooks and MCP servers that name `launcher.mjs` or `agent-context`, env values routed to the legacy proxy ports, Codex `model_provider = "agent_context"` and `[model_providers.agent_context]`, Hermes `supercompress` and `agent-context` plugin entries, instruction marker blocks. The Hermes `plugins/agent-context` files are removed.
  - The `contextq-monitor` launch agent, Windows task or systemd unit is unloaded, the global npm package `@alexkirs/agent-context` removed, and `<legacy>` moved to `<legacy>.retired-<YYYY-MM-DD>`, so the backup ends in its `config-backup/`. Running legacy proxy pids are listed and left for the user.
  - When the move fails (Windows: running proxies hold files, access denied), the folder is copied to the retired path, each copied file and emptied folder is removed where it can be, `<legacy>/.retired` names the retired path, and the remaining files are listed as locked; the removal succeeds. `doctor` lists those files and the legacy pids until the user stops the processes and deletes `<legacy>`.
- `onboard --yes` with a legacy install runs `uninstall --legacy` without a prompt (`--yes` is the consent), then applies § 4. A failure stops onboarding with its message.
- Kept names: MCP server `agent_context`, tool names, provider id `agent_context`, instruction markers. Existing relay-filed issues and Langfuse traces stay.
- The relay worker and its GitHub App are retired: the code is gone from this repository, the owner deletes the deployed Worker and the App. Node clients that still default to the relay keep reports in their local queue.
- Final npm version: `npm-final/` is the package `@alexkirs/agent-context` 0.5.0; every invocation prints the migration instruction to stderr and exits 1, nothing else, no install scripts. The owner publishes it as a release asset without `recipe.json`, so the legacy updater never selects it and `uninstall --legacy` keeps working.
- The Node code, gateway, its tests, benchmarks, Python adapters and recipe signing are removed from this repository; only `npm-final/` stays. Manual removal on a host without agentq: `node ~/.agent-context/launcher.mjs uninstall --dry-run`, then `uninstall`.

## 11. PRODUCT.md map

| Req | Where | Notes |
|---|---|---|
| R1 | § 1, § 4, § 5 | Desktop Chat: MCP only. |
| R2 | § 2, § 3 | Changed: built-in search replaces context-mode; tool names unchanged. |
| R3 | § 3 | Kept; one compression core for every agent, only built-in qualified lists per adapter, others pass as `not_qualified`. |
| R4 | § 1 `direct`, § 3 | Kept. |
| R5 | § 1 `onboard`, `enroll`, § 4 | Kept; device enrollment served by dashq. |
| R6 | § 5 | Changed: coreq release trust (HTTPS and tags) replaces signatures; staged rollout dropped. Worker swap kept for headroom. |
| R7 | § 9, § 10 | Kept. |
| R8 | § 8, § 6 | Plain files, no SQLite. |
| R9 | § 6 | Kept. |
| R10 | § 6, § 8 | Accounting kept; dashboard dropped from agentq, owned by dashq. |
| R11 | Principles, § 5 | Kept. |
| R12 | Principles | Kept; this file is the approved spec revision. |

Dropped with reason: relay and GitHub App (§ 7 posts through the user's login, no server to run); gateway server, serviceq panel and dashboard (§ 8, dashq owns them); SuperCompress, provider selection and Headroom compression (local tools replaced them, no paid key); Ed25519 recipe signing and staged rollout (coreq trust model, one release repo).
