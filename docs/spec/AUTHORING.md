# Spec authoring

- English; short, precise sentences. One requirement per ID. Preserve numbers, negations, conditions and exceptions.
- Product spec owns outcomes, scope, constraints and acceptance—not file layout or speculative technology.
- Keep one canonical product spec. Evidence, technical plan and execution status stay separate; do not duplicate requirements across task tickets.
- Distinguish required, verified, unverified and open. A prototype or vendor claim is not product qualification.
- Pair requirements with a small executable example or a stated proof. Unknown/default decisions must be closed in the plan before implementation.
- Preserve requirement IDs within a revision series. Revision 2 starts the clean-build R1–R12 contract; retired draft IDs are not implementation tasks.
- User approves changed behavior before implementation. Existing authorization for unchanged behavior remains valid; agents must not invent extra approval steps.
- A bug violating an approved requirement needs a fix, not a spec change that excuses the bug. Changed expectations require a spec amendment.
- Amend only affected requirements/examples; update dependent task/model references. Keep the contract short and link evidence.

Use [PRODUCT.md](PRODUCT.md), [AGENT-DEVELOPMENT.md](AGENT-DEVELOPMENT.md) and [VERIFICATION.md](VERIFICATION.md). Do not generate a document for every function or development step.
