# Desktop tuning

Date: 2026-10-12. Qualification; no production promotion.
Evidence: `benchmarks/desktop-candidates/tuning-results.json`.

## Same task

Frozen 9,324-character document. Seven required fact groups: platforms,
clients, WSL runtime, Desktop Chat scope, provider IDs, fallback policy,
local key/download requirements. Same Claude Desktop Code/Max, Haiku 5.5,
Low effort, normal login and Auto approval. Fresh chat for each candidate.
User prompt stays intact. Only designated Read result is replaced.

## Cloud screen

| ScaleDown setting | Returned characters before pointer | Required facts | Proof |
|---|---:|---|---|
| Original auto query | 1,894 | Provider IDs lost | Previous live test |
| Rate `0.5` | 5,356 | 7/7 groups present | API screen |
| Rate `0.8` | 2,176 | Provider IDs lost | API screen |
| Auto + preserve inline-code spans and identifiers | 2,265 | 7/7 groups present | API screen, two extra repeats, live test |

The stronger query adds: “Keep all inline-code spans exactly, including
provider names; do not remove identifiers or paraphrase restrictions.”
Three component responses matched; live response also retained required facts.
This is evidence for this task, not a universal preservation guarantee.

## Live comparison

Numbers include the original pointer, exclude native line-number formatting.
Latency covers the hook, dependency startup, compression/search and archive.

| Candidate | Result characters | Reduction | Hook latency | Model answer |
|---|---:|---:|---:|---|
| ScaleDown auto + stronger query | 2,370 | 74.6% | 1.531 s | 7/7 correct |
| context-mode index/search | 2,759 | 70.4% | 0.470 s | 7/7 correct |

context-mode 1.0.169 uses its stock `ctx_index`/`ctx_search` locally behind
our temporary Read hook. The agent's native MCP configuration is unchanged.
This tests our adapter recipe, not a globally installed context-mode plugin.
Returned sections retain source wording. The model recognizes that remaining
sections were not shown; the original remains available.

Local component qualification: three repeats; required names present;
exact original recovery passed. Use canonical physical file/project paths:
the `/tmp` alias versus `/private/tmp` initially triggered the vendor's
workspace boundary. Correcting paths inside the same authorized workspace
resolved it; no allow rule or permission policy was changed.

Native recovery: a second Read returned the original and the previously
unseen O2 clause correctly. Archived original equals source bytes. Original
was not recompressed. No context-mode child process remained after requests.

## Selected next candidate

Prefer context-mode for this document task: comparable reduction, no cloud
API, lower latency, exact source sections and working recovery. Keep ScaleDown
with stronger query as a cloud candidate. Rate `0.5` is a conservative screen
candidate; rate `0.8` failed. RTK remains the command-output candidate;
it is not a document compressor. Headroom is excluded from this comparison.

## Active temporary setup

- User-approved test hook remains enabled in Claude user settings.
- Active profile: `/tmp/contextq-desktop-candidates/tuning/profile.json`;
  provider `context-mode`.
- Hook: `/tmp/contextq-desktop-candidates/tuning/read-hook.mjs`.
- Only `/tmp/contextq-desktop-candidates/variants/cloud/claude-doc-read.txt`
  is eligible. Other files and archived originals pass through.
- Fixed benchmark query and fact checklist are qualification controls;
  they are not a general agent integration. Failed checklist retains original.
- Backup: `/tmp/contextq-desktop-candidates/tuning/settings-before.json`.
- Existing login, model, approvals, working proxy and unrelated hooks preserved.

Not qualified: arbitrary documents/queries, RTK command interception, other
clients/hosts, subscription savings or production lifecycle. Actual unique
model usage is recorded, but no matched uncompressed model turn exists.
These reductions describe tool text, not account quota. Temporary paths are
unsuitable for production installation.
