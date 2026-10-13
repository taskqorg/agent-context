#!/usr/bin/env node
// agentq.md § 10: the final npm version only prints the migration instruction.
process.stderr.write(`agent-context is retired and replaced by the agentq binary.
Next: download agentq from https://github.com/taskqorg/agentq/releases/latest and run \`agentq onboard --yes\`; it removes the old install after your consent.
`);
process.exitCode = 1;
