# Tokenade qualification

2026-10-12; isolated Mac candidate, Tokenade 1.2.3 darwin-arm64. **Partial qualification; no rollout recommendation.**

## Setup

Native binary downloaded from npm registry; both archive integrity values verified. No global npm install. Closed-source commercial binary. Free account activated via user-confirmed device flow; license stays in isolated config and is excluded from artifacts.

Runtime writes confined by macOS process sandbox to `/private/tmp/contextq-tokenade`. Config/stash/debug/dedup/fold/search paths redirected there. Auto-update and hook self-repair disabled for qualification; no model downloaded. Working Claude/Codex settings and normal login/model/approval unchanged.

Installer dry-run and actual project-only Claude install completed inside lab. `--only claude-code --per-project` wrote project hooks and also scaffolded `.github/copilot-instructions.md` and `.hermes.md`. Broad installation proposed changes for overlapping tooling, which were not accepted. Standalone binary initially generated `/usr/local/bin/tokenade` hook commands; placing the isolated launcher on PATH and rerunning installer generated correct lab paths. No runtime source patch.

The installer sets hook stderr suppression and `exit 0`; installation success alone cannot prove hooks executed. Native debug events + agent tool traces were checked.

## Activation gate

Before activation: all seven component commands exited **0**, returned input unchanged, and explicitly warned tools were paused. These are not compression passes. [Pre-activation evidence](../../benchmarks/tokenade/pre-activation.json).

