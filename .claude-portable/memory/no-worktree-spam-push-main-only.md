---
name: no-worktree-spam-push-main-only
description: User override — stop creating git worktrees/branches per task; work directly in the main checkout and push straight to main
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a551576b-5904-491a-87d9-5da963355915
---

Do NOT create a new git worktree or feature branch for a task unless the user explicitly asks for isolation (e.g. genuinely conflicting parallel edits to the same files). Work directly in the main checkout on `main` and push straight to `origin/main` when the build gate is green.

**Why:** By 2026-07-05 the repo had accumulated 100+ stray `worktree-agent-*` / `worktree-wf_*` branches and dozens of leftover worktree directories (`.claude/worktrees/*`, plus several `C:\Users\motha\Documents\GitHub\pokewin-*` sibling checkouts) from CLAUDE.md's documented "isolated worktree" pattern for parallel pushes. The volume got bad enough that `Glob`/`Grep` over the repo started timing out (scanning node_modules across dozens of worktrees), and the user explicitly told all agents to stop: "only push to main and stop spamming trees/branches."

**How to apply:** This is an explicit user exception overriding the CLAUDE.md "Fan-out-Geometrie" worktree-isolation guidance (CLAUDE.md itself says explicit user exceptions win). Default to editing in the main checkout and pushing directly. Only reach for `isolation: "worktree"` when multiple agents must mutate the *same files* concurrently and there's no other way to avoid clobbering — and even then, prefer running those edits sequentially in the main checkout instead if the task allows it. If stray worktrees/branches are noticed, flag them to the user for a cleanup pass rather than silently accumulating more.
