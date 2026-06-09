# AGENT_HANDOFF.md — Live Session State

> **Read this first every session.** Then `ONBOARDING.md` + `AGENTS.md`.
> Protocol: `SESSION_MEMORY.md` (mandatory read/write rules).
> Operating rules (workflows, DB policy, build gate): `AGENTS.md` / `CLAUDE.md` — not duplicated here.

---

## CURRENT STATE

- **HEAD:** `47aa0aca` · **Updated:** 2026-06-10 · **Active focus:** Edge Plan 2.0 full rework SHIPPED (UI + logic + numbers); owner reviewing live for follow-up changes
- **Note (2026-06-06):** local checkout was on branch `dev` (even with `origin/main`) with **no `node_modules` / `.env`**; ran `npm install` + `prisma generate` (both clients) to gate.
- **Cloud VM dev env:** merged **PR #48** — `AGENTS.md` § Cursor Cloud specific instructions on `main`; update script `npm install`. Local VM: Postgres 16 + `.env.local`; lint/tsc/build + Playwright auth PASS.
- **Deploy:** `main` → Vercel prod `pokewin-admin.vercel.app`
- **Route segment:** `src/app/(creator-hub)/creator-hub/` (sub-app with own layout + sidebar)

---

## ✅ Shipped (recent — on `main`)

**Edge Plan 2.0 — full rework (2026-06-10, `47aa0aca`):** UI + logic + numbers, scoped to `/insights/edge-plan-2` only (v1 `system-edge-plan` reused unchanged). _Supersedes the "shards economy (raffle-proxy)" Edge Plan 2.0 bullet below._
- **Shards economy REMOVED** entirely (model + baseline + UI). **Raffles RESTORED** on real reconstructed prize cost (`getRaffleForecastBaseline().totalPrizeCost`; v1 raffle levers `rafflePrizePool/Frequency/TicketCostMult` reused).
- **Real affiliate split** via `getAffiliateOverview` (`affiliateCommissionCost` from `affiliate_claim` + `affiliateLeaderboardCost` from `affiliate_leaderboard_prize`), replacing the hardcoded 12% guess. `splitAffiliateCostBundle` kept as null-query fallback.
- **Dropped two unfounded constants** (confirmed no data source): withdrawal-friction ×0.25 adjustment + reward-wager recycling (0.55 cap / 2.5× turnover). Projection now rests only on real numbers; withdrawals section is real-data display only. Owner can supply real figures to re-add.
- **Color-token bug fixed**: `_planner/utils.ts` `EMERALD`/`ROSE` were Tailwind class strings fed into CSS/Recharts color slots → silent no-color. New `_planner/colors.ts` = `CHART_COLOR` (rgb values) vs `TEXT_TONE` (classes) + `netEdgeChartColor`/`netEdgeTextTone`/`houseAccent`.
- **UI restructured**: hero + single gross→net edge waterfall, lever-rail + active-group workspace + analysis zone, progressive-disclosure lever groups (`hero-summary`/`lever-rail`/`lever-group`/`raffles` new). Ideas/Future-levers section removed. Edge defaults unchanged (packs/battles 10.99%, upgrader 10%, battles no separate edge).
- **Responsive**: fixed 11 gating overflows at 320–390px — root cause was 10 grids missing a base `grid-cols-1` (auto-column grew to widest child, defeating `truncate`) + a non-wrapping Battles badge. New dev fixture `responsive-fixture/edge-plan-2` + WAVE0 sweep entry; `RESPONSIVE_EXPECT_CLEAN=1` PASS.
- **Verify gap (honest)**: the responsive sweep renders only the *active* lever group (active-only render) — Rewards/Raffles/Withdrawals/Packs got the same systematic grid fix but were NOT each re-rendered. Recommend a logged-in click-through of those tabs. Built via Workflow; its tsc-only verify-agent passed but MISSED these layout bugs — only the rendered sweep caught them (see memory `render-verify-not-workflow-verdict`).
- **Build-tree note**: pushed scoped (`git add` edge-plan-2 paths only) over an entangled tree — owner's pre-existing v1 blended-edge + KPI-unification work (`system-edge-plan/_model.ts`/`_baseline.ts`, `cost-breakdown/page.tsx`, `insights/page.tsx`, `dashboard.ts`, `insights-analytics/cost-breakdown.ts`) was left uncommitted for the owner. Remote PRs #52/#53 (`/rewards/shards` admin, source-wager-weights) rebased cleanly (no edge-plan-2 overlap).

