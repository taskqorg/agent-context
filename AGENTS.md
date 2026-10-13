# agentq

Shared rules: https://github.com/taskqorg/specq (binding for every task). Used owner pages: [principles](https://github.com/taskqorg/specq/blob/main/engineering/principles.md), [spec first](https://github.com/taskqorg/specq/blob/main/engineering/spec-first.md), [release contract](https://github.com/taskqorg/specq/blob/main/engineering/release-contract.md), [verification](https://github.com/taskqorg/specq/blob/main/engineering/verification.md), [documentation](https://github.com/taskqorg/specq/blob/main/caveman/rules/documentation.md).

Read [agentq.md](agentq.md) first; a decision change edits it before code. Product outcomes: [docs/spec/PRODUCT.md](docs/spec/PRODUCT.md); acceptance: [docs/spec/VERIFICATION.md](docs/spec/VERIFICATION.md).

Install, onboarding or removal at a user's request: [INSTALL.md](INSTALL.md).

Checks: `cargo test --locked`, `cargo run --locked -- selftest`. While the legacy Node package stays (agentq.md § 10): `npm test`, then `npm pack`; test it in an isolated `AGENT_CONTEXT_HOME` and, for CLI uninstall, an isolated `npm_config_prefix`, else it removes the real global npm package. Qualifying a candidate does not authorize deploying it to working profiles or calling it stable.
