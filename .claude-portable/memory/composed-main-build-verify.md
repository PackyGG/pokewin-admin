---
name: composed-main-build-verify
description: "After parallel worktree agents push to main, always run one final build on the composed main — per-agent builds miss cross-agent breakage"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 354eaae5-3ab4-42d0-a0fc-5aa1c19bf1fa
---

When many isolated git-worktree agents build+push to `main` in parallel, each agent's `npm run build` only verifies its OWN pre-rebase tree. Cross-agent breakage is invisible to every individual gate and only exists in the composed `main`.

**Real incident (2026-07-01):** one agent created `src/components/page-transition.tsx` importing `enter` from `@/components/ux`; a concurrent UI-cleanup agent deleted `enter` as a "0-consumer dead export" (its grep ran before the first agent pushed). Both rebased cleanly (no textual conflict — different files) and pushed. Composed `main` failed `tsc`/`npm run build` → **prod auto-deploy broke**. No agent's own build caught it. Hotfix `1449b268` swapped `enter("slide-up","fast")` for its literal classes `motion-safe:animate-in fade-in slide-in-from-bottom-1 duration-150`.

**Why:** rebase does NOT re-run the build. A fast-forward/clean-rebase push composes two independently-green trees into a red one.

**How to apply:** (1) After a wave of parallel worktree pushes, `git reset --hard origin/main` in the main checkout and run one `npm run build` on the composed HEAD as the authoritative final gate. (2) Be wary of "delete dead export" changes running concurrently with any agent that might add a consumer — dead-code deletion and new-feature agents in the same wave are a known collision class. See [[worktree-parallel-push-rules]].
