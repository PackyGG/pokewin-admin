# AGENT_HANDOFF.md — live state board

**Purpose:** the only thing agents need that git history does *not* tell them — what is in flight
right now, what is blocked, and which files another agent is currently holding.

**HARD SIZE CAP: 200 lines.** Loaded on demand, not at session start. This is a *board*, not a
changelog. Shipped work is described by the commit that shipped it — do not narrate it here. When
you finish something, delete its in-flight entry. If the file is over the cap, trim the oldest
entries; do not archive-and-grow. Pre-2026-08-05 history lives in `AGENT_HANDOFF_ARCHIVE.md`
(read-on-demand only, never at session start).

---

## 🟡 In flight

_Nothing tracked. Add an entry only while work is actually open; delete it when it lands._

## 🚦 File locks (concurrent agents)

The owner runs parallel Codex/Claude sessions that push to `main`. Before touching a shared file,
check here; add a line while you hold it; delete the line when you push.

_No locks held._

## 🔴 Blocked (needs owner)

| Item | Why | Options |
|---|---|---|
| Antifraud MAIN-mirror indexes | Prod mirror's read role lacks `CREATE` on `public`; the scoped DDL tool fails closed at preflight | Grant a mirror DDL role, or have the mirror operator apply `services/antifraud-monitor/migrations/source-mirror-indexes.sql`. Never on MAIN primary. |
| Bulk delete `/gift-cards` + `/vouchers` | Both tables live in **MAIN DB** — writes forbidden | Allow MAIN write · gift-cards admin-cancel only · drop the feature |
| Packy.gg PFP update on Add Creator | MAIN write, no backend endpoint | ADMIN-only preview until an endpoint exists |

---

## ⚠️ Gotchas that still bite

- **Dev-server port collision across worktrees** — parallel worktrees all default to `:3000`; the
  first to bind wins, and later runs silently hit the *other* worktree's stale code. Use a unique
  `PORT=` and confirm the listener's path is yours. Start dev servers via the Bash tool with
  `run_in_background: true` (a `&`-detached `npm run dev` dies on Windows when the call returns).
- **Stale local game DB** — live admin pages throw locally. "Broken locally" ≠ "broken in prod".
- **React #130** — every nav `icon` string must exist in the `ICONS` map in
  `src/components/app-sidebar.tsx`, or the sidebar crashes at runtime.
- **PowerShell writes UTF-8 with BOM**, which breaks `.sql` files for Postgres. Write SQL via Bash.
- **Stale `.next`** can make `tsc` fail on deleted routes — delete it before re-gating.
- **No function props Server → Client** (RSC boundary). Only `npm run build` catches this, not `tsc`.
- **Fresh checkout / worktree** — run `npm install`, never `npm ci` (the committed lockfile diverges).
- **Admin schema first, deploy second** — a read selecting a column that does not exist yet fails the
  *whole* query, taking the page down for the entire window between deploy and migration.
- **App Router `_`-prefixed segments are private** — a temp `/api/_probe/route.ts` silently 404s.
- **Fire-and-forget `void fn()` post-response work does not flush in `next dev`** — a missing log line
  locally is not evidence the hook is broken.
- **Backend-owned config cards** (wager requirements, multiplier/leaderboard/shard wager weights,
  crypto fees, telegram notifications) write via `backendApi`, not MAIN. They render an
  "awaiting backend deploy" state until the matching backend branch ships — that is not a bug.

---

## 🧰 Doc index

| Need | File |
|---|---|
| Work rules (binding) | `CLAUDE.md` |
| Architecture + domain knowledge | `ONBOARDING.md` |
| Query / caching / streaming mechanics | `docs/BACKEND_QUERY_SYSTEM.md` |
| Pre-2026-08-05 history | `AGENT_HANDOFF_ARCHIVE.md` |
