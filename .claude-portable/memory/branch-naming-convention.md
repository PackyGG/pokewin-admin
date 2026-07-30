---
name: branch-naming-convention
description: "Owner's branch-name convention for the PackyGG repos — motha/<category>/<slug>, identifier first"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b1c5d865-1d34-4536-9fcf-0423309bda6a
---

Owner (2026-07-12): when creating branches in the **PackyGG repos** (backend, frontend, and siblings), name them **`motha/<category>/<slug>`** — the owner's identifier (`motha`) FIRST, then a category, then a kebab-case description. Example given verbatim: `motha/design/toast-design-rework`. Categories are free-form (design / docs / feat / fix / geo / …).

**Why:** keeps the owner's personal work namespaced and identifiable among branches.

**How to apply:** use this for ANY new branch I push to those repos going forward (e.g. `motha/docs/code-quality-rule`, `motha/geo/us-state-enforcement`). It's forward-looking — branches I created earlier in this session WITHOUT the prefix (`geo-blocking/us-state-restrictions-dev` = PR #443, `docs/code-quality-rule` = backend PR #444 / frontend PR #730) were pre-rule; don't rename mid-flight (especially #443 — a background agent is actively pushing to it). In `pokewin-admin` I push straight to `main` (no feature branches), so this convention mainly governs the sibling-repo PR flow. See [[feedback_repo_scope_boundary]].