**Dashboard + leaderboards P&L surfaces (2026-06-08):**
- **Edge Plan 2.0** — NEW `/insights/edge-plan-2` (v1 `/insights/system-edge-plan` untouched): full-width planner shell, shards economy (raffle-proxy baseline), balance-withdrawal + wager-req what-ifs, pack-first tuners, presets in `edge-plan-2:presets:v1` localStorage; e2e `e2e/tests/edge-plan-2.spec.ts`
- **System Edge Plan overview layout** — overview sections stack full-width (no 2-col height mismatch); GGR by game type uses compact 3-tile row; reward/net-edge charts get dynamic height, wider Y-axis labels, tighter bar sizing
- **Creator Hub leaderboard detail + freeze** — `/creator-hub/leaderboards/[id]` with shared `LeaderboardStandingsPanel` + `FreezeClaimCell`; hub list/creator cards link here; `freezeClaim`/`unfreezeClaim` accept Creator Hub access and revalidate hub paths
- **System Edge Plan GGR panel layout** — overview 2-col grid uses `items-start` so GGR by game type card doesn’t stretch empty space to match Net edge by scenario chart height
- **Excluded-users fail-closed** (`7b6c562b`) — `getExcludedUserIds()` uses last-known-good cache instead of `[]` on admin DB blip; `refreshExcludedUserIdsCache()` after blacklist mutations; `scripts/audit-pnl-today.mjs` exclusion leak check
- **Affiliate leaderboard detail** — `/creators/leaderboards/[id]` standings add **House P&L** column (bounded window `[start,end)` via `calculateUsersBoundedWindowedPnlBatch` in `pnl.ts`); **House P&L (event window)** aggregate under Affiliate codes in Definition panel
- **P&L Today Cash P&L badge** — top-right corner on dashboard tile: `deposits − withdrawals` only (raw crypto cash flow); full five-term P&L unchanged
- **Insights page retirements** — removed sidebar entries + UI for `/insights/games` (→ `/ggr`), `/insights/rewards/signup` (→ `/insights/rewards?tab=categories`), `/insights/balance-adjustments` (→ `/insights/analytics`); legacy permission keys + CSV export entries trimmed; signup forecast dropped from unified Forecast hub

**Creator Hub (waves 0 → B+C + audit closeout):**
- Access control — motha + per-role toggles (`admin_settings`, default OFF) · `757e996`
- Wave 1 pages — roster, detail/Overview, profitable-algo, live-leaderboards, changelog · nav wiring
- Substrate — 9 admin tables (kick/twitter/crm/alerts/session meta) + `src/lib/creator-hub/*` integration (TTL cache, throttle, server-only) + Settings (API keys in `admin_settings`)
- Per-creator tabs — Creator, Risk, Forecast, Cohorts&LTV, Alt Accounts, Kick, Twitter, Sessions+VOD
- Ops tools — Creator Check, onboarding checklist dock, acquisition, compare, alerts (right-rail dock), deal-tracker, socials-review
- **Wave B+C** (`c1e26f0b`) — dashboard 24h real-data + bucketed charts, Add Creator v2, ops routes wired, Top Creators = most wager
- **Post-B+C fixes** (`e3cb6683`, `5ad928bd`, `937844c1`) — Vercel build, creator cost converted payouts, dashboard data, linked socials, Kick refetch, 30-day charts
- **Plan closeout (2026-06-06)** — audit fixes (Hub gates on add-creator + alerts redirect), `creator_manager` assignable (schema + SQL applied), plan file recreated, e2e smoke `e2e/tests/creator-hub.spec.ts` PASS (12 routes; detail/forecast skipped on empty local MAIN DB)
- **Forecast tab deal allowance (`d629ba09`)** — weekly tip/sponsor spend uses deal per-stream caps × `fills_allowed`; realized lifetime cadence only when no deal; UI labels source + fallback
- **Codes & Ads hub route (`9f0c02f8`)** — `/creator-hub/codes-ads` lazy tabs (affiliate codes table + ads dashboard); hub-gated mutations; sidebar nav; e2e smoke route added (13 hub routes)
- **Responsive harness — Creator Hub (`634b12e3`)** — `CREATOR_HUB_ROUTES` + `e2e/responsive/creator-hub-audit.spec.ts` (minted `canAccessCreatorHub` session); roster SectionHeading action stack fix at md; `RESPONSIVE_EXPECT_CLEAN=1` PASS (detail routes skip without creator in MAIN)
- **Hub ad detail (`73282fc9`)** — `/creator-hub/codes-ads/ads/[code]` (hub gate, modern panels, reuses `getAdCodeDetail` + admin chart/copy-link); hub cards no longer deep-link to `/creators/ads/[code]`; e2e `readSampleAdCode` + prod smoke spec (`ff6ea75a`)

