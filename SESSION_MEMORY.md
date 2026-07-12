# SESSION_MEMORY.md — Cross-Session Knowledge Protocol

> **Binding for every agent session.** This file is the map. Follow it exactly.
> Chat history does not survive session switches — **these repo files do.**

---

## 🔴 HARD RULE — you are FORCED to read and write

| When | Action | Skip allowed? |
|---|---|---|
| **Session start** (before any tool call or edit) | Read files in §1 | **NEVER** |
| **After every substantive task** (before DONE / end of turn) | Write updates in §2 | **NEVER** |
| **When delegating** sub-agents | Paste §4 contract into their prompt | **NEVER** |

**A task is NOT complete until the repo docs are updated.** Saying "done" without writing = protocol violation.

If you only answered a quick question with zero code changes and zero new facts → skip write. Everything else → **write**.

---

## §1 READ on start (strict order)

```
1. AGENT_HANDOFF.md     ← what is happening RIGHT NOW
2. ONBOARDING.md        ← how the system works (architecture + domain)
3. AGENTS.md            ← binding work rules (auto-loaded in Cursor)
4. CLAUDE.md            ← extended rules (if present)
5. CLAUDE.local.md      ← owner pacing overrides (if present)
6. Active plan (only if your task touches it):
     Creator Hub        → .claude/plans/iridescent-mixing-lecun.md
     Pack Studio Retune → .claude/plans/retune-v2-{blueprint,ruleset,workspace}.md
7. Domain audits (only if editing that surface):
     layout/insights    → AUDIT_REPORT.md
     packs/cards        → AUDIT_PACKS_CARDS.md
```

If `AGENT_HANDOFF.md` HEAD sha ≠ `git rev-parse --short HEAD`, trust **git log -5** + handoff together.

---

## §2 WRITE on end (pick the right file)

| You learned or changed… | Write to |
|---|---|
| Shipped work, in-flight, blocked, next steps, fresh gotchas | `AGENT_HANDOFF.md` |
| Durable facts: schema, domain math, DB policy, conventions | `ONBOARDING.md` + `DB_ACCESS.md` |
| New binding policy or workflow rule | `CLAUDE.md` or `AGENTS.md` |
| Owner pacing / parallel-mode override | `CLAUDE.local.md` |
| Creator Hub wave progress, decisions, backlog | `.claude/plans/iridescent-mixing-lecun.md` |
| Single-feature fix spec | `.claude/plans/*-agent-*.md` |
| Route-group audit findings | `AUDIT_*.md` |

### Boundaries (do not mix)

- **Ephemeral** → `AGENT_HANDOFF.md` only (delete finished items)
- **Evergreen** → `ONBOARDING.md` (promote from handoff when a fact stays true)
- **Rules** → `CLAUDE.md` / `AGENTS.md`
- **Never** store secrets, API keys, tokens, or `.env` values in any doc

### `AGENT_HANDOFF.md` — required sections

Keep this structure; replace content each update:

```markdown
## CURRENT STATE
- **HEAD:** `<sha>` · **Updated:** `<YYYY-MM-DD>` · **Active focus:** `<one line>`

## ✅ Shipped (recent)
- …

## 🟡 In-flight
- …

## 📋 Open / next
- …

## 🔴 Blocked (needs owner)
- …

## ⚠️ Gotchas (session-relevant only)
- …
```

Rules: only claim shipped work that is **committed**; remove completed in-flight items.

**🔴 Hard cap — this file must stay compact (added 2026-07-12 after it grew to 270KB):**
- **Never append a permanent narrative log.** No "### SESSION YYYY-MM-DD (part N) — …" entries that just accumulate forever — that pattern is exactly what caused the bloat (fixed once by moving everything to `AGENT_HANDOFF_ARCHIVE.md`, don't recreate it). Forensic detail (exact SHAs, exact test counts, root-cause essays) belongs in the **commit message**, not this file — git already keeps that history searchably.
- **"Shipped (recent)" means the last few days, not ever.** When an item stops being recent, either delete it or move it to `AGENT_HANDOFF_ARCHIVE.md` — don't just let the list grow.
- **If a write would push this file past ~40-50KB, archive old content first.** A new session should be able to get oriented from this file alone in well under a minute of reading, not several.

---

## §3 File map (quick reference)

| File | Purpose | Update frequency |
|---|---|---|
| `SESSION_MEMORY.md` | This protocol — read/write rules | Rarely |
| `AGENT_HANDOFF.md` | Live session snapshot | **Every task** |
| `ONBOARDING.md` | Architecture + domain knowledge | When facts are durable |
| `AGENTS.md` | Cursor auto-loaded work rules | When policy changes |
| `CLAUDE.md` | Extended binding rules | When policy changes |
| `CLAUDE.local.md` | Owner override (speed/parallel) | Owner-driven |
| `.claude/plans/*.md` | Active feature plans + progress logs | Per wave / decision |
| `AUDIT_*.md` | Audit artifacts per surface | Per audit |

---

## §4 Sub-agent / workflow contract (paste into every dispatch)

```
MANDATORY — Session Memory Protocol:
1. READ: AGENT_HANDOFF.md → ONBOARDING.md → AGENTS.md
2. WORK: follow all binding rules (MAIN DB read-only, ADMIN writable via db push)
3. WRITE before finishing: update AGENT_HANDOFF.md (+ ONBOARDING.md if durable facts changed)
4. REPORT honest status: DONE / PARTIAL / PROPOSED / BLOCKED
You are NOT done until step 3 is complete.
```

---

## §5 Self-check (run before closing any substantive task)

- [ ] I read `AGENT_HANDOFF.md` at session start
- [ ] I updated `AGENT_HANDOFF.md` with current HEAD, shipped, in-flight, next
- [ ] I promoted any lasting fact to `ONBOARDING.md` or the active plan
- [ ] A **new session** reading only these files would know exactly what to do next

**All boxes must be checked.** If not → update docs now, then respond.
