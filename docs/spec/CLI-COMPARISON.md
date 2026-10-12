# CLI comparison

Date: 2026-10-12. Mac qualification only.
Evidence: `benchmarks/desktop-candidates/cli-results.json`.

## Method

- Same frozen 9,324-character document and seven fact groups as Desktop.
- Candidates: ScaleDown auto with exact identifier/inline-code preservation;
  local context-mode index/search. No Headroom compression candidate.
- Fresh CLI runs; normal saved login, model and approval policy retained.
- Claude: isolated explicit settings, native Read hook; saved Opus 5.5 1M,
  Auto mode. Only Read exposed; unrelated MCPs excluded from qualification.
- Codex: gpt-6.1-sol, temporary explicit provider endpoint; native exec tool
  reads document. Existing MCPs disabled only for these exec calls; no hooks,
  no trust bypass, no global endpoint change.
- Each initial run uses one tool call; separate original retrieval control
  reads the previously unshown O2 clause. Original bytes match the fixture.

## Results

Reduction is tool text including the original pointer, not subscription quota.
Latency is the compression adapter call, not total model turn time.

| Client | Candidate | Text reduction | Adapter latency | Facts | Original |
|---|---|---:|---:|---|---|
| Claude CLI | ScaleDown | 74.6% | 1.365 s | 7/7 | Passed |
| Claude CLI | context-mode | 70.4% | 0.559 s | 7/7 | Passed |
| Codex CLI | ScaleDown | 74.6% | 6.774 s | 7/7 | Passed |
| Codex CLI | context-mode | 70.4% | 0.587 s | 7/7 | Passed |

ScaleDown latency varied substantially between calls. These single live
measurements are not a service latency percentile or availability estimate.
Actual model usage is recorded; there is no matched uncompressed control turn.

## Codex adapter findings

The first attempts answered correctly but did not compress; they are excluded
from the passing results. Markdown with a table was classified as tabular,
and current CLI tool output arrives as `input_text` blocks containing a JSON
exec result. Plain-text-only matching did not reach the document.

The isolated adapter now decodes that envelope, changes only the document
output field and preserves the other fields. A fixture self-check verifies
metadata preservation and unchanged unrelated input. Proxy route is proven
through `/v1/responses` WebSocket traffic and actual compression events.

An original read initially got compressed again because its path was absent
from the tool result. The adapter now associates native outgoing tool calls
with incoming results by `call_id`; calls reading the originals directory
are protected. Both live recovery controls returned the exact O2 clause.

These fixes are in the temporary qualification adapter, **not installed or
released in the production package**. They identify integration requirements;
the current general installer is not qualified by this test.

## Current state and limits

- Desktop's user-approved temporary context-mode hook remains enabled.
- CLI settings and proxy endpoints exist only in the isolated qualification
  kit `/tmp/contextq-desktop-candidates/cli/`; working profiles are unchanged.
- Local context-mode is preferred for this document task: correct source
  excerpts, lower measured latency, no cloud compression API.
- Not proved: arbitrary documents/queries, RTK command filtering, other hosts,
  Codex HTTP/SSE recovery, quota savings or production lifecycle.
