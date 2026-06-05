# Packy.GG Admin Dashboard — Master Knowledge & Operating Guide

> Single source of truth for working on **pokewin-admin** (the internal admin/back-office for the Packy.GG game platform). Consolidates the strict CLAUDE.md working rules, global architecture knowledge, domain knowledge, and hard-won gotchas. Read this before touching anything.

---

## 0. What this is
- **pokewin-admin** = the staff admin dashboard for **Packy.GG** (packy.gg), a pack-opening / battles / upgrader gambling-style game.
- It is **internal/back-office** (admins, support, marketing, creators), NOT the player-facing site.
- **Deploy topology:** `main` branch = **Vercel PRODUCTION** → `pokewin-admin.vercel.app`. Every push to `main` is a prod deploy. Other branches = preview. (The old "hungry-gould is prod" note is WRONG.)

---

## 1. 🚫 DATABASE POLICY — HARD RULE (highest priority)

Two fully separate Postgres databases, treated **very differently**:

### 🟢 ADMIN DB — full access
- Client `adminDb` (`src/lib/admin-db.ts`), schema `prisma/admin/schema.prisma`, env `ADMIN_DATABASE_URL`.
- Writes, migrations, DDL/DML, `db push` — **all allowed**; the agent applies them itself.
- Holds ONLY admin-panel data: `admin_users`, `admin_sessions`, `admin_audit_events`, `admin_notes`, `admin_gift_card_actions`, `admin_voucher_actions`, `admin_balance_limits`, `creator_deals`, `creator_webhooks`, `expenses`, `recurring_expenses`, salary tables, `admin_excluded_user_balance_v2` (Balance 2.0), etc.
- **⚠️ Admin DB is `db push`-managed, NOT migrate-baselined.** `prisma migrate dev/deploy` will demand a **destructive reset** — NEVER run it. Apply schema changes via `prisma db push` (it refuses on data loss — good) or `prisma db execute --file <migration.sql> --config prisma/admin/prisma.config.ts` for additive SQL. Always audit-log admin mutations (`createAdminAuditEvent`).

### 🔴 MAIN / PROD GAME DB — strict read-only
- Client `getDb()`/`db` (`src/lib/db.ts`, prod/dev toggle via `admin_db_env` cookie + `DEV_DATABASE_URL`), schema `prisma/schema.prisma`, env `DATABASE_URL`. 30s statement timeout.
- Holds the **live game**: users, balances, ledger, packs, cards, battles, inventory, rewards, affiliate, deposits/withdrawals, promo/gift/vouchers, rain/raffles/races. Real users, real money.
- **READ-ONLY. No writes, migrations, DDL/DML, ever.** AND: **do not even build/propose features that would require a MAIN-DB schema change** — the owner won't apply them. Such tasks are blocked → model it in the ADMIN DB instead, or tell the owner it can't be built without changing MAIN.
- No cross-DB joins — query each DB separately, merge in code.

**Known MAIN-DB tables that surprised us:** `gift_cards` and `vouchers` live in MAIN (not admin) — so bulk-delete on those = a MAIN write = forbidden.

**Open admin-DB schema drift (unresolved):** `creator_deals.monthly_cashout_limit` + `weekly_cashout_limit` (1 non-null value each) and the `creator_deal_estimates` table (17 rows) exist in prod admin DB but were dropped from `prisma/admin/schema.prisma`. `db push` correctly refuses. Decision pending: restore in schema, or archive+drop.

---

## 2. ⚙️ WORKING RULES (from CLAUDE.md)

