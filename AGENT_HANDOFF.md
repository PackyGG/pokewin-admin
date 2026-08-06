# AGENT_HANDOFF.md — live state board

**Purpose:** the only thing agents need that git history does *not* tell them — what is in flight
right now, what is blocked, and which files another agent is currently holding.

**HARD SIZE CAP: 200 lines.** Loaded on demand, not at session start. This is a *board*, not a
changelog. Shipped work is described by the commit that shipped it — do not narrate it here. When
you finish something, delete its in-flight entry. If the file is over the cap, trim the oldest
entries; do not archive-and-grow. Pre-2026-08-05 history lives in `AGENT_HANDOFF_ARCHIVE.md`
(read-on-demand only, never at session start).

**Cursor speed:** a compact board is fine. Cursor slows when alwaysApply rules force-load huge
files every turn — never require reading this file before every tool call.

---

## 🟡 In flight

_(empty)_

## 🚦 File locks (concurrent agents)

_(empty)_

## 🔴 Blocked (needs owner)

| Item | Why | Options |
|---|---|---|
| Antifraud MAIN-mirror indexes | Prod mirror's read role lacks `CREATE` on `public`; the scoped DDL tool fails closed at preflight | Grant a mirror DDL role, or have the mirror operator apply `services/antifraud-monitor/migrations/source-mirror-indexes.sql`. Never on MAIN primary. |
| Bulk delete `/gift-cards` + `/vouchers` | Both tables live in **MAIN DB** — writes forbidden | Allow MAIN write · gift-cards admin-cancel only · drop the feature |
| Packy.gg PFP update on Add Creator | MAIN write, no backend endpoint | ADMIN-only preview until an endpoint exists |

## 🟠 Residual from Aug 5–6 Claude audit

All code residuals from that review are fixed on `fix/audit-residuals` (containment outbox for all 8 kinds, KYC tip-lock hard-fail, promo `usdAmountSchema`, HISTORICAL banners on stale audit docs). After merge/push, treat git as source of truth.

Ops note: local checkouts often dirty + behind `origin/main` after parallel sessions — prefer `origin/main`.

---

## ⚠️ Gotchas that still bite

- **Dev-server port collision across worktrees** — use a unique `PORT=`; confirm the listener path.
- **Stale local game DB** — "Broken locally" ≠ "broken in prod".
- **React #130** — every nav `icon` string must exist in `app-sidebar.tsx` `ICONS`.
- **PowerShell UTF-8 BOM** breaks `.sql` — write SQL via Bash.
- **Stale `.next`** can fail `tsc` on deleted routes — delete before re-gating.
- **No function props Server → Client** — only `npm run build` catches this.
- **Fresh checkout / worktree** — `npm install`, never `npm ci`.
- **Admin schema first, deploy second** — missing column fails the whole query window.
- **App Router `_`-prefixed segments are private** — temp `/api/_probe` silently 404s.
- **Fire-and-forget `void fn()`** may not flush in `next dev`.
- **Backend-owned config cards** write via `backendApi`; "awaiting backend deploy" is not a bug.

---

## 🧰 Doc index

| Need | File |
|---|---|
| Work rules (binding) | `CLAUDE.md` |
| Architecture + domain | `ONBOARDING.md` |
| Query / caching / streaming | `docs/BACKEND_QUERY_SYSTEM.md` |
| Fraud contracts (current) | `docs/ANTIFRAUD_CONTRACTS.md` · `.cursor/rules/antifraud.mdc` |
| Pre-2026-08-05 history | `AGENT_HANDOFF_ARCHIVE.md` |
