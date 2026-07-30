---
name: concurrent-codex-sessions
description: Owner runs parallel Codex sessions that commit+push to main from the MAIN checkout and sibling worktrees — never assume the main checkout is idle
metadata: 
  node_type: memory
  type: project
  originSessionId: b1393151-cbfd-4ead-bae4-a1fa6dd5ca5d
  modified: 2026-07-30T05:43:41.137Z
---

The owner runs multiple concurrent Codex agent sessions against pokewin-admin (seen 2026-07-30: `codex/discord-superuser` worktree inside the repo, plus sibling worktrees `pokewin-admin-cleanup-task`, `-deal-command`, `-fraud-channels`, `-opportify`). At least one of them works directly in the MAIN checkout, committing and pushing to origin/main every few minutes, so the working tree and HEAD can change between any two commands.

**Why:** A stash/edit in the main checkout can yank files out from under a live session (happened 2026-07-30); "uncommitted changes" there are usually another session's in-flight work, not abandoned.

**How to apply:** Do task work in a fresh isolated worktree off origin/main (short path — `git worktree remove` fails with "Filename too long" under the deep scratchpad path; use `rm -rf` + `git worktree prune`). Never stash/reset/commit the main checkout. Expect origin/main to advance mid-task: fetch + rebase right before push. Related: [[cwd-resets-between-turns]].
