# Minimal product acceptance

Status: target gate for [PRODUCT revision 2](PRODUCT.md). Test observable outcomes through real interfaces. A scenario may cover several requirements and use a small data table; do not write a test per function.

## Core scenarios

| ID | Chain and expected outcome | Requirements |
|---|---|---|
| A1 | One-link onboarding → selected real client round trip → correct installation/agent visible centrally; repeat preserves unrelated configuration | R1, R5, R9–R10 |
| A2 | Eligible task → native tool/optimization → correct final result; protected code/JSON/constraints unchanged; requested original recoverable | R2–R4 |
| A3 | New recipe/release → verified stage → active-work deferral → switch or rollback; identities/history unchanged and actual version visible | R2, R6, R8–R10 |
| A4 | Tool/proxy/exporter unavailable, duplicate delivery or full storage → work preserved or direct access restored; no double count; truthful backlog/incident | R4, R8–R10 |
| A5 | Dry-run → uninstall → native client access; only owned components removed, reused tools/later edits preserved; repeat no-op | R7 |
| A6 | Two owners/profiles/runtimes → correlated usage/health → dashboard and agent query agree; members cannot read another owner's data | R1, R9–R10 |

Start with six scenario families, not six claims covering every possible input. Parameterize supported clients/OS and critical boundary cases. Use the same release artifact and approved versions.

## Necessary extra checks

