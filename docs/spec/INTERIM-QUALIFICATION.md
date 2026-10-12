# Interim candidate qualification

## Emergency recovery — 2026-10-12

User authorized immediate recovery with qualified 0.4.7 while 0.4.8 remains unfinished. Frozen archive SHA256: `f70d230e044984f9e3060196234d879e62ec734ff4bd6ac5fe34ab40433f3c7b`. This is manual candidate adoption, not a signed stable release.

- Native Windows and WSL artifact gate: 156 passed, 2 skipped, 0 failed each. User completed native Windows Codex setup from the exact archive, transaction `1791791671772-38712`: monitor installed, no warnings, initially only `codex:telemetry_delivery_unverified`. First attempt correctly refused an active old proxy session. WIN_CDX2 live readback confirms selected/front/running/target/active worker 0.4.7, `local-tools`, front protocol 1, one worker, no retiring worker or stage failure. Normal-policy Codex request returned `WINDOWS_CODEX_OK_047` in ~17 s, exit 0, no errors; session `01a12f1f-0f29-7bb0-9043-88f0d7e42e01`. Synthetic OTLP/readback delivered; monitor snapshot accepted, monitor outbox empty. Native conversion completed, acknowledgement matches the completed turn, queue empty. Independent Langfuse CLI session readback confirms two observations (AGENT and GENERATION), model `gpt-6.1-sol`, input/cache/output usage and tags `host:windows`, `runtime:native`, `agent:codex`, `user:alexkirs`. This no-tool request proves native capture, not RTK savings. WSL production adoption is not implied.
- FRA: gateway, overview, Codex and Hermes upgraded to the same archive. Both verified proxies report front protocol 1, active worker 0.4.7, `local-tools`; no cloud compressor selected.
- FRA normal-login model checks: Hermes `FRA_READY_047`, Codex `FRA_CODEX_READY_047`, both exit 0. No model, approval or sandbox override. No tool was requested; this does not clear the earlier sandbox uid-map blocker.
- Hermes gateway plugin handlers reloaded through its native control socket; active sessions not restarted.
- FRA monitor service active; snapshot accepted by gateway. Overview readback shows fresh FRA, selected/monitor/both proxy versions 0.4.7, both proxy states `ok`, enabled updates and connected release subscription. Synthetic OTLP/readback delivered separately for Codex and Hermes. Full native capture and paid-token savings remain separate checks.
- Private setup/recovery receipts retained under the installation; configuration backups retained. Busy Claude Desktop excluded from intermediate changes.
- Windows latest failed turn reported `Selected model is at capacity`; that failure is not proof of a compressor timeout.
- FRA Codex native capture remains unproved: fresh session `01a12f0f-ba18-7712-b4e9-97b79c8c2b7f` returned the expected model reply, but Langfuse CLI readback found zero observations despite an empty local conversion queue. Synthetic delivery success does not clear this gap.

### Fresh fleet checks and native trust

Exactly one new model request each on FRA: Codex session `01a12f2a-1653-74e2-ad0c-08971c894226`, Hermes session `20261012_081053_7be344`; both exit 0 and return the expected marker. Hermes remote readback: GENERATION + CHAIN, actual usage, correct FRA/Hermes tags. Initial Codex remote readback: zero observations, conversion queue empty.

