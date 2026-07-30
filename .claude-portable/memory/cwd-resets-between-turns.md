---
name: cwd-resets-between-turns
description: Shell cwd silently resets to the main checkout between turns — never run git reset/checkout without an explicit absolute cd in the SAME command
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ee2803a1-a012-4949-8f2f-8da123310038
  modified: 2026-07-28T22:19:28.666Z
---

On 2026-07-29 a `git reset --hard origin/main` intended for a build worktree ran in the MAIN checkout because the Bash tool's cwd had silently reverted to the project dir between notification turns. It yanked another active session's local main from `4250990c` to origin/main and wiped its uncommitted state (rescue branch `rescue/pre-reset-2026-07-29` preserves the commits).

**Why:** cwd persistence across turns is not guaranteed, and the main checkout is often mid-flight for OTHER concurrent sessions (see [[fetch-before-audit]]).

**How to apply:** any destructive git command (reset --hard, checkout --, clean, rebase) must start with an explicit absolute `cd <worktree> &&` in the same command line, and verify `pwd`/`git log -1` output matches the intended tree before acting. Treat the main checkout as shared, possibly-active territory — never hard-reset it.
