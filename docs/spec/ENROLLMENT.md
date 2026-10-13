# AgentQ connection

Accepted target under [agentq.md](../../agentq.md), PRODUCT R5/R9/R10. [Shared semantics](https://github.com/taskqorg/specq/blob/main/engineering/product-connections.md); [complete scenario, limits and E1–E10](https://github.com/taskqorg/dashq/blob/main/docs/design/enrollment.md). Not a shipped-command claim.

- `agentq enroll <https-url>` reuses installation/service/update state and the coreq connection client. Browser or headless approval uses DashQ's identity provider; no GitHub token, copied key, onboarding rerun, capture or routing change.
- `agentq connection status` reports destination, connection/projection/export state and safe recovery action. `agentq disconnect` follows C1, including pending offline revocation. JSON matches CLI facts; no secrets.
- Existing `data/installation` remains identity. Snapshot allowlists version, runtime, component/routing/engine state, queue counters, source timestamps and resource samples with unknown reasons. Raw status, paths, prompts and arbitrary OTLP attributes never cross enrollment.
- Use the existing sender queue and C5 cadence/bounds. Wake immediately for first real snapshot; keep the existing resource probes and 300-second history cadence. Enrollment completion is independent of CPU warmup, chart history and Langfuse export.
- Preserve standalone configuration until new projection receipt verifies it. New records switch atomically; old records retain destination/generation and consent. Disconnect does not revive the old destination. Accepted receipt precedes queue deletion; retransmissions retain IDs.
- Protected per-installation credentials and revoke state are excluded from queue pruning and update cleanup. Never migrate a credential into another installation or runtime.
- C3's owner-accepted credential lifetime exception is observation-only. No task actions, remote execution or shared employee secrets.
- Release requires installed desktop/headless and storage/service qualification on macOS, Linux, native Windows and WSL, plus E1–E10 applicable to AgentQ. Existing resource qualification is reused; no fake workload or invented chart samples.
