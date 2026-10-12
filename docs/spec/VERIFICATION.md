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

- Add small contract/property/stateful checks only where a journey can pass while ownership, credentials, protocol parsing, concurrency or accounting is wrong. Prefer data cases/generated sequences to many duplicate authored tests.
- Include actual Claude success/failure hook formats and Codex string/typed/nested Responses output; validate protected fields, HTTP/SSE/WebSocket where claimed and cancellation. Vendor tests alone do not qualify our adapter.
- Expected outcomes come from the approved contract and independent fixtures, not the implementation. Implementers cannot weaken verifiers or hide failing cases to obtain a pass.
- Each persistent test names its requirement and distinct failure risk. Remove redundant tests only after confirming their risk is covered. No arbitrary coverage percentage, snapshot churn or test of every trivial helper.

## Optimization experiment

Paired baseline/candidate tasks use the same model/auth/client, frozen inputs and independently checked outcomes. Include all input/cache/output, tool/schema/instruction overhead, retries, retrieval/rework, latency and monetary source. Reverse run order and distinguish cold/warm cache and state. A smoke case is not statistical proof.

Reuse selected LongBench/RULER cases and official scorers for content quality; use a few executable coding/terminal tasks for task success. Do not run full research benchmarks on every deploy. [Sources and prior evidence](PUBLIC-BENCHMARKS.md).

## Run policy and failure diagnosis

- During development: affected scenario plus relevant high-risk checks; no repeated unrelated suite runs.
- Merge candidate: cheap deterministic core acceptance and checks affected by the diff. Capture seed, version, step events and native logs; a failure identifies the broken chain before the agent isolates the responsible step.
- Release candidate: platform/client matrix, lifecycle and outage cases; bounded live model/telemetry probes for changed integration paths. Full paid evaluations run on engine/policy changes, not documentation edits or unchanged redeploys.
- Deployment: exact approved artifact → canary real round trip/version/telemetry → widen under authorized policy or rollback. Stop after proof; no unrelated cleanup.
- When behavior changes, update approved examples first. When code violates an existing example, fix code without redefining success. Publish pass/fail/unsupported/unknown, never just “healthy”.

Quality, latency, resource and savings budgets must be agreed before engine selection/release. No code-level test suite or numeric target inherited from the old implementation.