**Withdrawal wager requirement admin UI (2026-06-06):**
- `src/lib/backend-api/client.ts` — added `PUT` to `HttpMethod` + `backendApi.put()` (mirrors `patch`) · `c96a3075`
- `src/lib/backend-api/wager-requirements.ts` (NEW) — server-only module wrapping the backend's `/admin/wager-requirement/default` GET/PUT + `/admin/users/:id/wager-requirement` GET/PUT/DELETE; all bps (10000 = 1×); errors surface as BackendApiError/BackendNetworkError · `c96a3075`
- `/security` defaults card — `wager-requirement-card.tsx` (5 knobs in ×-multipliers + live "= N bps" hint, changed-fields-only, null → muted "awaiting backend deploy") + `wager-requirement-actions.ts` (requireAdmin, audit old→new, backend PUT) + `wager-requirement-keys.ts` (5 site_config keys added to the `movedKeys` filter in `security/page.tsx`); backend read non-critical (try/catch→null) · `b4096d61`
- Per-user override card — `user-wager-requirement-card.tsx` on the Account tab right after Custom Battle Limits (site default / override / effective in × + bps; set custom, quick-exempt 0×, clear) + `wager-requirement-actions.ts` (requireAdmin, 404→"User not found in backend", network→"Backend not updated yet", audit old→new). Data fetched NON-critically in `page.tsx` `UserDetailBody` (own try/catch→null, NOT in the heavy `getUserDetailCached` aggregate) → threaded `UserViewModern`→`AccountTab`; also threaded through classic `tab-content.tsx` + responsive fixture · `dc6e05c3`
- **Verify gap:** build-gated only. No live logged-in click-through (no local `.env`/DB) and no real backend success path (branch undeployed) — both surfaces degrade to the "awaiting backend deploy" state, which is the realistic current prod render. Recommend a logged-in pass once the backend branch ships.

**Leaderboard wager weights admin UI (2026-06-07):**
- `src/lib/backend-api/leaderboard-wager-weights.ts` (NEW) — server-only module wrapping the backend's `/admin/leaderboard-wager-weights` GET/PUT (`{ packs_bps, battles_bps, upgrader_bps }`, bps 10000 = 1×, partial PUT)
- `/security` card — `leaderboard-wager-weights-card.tsx` (3 knobs in ×-multipliers + live "= N bps" hint, changed-fields-only, null → muted "awaiting backend deploy") + `leaderboard-wager-weights-actions.ts` (requirePageAccess + requireAdmin, audit `leaderboard_wager_weights_updated` old→new, backend PUT) + `leaderboard-wager-weights-keys.ts` (3 site_config keys `leaderboard_wager_weight_{packs,battles,upgrader}_bps` added to the `movedKeys` filter in `security/page.tsx`); backend read non-critical (try/catch→null); rendered under its own `SectionHeading` (Trophy icon) below the withdrawal card
- Semantics (for copy/QA): ONE shared weight set covers official races AND creator/affiliate leaderboards; weights freeze on each wager at bet time (changes affect future bets only, never reshuffle standings); independent from the withdrawal `wager_weight_*_bps` knobs; total_wagered/levels/rakeback/commissions unaffected. Backend source: `packy-backend` branch `axecutioner/sweepstake`, `src/routes/v1/admin/leaderboard-wager-weights.ts`
- **Verify gap:** build-gated only (tsc + lint 0 errors + `npm run build` exit 0); same live-pass caveat as the wager-requirement cards — degraded state is the expected prod render until the backend deploys.

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
- **Backend API env** — Hub dashboard/roster/deal-tracker degrade gracefully when `BACKEND_API_URL_*` missing (KPIs show `—`); not a render failure
- **Admin DB = `db push` only** — never `prisma migrate dev/deploy` (destructive reset); additive enum: `prisma/admin/sql/20260606_add_creator_manager_role.sql`
- **MAIN DB = read-only** — no schema changes, no writes; `gift_cards` + `vouchers` live in MAIN
- **React #130** — register new nav icons in `app-sidebar.tsx` ICONS map
- **PowerShell UTF-8 BOM** breaks `.sql` — write SQL via Bash/`printf`
- **Verify agents** — `git fetch && checkout exact SHA` before "not found" verdicts
- **Twitter API shape** — read `core` + `avatar`, not only `legacy` (`src/lib/creator-hub/`)
- **Hub ads e2e** — `readSampleAdCode()` needs `admin_settings.house_affiliate_user_id` + a row in MAIN `affiliate_codes`; local VM has neither → detail e2e skips; ads tab still renders house-setup empty state
- **Prod Playwright mint** — cookie signed with VM `SESSION_SECRET` must match Vercel env or prod smoke lands on `/login`
- **Wager-requirement backend dependency** — the 5 default knobs + per-user override are owned by the backend (`packy-backend` branch `axecutioner/sweepstake`, `src/routes/v1/admin/user-wager-requirements.ts`); the panel writes them via `backendApi` (NOT the MAIN DB). Until that branch deploys, both UI surfaces show the muted "awaiting backend deploy" state. New audit event types: `wager_requirement_defaults_updated`, `user_wager_requirement_updated`, `user_wager_requirement_cleared`.
- **Leaderboard wager-weights backend dependency** — same pattern, same backend branch (`src/routes/v1/admin/leaderboard-wager-weights.ts`): 3 knobs `leaderboard_wager_weight_{packs,battles,upgrader}_bps` in MAIN `site_config` (hence the `movedKeys` filter), written ONLY via `backendApi`. Audit event type: `leaderboard_wager_weights_updated`. Card degrades to "awaiting backend deploy" until that branch ships.
- **Fresh checkout may lack `node_modules` + `.env`** — run `npm install` (NOT `npm ci` — lockfile mismatch) then `prisma generate` for BOTH schemas before tsc/build; without `.env` the minted-session Playwright harness can't run (needs `SESSION_SECRET` + `ADMIN_DATABASE_URL` + `DATABASE_URL`).

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
