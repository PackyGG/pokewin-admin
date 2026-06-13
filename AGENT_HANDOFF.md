# AGENT_HANDOFF.md — Live Session State

> **Read this first every session.** Then `ONBOARDING.md` + `AGENTS.md`.
> Protocol: `SESSION_MEMORY.md` (mandatory read/write rules).
> Operating rules (workflows, DB policy, build gate): `AGENTS.md` / `CLAUDE.md` — not duplicated here.

---

## CURRENT STATE

- **HEAD:** `origin/main @ d237e8a6` · **Updated:** 2026-06-12 · **Active focus:** multiple parallel sessions + 2 automated workflows — READ THE COORDINATION SECTION BELOW BEFORE EDITING ANYTHING.

---

## 🚦 ACTIVE COORDINATION (2026-06-12) — read before touching files

**Multiple agents are working this repo in parallel RIGHT NOW. `main` = prod and is receiving pushes from isolated worktrees. Always `git pull --rebase` before pushing. Keep your file scope tight and listed here.**

**🎯 EDGE-PLAN REWORK ACCEPTANCE NUMBERS (owner-confirmed live from /insights hub, 2026-06-12 ~04:40):** Wager **$3,211,825.07** (Lifetime · real customers, via `getInsightsHubWager`) · Total P&L **+$44,925.74** (balance-sheet snapshot incl. unclaimed rakeback, via `getCostBreakdown` pnl). Any earlier "~+$120K realized P&L" hint is OBSOLETE — reconcile edge-plan-2 against the LIVE helper values; these are the current ballpark. The `edge-plan2-data-rework` workflow (worktree `_wt-edge-plan2-rework`) SUPERSEDES Workflow A below for all edge-plan-2 files; on rebase conflicts in edge-plan-2/** its version wins.

**Workflow A — Edge Plan 2.0 overhaul (running, worktree `_wt-edge-plan2-overhaul`).** OWNS (do not touch): `src/app/(admin)/insights/edge-plan-2/**`, `src/app/(admin)/insights/system-edge-plan/**`, `src/lib/queries/insights-rewards/raffle/**`, `src/app/responsive-fixture/edge-plan-2/**`, `e2e/tests/edge-plan-2.spec.ts`, `scripts/probe-edge-plan-recon.ts`.

**Workflow B — app-wide perf/reliability audit (SHIPPED its safe-fix batch from worktree `_wt-app-audit`; audit phase complete).** Audited everything read-only; implemented ONLY behavior-preserving fixes (queries/errors/loading mechanics). Shipped scope (gates + Playwright render-sweep verified): pagination clamps in `src/lib/queries/{transactions,audit,withdrawals}.ts`; dead-relation + SELECT-star cleanups in `withdrawals.ts`/`whitelist.ts`; topbar safeQuery timeout (`src/components/topbar-house-stats.tsx`); safeQuery/TileErrorFallback hardening across `src/app/(admin)/analytics/tab-*.tsx` (+ Overview Suspense split); `loadPrimary`/safeQuery wraps on `/battles`, `/sets`, `/vouchers`, `/promo-codes`; streamed+degraded `/audit` + transactions table sections; `after()` for `/my-profile` socials refresh; creator-hub route `error.tsx` ×4 + hub-overview globalStats timeout leg. Deferred (data-meaning — owner sign-off needed, see audit report in session log): dual-DB env in cached money aggregates (`house-kpis.ts` + 3 dashboard caches), gift-card status pagination, `users-sessions` lifetime scan, LTV `all` cap, creators signups/FTD exclusion asymmetry, DockedAlerts eager sync, hub-cohort cache split, rain tips pagination, promo-code true redemption count. It did NOT touch: hotspots, frozen files, in-flight files, `insights/**`.

**Owner's parallel sessions (live):** "Rendered more hooks on Creator Hub" → owns the (creator-hub) component hook fix. "First-visit TZ hydration app-wide" → owns `src/components/timezone-provider.tsx`, `src/app/(admin)/layout.tsx`, and any `suppressHydrationWarning` sweep (root-cause = TimezoneProvider first-visit re-render racing late-hydrating streamed legs; per-page suppress is a patch, provider/layout is the right layer). UI-performance chat → owns visual loading-UX (skeleton quality, pending states). Don't duplicate each other's class of change.

**FROZEN (recent verified fixes / money math — report findings, never edit):** `src/lib/queries/users-transactions.ts` (owner-only adjustments gate), `src/lib/balance-adjustment-categories.ts` (null-safe 3VL predicates), `src/lib/queries/_ledger-tx-types.ts` (live prod-enum filter), `src/lib/queries/pnl.ts` + `users-windowed-pnl.ts` (**NEVER add `upgrader_games.won_amount` into ledger balance-delta P&L** — upgrader wins are inventory items, already counted via inventoryChange; commit `ea5e97b8` did it and broke Daily P&L → reverted `231884f9`), `src/lib/users/owner-adjustments-visibility.ts`, `src/lib/creator-hub-access.ts`, `src/lib/queries/dashboard.ts` (pending owner-side commit).

**DB (2026-06-11, CLAUDE.md):** NEW live prod game DB in `.env` — strictly READ-ONLY for everyone (no DDL by anyone, ever; indexes are dead ends — perf is won in code). Old-DB facts (enums/tables/indexes) are unverified on the new DB; re-probe before relying.

**Recently shipped (don't re-audit deeply):** `/users` list + `/users/[id]` remakes, `/creator-hub/creators/[id]` remake, gaming-tab enum fix, page-size fix, 3VL adjustment fix, P&L revert. All verified on live prod data.
- **Note (2026-06-06):** local checkout was on branch `dev` (even with `origin/main`) with **no `node_modules` / `.env`**; ran `npm install` + `prisma generate` (both clients) to gate.
- **Cloud VM dev env:** merged **PR #48** — `AGENTS.md` § Cursor Cloud specific instructions on `main`; update script `npm install`. Local VM: Postgres 16 + `.env.local`; lint/tsc/build + Playwright auth PASS.
- **Deploy:** `main` → Vercel prod `pokewin-admin.vercel.app`
- **Route segment:** `src/app/(creator-hub)/creator-hub/` (sub-app with own layout + sidebar)

---

## ✅ Shipped (recent — on `main`)

**Multiplier (odds-based) wager-weight admin UI (2026-06-12, `d237e8a6`):**
- `/security` "Multiplier Wager Weights" card (Gauge icon, between Funding-Source and Reward Expiry): per destination — display order Leaderboard, Rakeback, Shards, Withdrawal (leaderboard = owner's main farming concern) — an enable Switch + ordered tier rows reading "Below [max_x] × → counts [weight] %" with live "= N bps" hint, add/remove tier (cap 10). Backend rule: a bet with payout multiplier m gets the FIRST tier (ascending max_x) where m < max_x, else 100%; only upgrader bets carry a player-chosen multiplier (packs/battles unaffected). Defaults: <1.25× → 20%, 1.25–1.50× → 50%, all destinations disabled.
- 3-layer pattern: `src/lib/backend-api/multiplier-wager-weights.ts` (server-only GET/PUT `/admin/multiplier-wager-weights`; doc points at `packy-backend/src/routes/v1/admin/multiplier-wager-weights.ts`) + `multiplier-wager-weights-shared.ts` (plain module: destination list, tier type, cap, default tiers — value-importable by the client card, crypto-fees-assets precedent) + `multiplier-wager-weights-actions.ts` (requirePageAccess("/security") + requireAdmin, zod mirror: weight_bps int 0..10000, max_x finite >1 ≤100000 strictly ascending, ≤10 tiers, at-least-one-value; audit `multiplier_wager_weights_updated` changed/old/new) + `multiplier-wager-weights-card.tsx` (percent inputs, 50 = 5000 bps; changed-destinations-only PUT; a changed tier list sends the FULL replacement per the wholesale-replace contract; Save disabled while clean; `initial === null` → amber "awaiting backend deploy").
- NO `-keys.ts` movedKeys filter: backend branch not fetched locally, its site_config key names (if any) unverified — add the filter when the route lands (same call as crypto-fees).
- Dev fixture `responsive-fixture/multiplier-wager-weights` (REAL card, populated incl. empty-tier destination + degraded). Verified via Playwright against `next dev` + locally-minted session (no `.env` here): 29/29 checks — render both states, section order, dirty-tracking (toggle/edit/add/remove + reverts), bps hint, ascending/>1×/0–100% validation toasts, add-tier disabled at 10, payload intercept confirmed changed-destinations-only with full tier-list replacement, 0 overflow at 375/1280, 0 pageerrors. tsc / lint (0 new) / build exit 0.
- **Verify gap:** fixture-rendered + build-gated only — no live logged-in click-through and no real backend success path (branch undeployed; prod will show the degraded state, which IS the verified render). Recommend a logged-in pass once the backend ships.

**Crypto deposit/withdrawal exchange-rate fee admin UI (2026-06-12, `a589fa44`):**
- `src/lib/backend-api/crypto-fees.ts` (server-only GET/PUT `/admin/crypto-fees`, doc points at `packy-backend/src/routes/v1/admin/crypto-fees.ts`) + `crypto-fees-assets.ts` — plain module holding the 11-asset list (`BTC…XRP`); the client card needs the RUNTIME constant, and a value import from the server-only module pulls `"server-only"` into the client bundle and fails `npm run build` (type-only imports are fine — that's why the older cards never hit this).
- `/security` "Crypto Exchange-Rate Fees" card (Bitcoin icon, below Reward Expiry): `crypto-fees-card.tsx` (Deposits + Withdrawals sections; one row per coin: enable Switch + Min %/Max % inputs in PERCENT, 0.35% = 35 bps, cap 5%; changed-fields-only PUT; Save disabled while clean; min ≤ max validated on the EFFECTIVE merged pair; `initial === null` → muted "awaiting backend deploy") + `crypto-fees-actions.ts` (requirePageAccess("/security") + requireAdmin, zod mirror of backend: int 0..500 + min≤max per provided pair + at-least-one-value, audit `crypto_fees_updated` changed/old/new, revalidatePath). Placement note: `/transactions/deposits` was evaluated first per the owner spec but is purely a data-table surface → fell back to /security per the same spec.
- NO `-keys.ts` movedKeys filter: the backend branch isn't fetched locally, so its site_config key names are unverified — if the deployed route persists per-coin keys into `site_config`, add the filter then (same pattern as the other cards).
- Dev fixture `responsive-fixture/crypto-fees` (renders the REAL card populated + degraded). Verified via Playwright against `next dev` with a locally-minted session (no `.env` in this checkout): dirty-tracking enables/disables Save correctly on toggle + % edit + revert, 22 switches (11 coins × 2 directions), degraded banner renders, 0 horizontal overflow at 375/1280, 0 pageerrors. tsc/lint(0 new warnings)/build all green.
- **Verify gap:** fixture-rendered + build-gated only — no live logged-in click-through and no real backend success path (branch undeployed; prod shows the degraded state, which IS the verified render). Recommend a logged-in pass once the backend ships.

**"More hooks" Router crash — last two routes fixed (2026-06-12):**
- `/withdrawals` in-render `redirect()` stub deleted → HTTP 308 in `next.config.ts` to `/transactions/deposits?tab=withdrawals` (Next forwards unused incoming query params, so `?status=pending` deep-links keep filters; exact-match source — `/withdrawals/:id` detail route stays live).
- `/my-profile` no longer in-render-redirects at all: `requireRole(["creator"])` + `redirect("/login")` replaced with `verifySession()` + `sessionHasRole` — non-creators (and creators without profile data) get a PageHero + page-level EmptyState ("No creator profile", zero data calls); creator path incl. `after()` socials refresh unchanged.
- Verified via Playwright + minted plain-admin session (fresh context per route, `pageerror` listeners): baseline reproduced "Rendered more hooks" on BOTH routes; post-fix 0 pageerrors, redirect + query-forward land correctly, empty state renders. Creator-session render check skipped — no creator-role `admin_users` row in ADMIN DB. tsc/lint/build green.
- `/gift-cards` (adversarial-review finding — third and last fixed-destination stub of this class): in-render `redirect()` stub deleted → HTTP 308 in `next.config.ts` to `/rewards`; the stub's `requirePageAccess("/rewards")` gate is intentionally dropped — `/rewards` enforces the same gate server-side (same as the `/withdrawals` redirect). Baseline reproduced "Rendered more hooks" on `/gift-cards`; post-fix 0 pageerrors, lands on `/rewards` rendered. tsc/lint/build green.
- **`/rewards/analytics` (DYNAMIC-destination stub — 2026-06-13):** can't be a static 308 (its `?category=` → 7 `/insights/rewards/<sub>` targets and `?period=` remap `today`→`24h`). In-render `redirect()` replaced with a `/my-profile`-style client redirect: server keeps the `requirePageAccess("/rewards/analytics")` gate + computes the exact dest string from `searchParams` (category map + period map copied verbatim), then hands the plain string to a new `"use client"` `RewardsAnalyticsClientRedirect` (`_components/client-redirect.tsx`) that does `router.replace(dest)` in `useEffect`; a `PageHero` "Redirecting…" skeleton renders meanwhile (no function props over the RSC boundary). Files: `rewards/analytics/page.tsx` + `_components/client-redirect.tsx`. The rest of the `rewards/analytics/` folder is a shared component lib still imported by the live `/insights/rewards` pages — left untouched. Verified via Playwright + minted plain-admin session (per-URL `pageerror` listeners) against `npm run start`: `/rewards/analytics` → `/insights/rewards?period=7d` (0 pageerrors); `?category=rakeback&period=today` → `/insights/rewards/rakeback?period=24h` (0 pageerrors). tsc/lint/build green. **Dynamic-destination stubs of this class: 4 → 3 remain.**

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

**Reward Expiry config (2026-06-10, LOCAL/uncommitted, backend + admin) — PARTIAL:** owner request — per-reward-type claim windows ("rakeback expires in 3 days, race winnings in 7"). Reward types: rakeback / race / leaderboards / reloads (= balance rewards: Reload is a balance-reward category alongside Bonus/Giveaway/Deposit-fix/Lossback).
- **Backend (`packygg-backend`):** rakeback ALREADY had per-type expiry (`rakeback_config.expiration_days`, enforced) — race prizes and leaderboard prizes explicitly never expired, balance rewards never expired. Added: 3 site_config keys `reward_expiry_{race,leaderboard,balance}_days` (DEFAULTS `'0'` = never, preserving current behavior) + getters; claim-time enforcement in `race.service.ts claimRacePrize` (anchor `period.ends_at`, error `RACE_PRIZE_EXPIRED`), `affiliate-leaderboard.service.ts claimPrize` (anchor `end_date`, ForbiddenError), `claimBalanceReward.ts` (anchor `granted_at`, new `ERROR_CODES.BALANCE_REWARD_EXPIRED`); new repo method `rakeback.updateExpirationDays`; new admin route `/admin/reward-expiry` GET/PUT (`{ rakeback: {daily,weekly,monthly}_days, race_days, leaderboard_days, balance_days }`, days int 0..3650, rakeback writes through to `rakeback_config`, rest to site_config) registered in `admin/index.ts`.
- **Admin UI:** `/security` "Reward Expiry" card (Hourglass icon, below Funding-Source): `reward-expiry-card.tsx` (4 groups: Rakeback daily/weekly/monthly · Race winnings · Leaderboards · Reloads & balance rewards; whole-day inputs, "never expires"/"expires after N days" hint, changed-fields-only) + `-actions.ts` (requirePageAccess+requireAdmin, audit `reward_expiry_updated` old→new) + `-keys.ts` (3 site_config keys → movedKeys) + `src/lib/backend-api/reward-expiry.ts`.
- **Known UX gap (frontend follow-up):** enforcement is claim-time only — `packygg-frontend` race history / leaderboard pages still render expired prizes as claimable (claim then 4xxs with the expiry error). Rakeback UI already shows `is_expired`. Surfacing expiry in race/leaderboard/reward user UIs = packygg-frontend work, not started.
- **Verify:** backend `tsc` — 0 errors in touched files (21 pre-existing unrelated, missing-dep typings; backend `npm run lint` broken repo-wide: eslintrc-format config + ESLint 9). Admin: `tsc` exit 0 · lint clean · `npm run build` exit 0 (Node 22). NO live click-through (no backend env; card renders degraded state). NOT committed (loose checkout, see below).

**Shard wager-weights admin UI (2026-06-10, LOCAL/uncommitted) — PARTIAL:** two `/security` cards added to expose the already-shipped backend shard knobs (backend on `packy-backend`: per-game `shard-wager-weights.ts` route + `shards` as the 4th `source-wager-weights.ts` destination, both already wired into all four wager callers).
- **NEW per-game "Shard Wager Weights" card** (Gem icon, placed before Funding-Source): `shard-wager-weights-card.tsx` + `-actions.ts` (requirePageAccess+requireAdmin, audit `shard_wager_weights_updated`, backend PUT) + `-keys.ts` (`shard_wager_weight_{packs,battles,upgrader}_bps`) + `src/lib/backend-api/shard-wager-weights.ts` (GET/PUT `/admin/shard-wager-weights`). Mirrors the leaderboard-weights card exactly.
- **Funding-Source card extended** with a 4th `shards` destination (withdrawal/rakeback/leaderboard/**shards**): added to lib types (`shards?` optional → graceful per-destination degrade), card `DESTINATIONS`, action Zod schema + refine, and the `movedKeys` filter.
- **⚠️ Backend key-naming finding (NOT changed):** the funding-source `shards` keys persisted to `site_config` are PLURAL `shards_source_weight_*` (PUT/GET build the key from the `'shards'` destination string). The `DEFAULTS` map in `packy-backend` `site-config.service.ts` has SINGULAR `shard_source_weight_*` entries → **dead** (never read; harmless, all = 10000 via the hardcoded fallback). Admin `movedKeys` uses the live PLURAL keys. Backend could drop the dead singular DEFAULTS entries; no functional impact.
- **Env finding:** `prisma generate` / `npm run build` need **Node ≥22** here (Prisma 7.5.0 WASM needs `externref`; Node 16 → `CompileError`, Node 20.18 → `ERR_REQUIRE_ESM`). Built green on `v22.14.0`.
- **Verify:** `tsc --noEmit` exit 0 · `lint` clean · `npm run build` exit 0 (Node 22). **NO live logged-in click-through** (no backend API env here → cards render the degraded "awaiting backend deploy" state). Recommend a logged-in pass on a deploy where the backend shard routes are reachable.
- **NOT committed/pushed:** this `PackyGG/pokewin-admin` checkout is loose, untracked files (surrounding git remote is unrelated). Deploy via the real pokewin-admin repo.

_Creator Hub plan closed. Pick up deferred items below when owner prioritizes._

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
- **Multiplier wager-weights backend dependency** — same "awaiting backend deploy" pattern (`/admin/multiplier-wager-weights`, backend branch in parallel development, NOT in the local packy-backend checkout). Audit event type: `multiplier_wager_weights_updated`. Runtime constants for the client card live in `src/lib/backend-api/multiplier-wager-weights-shared.ts` (deliberately NOT server-only). PUT semantics: tiers replace the stored list wholesale — never send a partial tier list.
- **Crypto-fees backend dependency** — same "awaiting backend deploy" pattern (`/admin/crypto-fees`, backend branch in parallel development, NOT in the local packy-backend checkout). Audit event type: `crypto_fees_updated`. The 11-asset constant lives in `src/lib/backend-api/crypto-fees-assets.ts` (deliberately NOT server-only — client card imports it as a value).
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
