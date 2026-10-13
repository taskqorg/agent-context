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

Include actual Claude success/failure hook formats and Codex string/typed/nested Responses output; validate protected fields, HTTP/SSE/WebSocket where claimed and cancellation. Vendor tests alone do not qualify our adapter. Shared evidence rules: [specq verification](https://github.com/taskqorg/specq/blob/main/engineering/verification.md).

## Optimization experiment

Paired baseline/candidate tasks use the same model/auth/client, frozen inputs and independently checked outcomes. Include all input/cache/output, tool/schema/instruction overhead, retries, retrieval/rework, latency and monetary source. Reverse run order and distinguish cold/warm cache and state. A smoke case is not statistical proof.

Reuse selected LongBench/RULER cases and official scorers for content quality; use a few executable coding/terminal tasks for task success. Do not run full research benchmarks on every deploy.

Quality, latency, resource and savings budgets must be agreed before engine selection/release. No code-level test suite or numeric target inherited from the old implementation.

## Resource sample qualification

Procedure for the live task (#86) on each authorized host, at most 30 minutes per host; contract: [agentq.md § 6 Resource samples](../../agentq.md#resource-samples). Linux, macOS, Windows and WSL 2; WSL 1 reports CPU and memory unknown by design. An untested host is reported as untested, never as passed.

1. Install the candidate release; record OS and version, `agentq --version` and the release commit as the producer revision.
2. `agentq telemetry verify` passes.
3. Wait four buckets (20 minutes). From the Langfuse public API list traces named `agentq.resource` since the install; keep those whose `agentq.installation` equals `<install>/data/installation`. Pass: at least three consecutive buckets, one trace each, start times 300 ± 30 s apart.
4. Within 60 s of one sample, read native values. Linux: `vmstat 300 2` (us + sy + st over the same interval), `free -b` (total, available), `df -B1 /`. macOS: `top -l 2 -s 300 -n 0` CPU usage, Activity Monitor Memory Used, `diskutil apfs list` for the `/` container. Windows: Task Manager CPU and Memory In use over the same window, `fsutil volume diskfree C:`. WSL 2: the Linux commands inside the distribution; its values are the VM's, never compared with the Windows host's. Pass: CPU within 5 points, memory within 2 % of total, disk total exact and free within 1 GiB.
5. Privacy: the exported attributes hold no username, home path or volume name.
6. `agentq service restart`: the next bucket holds one sample, CPU known or `warmup`; no bucket holds two traces.

Record per host: OS, producer revision, three trace IDs, exported and native values, verdict. A graph claim needs at least three samples.