Root cause confirmed in native Codex `/hooks`: Stop installed 1, active 0, review 1. Reviewed the exact owned `node launcher.mjs native-hook codex` definition and trusted that single hook through the native UI; Stop now installed 1, active 1. No bypass flags or model/sandbox/approval changes. See [official hook trust requirements](https://developers.openai.com/codex/hooks/). Hook configuration and a successful synthetic upload do not prove native trust.

Recovered the exact retained Codex turn `01a12f2a-1817-7220-a1cf-55397279c6f1` through the existing enqueue/worker, without another model call. Acknowledgement matches that turn, queue empty; independent remote readback now finds GENERATION + AGENT, actual input/cache/output usage, correct FRA/Codex tags. This is recovered capture; automatic export after trust remains to be observed on the next natural turn. Older missed sessions were not silently replayed.

Mac/Desktop 0.4.7 adoption is now explicitly authorized after the user's safe session closure. Private backups prepared; latest verified legacy Codex connection count remains 2. No forced closure or Mac setup performed while that condition is pending.

Fresh Windows/WSL fleet requests (one each, normal configured model/login/policy): all return the expected marker, exit 0. Independent remote readback:

| Agent | Native session | Capture |
|---|---|---|
| Windows Codex | `01a12f31-1853-7cd2-8ae9-e37644a04c65` | GENERATION + AGENT; actual usage; correct Windows/native/Codex/user/device tags |
| Windows Claude Code | `e69390ea-fb42-4486-bdcb-57c21010cc43` | Recovered SPAN + GENERATION, actual usage, correct Windows/native/Claude/user/device tags; see runtime repair below |
| WSL Claude Code | `65fec4a3-c642-4a96-ad46-d278a7e2a2a5` | SPAN + GENERATION; actual usage; correct Windows/WSL/Claude/user/device tags |

Both Windows and WSL selected/front/backend proxies report 0.4.7/local-tools. WSL Codex profile/proxy migrated, but no native Linux Codex executable found; no Windows binary substituted and no model check claimed. These no-tool turns qualify routing/capture, not compression effectiveness.

Windows Claude official hook used MS Store Python without `langfuse`; UV was absent from its actual Git Bash PATH. Added previously qualified UV 0.13.0 to the absent user `~/bin/uv.exe`, verified source/target SHA256 `2bfbe53d3cc95799e98fa08323b04844fc01d4f8c87dd5c00089e43f6554f162`. The unmodified official PEP723 script recovered the exact retained session with one Stop replay, exit 0, no new model calls. Independent remote readback confirms capture. No vendor/system Python/PATH/model/policy/auth changes. Automatic future Stop delivery remains unproved until a natural turn. Ownership receipts retained by WIN_CDX2; **0.4.7 uninstall does not remove this temporary user UV dependency**, which must be integrated into the next candidate's ownership/removal contract. Do not delete shared UV caches.

### 413 / RTK 403 investigation

Mac's working 0.4.5 Claude collector returns `413 body_limit` for an authenticated synthetic 4 MiB + 1 byte request. Offline measurement of the retained TaskQ transcript through official hook 1.2.1 and SDK 4.17.0: default batching produced a maximum 392,655,933-byte protobuf batch (430,249,916-byte JSON equivalent); individual spans stayed below 4 MiB. With supported `LANGFUSE_FLUSH_AT=1`, maximum protobuf/JSON batches were 1,823,750/2,002,974 bytes, all below the limit. The active transcript advanced between runs (1143/1154 observations). Measurement used a custom local exporter, disabled media uploading, preserved original hook state and made no external uploads or model calls. This does not qualify media, a whole-backlog replay, or delivery after production adoption. SDK batch-byte caps drop oversized batches; they are not a batching repair.

Official Claude hook persists progress before SDK flush; failed exports can therefore be skipped by an ordinary replay. Preserve state and recover only verified missing IDs.

RTK 403 root cause confirmed in frozen 0.4.7: ingress and Python worker use different control keys. Current 0.4.8 source passes one installation key to workers. Isolated real TCP ingress + real Python worker: wrong key 403, shared key 200/accepted. Telemetry disabled in this probe; remote RTK delivery remains an adoption/readback gate. Production profiles unchanged by these investigations.

The following sections retain historical qualification evidence.

Current candidate: 0.4.5. Status: **partial qualification; not a stable fleet release**.
Artifact SHA256: `7f97a9c43797a3407018b5812e3c3bc12793a310d2d57537502bb8953a6b7762`.
Live interface qualification below used 0.4.4 (SHA256 `465453c875673a5e7512824ff7b26a44fb926f6ce4392a5b666c679bcf14107e`).
0.4.5 changes only telemetry session-presence reporting and package/adapter versions; MCP/CLI/engine code is unchanged.

## Contract

- R2: one `agent_context` MCP: `index_document`, `search_document`, `get_original`. Backend paths stay private; changing engine does not change client registration.
- R3–R4: `tools run` executes qualified RTK commands through the client's normal shell. Preserve sandbox, approval, exit/error evidence; recover originals without rerunning.
- R9–R10: proxy routes requests and telemetry. No injected tools or broad request compression. RTK estimates are separate from model usage/cost.
- R11: retain current installer/updater/ownership machinery. Clean-build workflow remains a separate experiment.

## Verified results

| Environment / interface | Result | Evidence |
|---|---|---|
| macOS package | Pass | npm test: 151 pass, 1 skipped, 0 fail; npm pack; Python adapter: 30 pass |
| macOS isolated installation | Pass | Private RTK 0.51.0, context-mode 1.0.169, MCP SDK 1.32.1; vendor install scripts disabled |
| Own MCP protocol | Pass | Exactly three tools; 9324-character reference indexed/searched; original matches UTF-8 bytes |
| Codex CLI 0.4.4 | Pass | workspace-write, unchanged approval policy; E42, 40 pass/1 fail, exit 101; all passing names recovered |
| Claude CLI 0.4.4 | Pass after explicit test-command approval | Initial Auto classifier denial retained as evidence; approved run preserved E42/counts/exit and recovered all passing names |
| Claude Desktop Code 0.4.4 | Pass after explicit test-command approval | Index/search passed; subsequent approved native run preserved E42, 40 pass/1 fail and exit 101; recovered all 40 passing names through own MCP |
| FRA Linux installation/package | Pass | Private dependencies installed; npm test: 148 pass, 2 skipped, 0 fail; npm pack |
| FRA Linux own MCP | Pass | Three-tool catalog; 9324-character document; search and byte-equivalent original |
| FRA live agent/RTK | Unverified | Existing agent account lacks cargo/pytest/go executables; known Codex sandbox uid-map restriction remains |
| Native Windows / WSL | Pending | Exact candidate sent to WIN_CDX2 for isolated qualification using existing authorized transfer access |
| Live Langfuse readback | Partial pass | Codex native-tool observation contains actual wrapper 0.4.4, RTK 0.51.0, native session, exit 101; estimates 385→75, elapsed 163 ms |

## Remaining acceptance

- R9: 0.4.5 fixes inherited `native_session_missing=true` when a native-tool event supplies its session. Python adapter: 31 tests pass; npm gate: 151 pass, 1 skipped, 0 fail; npm pack passes. Verify live readback before promotion. A present session does not imply a known turn.
- R3/R10: reduction of one command output is not proven whole-task savings or subscription-quota savings. Paired quality/model-usage evaluation remains separate.
- Native command approval remains client-owned. Initial Claude Auto denials are not compression failures and must not be bypassed.
- Complete Windows/WSL platform qualification and fleet lifecycle/rollback proof (A1/A3/A5). Current tests do not qualify every client or OS.
- Update gateway schema before deploying clients with new native metrics. Defer active-session replacement; verify actual running versions after authorized canary.
- Temporary Desktop test MCP/hook/command approvals remain isolated-test configuration, not production onboarding. Restore or migrate only owned edits; preserve unrelated experiments.

No production profiles, gateway or dashboard were promoted by this qualification. Existing exported observations remain unchanged.

## 0.4.7 candidate — permanent TCP ingress

R6 acceptance: real forked TCP workers preserve an existing upgraded stream across switch; new connections select the ready worker; third release waits; active crash rolls back; invalid readiness preserves active version. Accelerated retirement/grace test closes idle upgraded stream, kills worker and descendant, records forced-exit incident. Production defaults remain 15 min + 30 s. These protocol fixtures do not prove native Codex/Claude reconnect behavior.

R9: Python collector has an installation-scoped kernel sender lease. Stop conversion queues metadata, then invokes the unmodified vendor exporter asynchronously with one-span batches. Isolated 377,008-byte noisy-turn pilot: enqueue 2 ms; background export 17,898 ms; vendor acknowledgement present; conversion queue empty. This is collector acceptance, not confirmed remote Langfuse readback or model-token savings. Exporter version metadata is separate from model-worker version.

Real Python smoke: front/active/backend all 0.4.7; authenticated shutdown 200. Node gate: 159 passed, 1 skipped. Python gate: 35 passed. Direct remote readback returned HTTP 404; end-to-end delivery remains unverified.

Remaining release gates: native reconnection, real Python blue/green switching lifecycle, Windows/WSL and Linux exact-artifact gates, panel visual verification, and fleet canary. Native Windows currently uses the legacy logon task; Windows Service requires local elevated registration under the owner account, not LocalSystem. No 0.4.7 production promotion yet.

## 0.4.8 telemetry corrections, 2026-10-12

R9: Claude installer sets stock SDK `LANGFUSE_FLUSH_AT=1`; native-event delivery failures retain the event and record sanitized incidents. Test covers rejected 403, retry and acknowledged deduplication. Existing shared front/worker control-token fix is included. Hermes missing MCP collection is initialized before migration.

Local Node gate: 162 pass, 1 skip; 35 Python adapter tests passed; isolated local-tools HTTP smoke passed with exact passthrough of protected content; npm pack passed. This is not fleet qualification or confirmation of production Langfuse delivery.

Open incident: user observed Codex HTTP503 immediately after native context compaction in this chat. Active Mac proxy remains 0.4.5; its retained log contains no matching failed response, and inspected Desktop logs do not establish the origin. The OpenAI-style response body suggests upstream failure but is not conclusive. Do not claim the 403/413 fixes solve this incident, introduce blind request replay, or declare compression causal without request-level evidence.