After activation: free plan, 10M tokens-saved quota/month. [Official login docs](https://tokenade.net/en/docs/login) describe periodic account reporting and pausing after prolonged report failures. Product is local for content processing but is not an unlimited account-free optimizer.

## Activated component screen

Same seven frozen fixtures used for previous candidates. `filter --deliver` for command output; `read` for other formats. Locally counted `o200k_base` tokens; timing includes native launch. One run each, not p50/p95.

| Case | Input → output tokens | Reduction | Latency | Preservation |
|---|---:|---:|---:|---|
| Heartbeat log + error | 4,018 → 121 | 97.0% | 81ms | Required error facts retained; raw recovery adds one newline |
| Failed pytest | 923 → 320 | 65.3% | 32ms | Required facts retained; raw recovery byte-identical |
| Code | 511 → 511 | 0% | 36ms | Unchanged |
| JSON package metadata | 537 → 291 | 45.8% | 34ms | Valid JSON, **15 array entries omitted**, omission marker present; not semantically identical |
| Search | 141 → 141 | 0% | 27ms | Unchanged |
| Reference document | 1,909 → 1,909 | 0% | 33ms | Unchanged |
| Dense constraints | 21 → 21 | 0% | 28ms | Unchanged |

One literal JSON needle appeared missing only because whitespace was minified; actual information loss is the truncated array, not whitespace. The compact JSON response had no stash recovery pointer; expand-ref using its original hash failed. Original source file remained available for direct structured extraction.

Native `wrap` retained exit code **7** and `ERROR_E42` on a synthetic failed command.

Evidence: [activated-screen.json](../../benchmarks/tokenade/activated-screen.json). Component savings are not subscription quota or whole-task savings.

## Live Claude CLI

Saved normal model `claude-opus-5-5[1m]`, normal auth/permissions. Isolated native Tokenade hooks via explicit settings, not production global settings. MCP narrowed only for test processes. Autocompact not changed. Eight completions: two tasks × baseline/candidate × normal/reversed order. Stateful product caches retained between rounds; not independent statistical replicates. Baseline uses same normal model/permissions without Tokenade hooks. Project has no CLAUDE.md added; this qualifies hook behavior, not every default onboarding rule/add-on.

Tasks: diagnose a failed pytest containing noisy logs; read the complete JSON array and report its count/last item/node requirement. Expected facts checked outside agent workspace. Agent forbidden to edit fixtures or rerun pytest. Raw tool calls, hook events and provider usage retained privately in lab.

| Task | Baseline total input | Tokenade total input | Delta | Calls baseline → candidate |
|---|---:|---:|---:|---:|
| Failed test, first order | 15,801 | 11,036 | −30.2% | 1 → 1 |
| Failed test, reverse order | 15,801 | 11,036 | −30.2% | 1 → 1 |
| Complete JSON, first order | 11,323 | 17,429 | +53.9% | 1 → 2 |
| Complete JSON, reverse order | 11,323 | 17,436 | +54.0% | 1 → 2 |

Total input = actual input + cache creation + cache read tokens; cached tokens are not treated as fresh-cost equivalents. All facts correct in all eight runs. Tokenade's JSON truncation required an extra Bash call (`jq` / Python) to recover full data. All four candidate answers used Markdown fences despite the prompt requiring a JSON object only; bare JSON validation failed. All four baseline answers passed bare JSON validation. Facts success is not full output-contract success.

Across these two tasks and two orders: baseline **54,248 input / 737 output**, candidate **56,937 input / 1,003 output**: **+5.0% input, +36.1% output**. Do not generalize from this tiny sample. No broad net-savings proof. CLI USD estimates were collected but not used to rank: cache warmness and execution order materially affect them.

Evidence: [claude-live.json](../../benchmarks/tokenade/claude-live.json), [reverse order](../../benchmarks/tokenade/claude-live-reversed.json).

## Live Codex CLI

Normal model `gpt-6.1-sol`, existing ChatGPT login. Two ephemeral provider overrides: direct native Codex endpoint versus local Tokenade proxy; working config untouched. Hooks disabled only in test process, no hook-trust bypass. Same single native exec_command read, same synthetic error facts. HTTP/SSE route tested; WebSocket not qualified.

Both answers correct. Direct **44,409 input / 80 output**, proxy **44,427 input / 98 output**. Proxy debug recorded `folded=0`, `tokens_saved=0`, `relayed_unchanged`. Thus this real query proves subscription forwarding and correct answer, **not compression**. Cache-read counts differed; no claim that cost difference was caused by Tokenade.

Evidence: [codex-live.json](../../benchmarks/tokenade/codex-live.json).

## Large Responses format probes

Separate local mock upstream; no provider credentials, real model or private data. 2,000 synthetic heartbeat lines + required error at end. Four outgoing payload shapes: string `function_call_output`; string `custom_tool_call_output`; typed `input_text[]`; typed array with nested JSON exec output. Query and call IDs preserved in all four. HTTP 200 in all four is not a quality gate.

First three shapes compressed and kept the error inline. Nested JSON exec shape was replaced by a disclosure summary: **error and exit_code not visible inline**, inner text no longer parseable as original JSON. Explicit stash pointer remained; `expand-ref --raw --budget 0` recovered semantically exact original JSON. This is progressive disclosure with an extra read, not lossless preservation of the visible tool result.

Evidence: [protocol-screen.json](../../benchmarks/tokenade/protocol-screen.json). These generated probes test the format boundary, not a full upstream benchmark or all Codex versions.

## Conclusion

Useful for noisy terminal tasks. Not justified as a universal default across our agents:

- Fact recovery works on tested stashed results, but JSON compaction can hide required data and cause rework.
- Component savings did not become net savings across these live Claude tasks.
- Current Codex route worked but did not compress the tested real request.
- Native error status passed; exact raw bytes did not always pass.
- Claimed support does not replace live tests of current client versions and their actual envelopes.

Do not add our own repair layer or rewrite vendor internals on these results. Keep as a candidate, not a deployed replacement. A narrower noisy-command-only trial is defensible; a transparent all-context product claim is not.

Only the new qualification proxy/mock processes were stopped. Existing working services and earlier authorized Desktop test settings retained. Binary/license/test profile remain in temporary lab for follow-up. Desktop, Windows/Linux, auto-update/uninstall and WebSocket not qualified; no telemetry integration deployed. No commit/push.
