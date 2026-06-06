# AGENT_HANDOFF.md — Live Session State

> **Read this first every session.** Then `ONBOARDING.md` + `AGENTS.md`.
> Protocol: `SESSION_MEMORY.md` (mandatory read/write rules).
> Operating rules (workflows, DB policy, build gate): `AGENTS.md` / `CLAUDE.md` — not duplicated here.

---

## CURRENT STATE

- **HEAD:** `7f72f6d0` (local checkout behind `origin/main` by 4) · **Updated:** 2026-06-06 · **Active focus:** Creator Hub — post wave B+C; audit + live verify next
- **Cloud VM dev env (2026-06-06):** `npm install` + local Postgres 16 (`pokewin_admin` / `pokewin_main`) + `.env.local` — lint/tsc/build green; `npm run dev` :3000; Playwright auth → dashboard PASS. Docs: `AGENTS.md` § Cursor Cloud specific instructions. Update script: `npm install` only.
- **Deploy:** `main` → Vercel prod `pokewin-admin.vercel.app`
- **Route segment:** `src/app/(creator-hub)/creator-hub/` (sub-app with own layout + sidebar)

---

## ✅ Shipped (recent — on `main`)

**Creator Hub (waves 0 → B+C):**
- Access control — motha + per-role toggles (`admin_settings`, default OFF) · `757e996`
- Wave 1 pages — roster, detail/Overview, profitable-algo, live-leaderboards, changelog · nav wiring
- Substrate — 9 admin tables (kick/twitter/crm/alerts/session meta) + `src/lib/creator-hub/*` integration (TTL cache, throttle, server-only) + Settings (API keys in `admin_settings`)
- Per-creator tabs — Creator, Risk, Forecast (PARTIAL), Cohorts&LTV, Alt Accounts, Kick, Twitter, Sessions+VOD
- Ops tools — Creator Check, onboarding checklist dock, acquisition, compare, alerts, deal-tracker, codes-ads (port), socials-review (port)
- **Wave B+C** (`c1e26f0b`) — dashboard 24h real-data + bucketed charts, Add Creator v2, ops routes wired, Top Creators = most wager
- **Post-B+C fixes** (`e3cb6683`, `5ad928bd`) — Vercel build + creator cost converted payouts; dashboard data, linked socials, Kick refetch
- **Session memory system** — `SESSION_MEMORY.md` + `.cursor/rules/session-memory.mdc` + `CURSOR_USER_RULE.md` (forced read/write protocol)

**Earlier admin (pre-Hub):** dashboard rework, system-edge-plan, `/users` search, Balance 2.0, insights hub, responsive harness (`e2e/responsive/*`), smoothness primitives (`@/components/ux`)

---

## 🟡 In-flight

- **Creator Hub AUDIT wave** — design, security, perf, math, skeletons; fix findings from backlog below
- **Creator Hub LIVE VERIFY** — click every tab/page (Chrome if connected, else minted-session Playwright on prod)
- **Plan file stale** — `.claude/plans/iridescent-mixing-lecun.md` progress log still shows waveB as `[running]`; update to DONE when confirming B+C on disk

---

## 📋 Open / next (priority order)

1. Run audit + fix backlog (see plan file § AUDIT-FIX)
2. Align `creator-hub/page.tsx` gate to `canAccessCreatorHub` (layout already gates; page uses weaker `requireRole`)
3. Discord channel link field + reward-page storage gaps (noted in plan)
4. `creator_manager` enum — make assignable (additive `prisma db execute`, watch schema drift)
5. Packy.gg avatar write — **BLOCKED** (no confirmed backend endpoint; ADMIN-only pfp preview OK)
6. Fold durable reward findings into `ONBOARDING.md` (affiliate commission = % of wager; signup $5.71 = cash claim avg not welcome packs)
7. Admin-DB schema drift decision — `creator_deals` cashout limits + `creator_deal_estimates` (17 rows) exist in prod but dropped from schema
8. Responsive sweep — verify harness with `RESPONSIVE_EXPECT_CLEAN=1` if not already green

---

## 🔴 Blocked (needs owner)

| Item | Why | Options |
|---|---|---|
| Bulk delete `/gift-cards` + `/vouchers` | Tables in **MAIN DB** — write forbidden | H1: allow MAIN write (like promo-codes) · H2: gift-cards admin cancel only · H3: drop |
| Packy.gg PFP update on Add Creator | MAIN write / no API | ADMIN-only preview until backend endpoint exists |

---

## ⚠️ Gotchas (session-relevant)

- **Stale local game DB** — live admin pages throw locally → use fixtures (`src/app/responsive-fixture/*`) or prod
- **Admin DB = `db push` only** — never `prisma migrate dev/deploy` (destructive reset)
- **MAIN DB = read-only** — no schema changes, no writes; `gift_cards` + `vouchers` live in MAIN
- **React #130** — register new nav icons in `app-sidebar.tsx` ICONS map
- **PowerShell UTF-8 BOM** breaks `.sql` — write SQL via Bash/`printf`
- **Verify agents** — `git fetch && checkout exact SHA` before "not found" verdicts
- **Twitter API shape** — read `core` + `avatar`, not only `legacy` (`src/lib/creator-hub/`)

---

## 🧰 Doc index

| Need | File |
|---|---|
| Read/write protocol (forced) | `SESSION_MEMORY.md` |
| Architecture + domain | `ONBOARDING.md` |
| Work rules | `AGENTS.md` · `CLAUDE.md` · `CLAUDE.local.md` |
| Creator Hub plan + progress | `.claude/plans/iridescent-mixing-lecun.md` |
| Ex-creator GGR spec | `.claude/plans/iridescent-mixing-lecun-agent-a2e6b570aacbcb19d.md` |
| Layout audit | `AUDIT_REPORT.md` |
| Responsive harness | `e2e/responsive/*` · `playwright.responsive.config.ts` |
