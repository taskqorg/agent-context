# Spec-driven agent development experiment

Goal: our supplied AI manager/workers deliver [PRODUCT.md](PRODUCT.md) from a new codebase with minimum necessary code and tests. Use existing TaskQ/Git/CI; do not build an orchestrator, new testing framework or spec-management product.

## Authority and roles

- Owner approves product behavior, acceptance examples and deployment scope/policy.
- AI manager maintains the approved spec revision, closes ambiguities, chooses task order, assigns owners and integrates evidence. It cannot quietly change expectations to match code.
- Implementer delivers one bounded outcome from a frozen base in its own branch/worktree. No parallel writers in the same checkout or worker fan-out.
- Reviewer checks the frozen diff against requirement IDs and independent acceptance evidence. Reviewer's pass is not owner approval of new behavior.
- Integrator runs the combined candidate's acceptance; deployer promotes the exact reviewed artifact under existing authorization. Roles are jobs, not five mandatory agents/services.

## First build

1. **Freeze intent.** Approve product revision, core acceptance examples and non-goals. Record approval against a revision/hash. Evidence reports guide choices; legacy architecture is not a constraint.
2. **Choose technology.** AI manager compares at most three plausible stacks against cross-platform artifacts, upstream integration, install/update/removal, resource use, maintenance and own-code size. Choose the simplest adequate stack, not an abstract “best language”. Produce one short plan: components/ownership, interfaces, dependencies, operating limits, canonical gates and rollout policy. Owner reviews material tradeoffs once; routine choices stay autonomous within scope.
3. **Start clean.** Create an empty implementation project with thin agent instructions pointing here. Do not copy/import old runtime or old tests. Reuse upstream products and platform facilities. Keep specs/evidence; archive old work before a separately authorized deletion/migration. Do not stop working installations just to start the experiment.
4. **Freeze shared boundaries.** Agree only interfaces/data required by the first slice. Define one canonical event identity/accounting contract and owned configuration manifest. Schema/example checks reuse this definition; no second manually maintained specification of every field.
5. **Assign vertical slices.** Start with one selected client on one host: install → real optimized task → correlated telemetry → status → uninstall. Then add safe updates/tool replacement and remaining platforms/clients. Parallelize only independent ownership after shared boundaries stabilize; do not assign separate teams to layers that cannot yet produce a working chain.
6. **Accept and integrate.** Require requirement-linked proof from implementer, independent review where risk warrants, then acceptance on the combined frozen commit. Passing branches are not proof of a passing merge. Changed shared boundaries invalidate affected tasks; manager rebases/reviews them before merge.
7. **Release.** Build immutable target artifacts once in CI. Canary the exact approved version/config: real request, recovery, running version and delivered telemetry. Widen under authorized policy; failure rolls back. User sees actual coverage and remaining gaps.

## Task contract

Each existing task record carries only:

- approved spec revision/hash + requirement IDs;
- observable outcome and non-goals;
- exact base commit, owner, allowed files/interfaces and dependencies;
- acceptance example/command, independent expected result and supported platform scope;
- bounded time/model-call budget and escalation condition;
- completion artifact: commit/diff + evidence + remaining limitations.

Manager keeps one compact requirement → task → proof → release ledger in existing task records. Do not duplicate whole specs/prompts across tickets. “Agent says done”, checkbox totals and passing unit tests alone are not acceptance. Stop after two repetitions of the same unexplained failure; diagnose or escalate rather than consume unlimited agent budget.

## Continued changes

Request → investigate/test → propose narrow spec/example amendment → owner approves revision → update affected plan/model/tasks → implement → accept combined artifact → authorized deploy.

If code violates unchanged approved behavior, it is a bug: fix against the existing contract; do not weaken the spec or ask the owner to reapprove the same behavior. New behavior cannot start before its amended contract is approved. Preserve completed evidence; mark unsupported/unknown explicitly. An emergency restore/rollback follows already approved recovery policy and is recorded, not a silent feature change.

## Formal control: small and optional

Start with product examples and machine-readable interface constraints. Formalize only risky state transitions if the small experiment justifies its added toolchain.

Good targets: install/update/remove exclusion; no unverified release activation; active work drained before switch; recovery cannot delete unrelated files; stable event IDs/acknowledgments prevent double accounting. Associate each invariant with an R-ID, explicit assumptions and observable events.

- Lightweight default: one state model + generated operation sequences/property checks in the selected runtime's existing test tools.
- **P + PObserve:** model/check event-driven protocols, then monitor normalized implementation logs. Closest fit to a post-run trace checker; needs event mapping and tooling.
- **Quint + model-based testing:** concise transition model, generated action sequences and driver comparison with implementation; Quint Connect is Rust-oriented, not a reason to force Rust on the product.
- **TLA+ / TLC:** established design-level state/invariant checking; implementation conformance still needs a trace/test bridge. Lean/full code proofs are not required for this package.

No automatic proof that natural-language prose equals a model. Owner/reviewer checks the requirement-to-invariant mapping and examples. Model checking proves properties of the model under its assumptions/bounds; trace checking proves properties of observed executions. Neither alone proves all production code, external tools or content-compression quality. AI review assists this mapping; it is not a mathematical guarantee.

A formal spike stays limited to one lifecycle scenario. Adopt it only if it finds meaningful cases with less ongoing effort than ordinary targeted checks. Do not formalize the whole product or maintain two complete parallel specs.

## Evaluate the development experiment

For the first few accepted slices, record own code/dependencies, manual install steps, implementation/review tokens and time, retries, rejected outcomes, regressions and acceptance-runtime cost. Count integrated working outcomes, not tasks or tests. Adjust decomposition/tools from evidence; never reduce correctness to make the process look efficient.

## AI manager kickoff

> Read PRODUCT.md, VERIFICATION.md and this workflow. Prepare a short clean-build technology/implementation plan and requirement-linked tasks; do not implement yet. Choose the simplest adequate cross-platform stack using ready upstream tools. Plan the first complete install → useful optimization → telemetry/status → uninstall slice. Use my supplied agents and existing task system; isolated worktrees, no legacy code/test inheritance or new orchestration framework. Propose only core scenario tests and distinct high-risk checks. State open decisions, operating budgets and acceptance proof. After approval, implement approved slices, review the combined candidate and deploy only within authorized scope. For later behavior changes, amend and obtain approval of the spec before implementation.

Sources: [GitHub Agentic SDD](https://github.github.com/spec-kit/reference/agentic-sdd.html), [BDD/example mapping](https://cucumber.io/docs/bdd/example-mapping/), [test shapes](https://martinfowler.com/articles/2021-test-shapes.html), [P/PObserve](https://p-org.github.io/P/), [Quint model-based testing](https://quint.sh/docs/model-based-testing), [TLA+ scope](https://www.learntla.com/intro/faq.html). These are optional tools/methods, not mandatory dependencies.
