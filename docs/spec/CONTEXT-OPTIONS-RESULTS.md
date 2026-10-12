# Context options: local qualification

Date: 2026-10-12. Stage: qualification, not deployment.

## What was tested

- Seven safe payloads; three repeats per candidate.
- Baseline, Headroom local, RTK, context-mode; Boost in an isolated Linux container.
- One controlled live Claude Desktop Bash result; actual repository reads/search;
  actual isolated failing pytest output; one synthetic dense control.
- Observed Codex function/custom output and Claude tool-result/Bash-hook shapes.
- Required evidence; valid JSON; unchanged envelope metadata; original recovery.
- Tool responses include context-mode indexing/search replies and Boost recovery markers.
- Estimates use `o200k_base`; no model completion or subscription-quota measurement.

## Initial findings

| Candidate | Payload reduction | Warm median | Finding |
|---|---:|---:|---|
| Baseline | 0% | — | Reference |
| Headroom TextCrusher | 29.9% | about 0.2 ms in process | Required facts retained; JSON representation broken |
| RTK | 59.4% | about 7 ms including CLI launch | Strong log/test filters; unsupported cases passed through |
| context-mode | 63.5% | about 77 ms including MCP roundtrip | Good targeted retrieval; small results grew |
| Boost filtering enabled | 9.8% | about 5.3 s including Docker exec | Pytest reduced; other cases passed through; recovered paths redacted |
| Boost offline default | 0% | about 5.2 s including Docker exec | CLI filtering disabled by effective feature flag |

These totals weight this small corpus by size. The long heartbeat log dominates.
They are not expected savings across all work, model requests, costs or plan limits.
Headroom timing excludes Python startup; RTK includes native process startup;
context-mode excludes server startup; Boost includes container transport.
Do not rank latency across these different boundaries.

Boost's current supported route is `(command) | boost`, not `boost command`.
Its explicit filtering-enabled trial is recorded in the final metadata report.
Preview terms were approved for this isolated trial. Network was disabled.

## Payload examples

| Content | Baseline tokens | Headroom | RTK | context-mode |
|---|---:|---:|---:|---:|
| Claude heartbeat log + error | 4018 | 2798 | 58 | about 393 |
| Failing pytest output | about 923 | about 639 | about 97 | about 955 |
| Code read | 511 | 356 | 511 | about 542 |
| JSON package metadata | 537 | 333 | 537 | about 568 |
| Search results | 141 | 141 | 141 | about 171 |
| Targeted specification section | 1909 | 1366 | 1909 | about 257 |
| Dense protected statement | 21 | 21 | 21 | about 51 |

context-mode's first log reply omitted error detail and instructed retrieval.
The required search reply is included in the final token count.
Its full advertised MCP schema was 7039 estimated tokens; native deferred loading
may load fewer. This is not a measured startup prompt cost.

## Recovery and compatibility

- Headroom: original retained by the replay harness. Native retrieval not qualified here.
- RTK pipe: native recall not wired. Original retained locally; production integration
  must provide a retrieval pointer before acceptance.
- context-mode: exact original returned through bounded `ctx_execute_file` calls.
- Boost: native `retrieve` returned the original test output with temporary paths
  replaced by `$TMPDIR`. Exact byte comparison failed; a separate probe confirmed
  only those path substitutions and all required error details retained.
  This is redacted recovery, not exact original recovery.
- Envelope checks: replay only. They do not prove actual client interception, login,
  subscription preservation, approval behavior or exit-status propagation through a shell pipeline.
- Valid JSON: baseline, RTK passthrough and context-mode passed; TextCrusher failed.
- Exact evidence checks are necessary but insufficient for answer quality.

## Decision

Follow-up: [Cloud comparison and safe profile](CLOUD-COMPARISON.md) supersedes the broad
RTK recommendation below. Native RTK and generic RTK pipe have different behavior.

Shortlist **RTK + native client optimization** for the smallest shell-focused bundle.
Keep **context-mode** as the broader retrieval alternative for documentation/data-heavy work.
Do not use the current generic TextCrusher on structured JSON by default.
Do not stack these candidates on the same payload.

No universal production winner yet. Next acceptance: the same real task in fresh
Codex and Claude Code sessions, measured usage/cache/retries, correct result,
working retrieval/removal, then native Mac/Windows/Linux qualification.

[Candidate contract](CONTEXT-OPTIONS.md) ·
[Pinned variants](../../benchmarks/context-options/variants.json) ·
[Final metadata](../../benchmarks/context-options/results.json)
