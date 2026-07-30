---
name: feedback-repo-scope-boundary
description: "User has NOT authorized editing/committing code in sibling repos (backend, frontend) — pokewin-admin only unless explicitly told otherwise"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 73040211-dc85-42aa-b7fa-eec8eea8e5d8
  modified: 2026-07-21T18:11:18.042Z
---

Do not dispatch agents to write/commit/push code into the sibling `backend` or `frontend` repos (under `C:\Users\motha\Documents\GitHub\`) without explicit, per-task authorization from the user. Read-only investigation/research across those repos is always fine (e.g. tracing whether geo-blocking is wired end-to-end) and doesn't need to be asked for.

**Why:** User said "i never allowed u to touch frontend or backend" after an agent was dispatched to implement a cross-repo feature (US state-level geo-blocking) that involved writing code into `backend`/`frontend` without having been asked first. That agent was stopped mid-task and both repos were confirmed clean. Standing permissions built up in this session (Admin DB full access, MAIN DB read-only, autonomous background-agent dispatch, build+push without asking) are scoped to `pokewin-admin` specifically — they do NOT auto-extend to sibling repos just because a feature spans the whole site.

**Update — when the user DOES authorize it:** for the same geo-blocking feature, the user came back and explicitly said to build the backend half too, with hard constraints: (1) **NEVER push to `main`/`master`** on `backend` or `frontend` — always a feature branch + `gh pr create` for their main dev to review/merge manually; (2) do not run/apply any DB migration against a live database — ship the migration file in the PR for the dev to apply; (3) match existing code quality/conventions exactly, keep the diff minimal, run the repo's own lint/test/typecheck before opening the PR ("dont fuck anything up").

**Update 2026-07-21 — PRs target `dev`, not `main`:** when authorized, open the PR against the **`dev`** branch (both `PackyGG/backend` and `PackyGG/frontend` have one) — owner: "only push to dev branch with a pr". Feature branch → `gh pr create --base dev`. (Backend `main` can sit a merge-commit ahead of `dev`, so retargeting an already-open main-based PR isn't a clean no-op — rebase onto `dev` first or ask.) This session the owner authorized fixing the geo-blocking bug across backend+frontend as needed; frontend fix shipped as PR #737 into `dev`. The earlier crypto-fee backend PR #445 predates this rule and sits against `main`.

**How to apply:** Backend/frontend are read-only-by-default, PR-only-when-authorized. Never infer write authorization from task scope alone — wait for an explicit go-ahead each time. Once given, still never push directly to those repos' main branch even with authorization; branch + PR **into `dev`** is the only allowed path there, contrasted with `pokewin-admin` where direct push to `origin/main` remains the norm. See [[pokewin-admin-db-policy]] for the analogous MAIN-DB boundary this mirrors, and [[branch-naming-convention]] for `motha/<category>/<slug>` branch names.
