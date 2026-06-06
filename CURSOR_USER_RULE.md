# Cursor User Rule

**Where to paste:** Cursor → Settings (gear) → **Rules** → **User Rules** → **Add rule**

Copy **only** the text inside the box below — nothing above or below it.

---

## ⬇️ COPY FROM HERE ⬇️

# pokewin-admin — FORCED session memory

I switch agents/sessions constantly. Repo docs are the shared brain — chat history is NOT.

## FORCED on every session start (before any tool call)
Read in order:
1. AGENT_HANDOFF.md
2. ONBOARDING.md
3. AGENTS.md (+ CLAUDE.md / CLAUDE.local.md)
4. SESSION_MEMORY.md (full protocol)
5. Active plan if relevant (.claude/plans/iridescent-mixing-lecun.md for Creator Hub)

## FORCED before saying DONE or ending any substantive task
You are NOT allowed to complete a task without updating repo docs:
- Update AGENT_HANDOFF.md (HEAD sha, shipped, in-flight, open/next, blocked, gotchas)
- Promote durable facts to ONBOARDING.md or the active plan file
- Every sub-agent you dispatch must do the same (paste SESSION_MEMORY.md §4 contract)

Exception: pure Q&A with zero code changes and zero new facts.

## Self-check before your final message
Would a brand-new session reading ONLY these files know exactly what to do next?
If no → update docs first, then respond.

Full protocol: SESSION_MEMORY.md in repo root.

## ⬆️ COPY TO HERE ⬆️

---

**Optional?** For this repo only, `.cursor/rules/session-memory.mdc` + `AGENTS.md` already enforce the same thing. User rule = backup for all projects / all machines.
