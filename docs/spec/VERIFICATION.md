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

## Enrollment qualification

Live task #95 against `https://dash.ufobe.com`, contract: [ENROLLMENT](ENROLLMENT.md), dashq E1–E10. Release follows only when every platform below reads `pass` with CLI receipt, service delivery and dashboard page readback. An unapproved or unrun step reads `not run`, never pass.

Procedure per host. The candidate runs in a separate `AGENTQ_INSTALL`, so the working installation stays untouched. Run `service run` there as a plain process. Never use `agentq service stop|restart|uninstall` there: the unit name (Windows task `AgentQ-host`) is shared with the working installation.

| Run | Host | Candidate | E1 connect | E2 cancel / repeat / expire | Other E | Verdict |
|---|---|---|---|---|---|---|
| 2026-10-15 | Windows 11, isolated install | `3c251d7` built as `0.6.0-rc95`; service status read back | not run: two codes expired unapproved | pass: abort leaves `pending approval`, no grant; repeat reuses the same code; expiry gives `expired_token`, no grant, next action `agentq enroll` | not run | incomplete |
| 2026-10-15 | WSL 2 Ubuntu 24.04, same host, isolated install | `3c251d7` built as `0.6.0-rc95`; service status read back | not run: code expired unapproved | pass: expiry gives no grant and next action `agentq enroll` | not run | incomplete |
| — | macOS, FRA Linux (from the Mac over ssh) | — | not run | not run | not run | untested |

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
