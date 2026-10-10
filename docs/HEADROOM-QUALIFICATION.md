# Headroom + SuperCompress: qualification candidate

Headroom 0.40.0 owns transport and its native compressor registry; the external SuperCompress adapter supplies the paid compressor. Existing agent subscription login and SuperCompress credential source stay in place. No keys are packaged.

## Commands

Node 22+ and an installed Python 3.11–3.13 are required; `AGENT_CONTEXT_PYTHON` selects the interpreter. Preparation installs a pinned private virtual environment.

```sh
agent-context headroom prepare
agent-context headroom qualify --source mcp --protocol ws --approve-fixture-test-tool
```

The second command trusts only the static read-only fixture tool in its disposable Codex test. Retrieval requires its own explicit `--approve-retrieval-test-tool` flag. Neither flag changes global trust. Qualification starts and stops its own loopback proxy and leaves global routing alone.

`agent-context run codex|claude [agent arguments]` is an experimental per-process launcher. It owns a dynamically bound proxy and preserves native login. Windows currently needs `AGENT_CONTEXT_CODEX_EXE` or `AGENT_CONTEXT_CLAUDE_EXE` pointing to a native executable. Native installer integration and Hermes launch are not complete; the existing `install` command still installs the earlier MCP/Bash integration.

## Real qualification, 2026-10-11

| Agent | Environment | Automatic tool result compression and correct answer |
| --- | --- | --- |
| Codex | macOS, shell and MCP | PASS |
| Codex | Linux FRA, shell | PASS |
| Codex | Windows, Windows directory | PASS, read_fixture MCP |
| Codex | Windows, UNC WSL directory | PASS, read_fixture MCP |
| Codex | WSL, Linux directory | PASS, read_fixture MCP |
| Codex | WSL, /mnt/c directory | PASS, read_fixture MCP |
| Claude | macOS, native Read | PASS |
| Claude | Windows, Windows directory | PASS, native Read |
| Claude | Windows, UNC WSL directory | PASS, native Read and retrieval |
| Claude | WSL, Linux directory | PASS, native Linux Read; reported by WIN_CSGO |
| Claude | WSL, /mnt/c directory | PASS, native Linux Read; reported by WIN_CSGO |
| Claude | native Linux FRA/macOS other directory variants | Not qualified |
| Hermes | Linux FRA, native all-tool plugin + MCP fixture | PASS |
| Hermes | macOS/Windows | Not qualified |

Windows results came from WIN_CSGO against frozen v4 archive SHA256 `f189084467c5102155dead9c00c7a43586f4eaf2fb35524541720a9e46bf4a9f`. Four Codex runs each completed read_fixture and compressed about 11.6–11.8k characters to 856–897. Two Claude runs compressed 12184 to 889. The UNC Claude run also retrieved the original; independent byte equality for that run was not checked before shutdown. These are tested tool classes, not proof that every possible tool/output encoding is covered.

Hermes's real native plugin test returned the correct release, port and retry limit after SuperCompress reduced 11819 to 2989 characters. Evidence: FRA `/tmp/agent-context-hermes-alias-v4`. Its disposable profile shared native root authentication read-only and was removed afterward. The tested snapshot contains later qualification-script overlays and is not the same immutable archive as Windows.

WIN_CSGO subsequently reported both native WSL Claude routes PASS against v4: ELF Claude 2.1.296, its own normal claude.ai/firstParty/Max login, SuperCompress 12184→889 characters in 3140/2346 ms, correct release/port/retry facts and exit 0. Metadata resides in WSL `~/.cache/headroom-sc-four-routes/v4-claude-wsl-results.json`; raw evidence has not been independently fetched in this Mac chat. The prior six routes were not repeated. This closes eight Windows/WSL integration rows, not whole-task savings or final-package qualification.

## Whole-task comparison

An exact current user query and unchanged native tool schemas are necessary: generic compression queries lost facts and triggered expensive retrieval; native schema compaction reduced prompt-cache reuse. The pinned integration disables schema compaction and removes Headroom's built-in Read/Glob exclusions. Requalify both shims on any Headroom update.

Four paired synthetic tasks with alternating arm order all answered correctly:

| Usage | Baseline | Compressed |
| --- | ---: | ---: |
| Input | 111635 | 102200 |
| Cached input | 90112 | 88320 |
| Uncached input | 21523 | 13880 |
| Output | 383 | 363 |

Total input decreased 8.45%; uncached input decreased 35.51%. Every run used one shell call and no retrieval. Metadata is in `docs/benchmark-prefix-results.json`. These are small synthetic subscription tests, not representative project economics. SuperCompress expense/quota and representative workloads remain unmeasured; no monetary savings claim is made.

A further pair read the actual `src/update.js` and correctly identified repository, daily update interval and integrity-before-loading behavior. Baseline input/cached/output: 32087/23808/146; compressed: 27693/22144/143. Input decreased 13.69%; uncached input 32.97%. Both used one shell call, no retrieval. One small code-reading task is not a representative engineering workload. Metadata: `docs/benchmark-code-results.json`.

## Langfuse and remaining gates

Opt-in `AGENT_CONTEXT_LANGFUSE=1` exports compression spans using the existing credential source. Two live fetched observations were type SPAN with empty generation usage and no generation cost. Native tracers remain authoritative for model usage. Missing session/turn IDs are explicit; a shared trace tree is not yet proven.

The owned proxy launcher was checked for dynamic-port identity, clean shutdown and missing-executable failure. Current unit gate: 40 Node, 6 adapter and 2 Hermes plugin tests pass. A concurrent request test verifies separate exact queries and native session/turn identities with restoration afterward; live native correlation remains unqualified.

One-command automatic native installation/update, Windows executable resolution, all Claude platform variants, native telemetry correlation, concurrent recovery isolation, cancellation/reconnect and representative cost/quality tests remain open. Native upstream logging needs privacy review. This is not a production release and no global routing has been enabled.
