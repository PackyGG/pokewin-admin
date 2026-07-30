---
name: fetch-before-audit
description: "Always `git fetch` and compare HEAD to origin/main before auditing or fixing — this local checkout runs far behind origin"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1a32c0dd-416a-4012-9535-5b1e65a405cf
  modified: 2026-07-26T05:35:23.994Z
---

Before any audit, review, or fix sweep in pokewin-admin, run `git fetch origin`
and check `git rev-list --count HEAD..origin/main`. The local `main` checkout is
routinely tens of commits behind origin because parallel worktree agents push
straight to `origin/main` from other sessions.

**Why:** On 2026-07-26 a 75-agent antifraud audit (~7.4M tokens) ran against a
tree 29 commits stale. Its headline finding — "the monitor service does not
compile, so the WebSocket server was never deployed" — was already fixed on
origin. Roughly half the service findings had to be re-verified because
`monitor.ts` (+175 lines), `server.ts` (+129), `source.ts` (+75) and
`reviews/actions.ts` (+51) had all moved upstream in the meantime.

**How to apply:** Fetch first, then audit/fix against `origin/main`, not the
local checkout. Give every subagent an explicit
`git fetch origin && git reset --hard origin/main` as step one of its brief —
this is already the documented build-agent contract in CLAUDE.md, and it applies
to read-only auditors too, not just editors. Also expect local `main` to carry
unpushed commits from earlier sessions; never resolve that divergence
unilaterally, flag it. Related: [[verify-agent-push-before-done]],
[[composed-main-build-verify]].
