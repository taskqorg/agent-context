# Public benchmarks and protocol coverage

Research + isolated screen, 2026-10-12. No deployment or client setting changes.

## Recommendation

Use **LongBench** for paired downstream quality, **RULER** for long-context stress, and client/vendor fixtures for protocol correctness. No single ready suite found that qualifies compression across Claude Desktop/CLI and Codex Desktop/CLI, subscription routing, installation, retrieval and telemetry.

Keep **RTK native commands + context-mode explicit index/search** as local candidates. Do not apply index/search to every tool result. Keep ScaleDown as a comparison arm, not a default selected by compression percentage alone.

## Available methodologies

| Suite | What it covers | Metric / role | Limitation |
|---|---|---|---|
| [LongBench v1](https://github.com/THUDM/LongBench/tree/main/LongBench) | QA, retrieval, counting, summary, code completion; English/Chinese | Official F1, retrieval/count score, ROUGE, code similarity; paired original/compressed answers | Does not exercise client hooks or transports |
| [LongBench v2](https://github.com/THUDM/LongBench) | Deep QA, dialogue, code repo and structured data | Multiple-choice accuracy on 503 items | Larger contexts and higher inference cost |
| [RULER](https://github.com/NVIDIA/RULER) | Single/multiple needles, variable tracing, aggregation, QA; configurable lengths | Official task scorers; position/length/complexity stress | Synthetic, not client protocol or complete coding workflow |
| [LLMLingua evaluation](https://github.com/microsoft/LLMLingua/tree/main/experiments/llmlingua2/evaluation) | Public compression experiments and downstream evaluation | Existing compression/evaluation recipe | Its published compressor/model results do not qualify ours |
| [SWE-bench](https://github.com/SWE-bench/SWE-bench) | Real repository issues and patches | Resolved tests; final engineering outcome | More expensive, Docker/environment setup; not a short first screen |
| [Terminal-Bench](https://github.com/laude-institute/terminal-bench) | Executable terminal tasks | Task verifier success | More expensive; task environments required |

These suites produce scores. They do not supply a universal safe-loss threshold for our product. Our release gate must compare paired outcomes and require exact preservation of protected protocol fields.

## Completed LongBench screen

Downloaded official repo and public dataset archive. Original upstream prompt templates and `metrics.py`, unchanged. One shortest-context item from each of three tasks; deterministic selection before inference. Three arms: original, ScaleDown auto, context-mode index/search limit=3. Nine independent Claude CLI completions. Saved model: `claude-opus-5-5[1m]`. Tools/MCP disabled for these answer-only runs; production auth/settings unchanged. No retries. ScaleDown timeout 15s; MCP timeout 20s; inference timeout 120s.

ScaleDown receives context and task query plus a preservation instruction. Context-mode receives the same task query. Neither receives the ground-truth answer. ScaleDown output used raw; context-mode search output includes vendor wrappers. Public input only. Original and outputs retained.

| Task | Original score | ScaleDown score / reduction / compression latency | context-mode score / reduction / latency |
|---|---:|---|---|
| hotpotqa, 1,695 tokens | F1 0.25 | 0.25 / 99.1% / 9.238s | 0.25 / 40.8% / 0.602s |
| passage_retrieval_en, 9,616 tokens | 1.00 | 1.00 / 91.4% / 4.767s | 1.00 / 88.8% / 0.580s |
| repobench-p, 1,243 tokens | code similarity 1.00 | 1.00 / 0% / 1.888s | 1.00 / **−114.7%** / 0.476s |

All nine calls completed without error. Answers matched across arms. HotpotQA answer was `Suining`; gold is a full sentence, so upstream token F1 penalizes even the correct short baseline. Do not reinterpret 0.25 as a compression failure, or average unrelated metrics into one quality number.

Important failure of the generic recipe: context-mode returned **2,669 tokens** for a **1,243-token** code context. It preserves the answer here but increases payload. ScaleDown left that code unchanged. Aggressive savings on one QA item are not evidence of universal 99% reduction.

Tokens counted locally with `o200k_base` for consistent payload comparison, not Claude billing. Actual CLI input/cache/output usage retained in JSON. This is a small screen, not full LongBench, p50/p95, subscription quota savings, or a Desktop/Windows/Linux qualification. Original retrieval and native client interception were tested separately in [CLI-COMPARISON.md](CLI-COMPARISON.md); this screen does not retest those routes.

Evidence: [machine-readable results](../../benchmarks/public-methodology/longbench-screen.json). Item IDs, archive SHA256 and upstream commit SHAs included. Frozen public contexts and both candidate outputs live beside results. Lab scripts/logs: `/tmp/contextq-public-bench/`; lab retention is temporary.

## Popular integration repositories

Live GitHub counts at research time; popularity is adoption evidence, not proof of safety. Not an exhaustive ranking. Exact metadata: [repositories.json](../../benchmarks/public-methodology/repositories.json).

| Repository | Stars | Useful evidence | What to borrow |
|---|---:|---|---|
| [RTK](https://github.com/rtk-ai/rtk) | 82,975 | Native command-aware reducers | Test requested command semantics; do not replace them with generic postfilters |
| [LiteLLM](https://github.com/BerriAI/litellm) | 60,979 | Provider normalization, streaming, usage/cost and gateway policies | Coverage categories; no need to add its whole gateway |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 54,854 | Claude/Codex translators and executor test fixtures | Tool IDs, errors, signatures, interruption, retries, cache and stream behavior |
| [Claude Code Router](https://github.com/musistudio/claude-code-router) | 37,628 | Provider transformers and request routing | Keep transformation explicit; routing/failover changes semantics and attribution |
| [context-mode](https://github.com/mksglu/context-mode) | 26,678 | Vendor MCP + platform adapters + extensive hook/security/retrieval tests | Native index/search, canonical paths, session isolation and supported hook schemas |

CLIProxyAPI, LongBench, RULER and context-mode source checkouts pinned in result metadata. RTK reviewed via its native documented interface and prior installed 0.51.0 tests. Router/LiteLLM overview is from public project documentation, not a complete source audit. RTK Apache-2.0; CLIProxyAPI/router MIT. GitHub reports NOASSERTION for context-mode/LiteLLM: inspect their actual licensing before redistribution; do not infer permissive licensing from stars.

## Concrete missing coverage

| Area | Existing source of cases | Required evidence for our adapter |
|---|---|---|
| Claude tools | [Official hooks](https://code.claude.com/docs/en/hooks), context-mode `tests/hooks/` | Read/Bash/MCP success and failure; nested output, stderr/exit code; correct native replacement schema |
| Claude history | CLIProxyAPI `internal/translator/claude/*/*test.go` | Preserve `tool_use_id`, ordering, `is_error`, images/nontext and opaque thinking signatures |
| Codex output | [Official Codex source](https://github.com/openai/codex), previously captured CLI frames | String AND typed `input_text` arrays; JSON-wrapped exec outputs; change only intended text leaf |
| Codex streaming | CLIProxyAPI `internal/runtime/executor/codex_websockets_*test.go` | Cancellation, interrupt/reconnect, fragmented frames; no truncation, duplicate execution or session mix |
| Reasoning/compaction | CLIProxyAPI `codex_executor_signature_test.go` | Preserve opaque encrypted reasoning in passthrough; correct handling of compact requests; never compress protocol metadata |
| Retry/cache | CLIProxyAPI `codex_executor_retry_test.go`, `codex_executor_cache_test.go` | Bounded failure, original retained; stable cache prefix; count all retry usage |
| Retrieval | context-mode `tests/hooks/redirect-marker-*.test.ts`, `tests/security.test.ts` | Recover exact original; protected recovery on HTTP/SSE AND WebSocket; canonical `/tmp`/`/private/tmp`; denied path stays denied |
| Encoding/limits | context-mode `tests/truncate.test.ts` | Unicode byte boundaries, tiny limits, JSON/code validity, numeric/negative constraints |
| Effectiveness | LongBench + RULER | Paired task score, payload tokens, actual input/cache/output, latency, retrieval and rework; no synthetic savings from metadata alone |
| Lifecycle/identity | Our product acceptance tests | Concurrent sessions, host/runtime/version/provider identity; install/update/restore on macOS/native Windows/Linux; WSL separate |

These are coverage gaps, not claims that every implementation path is broken. Prior live evidence already found: failed Bash needs its failure hook; Codex typed arrays were skipped; retrieval protection needed native call IDs; generic RTK filtering lost commit records. Latest temporary CLI adapter fixes are not yet a shipped production package.

Do not copy compatibility transformations that strip signatures or alter auth from another proxy: their provider translation policy differs from our transparent compression path.

## Upstream test execution status

LongBench official metrics executed successfully on all nine answers. RULER generator, SWE-bench and Terminal-Bench not run in this screen.

Attempt to run context-mode upstream tests blocked at dependency setup: no package-lock for `npm ci`; `npm install --ignore-scripts` fails in npm with `Cannot read properties of null (reading 'edgesOut')`. A clean isolated vitest runner hit the same npm failure. No permission changes, global dependency replacement, hook registration or postinstall execution attempted. CLIProxyAPI Go tests not run: Go toolchain absent. These source fixtures provide a coverage plan, not a passing compatibility result for our proxy.

## Next bounded qualification

1. Freeze this three-case screen as smoke coverage; add a seeded, stratified LongBench sample covering QA, code, counting and Chinese, without choosing samples by achieved savings.
2. Run RULER at multiple lengths and needle positions. Use its upstream generator/scorer, retain original baseline.
3. Run vendor hook tests in a working isolated dependency environment, then replay matching native Claude/Codex fixtures through our actual adapter. Passing vendor tests alone does not qualify ours.
4. Test RTK on native git/test/build command tasks, not document retrieval.
5. Require no lost protected fields, exact original recovery, no payload inflation, no silent fallback. Agree task-quality and latency budgets before release; report raw scores and paired failures.
6. Only then run the same chosen recipe through Desktop/CLI on Mac, native Windows and Linux, with telemetry linking real calls and version/provider identity.
