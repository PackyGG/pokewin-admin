# AGENT_HANDOFF.md — Live Session State

> **Read this first every session.** Then `ONBOARDING.md` + `AGENTS.md`.
> Protocol: `SESSION_MEMORY.md` (mandatory read/write rules).
> Operating rules (workflows, DB policy, build gate): `AGENTS.md` / `CLAUDE.md` — not duplicated here.

---

## CURRENT STATE

- **HEAD:** `b2321310` · **Updated:** 2026-06-06 · **Active focus:** Hub nav cleanup — Deal Tracker removed, Compare in Workspace sidebar (`cursor/hub-nav-cleanup-775d`, PR pending)
- **Cloud VM dev env:** merged **PR #48** — `AGENTS.md` § Cursor Cloud specific instructions on `main`; update script `npm install`. Local VM: Postgres 16 + `.env.local`; lint/tsc/build + Playwright auth PASS.
- **Deploy:** `main` → Vercel prod `pokewin-admin.vercel.app`
- **Route segment:** `src/app/(creator-hub)/creator-hub/` (sub-app with own layout + sidebar)

---

## ✅ Shipped (recent — on `main`)

**Creator Hub (waves 0 → B+C + audit closeout):**
- Access control — motha + per-role toggles (`admin_settings`, default OFF) · `757e996`
- Wave 1 pages — roster, detail/Overview, profitable-algo, live-leaderboards, changelog · nav wiring
- Substrate — 9 admin tables (kick/twitter/crm/alerts/session meta) + `src/lib/creator-hub/*` integration (TTL cache, throttle, server-only) + Settings (API keys in `admin_settings`)
- Per-creator tabs — Creator, Risk, Forecast, Cohorts&LTV, Alt Accounts, Kick, Twitter, Sessions+VOD
- Ops tools — Creator Check, onboarding checklist dock, acquisition, compare (Workspace nav), alerts (right-rail dock), socials-review
- **Wave B+C** (`c1e26f0b`) — dashboard 24h real-data + bucketed charts, Add Creator v2, ops routes wired, Top Creators = most wager
- **Post-B+C fixes** (`e3cb6683`, `5ad928bd`, `937844c1`) — Vercel build, creator cost converted payouts, dashboard data, linked socials, Kick refetch, 30-day charts
- **Plan closeout (2026-06-06)** — audit fixes (Hub gates on add-creator + alerts redirect), `creator_manager` assignable (schema + SQL applied), plan file recreated, e2e smoke `e2e/tests/creator-hub.spec.ts` PASS (12 routes; detail/forecast skipped on empty local MAIN DB)
- **Forecast tab deal allowance (`d629ba09`)** — weekly tip/sponsor spend uses deal per-stream caps × `fills_allowed`; realized lifetime cadence only when no deal; UI labels source + fallback
- **Codes & Ads hub route (`9f0c02f8`)** — `/creator-hub/codes-ads` lazy tabs (affiliate codes table + ads dashboard); hub-gated mutations; sidebar nav; e2e smoke route added (13 hub routes)
- **Responsive harness — Creator Hub (`634b12e3`)** — `CREATOR_HUB_ROUTES` + `e2e/responsive/creator-hub-audit.spec.ts` (minted `canAccessCreatorHub` session); roster SectionHeading action stack fix at md; `RESPONSIVE_EXPECT_CLEAN=1` PASS (detail routes skip without creator in MAIN)
- **Hub ad detail (`73282fc9`)** — `/creator-hub/codes-ads/ads/[code]` (hub gate, modern panels, reuses `getAdCodeDetail` + admin chart/copy-link); hub cards no longer deep-link to `/creators/ads/[code]`; e2e `readSampleAdCode` + prod smoke spec (`ff6ea75a`)

**Earlier admin (pre-Hub):** dashboard rework, system-edge-plan, `/users` search, Balance 2.0, insights hub, responsive harness (`e2e/responsive/*`), smoothness primitives (`@/components/ux`)

---

## 🟡 In-flight

_None — Creator Hub plan closed. Pick up deferred items below when owner prioritizes._

---

## 📋 Open / next (priority order)

1. Admin-DB schema drift decision — `creator_deals` cashout limits + `creator_deal_estimates` (17 rows) exist in prod but dropped from schema
2. Packy.gg avatar write — **BLOCKED** (no confirmed backend endpoint; ADMIN-only pfp preview OK)
3. Bulk delete `/gift-cards` + `/vouchers` — **BLOCKED** (MAIN DB write forbidden)
4. Fold durable reward findings into `ONBOARDING.md` (affiliate commission basis; signup $5.71 clarification)
5. Add `/creator-hub/tips-sponsors` to responsive matrix (codes-ads + hub ad detail verified on prod 2026-06-06)

---

## 🔴 Blocked (needs owner)

| Item | Why | Options |
|---|---|---|
| Bulk delete `/gift-cards` + `/vouchers` | Tables in **MAIN DB** — write forbidden | H1: allow MAIN write · H2: gift-cards admin cancel only · H3: drop |
| Packy.gg PFP update on Add Creator | MAIN write / no API | ADMIN-only preview until backend endpoint exists |

---

## ⚠️ Gotchas (session-relevant)

- **Stale local game DB** — live admin pages throw locally → use fixtures (`src/app/responsive-fixture/*`) or prod; Creator Hub e2e detail tab skips when no `creator` role user in MAIN
- **Backend API env** — Hub dashboard/roster degrade gracefully when `BACKEND_API_URL_*` missing (KPIs show `—`); not a render failure
- **Admin DB = `db push` only** — never `prisma migrate dev/deploy` (destructive reset); additive enum: `prisma/admin/sql/20260606_add_creator_manager_role.sql`
- **MAIN DB = read-only** — no schema changes, no writes; `gift_cards` + `vouchers` live in MAIN
- **React #130** — register new nav icons in `app-sidebar.tsx` ICONS map
- **PowerShell UTF-8 BOM** breaks `.sql` — write SQL via Bash/`printf`
- **Verify agents** — `git fetch && checkout exact SHA` before "not found" verdicts
- **Twitter API shape** — read `core` + `avatar`, not only `legacy` (`src/lib/creator-hub/`)
- **Hub ads e2e** — `readSampleAdCode()` needs `admin_settings.house_affiliate_user_id` + a row in MAIN `affiliate_codes`; local VM has neither → detail e2e skips; ads tab still renders house-setup empty state
- **Prod Playwright mint** — cookie signed with VM `SESSION_SECRET` must match Vercel env or prod smoke lands on `/login`

---

## 🧰 Doc index

| Need | File |
|---|---|
| Read/write protocol (forced) | `SESSION_MEMORY.md` |
| Architecture + domain | `ONBOARDING.md` |
| Work rules | `AGENTS.md` · `CLAUDE.md` · `CLAUDE.local.md` |
| Creator Hub plan + progress | `.claude/plans/iridescent-mixing-lecun.md` |
| Layout audit | `AUDIT_REPORT.md` |
| Responsive harness | `e2e/responsive/*` · `playwright.responsive.config.ts` |
| Creator Hub e2e smoke | `e2e/tests/creator-hub.spec.ts` |
