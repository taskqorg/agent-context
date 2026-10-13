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
