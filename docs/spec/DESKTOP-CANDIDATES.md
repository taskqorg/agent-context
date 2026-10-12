# Desktop candidates

Date: 2026-10-12. Qualification only. No production rollout.

## Contract

- Compare cloud wrapper, stock DietCode, native RTK, context-mode.
- Preserve user prompt, login, model, approvals and full Git records.
- Test real Desktop interception separately from component replay.
- Measure input/cache/output tokens; payload reduction is not quota saving.
- Store originals before replacement. Retrieval must reproduce exact bytes.
- Failed compression keeps original. Source/JSON must remain valid.

## Pinned kits

Manifest: `benchmarks/desktop-candidates/variants.json`.
Local kits: `/tmp/contextq-desktop-candidates/variants/`.
These contain Mac qualification paths, not portable production installers.
Dependencies: Headroom 0.40.0; DietCode 0.5.0; RTK 0.51.0;
context-mode 1.0.169. Keys remain outside kits.

DietCode installs with `--ignore-scripts`: its postinstall changes global
integrations. Test stock PostToolUse only; do not enable user-prompt rewriting.
RTK uses native command rewrite, not `rtk pipe` on already executed output.
context-mode needs native hooks and approved MCP, including original retrieval.

## ScaleDown compression API

- POST `https://api.scaledown.xyz/compress/raw/`.
- Header: `x-api-key`; read protected key source at runtime.
- JSON: `context`, `prompt`, `scaledown.rate`.
- Rate: string `auto` (default) or finite numeric string in [0,1].
- Response: accept nested `results.compressed_prompt`; validate success and type.
- Errors: HTTP 400/401/429/500, HTTP-200 error envelopes, malformed results,
  timeouts and no gain all retain original. No retries in qualification.
- Compare returned text with the same tokenizer; service counters are separate.
- Cloud Claude adapter: 12-second child limit; hook limit 15 seconds.
- Compress successful pytest/node-test stdout only. Protect Git/source/JSON
  and unknown commands. Do not silently expand this allowlist.

Other API operations exist: extract, classify, typed decisions and abstractive
summarization. They are not interchangeable context compressors and are not
implemented in our wrapper. Official contract: [OpenAPI](https://docs.scaledown.ai/api-reference/openapi.json).

## Current evidence

Results: `benchmarks/desktop-candidates/results.json`.

| Candidate | Component evidence | Desktop evidence | Status |
|---|---|---|---|
| ScaleDown wrapper | pytest: 2.56 s; no gain after original pointer | Claude hook invoked; Git protected, 30 records retained | Partial |
| DietCode | native stdout schema returns `{}`; 0.06 s | Not qualified | Reject current stock hook recipe |
| RTK | native Git retains 30/30 complete records, three repeats | Not qualified | Candidate |
| context-mode | frozen corpus: 63.5% payload reduction; originals retrievable | Not qualified | Candidate |

Claude Max returned real answers despite displayed weekly usage 100%.
Live pytest: 200 passed, one deliberate failure; full E42 details retained.
PostToolUse does not run for failed Bash. A recipe claiming failed-output
compression must separately qualify PostToolUseFailure; this test did not.

Initial fresh Claude session did not invoke the project hook. After an approved
temporary user hook was added, hook execution was observed, including duplicate
project/user invocation. Test routing was then scoped to one dispatcher.
User settings and prior temporary hook were restored after the UI control
returned repeated `elementHasNoFrame` errors. Do not infer universal project
hook incompatibility from this observation.

Codex replied to route probe, but isolated proxy saw only our health GET:
project override did not route that chat's inference. Existing production
proxy was untouched. Four-way Codex comparison is blocked until the normal
trusted project/profile route is actually applied.

No comparable Desktop quota-saving result exists yet. Do not promote a winner.
Prefer qualifying native RTK first for command output; context-mode for
large searchable context. ScaleDown remains an optional targeted candidate.

## Completion gate

For each client/candidate: fresh session; prove interception; run identical
Git, noisy successful output, deliberate failure, JSON and document cases;
check exact retained facts and original retrieval; capture unique native
message usage once; include MCP/system overhead; compare accepted answer.
Repeat only after all first-run rows pass. Then `npm test`, `npm pack`.

Current code gate: 146 passed, one skipped, zero failed; Python provider
tests: seven passed. npm package built. Full Desktop qualification incomplete.

## Single live ScaleDown Read proof

Evidence: `benchmarks/desktop-candidates/single-cloud-read.json` and
`single-cloud-read-output.txt`. Native session:
`5e8c48e3-60ad-4474-acef-fac50546e189` (Claude Desktop Code / Max).

- One native Read; temporary hook restricted to one designated text fixture.
- ScaleDown auto: 9,324 → 1,999 content characters, including original pointer;
  hook roundtrip 1,289 ms. Native transcript confirms replacement reached model.
- **Quality failed:** all three required provider identifiers disappeared,
  despite the compressor query explicitly requesting exact identifiers.
  Model reported them missing rather than guessing.
- Recovery: one native Read of archived original; exact bytes verified;
  identifiers and fallback policy correctly returned. Original not recompressed.
- Same `o200k_base` measurement of native formatted results: compressed 455,
  original 2,099; combined with recovery 2,554 (+21.7% versus original alone).
  These are tool-text estimates, not Claude billing or subscription savings.
- Actual unique-message model usage recorded; no uncompressed control turn,
  so no quota-saving claim. Existing system/MCP overhead remains in those totals.
- Initial Bash attempt was denied by Auto classifier (`Code from External`).
  No permission rule or approval policy changed; Read required no code execution.
- Temporary user/project settings and previous test hook exactly restored.

Result: interception and original recovery proven; this ScaleDown recipe fails
the semantic gate. Do not enable it by default. This proof does not qualify
arbitrary Read output, command output, other clients or other providers.