- **Workflow-first is STRICT.** Begin every non-trivial task with a `Workflow` (deterministic multi-agent orchestration). Multiple tasks → multiple workflows in parallel. Use as many agents as useful. Inline/single-agent only for: a pure codebase question (no edit), ONE trivial 1-file fix, live troubleshooting, or explicit "inline".
- **Fan out by independent unit, not by file.** Independent units (many pages, many files) → many parallel agents. One coupled file/surface → ONE builder + an adversarial **verify** agent (the verifier re-checks the diff cold — it has caught real bugs). Two agents editing the same file collide.
- **Parallel background agents are the norm.** New task → start it immediately; never block the channel; always stay ready for the next message.
- **Push discipline:** ship after EVERY finished+verified task; never batch 5 things into one late push. Independent tasks build in isolated git **worktrees** and push to `main` independently (rebase-retry on non-fast-forward).
- **Build gate:** `npx tsc --noEmit` + `npm run lint` (0 new warnings) + `npm run build` (exit 0) before every push. `npm run build` is the authoritative gate — client→server boundary errors only surface there.
- **Browser/rendered verification** is required for UI work before calling it DONE. (See §8 for the headless approach + the Chrome-extension gap.)
- **Honest reporting:** statuses are `DONE` / `PARTIAL` / `PROPOSED` / `BLOCKED`. Never claim DONE without verification. Never fake a diff or a passing gate. Flag omissions proactively.
- **No guessing / no invented APIs, tables, columns, env vars.** Reuse existing utilities/patterns. Ask for DB info rather than assume.

---

## 3. 🏗️ ARCHITECTURE

