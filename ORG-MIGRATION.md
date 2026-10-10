# Organization layout and TaskQ migration

`taskqorg/agent-context` owns executable context adapters and their installation, verification, releases and rollback. A separate proposed `taskqorg/agent-guidelines` should own original, reusable development policies and versioned adoption recipes. Do not redistribute third-party Caveman or other plugin content without checking its license; reference upstream instead. Project-specific decisions stay in each project's canonical contracts. Do not copy secrets, private incident logs or host inventories into public repositories.

TaskQ repository transfer is deferred. This document authorizes no queue start or transfer by itself.

## Migration checkpoint

1. Obtain the owner's coordinated migration window. Every host acknowledges dispatch/ARM/retry pause. Inventory running workers, sessions, results, PRs and held claims; finish operations safely and preserve their data. A quiet UI alone is insufficient.
2. Record the current repository identity, default branch, commit, issue/project IDs and URLs, open PRs, releases, automation definitions and adapter settings. Confirm target organization permissions and repository-transfer limitations before mutation. Project-board ownership and external integrations require separate inspection; never assume a repository transfer also moves them.
3. Transfer the repository once. Verify the new owner and canonical URL through the provider API. Check issue/PR history, releases, protected branches, Actions permissions, webhooks and project-board access. Keep a migration evidence record and stop on an unexplained mismatch.
4. Publish one pinned migration brief with old/new coordinates and the qualified TaskQ version. Update installer/source URLs, repository defaults and owned documentation. Keep provider IDs stable where supported; map changed IDs explicitly. Do not replace boards or recreate issues merely to change URLs.
5. Each host updates the existing checkout remote and installs the qualified release through the supported update command. Inspect effective repository and board settings, credentials scope and automation prompts; doctor/read-only queue inspection must point to the new canonical source. Preserve sessions, locks, branches, results and local configuration backups. Do not run tick during this step.
6. Each PM reports host, installed version, canonical remote, board identity, doctor result and unresolved work. The migration coordinator reviews acknowledgements from all hosts before issuing any explicit resume instruction. Old paths redirecting successfully do not prove every integration was updated.

## Brief to installed agents

TaskQ has moved from `<old-coordinate>` to `<new-coordinate>` at qualified release `<version/commit>`. Queue remains paused. Update only the owned TaskQ remote, installation source and repository settings using the supported updater. Check board/provider identity and effective automation instructions. Preserve all worker sessions, claims, branches and results. Return sanitized read-only evidence; do not dispatch, retry or release anything until the migration coordinator explicitly resumes the queue.