# Cloud comparison and safe profile

Date: 2026-10-12. Follow-up supersedes the broad RTK recommendation in the first trial.

## Method

- Same frozen seven payloads, same queries, same provider wrapper.
- Real saved SuperCompress and ScaleDown credentials; no key values copied or printed.
- Three repeats; 10-second request budget. Stop a variant after two consecutive failures.
- Explicit variants: SuperCompress Neural; documented Compiler; ScaleDown 0.5; recommended auto.
- Compiler remains a separate variant. Never disguise it as Neural fallback.
- Two additional Git cases: full-history query and the existing Claude hook policy.
- Git data comes from an isolated 30-commit fixture repository, not private project history.
- Same tokenizer (`o200k_base`) measures returned text. Keep service counters separate.

## Comparable results

Reduction below covers the same **seven original payloads**, not quota or total task cost.

| Variant | Payload reduction | Warm median | Important qualification |
|---|---:|---:|---|
| Headroom TextCrusher | 29.9% | 0.19 ms, in process | JSON representation failed; Git records lost |
| RTK pipe | 59.4% | 6.9 ms, native CLI | Generic pipe lost Git arguments and records |
| context-mode | 63.5% | 77 ms, MCP roundtrip | Search replies included; preserves Git; extra MCP context |
| Boost suffix, filtering enabled | 9.8% | 5.27 s, Docker + Linux CLI | Redacted recovery; Git not tested in this follow-up |
| SuperCompress Neural | Incomplete | Two long requests exceeded 10 s | Tiny probe returned Compiler; wrapper rejected substitution |
| SuperCompress Compiler | Incomplete | Two long requests exceeded 10 s | Tiny probe: 8.74 s, no gain |
| ScaleDown 0.5 | 11.12% | About 0.97 s | Required checklist retained; not full source-code preservation |
| ScaleDown auto | 22.90% | About 0.93 s | Required checklist retained; not full source-code preservation |

Latency boundaries differ. These are diagnostic measurements, not an engine-speed ranking.
Neural availability for our normal payload was not established. Tiny-input fallback does not
prove global Neural unavailability. Successful tiny responses established API reachability.

ScaleDown auto achieved 19.18% over all nine cases. Most savings came from targeted documentation:
1909 → 146 estimated tokens. Heartbeat log: 4018 → 4018; no saving.
Its returned code retained the checklist but failed `node --check` as a complete module.
Do not treat a relevant snippet as a complete source file.

One ScaleDown response reported 4831 → 4018 service tokens while returning the exact same
14340-character context. Our same-tokenizer measurement correctly recorded zero reduction.
The source of that service-counter discrepancy was not established.

## Git finding

| Route | Commit hashes retained | Complete hash + subject records |
|---|---:|---:|
| Original | 30/30 | 30/30 |
| TextCrusher | 22/30 | 22/30 |
| `rtk pipe -f git-log` | 4/30 | 0/30 |
| Native `rtk git log --oneline -n 30` | 30/30 | 30/30 |
| context-mode | 30/30 | 30/30 |
| ScaleDown auto | 30/30 | 30/30 |

The RTK defect was in our chosen pipe recipe: original command arguments were absent.
The native command preserved the explicit `-n 30`. This does not qualify every RTK command.
Do not insert generic RTK pipe filters into the HTTP proxy or re-execute an already-run command.
The screenshot alone does not identify the exact live failing request; replay reproduces the loss class.

## Final recommendation for the existing proxy

Try **ScaleDown auto with the safe profile**, as a qualification candidate.
It fits the existing provider boundary without models, extra MCP routing or a new service.
Lower savings are acceptable when the alternative silently drops requested records.

Safe profile contract:

1. Full Git history, source code, structured JSON, exact-output tasks: return original.
2. Unknown tool/command classification: return original.
3. Compress only explicitly eligible noisy text or requested document excerpts.
4. Archive original before replacement. Include a retrieval pointer; verify recovery.
5. Preserve query, tool identity, error status, critical evidence and transmitted prefixes.
6. Timeout, invalid response, failed validation or unavailable archive: return original.
7. Telemetry distinguishes compressed, no gain, protected, failed and fallback. Report actual savings.

This profile is specified, **not installed**. Runtime ScaleDown still requests 0.5;
the auto experiment changes the API payload only inside the test sender.
The profile must pass a real Codex/Claude task before promotion. Do not claim zero-error compression.

Native RTK remains the preferred local shell option if we choose a client-level integration
that preserves original arguments and normal approvals. context-mode remains the separate local
retrieval alternative. Neither replaces the proxy through an unqualified generic pipe filter.
Keep SuperCompress optional until normal Neural requests pass latency and mode checks.

## Re-run

```sh
python scripts/context-cloud-benchmark.py \
  --lab /tmp/contextq-optimization-lab \
  --output /tmp/contextq-optimization-lab/cloud-results.json
```

Requires the prepared local lab and canonical saved credentials. No login/profile changes.
Only safe fixture content is sent to cloud endpoints. Raw outputs stay in the isolated lab.

[Metadata and checks](../../benchmarks/context-options/cloud-results.json) ·
[Previous local trial](CONTEXT-OPTIONS-RESULTS.md)

API recipes: [ScaleDown auto](https://docs.scaledown.ai/quickstart),
[SuperCompress Compiler](https://docs.supercompress.dev/api-reference),
[RTK native command integration](https://github.com/rtk-ai/rtk).