- **Stack:** Next.js 15.5.12 (App Router, Turbopack), React 19.1, TS strict, Tailwind 4 + shadcn/ui (base-nova), Prisma 7.5 (dual client), Auth = JWT (`jose`) + TOTP 2FA (`otpauth`), Zod 4, `sonner` toasts, TanStack Table 8, Recharts, `@dnd-kit`, `cmdk`, `next-themes` (dark default), Playwright (e2e, already installed).
- **Server-Components-first:** pages are `async` Server Components; client interactivity in `"use client"` islands; mutations via Server Actions + `revalidatePath`. No SWR/React Query.
- **Routing:** ~84 routes under `src/app/(admin)/` (+ `(auth)`), grouped: Overview (dashboard, analytics, users, transactions), Insights (`/insights` hub + cost-breakdown, analytics, games, rewards/*, forecast, system-edge-plan, ggr, balance-adjustments), Creators (list, [userId], leaderboards, socials, changelog, ads, codes, settings), Content (packs, cards, sets, upgrader), Transactions, Rewards, Admin/Security (admin-users, audit, settings/roles, balance-limits, security), System (stats, commands, excluded-users), Promo/misc (promo-codes, rain, vouchers, gift-cards, bots, chat, salaries, employees, shifts).
- **Shell:** `src/app/(admin)/layout.tsx` — `SidebarProvider` + `AppSidebar` (collapses to a Sheet drawer on mobile) + `SidebarInset` (main content `flex-1 overflow-auto min-w-0 p-3 sm:p-4 md:p-6` + safe-area insets) + sticky `AdminHeader` (responsive breadcrumbs) + `TopProgressBar` + right-rail docks (LiveMoneyChat / RecentActivity / Chat; pages reserve `pr-6 sm:pr-10 xl:pr-12 2xl:pr-16`). **Nav is single-source in `src/lib/nav-config.ts`**; icon strings MUST be registered in the `ICONS` map in `app-sidebar.tsx` (unregistered → React #130 shell crash; a `?? ScrollText` fallback now prevents the crash).

---

## 4. 🎨 UI / DESIGN CONVENTIONS

- **Only the house stack:** Tailwind + shadcn (base-nova) + `@base-ui/react` + `lucide-react` icons + `recharts` + TanStack data-table + `sonner`. No other UI frameworks, no new design systems, no hardcoded colors (use `globals.css` vars + `src/lib/constants.ts`).
- **Modern-page pattern (mandatory, reference = `/users/[id]`):** every page = `PageHero` (+ `PageHeroIdentity`) → KPI strip (`KpiTile`/`MetricTile`) → sections with `SectionHeading` → content. Primitives live in `src/components/modern-panels.tsx` (`PageHero`, `PageHeroIdentity`, `StatPanel`, `KpiTile`, `MetricTile`, `PanelRow`) + `AnimatedNumber`, `FadeIn`. **Never pass function props server→client** (Next 15 crashes) — serializable primitives only.
- **🎯 House-POV finance colors (STRICT, site-wide, the single rule):**
  > **User gains / profits → 🔴 ROSE.   User loses money → 🟢 EMERALD.   Neutral (signup etc.) → 🔵 BLUE.**
  Because every dollar the user holds is a dollar we owe. User win = our loss = rose; user loss = our gain = emerald. Deposits/wagers = emerald (cash to us); withdrawals/wins/bonuses/rakeback/affiliate payouts/rain/race/raffle = rose. House P&L/GGR/NGR positive = emerald, negative = rose. **Quick test before commit:** "if the user celebrates this event, is it rose? yes → correct."
- **Responsive:** mobile-first, standard Tailwind breakpoints (sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536). Conventions: grid ladder `grid-cols-1 sm:grid-cols-2 lg:grid-cols-N` (never fixed `grid-cols-N` at base); `min-w-0` on every flex text column; **no `shrink-0` on grids that must wrap** (this caused the `/users/[id]` hero break); breakpoint-qualify negative margins (`sm:-mx-…`); tables collapse to mobile card-lists (`lg:hidden` ↔ `hidden lg:block`) or `overflow-x-auto`; dialogs are bottom-sheets on mobile with safe-area insets.
- **Active-timeframe-only (perf rule):** a timespan/tab page loads ONLY the active window + active tab on first render; other windows/tabs load lazily on selection (keyed `<Suspense>`). Heavy queries use `unstable_cache` + the `safeQuery` timeout wrapper; bound lifetime scans (`windowDateFilterCapped`). Reference: `src/lib/queries/dashboard-period.ts` + the insights lazy-tab structure.
- **Smoothness foundation (mature, exported from `@/components/ux`):** `motion.ts` (DURATION/EASING tokens, motion-safe `transition()`/`enter()`/`pressable()` helpers — cubic-bezier(0.16,1,0.3,1)), `TopProgressBar`, `AnimatedNumber`, dimension-matched skeleton atoms (`SkeletonTable`/`KpiStrip`/`Chart`) + CLS wrappers (`StableCard`/`StableTable`/`PageReadyBoundary`), pending primitives (`RouteTransitionShell`, `LinkPending`, `Spinner`). Gold-standard non-blocking switch = `dashboard-period-selector.tsx` (`useTransition` + `router.replace(scroll:false)` + dim + in-chip spinner). New shared primitives being added: `<PeriodChips>`/`<TabChips>`, `<TabContainer>`, scroll-to-top-on-nav, motion-safe `Button`.

---

## 5. 🔐 AUTH & PERMISSIONS

- Use the DAL only (`src/lib/dal.ts`): `verifySession()`, `requireAdmin()`, `requireRole(roles)`, `requirePageAccess(pageKey)`. They `redirect()` on failure — don't reimplement. `src/middleware.ts` enforces the flow (decrypts the `admin_session` JWT + checks expiry).
- Roles (`src/lib/admin-roles.ts`): `admin`, `support`, `marketing`, `creator`, `pack_creator`. `ROLE_PRIORITY` (admin wins), `getEffectiveRoles()` normalizes `role` + `roles`. Per-page access via `allowed_pages`.
- Mutating actions must `createAdminAuditEvent()`. 2FA-gate sensitive mutations (balance, XP, withdrawals).

---

## 6. 💰 DOMAIN: MONEY & REWARDS

- **Ledger is the source of truth.** All balance changes go through `ledger_transactions` (immutable, `balance_before`/`balance_after`). Never `balances.update()` without a ledger entry. Multi-step = `db.$transaction([...])`. Money = `Decimal(20,2)`; use Decimal utils, not JS number math.
- **Voucher = Card** (same item). `battle_excess_to_voucher` + `battle_refund` are legs of a normal battle win → merge into "Pack & battle wins", not separate cost lines. Exchanging/redeeming a voucher/card is neutral (value already booked at creation) — never a house loss.
- **Customer scope (canonical):** `getMetricsScope()` (`src/lib/metrics/scope.ts`), `CUSTOMER_EXCLUDED_ROLES = ['admin','support','creator']` (creators dropped wholesale 2026-06-03) + the `excluded_users` blacklist. Use `scope.ts` for GGR/NGR/PnL/wager (NOT the legacy `EXCL_STAFF_FRAG`).
- **P&L formula** (per-user and global): `pnl = deposits − withdrawals − onSiteBalance − inventoryValue − unclaimedVouchers`. `official_stream` adjustment category = FAKE balance → exclude everywhere (incl. PnL/onSiteBalance).
- **Edge / GGR:** GGR = house edge × wager. Per-type wager (real, recent window): **packs ~82.2M + battles ~5.5M** = canonical wager (reconciles exactly); GGR ~3.08M. Planned default house edge: **Packs & Battles = 10.99%**, **Upgrader = 10%**.
- **Reward programs + real costs (recent window):**
  | Program | Real config / cost | Notes |
  |---|---|---|
  | Rakeback | daily **0.25%** / weekly **0.1%** / monthly **0.05%** (= 0.40% blended) | `rakeback_config`; pre-claim/instant-claim lever modeled |
  | Affiliate | **8 tiers, 3%→10%**, thresholds $0→$1.5M | `affiliate_level_configs`; the "1× wager req" is a modeled what-if, not a confirmed stored toggle. **Commission basis (NGR vs wager) decides net-edge erosion — must be read, not assumed.** |
  | Deposit bonus | match 100%, **cap $100/24h**, real spend ~$17,364 | settings live in game backend |
  | Races | `race_prize`, real ~$6,907.50 | on-site competitive races |
  | Raffles | reconstructed from raffle `prizes` JSON (no ledger type), ~$15.59 | tickets per $X wagered; distinct from races |
  | Daily packs | ~$9.27 (`getDailyPacksTotalCost`) | free daily packs; EV editable; 30-day XP-unlock %; wager-loss (under active rework) |
  | Signup | "avg $5.71" is **suspect/misleading** | actually the **3 welcome packs**, EV ~$0.01–0.02 each (under investigation) |
  | Rain | net house slice = `max(0, rain_win − tips)`, ~$928.68 | system-automatic, mixed-funded (users + founder/motha) |
  | Motha giveaways | founder account: `creator_tip` + `battle_sponsorship` + motha `rain_tips` | named line, no double-count (these are residual/wager/rain-funding, not in canonical reward cost) |
- **Reward Costs box** (dashboard + system-edge-plan) is broken out **per-program** (rakeback, affiliate, deposit bonus, race, raffle, daily packs, signup, motha, rain) with an explicit sum = total (no double-count). Motha + raffle are **named lines only — no standalone display pages**.
- **Leaderboard cost attribution:** affiliate leaderboards = creator cost (100% Creators Costs); on-site competitive = races (`race_prize`); never put leaderboard prizes in on-site Reward Costs.
- **`/insights/system-edge-plan`** = the read-only planning tool to tune every edge + reward lever and see projected GGR/NGR/profit + delta + a "net edge by scenario" view (e.g. affiliate tier 8 → net edge X%). Levers are being reworked from opaque ×-multipliers into concrete, explained, real-data controls. Configs are saveable as named presets in **localStorage** (no prod-DB write).

---

## 7. ⚠️ GOTCHAS / HARD-WON LESSONS (incident log)

- **React #130 (prod-down):** a nav `icon` string not in the `ICONS` map → `<undefined/>` → admin shell crash. Always register new nav icons; `?? ScrollText` fallback added.
- **Smoke gap:** logged-out HTTP smoke (`/`→307, `/login`→200) CANNOT catch authenticated-shell render errors. Real verification needs an authed render.
- **Headless auth (the real verification path):** mint an `admin_session` JWT signed with `SESSION_SECRET` (matching `src/lib/session.ts`), reading one active admin from the ADMIN DB read-only, inject via Playwright `context.addCookies()` → renders any page past 2FA. Playwright + Chromium are already installed; an `e2e/` harness exists.
- **Responsive audit must RENDER, not read classes:** two prior class-reading audits missed a glaring `/users/[id]` break. The detector measures real `scrollWidth`/bounding-box/sibling-overlap at the viewport matrix (320→1536).
- **Verify agents can false-negative** (stale tree): always have the verify agent `git fetch + checkout the exact commit` first, and cross-check "not found" verdicts against `git show <sha>`.
- **Worktrees:** use `npm install` (NOT `npm ci` — committed lockfile mismatch `@emnapi/wasi-threads`); copy `.env` from main checkout; do NOT junction `node_modules` (concurrent `prisma generate` corrupts main); cleanup is junction-safe (check `LinkType` before recurse). `git commit --only <paths>` (never `git add -A`) and leave `src/generated/*`, `package-lock.json`, `recent-pushes.json`, `audit-artifacts/` uncommitted.
- **Stale `.next`:** `.next/types/validator.ts` references deleted page routes → tsc fails; clear `.next` before re-running the gate.
- **Admin migrate gotcha:** see §1 — prod admin DB is `db push`-managed; `migrate dev/deploy` demands a destructive reset. Apply via `db push` / `db execute`. (`prisma db execute` needs `--config prisma/admin/prisma.config.ts`, not `--schema`.)
- **PowerShell UTF-8 BOM** breaks Postgres SQL files — write SQL via Bash/`printf`, not PS `Set-Content -Encoding utf8` (BOM → `syntax error at or near "﻿SELECT"`).

---

## 8. 🗂️ KEY FILES

| Purpose | Path |
|---|---|
| Main DB client | `src/lib/db.ts` |
| Admin DB client | `src/lib/admin-db.ts` |
| Auth / DAL | `src/lib/dal.ts` · `src/lib/session.ts` |
| Roles | `src/lib/admin-roles.ts` |
| Metrics scope | `src/lib/metrics/scope.ts` |
| Format utils | `src/lib/utils/format.ts` |
| Constants (colors/status) | `src/lib/constants.ts` |
| Modern primitives | `src/components/modern-panels.tsx` |
| Smoothness/ux primitives | `src/components/ux/*` (`motion.ts`, skeletons, `AnimatedNumber`) |
| Nav (single source) | `src/lib/nav-config.ts` + `app-sidebar.tsx` ICONS |
| Admin shell | `src/app/(admin)/layout.tsx` |
| Schemas | `prisma/schema.prisma` (MAIN) · `prisma/admin/schema.prisma` (ADMIN) |
| Query modules | `src/lib/queries/**` |
| Period system | `src/lib/queries/dashboard-period.ts` |
| Edge planner | `src/app/(admin)/insights/system-edge-plan/*` |
| e2e / responsive harness | `e2e/*` (Playwright) |

**Scripts:** `npm run dev` · `npm run build` (prisma generate ×2 + next build) · `npm run lint` · `npm run admin:seed`. (Avoid `npm run admin:migrate` — it's `migrate dev`; see §1.)
**Env:** `DATABASE_URL` (MAIN) · `ADMIN_DATABASE_URL` (ADMIN) · `SESSION_SECRET` · `DEV_DATABASE_URL` · `ADMIN_SEED_PASSWORD`.

---

## 9. 📌 RECENT STATE (as of this session)
Shipped to `main`: dashboard windowing perf + full rework (panel boxes, today/24h, per-program Reward Costs), unified forecast hub (all rewards), rakeback/affiliate real-config forecasts, system-edge-plan planner (+ races/raffles split, saveable presets, exact-% inputs, resilient aggregates), creator changelog + fired-creator detection + artifact-anchored ex-creators, `/users` search rebuild (prefix-index), Total Withdrawn tile, Balance 2.0 on excluded-users (admin-DB table applied), `/insights` hub (was 404), a quick-win sweep (security gates, 2FA on XP, audit event types, a11y/motion-safe, mobile grids, forecast tabs). In flight: full **responsive audit** (Playwright rendered-detection harness, fix waves) + **smoothness** initiative (skeletons, route/tab transitions, View Transitions — gated) + reworking the system-edge-plan reward levers into concrete, real-data, explained controls (deposit/races/raffles/daily-packs/signup/rain).

---
*Living document — update it when rules, schema, or domain facts change.*