The § 3 compression chain (`tests/compression.rs`, task [#120](https://github.com/taskqorg/agentq/issues/120), approved behavior) starts with writable isolated storage and a native runner. It proves one execution, stderr/exit preservation, bounded filtering, smaller output including its recovery ref, MCP original recovery and one local record per call. Protected text, engine error, timeout and larger output return native bytes; missing or corrupt stats remain unknown. The process double checks the adapter, not RTK quality or client integration.

The profiling chain (`agentq/profile.rs` tests, task [#122](https://github.com/taskqorg/agentq/issues/122)): stats records and export samples rank worst first by failure, time and instability budgets; an empty store, a corrupt stats record, corrupt or non-object export state (every export) and a malformed sample (that export only) and a corrupt trace directory or line read unknown for their own operations only; a corrupt config or invalid `trace_until` reads the switch unknown, never off; the trace switch is bounded and keeps other config keys. Live send and delivery timings on a host are not qualified by it.

Include actual Claude success/failure hook formats and Codex string/typed/nested Responses output; validate protected fields, HTTP/SSE/WebSocket where claimed and cancellation. Vendor tests alone do not qualify our adapter. Shared evidence rules: [specq verification](https://github.com/taskqorg/specq/blob/main/engineering/verification.md).

## Optimization experiment

Paired baseline/candidate tasks use the same model/auth/client, frozen inputs and independently checked outcomes. Include all input/cache/output, tool/schema/instruction overhead, retries, retrieval/rework, latency and monetary source. Reverse run order and distinguish cold/warm cache and state. A smoke case is not statistical proof.

Reuse selected LongBench/RULER cases and official scorers for content quality; use a few executable coding/terminal tasks for task success. Do not run full research benchmarks on every deploy.

Quality, latency, resource and savings budgets must be agreed before engine selection/release. No code-level test suite or numeric target inherited from the old implementation.

## Accounting qualification

Live check for [ACCOUNTING O4](ACCOUNTING.md#o4-qualification) (#108). Persistent chain checks: `accounting::tests::consumer_fixtures` runs every published case, producer-path cases included; `tests/compression.rs` requires equal accounting from local stats and their queued spans, unknown for an empty store, and a gap, reset or unknown reason after a failed append, a lost journal or a corrupt one, and unknown for a deleted day file under an intact journal. A call that can write neither its record nor a failure marker leaves no evidence, so local observed intervals carry reason `unproven` and local totals stay lower bounds (`compression::tests::no_evidence_chain`).

Run 2026-10-14 on Windows 11 Pro 10.0.26100, candidate commit a05b667 (debug build, `agentq 0.0.0-dev`, unreleased), RTK 0.51.0, cargo 1.99.0, git 2.46.0.windows.1, in an isolated install under the OS temp dir; no profile or working install changed. Client: Claude Code 2.1.299 headless (`claude -p`, model `claude-opus-5-5`, user settings excluded with `--setting-sources project`, two allowed Bash commands). In one real turn the model's Bash tool ran `agentq run -- cargo test` in a 150-test crate and `agentq run -- git --version`; `AGENTQ_AGENT=claude` and `AGENTQ_SESSION` = the client's session ID. The client received RTK's summary with the `get_original` ref line plus native stderr. Then `agentq telemetry verify` posted the queue through the real sender to a loopback Langfuse stand-in (Python 3.12.10); its stored body is the delivered events.

| Check | Local stats (`--from` journal `since`) | Delivered events |
|---|---|---|
| State | complete, observed from the first record through now, no gap (since then: partial, `unproven`, see below) | partial: exported events carry no coverage |
| Calls, outcomes | 2: 1 compressed, 1 passed, 0 failed | same |
| Reasons | compressed 1, not_qualified 1 | same |
| Volume run/rtk | 1 paired: 5222 bytes in, 132 out (stdout; stderr is never compressed), reduction 0.9747 | same |
| Cohorts | agent `claude`, adapter `run`, runner `cargo test`/null, engine `rtk` 0.51.0/`none`, version 0.0.0-dev, profile unknown | same |
| Event IDs | 2, session = client session | the same 2 `agentq.compress` spans, plus 3 `agentq.verify` |

No host path, command argument or tool output appeared in either aggregate or the delivered body. Unsupported adapters: the Claude Code `PreToolUse` rewrite into `agentq run` is still a no-op hook, so the client ran `agentq run` as a command; the Codex loopback provider and the Hermes plugin do not call the core; hook and provider recipes are unqualified (`not_qualified`). Gaps: native turn and tool call IDs are unknown; no Langfuse or DashQ ingestion read-back (no authorization to write test events to a production project); profile is unknown on every record; macOS, Linux and WSL untested.

## Resource sample qualification

Procedure for the live task (#86) on each authorized host, at most 30 minutes per host; contract: [agentq.md § 6 Resource samples](../../agentq.md#resource-samples). Linux, macOS, Windows and WSL 2; WSL 1 reports CPU and memory unknown by design. An untested host is reported as untested, never as passed.

1. Install the candidate release; record OS and version, `agentq --version` and the release commit as the producer revision.
2. `agentq telemetry verify` passes.
3. Wait four buckets (20 minutes). From the Langfuse public API list traces named `agentq.resource` since the install; keep those whose `agentq.installation` equals `<install>/data/installation`. Pass: at least three consecutive buckets, one trace each, start times 300 ± 30 s apart.
4. Within 60 s of one sample, read native values. Linux: `vmstat 300 2` (us + sy + st over the same interval), `free -b` (total, available), `df -B1 /`. macOS: `top -l 2 -s 300 -n 0` CPU usage, Activity Monitor Memory Used, `diskutil apfs list` for the `/` container. Windows: Task Manager CPU and Memory In use over the same window, `fsutil volume diskfree C:`. WSL 2: the Linux commands inside the distribution; its values are the VM's, never compared with the Windows host's. Pass: CPU within 5 points, memory within 2 % of total, disk total exact and free within 1 GiB.
5. Privacy: the exported attributes hold no username, home path or volume name.
6. `agentq service restart`: the next bucket holds one sample, CPU known or `warmup`; no bucket holds two traces.

Record per host: OS, producer revision, three trace IDs, exported and native values, verdict. A graph claim needs at least three samples.

## Update restart qualification

Live check for agentq.md § 5 Update (#111, #116): from a service running the previous release, `agentq update` on the host, then poll `agentq service status` every 2 s for at most 90 s. Pass: within 60 s the service pid changes and its exe is `<install>/releases/<new>/agentq` answering `--version` with the new release, with no manual restart. A 0.5.6 service lacks the restart code, so the first proof runs 0.5.7 to 0.5.8; hosts reached 0.5.7 by their own hourly update.

Run 2026-10-14, 0.5.7 to 0.5.8, CLI `agentq update`. No host routes an agent, so no proxy worker port was open and no turn was in flight; each old service logged `agentq: restarting into 0.5.8 (no open proxied connection)`.

| Host | OS | Old pid | New pid | Update (UTC) | Serving 0.5.8 (UTC) | Verdict |
|---|---|---|---|---|---|---|
| Mac | macOS (Darwin 27.0.0 arm64) | 1069 | 13906 | 02:56:40 | 02:57:09 (+29 s) | pass |
| FRA | Linux 6.8.0 x86_64, user hermes | 1151912 | 1166920 | 02:57:16 | 02:57:56 (+40 s) | pass |
| WSL | WSL 2, Linux 6.18.33.2 x86_64 | 39456 | 43375 | 02:57:56 | 02:58:30 (+34 s) | pass |
| Windows | Windows 11 Pro 10.0.26100 | 9020 | 35096 | 02:58:53 | 02:59:17 (+24 s) | pass |

Drain with an open proxied connection (deferral log, then restart once it closes) is covered by unit tests only; no routed host was available.

## Heartbeat routing and hook state (#134)

Live check for agentq.md § 6 `agentq.installation` (`agentq.routing`, `agentq.hooks`), release v0.6.0 (tag at bd2b4d9, release CI green), run 2026-10-15 on Windows 11 Pro 10.0.26100.

- Isolated install (OS temp dir, no Langfuse keys, so spans stay queued): the released `agentq-0.6.0-windows-x86_64.exe` (sha256 matches `SHA256SUMS`) ran `hook codex Stop` with invalid UTF-8 stdin (answered `{}`, exit 0), then `service run`. Its start heartbeat carried `agentq.hooks` `[{"agent":"codex","event":"Stop","state":"failed","last_ok_at":null,"last_failure":{"at":…,"error":"stdin: stream did not contain valid UTF-8"}}]` and `agentq.routing` `{"codex":{"routing":"direct","reason":"config.toml selects no agent_context provider","intended":"direct","intended_reason":"not onboarded"}}`. After one successful `hook codex Stop`, the next heartbeat read `state` `ok` with the same `last_failure`, and `agentq.hook_failures` read `none`.
- Working install: `agentq update` moved the service from 0.5.9 to 0.6.0. A forced `hook codex Stop` with invalid UTF-8 stdin made `doctor` report the failure. The 0.6.0 start heartbeat after it was delivered: `telemetry status` showed the last delivery 13 s after the start, error none.
- Langfuse readback (`GET /api/public/v2/observations?name=agentq.installation`, the installation's own keys), 2026-10-14 UTC. v0.6.0 published 19:28:57; each service took it on its hourly update check and its 0.6.0 start heartbeat carried `agentq.routing` and `agentq.hooks`:

| Host | Runtime | Last 0.5.9 heartbeat | First 0.6.0 heartbeat | `agentq.routing_problems` | `agentq.hooks` |
|---|---|---|---|---|---|
| DESKTOP | windows | updated by `agentq update` | 19:30:57 | codex unknown (proxy not answering) | `[]`, then codex Stop failed |
| macbook-m2.local | macos | 20:17:57 | 20:25:56 | codex unknown (proxy not answering) | codex SessionStart and Stop ok, `last_failure` null |
| hermes-fra1 | linux | 20:25:42 | 20:25:53 | codex unknown (proxy not answering) | `[]` |
| DESKTOP (WSL) | linux | 20:26:09 | 20:26:23 | codex unknown (proxy not answering) | `[]` |

- Forced failure: on Windows `hook codex Stop` with invalid UTF-8 stdin failed at 19:31:07; the next heartbeat (19:32:11) carried `agentq.hooks` codex Stop `failed` with `last_failure` `{"at":1792006267,"error":"stdin: stream did not contain valid UTF-8"}` and `agentq.hook_failures` `codex Stop (stdin: stream did not contain valid UTF-8)`; the hourly one (20:32:15) still did, with `agentq.routing_problems` `none`.
- Found: every 0.6.0 start heartbeat read codex `unknown`, because the sender beats before the headroom proxy binds (37 s and 48 s measured on Windows); the Windows hourly heartbeat read routed. The start heartbeat now waits until no agent reads `unknown`, at most 5 min (agentq.md § 6); it ships in the next release.
- Not checked: dashq Attention rendering (dashq#116) and a forced failure on mac or hermes-fra1 (no host access).
- Found: `agentq service restart` on this host ended the `AgentQ-host` task and then failed `schtasks /Create` with Access denied, leaving no service. `schtasks /Run /TN AgentQ-host` restored it.
