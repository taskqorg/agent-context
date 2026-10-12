# Context optimization candidates

Status: research + local qualification. No production selection or rollout.

## Baseline

- Keep native compaction, login, subscription, model and approvals.
- Load detailed instructions through Skills, not startup files.
- Keep native deferred tools/tool search.
- Transform new tool results once. Preserve transmitted prefixes and prompt caching.
- Measure input/cache/output separately. Output reduction is not subscription savings.

Sources: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[Skills](https://learn.chatgpt.com/docs/build-skills),
[Claude cost guidance](https://code.claude.com/docs/en/costs),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Alternatives

| Candidate | Ready mechanism | Evaluate |
|---|---|---|
| Headroom | Local tool-result compression | Relevant detail retention; structured data; original retrieval |
| RTK | Command-aware output filters; native binaries | Shell savings; failures/exit status; unsupported passthrough; recall |
| JFrog Boost | Command filters, recovery, reporting, OTLP | Same checks; preview terms; integration footprint |
| context-mode | MCP sandbox, local indexing/search, session continuity | Full retrieval path; calls/schema overhead; routing reliability |
| token-optimizer | Delta reads, skeletons, archives, checkpoints | Later experiment; overlapping hooks and behavior changes |

Sources: [Headroom](https://docs.headroomlabs.ai/docs), [RTK](https://github.com/rtk-ai/rtk),
[Boost](https://github.com/jfrog/boost), [context-mode](https://github.com/mksglu/context-mode),
[token-optimizer](https://github.com/alexgreensh/token-optimizer).

Native API context editing is a separate option, not a proven Max/Desktop setting.
Editing earlier turns can invalidate caches and signed thinking.
[Claude context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing).

## Small test contract

1. Replay safe tool content. Never capture credentials, user prompts or whole sessions.
2. Cover log, failing test, code, JSON, search, documentation and dense control.
3. Test observed Codex function/custom output and Claude tool-result/Bash-hook envelopes.
4. Run each case three times. Count every response needed to answer the question.
5. Check exact evidence, JSON representation, metadata roundtrip and original recovery.
6. Record cold startup, warm latency and MCP schema size separately.
7. Compare baseline and one candidate at a time. No stacked compressors.

Current corpus: one controlled live Claude Bash result; actual repository code/JSON/spec;
actual isolated pytest and rg output; one synthetic dense control.
Envelope replay uses observed transcript shapes. It does not prove native hook/proxy integration.
Both clients use `o200k_base` estimates for comparison; Claude usage is not measured.
Needle retention is a small deterministic check, not model answer-quality proof.

## Test bundles

[Variant recipes](../../benchmarks/context-options/variants.json) pin tested versions and routes.
These are isolated qualification bundles, not new production npm packages.
No hooks, agent profiles, login or running proxies are changed.

The prepared Mac lab is `/tmp/contextq-optimization-lab`:

- `rtk/rtk`: upstream native release.
- `context-mode/node_modules/context-mode`: upstream npm package and MCP server.
- `boost/boost`: upstream Mac binary; global consent check prevents this isolated route.
- `boost-linux/boost`: upstream Linux binary, tested in a network-disabled Docker container
  with separately accepted preview terms; host agent settings are not mounted.
- Headroom: existing isolated Python environment, version 0.40.0; no model download.
- `corpus/`, `outputs/`, databases: local qualification data; not committed.

Re-run with a Python environment containing Headroom 0.40.0, tiktoken and pytest:

```sh
python scripts/context-options-benchmark.py \
  --lab /tmp/contextq-optimization-lab \
  --output /tmp/contextq-optimization-lab/results.json
```

Optional `--claude-original <path>` replays the approved controlled live fixture.
Without it the runner reproduces that fixture and labels it accordingly.
Install context-mode locally with `npm install --prefix <lab>/context-mode context-mode@1.0.169`.
Extract the matching [RTK release](https://github.com/rtk-ai/rtk/releases/tag/v0.51.0) into `<lab>/rtk`.
Do not run global `init` commands for this replay.

Boost uses the current documented suffix recipe `(command) | boost`, not `boost command`.
Extract the Linux arm64 asset from its pinned release into `<lab>/boost-linux`.
After accepting its preview terms, append `--boost-container --accept-boost-preview`.
The runner uses the existing `ubuntu:24.04` image, no network, temporary container storage,
and local corpus mounts. Linux/container latency is not native Mac latency.
Offline defaults reported `boost-cli-filtering: false`; the qualification explicitly
enables that feature with `BOOST_FEATURE_FLAGS_FORCE_ENABLED=boost-cli-filtering`.
This is a recorded test configuration, not proof of the default onboarding behavior.

## Selection gate

Use local results to shortlist, not promise universal savings.
Before selecting the production bundle, run the same real task with baseline and candidate:
fresh Codex and Claude Code sessions; measured usage/cache; correct result; retries;
retrieval; uninstall; Mac, native Windows and Linux.
Desktop Chat remains separate from Desktop Code.

Prefer the smallest passing bundle. Reject lost required evidence, broken approvals,
unavailable originals, hidden fallback or an unverified client route.

See [local results](CONTEXT-OPTIONS-RESULTS.md).
