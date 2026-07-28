# Packy.GG Admin Dashboard — Master Knowledge & Operating Guide

## 2026-07-27 MAIN mirror routing

Normal MAIN reads use `MIRROR_PRODUCTION_DB` / `MIRROR_DEV_DB`; runtime sessions
are forced read-only and fail closed. Existing mutation workflows explicitly
use `DATABASE_URL` / `DEV_DATABASE_URL`. Agents may apply indexes to mirrors
with `npm run db:index:mirrors -- <prod|dev|all>`, but may not run direct
DDL/DML against either primary. This supersedes older blanket read-only wording
below.

> **Durable architecture + domain knowledge** for **pokewin-admin**. Does NOT hold live session state.
>
> **Read order every session:** `AGENT_HANDOFF.md` (state) → **this file** (knowledge) → `AGENTS.md` (rules).
> **Forced protocol:** `SESSION_MEMORY.md` — agents MUST read on start and write before done.

---

## 0. What this is
- **pokewin-admin** = the staff admin dashboard for **Packy.GG** (packy.gg), a pack-opening / battles / upgrader gambling-style game.
- It is **internal/back-office** (admins, support, marketing, creators), NOT the player-facing site.
- **Deploy topology:** `main` branch = **Vercel PRODUCTION** → `pokewin-admin.vercel.app`. Every push to `main` is a prod deploy. Other branches = preview. (The old "hungry-gould is prod" note is WRONG.)

---

## 1. 🚫 DATABASE POLICY — HARD RULE (highest priority)

> **Canonical short reference:** [`DB_ACCESS.md`](./DB_ACCESS.md) — admin DB **full access** (agent applies migrations), MAIN/prod game DB **read-only**. Owner (2026-06-06): agents may run any admin DB operations.

Two fully separate Postgres databases, treated **very differently**:

### 🟢 ADMIN DB — full access
- Client `adminDrizzle` (`src/lib/admin-db.ts`), schema snapshot `src/lib/db-schema/admin/schema.ts`, env `ADMIN_DATABASE_URL`.
- Writes, reviewed SQL migrations, and DDL/DML are **all allowed**; the agent applies them itself.
- Holds ONLY admin-panel data: `admin_users`, `admin_sessions`, `admin_audit_events`, `admin_notes`, `admin_gift_card_actions`, `admin_voucher_actions`, `admin_balance_limits`, `creator_deals`, `creator_webhooks`, `expenses`, `recurring_expenses`, salary tables, `admin_excluded_user_balance_v2` (Balance 2.0), etc.
- **Admin schema workflow:** author reviewed, idempotent SQL under `drizzle/admin/migrations`, apply it transactionally with `npm run admin:sql -- <file>`, then refresh types with `npm run db:pull:admin`. Runtime DDL/self-heal is forbidden. The pull scripts normalize drizzle-kit's empty-array and unsupported `bytea`/`oid` introspection output. Do not use schema-push tooling. Always audit-log admin mutations (`createAdminAuditEvent`).

### 🔴 MAIN / PROD GAME DB — strict read-only
- Drizzle resolver in `src/lib/db.ts` (prod/dev toggle via `admin_db_env` cookie + `DEV_DATABASE_URL`), schema snapshot `src/lib/db-schema/main/schema.ts`, env `DATABASE_URL`. 30s statement timeout.
- Holds the **live game**: users, balances, ledger, packs, cards, battles, inventory, rewards, affiliate, deposits/withdrawals, promo/gift/vouchers, rain/raffles/races. Real users, real money.
- **Antifraud deposit classification:** use `fiat_deposit_intents.completed_ledger_id = ledger_transactions.id` as the authoritative fiat/card link. Do not infer every `crypto_asset IS NULL` row is fiat. Crypto deposits carry their chain/asset fields on `ledger_transactions`; fiat is reversible and needs a separate payment-risk lifecycle.
- **Antifraud signup history:** `services/antifraud-monitor` copies the minimum signup identity into its own `subjects` table and stores one current aggregate in `signup_assessments`; provider payloads remain private. Dashboard signup lists read the dedicated Antifraud Postgres through the authenticated monitor API, never by scanning MAIN.
- **Antifraud account networks and creator fraud:** the monitor service owns durable graph snapshots, scan jobs, creator assessments, categorized analysis rules, masked evidence, exact-value isolation, and account/network cases. The dashboard uses authenticated REST only for `/antifraud/networks` and `/antifraud/creator-fraud`; no graph or creator data uses WebSocket/SSE. Full network discovery follows signup IP and Fingerprint device links across the entire connected component, including accounts outside a creator cohort, while other signals affect scores/evidence without becoming graph nodes. MAIN is a read-only source throughout.
- **Antifraud withdrawal tracking:** `/antifraud/withdrawals` reads only the authenticated monitor API. Each funding trail begins at the latest completed deposit before the request, or the latest completed win/reward/other funding source when no deposit exists, and follows activity only from that origin to the withdrawal. Balance withdrawals do not require attached card/voucher records; asset-origin checks apply only to physical and crypto requests. The monitor also checks account age, deposit-to-withdrawal timing, and payout-destination reuse, then stores the derived score/evidence in Antifraud `withdrawal_assessments`. MAIN remains read-only; the assessment is refreshed when staff load the list.
- **READ-ONLY. No writes, migrations, DDL/DML, ever.** AND: **do not even build/propose features that would require a MAIN-DB schema change** — the owner won't apply them. Such tasks are blocked → model it in the ADMIN DB instead, or tell the owner it can't be built without changing MAIN.
- No cross-DB joins — query each DB separately, merge in code.

**Known MAIN-DB tables that surprised us:** `gift_cards` and `vouchers` live in MAIN (not admin) — so bulk-delete on those = a MAIN write = forbidden.

Drizzle schemas are catalog snapshots. After any approved ADMIN migration,
re-introspect and review the generated diff before committing it.

---

## 1.5 🗄️ BACKEND READ POLICY — PostgreSQL via Drizzle (HARD RULE, 2026-07-26)

> **Canonical short reference:** `docs/BACKEND_QUERY_SYSTEM.md`. Mirrored as a top-priority rule in `CLAUDE.md` / `AGENTS.md`.

The webapp uses PostgreSQL as its only database engine. Drizzle ORM is the default access layer, with parameterized Drizzle `sql` for complex or performance-critical queries.

> **A read hits a confirmed PostgreSQL index or has an `EXPLAIN ANALYZE`-documented reason for the planner's scan. No accidental unbounded scan on MAIN.**

- **PostgreSQL** serves live, per-user, money-exact, analytics, and fan-out reads. Queries must be bounded, cached where appropriate, and `EXPLAIN ANALYZE`-checked with read-only access.
- **Parameterized SQL only:** use Drizzle query builders by default and Drizzle `sql` with bound values when raw SQL is clearer or faster. Do not concatenate filters or user values into SQL.
- **MAIN is read-only:** agents never apply indexes there. Add justified `CREATE INDEX CONCURRENTLY` statements to `prisma/recommended-indexes.sql` and flag the owner.
- **Streaming is mandatory:** every page with a non-trivial read renders the `PageHero` shell instantly and loads data in an async child behind its own `<Suspense fallback={…Skeleton}>` plus a matching `loading.tsx`.
- **Per-read/page checklist:** index proof or documented planner choice; shell-first streaming; active-window/tab only; `safeQuery`/timeout plus `unstable_cache`; Decimal-safe money; House-POV colors; tsc/lint/build green.
- This does **not** loosen the MAIN read-only rule (§1).

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

- **Stack:** Next.js 15.5.22 (App Router, Turbopack), React 19.1, TS strict, Tailwind 4 + shadcn/ui (base-nova), PostgreSQL via Drizzle ORM (two isolated databases), Auth = JWT (`jose`) + TOTP 2FA (`otpauth`), Zod 4, `sonner` toasts, TanStack Table 8, Recharts, `@dnd-kit`, `cmdk`, `next-themes` (dark default), Playwright (e2e, already installed).
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
- Roles (`src/lib/admin-roles.ts`): `admin`, `support`, `marketing`, `creator`, `pack_creator`, `creator_manager`. `ROLE_PRIORITY` (admin wins), `getEffectiveRoles()` normalizes `role` + `roles`. Per-page access via `allowed_pages`. `pack_creator` is displayed as **Pack Builder**; a single-role holder may use Pack Studio plus only the normal `/packs`, `/cards`, and `/sets` Content routes. Middleware denies every other dashboard/webapp route, while multi-role staff keep the union of their assigned jobs. The canonical Pack Builder role has 19 page/capability tokens and no Upgrader or Shards access.
- Pack Builder inactive builds are ADMIN-only saved drafts (`pack_creation_requests.requested_active = false`) shown in **Saved Builds** at `/pack-studio/builder-drafts`; saving needs no owner approval, may omit artwork, and never touches MAIN. Pack Builders see only their own saved builds, while owners/admins see the shared workspace. Saved Builds lets an authorized builder or owner add or replace the draft image. A valid image is required server-side before direct live submission, draft promotion, and final owner approval. Only live requests appear in the owner-only **System → Approval Queue**, where approval revalidates and materializes the pack in MAIN. Approval/decline is one click with no extra 2FA; direct activation remains blocked for non-owner `pack_creator` users.
- Pack Builder production math is strict: house edge must be inside the inclusive **10.95%–11.50%** band, and the final persisted positive card weights must total exactly **1,000,000 integer ticket units (100.0000%)**. The builder clamps its configured curve into the edge band; submission preview, saved-build/approval UI, queued-request validation, the fresh owner-approval solve, and a second check over the exact rows entering the transaction all fail closed.
- Mutating actions must `createAdminAuditEvent()`. 2FA-gate sensitive mutations (balance, XP, withdrawals).
- **Login = password → second factor at `/verify-2fa`.** Second factor is EITHER a TOTP code (`otpauth`) OR a **passkey (WebAuthn, `@simplewebauthn` v13)** — passkeys are an additive ALTERNATIVE to TOTP, not a replacement. Passkeys live in the ADMIN DB table `admin_passkeys` (per-admin, FK cascade); enrollment is in the profile dialog's Security section (`src/app/(admin)/profile/passkeys-card.tsx` + `passkey-actions.ts`); login branch in `src/app/(auth)/verify-2fa/`. Server wrappers + RP config in `src/lib/webauthn.ts` (RP ID/origin derived from request host, overridable via `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN`). The WebAuthn challenge rides a 5-min signed cookie (`admin_webauthn_challenge`) via the existing `encryptGeneric`/`decryptGeneric` in `session.ts`. Counter + `last_used_at` give a replay guard; passkey login audits with `method:"passkey"`.
- **In-app passkey grace:** after an admin or owner verifies a passkey for a sensitive action, a signed HttpOnly `admin_passkey_grace` cookie suppresses further shared `StepUpField` prompts for 10 minutes. `require2FA` rechecks the active account's DB-fresh admin/owner status and binds the proof to that user on every use. Other roles keep one-action passkey proofs, TOTP remains single-use for everyone, and logout clears the grace cookie.
- **Staff password recovery is admin-driven:** `/admin-users/[id]` can set a new password after the acting admin completes a TOTP/passkey step-up. The write hashes with bcrypt cost 12, revokes all target sessions, protects owner accounts from non-main-owner resets, and audit-logs no password material. This flow needs no email provider; email is only needed for a future self-service reset-link flow.

- **Custom Antifraud point flows:** manager-only `/antifraud/flows` creates and edits ordered `rule_definitions` sequences; `/antifraud/events` is the authoritative live/planned event vocabulary. Enabled flows may contain only live events. The monitor evaluates every enabled flow after each accepted event, matches once per flow/session, applies its score plus manual-review/escalation outcome, sends the existing alert, and stores immutable match evidence shown on the monitor case. Planned events are documentation/draft-only until their source is connected.
- **Antifraud reward behavior:** live activity classifies the three-pack welcome reward, the level-0-unlocked Level 1 daily pack, level 10–100 daily packs, deposit bonus, rakeback, rain, races, creator leaderboards, challenges, paid packs, battles, upgrader bets, received creator tips, and received sponsored battles as distinct events. Welcome-reward gambling/Level 1 stacking and tip/sponsored-battle receipt before any deposit are dedicated behavior flows; a reward before deposit is not suspicious by itself.
- **High-risk signup review:** every signup assessment at 60 points or higher writes a dedicated marker into the existing durable signed risk-event stream and a separately retried Discord webhook outbox. The marker opens or updates the ADMIN-backed Account Review case even though 60 remains inside the general `medium` severity band. Account Review exposes Fine, Ban, and Lock withdrawals as capability-gated, audited quick actions with one confirmation dialog and no extra 2FA prompt.
- **Fiat-threshold withdrawal review:** the Antifraud monitor incrementally detects the automatic lifetime-deposit lock from `user_feature_locks` on the read-only MAIN mirror. It atomically advances a durable cursor while writing a high-severity `fiat_deposit_withdrawal_hold` risk event and a separate Discord outbox row. Signed risk-event delivery opens or updates the ADMIN-backed Account Review case; review surfaces label it “Fiat-triggered withdrawal hold.” The dedicated webhook retries independently and uses only the compiled standard support mentions.
- **Antifraud Discord alert contract:** score-60 signup alerts show account identity, score/severity, the trigger, up to four strongest scored signals, the case id, and a direct case-review link. Rule-match alerts use the same layout and add score delta plus outcome. Discord mention allowlisting stays restricted to the compiled support/urgent recipients.
- **Creator fraud means affiliate-cohort fraud:** the creator account is only the owner/grouping key for affiliate codes. Creator-fraud scoring evaluates referred accounts, their connected networks, signup patterns, deposit/wager economics, and shared-wallet/timing evidence. The creator account's own behavior and any self-referral rows are excluded.

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
  | Affiliate | **8 tiers, 3%→10%**, thresholds $0→$1.5M | `affiliate_level_configs`; the "1× wager req" is a modeled what-if, not a confirmed stored toggle. **Commission basis (RESOLVED, see `system-edge-plan/_model.ts`): `commission_rate` is a share of referred house edge / GGR, NOT a % of wager — wager drag = edge_share × house_edge (tier 8 = 10% of edge @ 10.5% edge → 1.05% of referred wager).** |
  | Deposit bonus | **5% of a deposit, but ONLY if the deposit lands inside a 30-MINUTE bonus window** (`user.affiliate_bonus_expires_at`, opened on code-apply / same-code re-apply / referral signup), then capped at **$20 per rolling 6h** (live `deposit_bonus_cap_per_period_usd` = 20; `deposit_bonus_period_hours` never written → backend default). Two filters stack: only ~37% of deposit volume is in-window, and the cap clamps that 5%→2.7% ⇒ **real cost ≈ 1% of all deposits** (14d to 2026-07-22: $590 bonus on $59,378 deposited) | rebuilt 2026-06-17, replacing the old match-100% / $100-24h regime. Window + rate are backend constants (`affiliate.service.ts`), NOT admin-editable; only the cap/period are, from /security. Staff + creators are excluded outright |
  | Races | `race_prize`, real ~$6,907.50 | on-site competitive races |
  | Raffles | reconstructed from raffle `prizes` JSON (no ledger type), ~$15.59 | tickets per $X wagered; distinct from races |
  | Daily packs | ~$9.27 (`getDailyPacksTotalCost`) | free daily packs; EV editable; 30-day XP-unlock %; wager-loss (under active rework) |
  | Signup | "avg $5.71" **CLARIFIED** = total signup-bonus cost amortized across EVERY signup (incl. the majority who never claim) — an efficiency metric, NOT the grant | the real cost is the cash `balance_reward_claim` per CLAIMANT (`signupAvgGrant`); bridge: `avgPerSignup = avgPerClaim × conversionPct`. The **3 welcome packs** (EV ~$0.01–0.02 each) are display-only context, not the signup cost. See `system-edge-plan/_model.ts` signup anchors |
  | Rain | net house slice = `max(0, rain_win − tips)`, ~$928.68 | system-automatic, mixed-funded (users + founder/motha) |
  | Motha giveaways | founder account: `creator_tip` + `battle_sponsorship` + motha `rain_tips` | named line, no double-count (these are residual/wager/rain-funding, not in canonical reward cost) |
- **Reward Costs box** (dashboard + system-edge-plan) is broken out **per-program** (rakeback, affiliate, deposit bonus, race, raffle, daily packs, signup, motha, rain) with an explicit sum = total (no double-count). Motha + raffle are **named lines only — no standalone display pages**.
- **Leaderboard cost attribution:** affiliate leaderboards = creator cost (100% Creators Costs); on-site competitive = races (`race_prize`); never put leaderboard prizes in on-site Reward Costs.
- **`/insights/system-edge-plan`** = the read-only planning tool to tune every edge + reward lever and see projected GGR/NGR/profit + delta + a "net edge by scenario" view (e.g. affiliate tier 8 → net edge X%). Levers are being reworked from opaque ×-multipliers into concrete, explained, real-data controls. Configs are saveable as named presets in **localStorage** (no prod-DB write).

### Direct personal-notification contract

- `/notifications?tab=direct` targets the backend environment returned by `resolveBackendApiConfig`; production and development are both supported when configured. Every composer displays that resolved target, and production sends require explicit confirmation.
- Reward campaigns create deterministic, single-use, account-bound `promo_codes` through the explicit MAIN mutation client. The action fails closed unless the notification backend and writable game database resolve to the same environment; retrying reuses the same codes and notification dedupe keys.

### Fiat operations contract

- `/fiat` reads card intents, recorded provider fees, and webhook processing from the MAIN mirror. Provider-paid, provider-net, credited-balance, and fee totals are independently recorded fields; differences are investigation signals and must not be labelled automatically as profit or loss.
- Fiat configuration writes remain backend-owned. The dashboard does not write MAIN fiat/payment relations directly.

### Keno engine contract

- Backend source of truth is `backend/src/utils/keno.ts`: 40 positions (`0–39` internally), 10 distinct draws, 1–10 player picks, Low/Medium/High compile-time payout curves, and a fixed $0.25 minimum bet. The live maximum bet is `keno_max_bet_usd` (default $20, allowed up to $1,000), exposed through `GET/PUT /v1/admin/keno-config` and applied immediately to new games.
- Content → Keno → Configuration is the sole admin editor for the live maximum bet plus the three active database-backed Keno weights: withdrawal requirement (`wager_weight_keno_bps`), leaderboard (`leaderboard_wager_weight_keno_bps`), and rakeback (`rakeback_wager_weight_keno_bps`). The legacy `shard_wager_weight_keno_bps` key is intentionally not editable because Shards are retired site-wide.
- The dashboard Keno KPI and `/keno` operations overview are settled-performance views over `keno_games`, scoped to real customers (staff, creators, and the admin blacklist excluded). They report wager, player payouts, profit (`wager - payouts`), and realized edge (`profit / wager`); they are not the configured mathematical edge shown on Odds & Chances.
- Exact hit probability is hypergeometric: `C(picks,hits) × C(40-picks,10-hits) / C(40,10)`. Configured RTP is `Σ(probability × multiplier)` and house edge is `1 − RTP`; all 30 clean payout rows land near 92.5% RTP / 7.5% edge.
- `GET /v1/keno/multipliers` returns the backend table only in development/test. The backend deliberately registers no Keno routes in production, so `/keno?tab=odds` uses the tested compile-time mirror in `src/lib/keno/payouts.ts`. Settled `keno_games` rows are evidence/drift detection only, never the source for unobserved configured multipliers.
- Any backend payout edit must update the admin mirror and `scripts/__fixtures__/keno-payouts.test.ts` in the same release. The test locks 30 complete rows, anchor multipliers, probability normalization, and the reference RTP band.

---

## 7. ⚠️ GOTCHAS / HARD-WON LESSONS (incident log)

- **React #130 (prod-down):** a nav `icon` string not in the `ICONS` map → `<undefined/>` → admin shell crash. Always register new nav icons; `?? ScrollText` fallback added.
- **Smoke gap:** logged-out HTTP smoke (`/`→307, `/login`→200) CANNOT catch authenticated-shell render errors. Real verification needs an authed render.
- **Headless auth (the real verification path):** mint an `admin_session` JWT signed with `SESSION_SECRET` (matching `src/lib/session.ts`), reading one active admin from the ADMIN DB read-only, inject via Playwright `context.addCookies()` → renders any page past 2FA. Playwright + Chromium are already installed; an `e2e/` harness exists.
- **Responsive audit must RENDER, not read classes:** two prior class-reading audits missed a glaring `/users/[id]` break. The detector measures real `scrollWidth`/bounding-box/sibling-overlap at the viewport matrix (320→1536).
- **Verify agents can false-negative** (stale tree): always have the verify agent `git fetch + checkout the exact commit` first, and cross-check "not found" verdicts against `git show <sha>`.
- **Worktrees:** use `npm install` (NOT `npm ci` — committed lockfile mismatch `@emnapi/wasi-threads`); copy `.env` from main checkout; do NOT junction `node_modules`; cleanup is junction-safe (check `LinkType` before recurse). `git commit --only <paths>` (never `git add -A`) and leave `package-lock.json`, `recent-pushes.json`, `audit-artifacts/` uncommitted.
- **Stale `.next`:** `.next/types/validator.ts` references deleted page routes → tsc fails; clear `.next` before re-running the gate.
- **Admin schema gotcha:** use only reviewed SQL via `npm run admin:sql -- <file>`, then `npm run db:pull:admin`. Schema-push tools can drop catalog drift and are not part of the workflow.
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
| Schemas | `src/lib/db-schema/main/schema.ts` (MAIN) · `src/lib/db-schema/admin/schema.ts` (ADMIN) |
| Query modules | `src/lib/queries/**` |
| Period system | `src/lib/queries/dashboard-period.ts` |
| Edge planner | `src/app/(admin)/insights/system-edge-plan/*` |
| e2e / responsive harness | `e2e/*` (Playwright) |

**Scripts:** `npm run dev` · `npm run build` · `npm run lint` · `npm run admin:seed` · `npm run db:pull:main` · `npm run db:pull:admin` · `npm run admin:sql -- <file>`.
**Env:** `DATABASE_URL` (MAIN) · `ADMIN_DATABASE_URL` (ADMIN) · `SESSION_SECRET` · `DEV_DATABASE_URL` · `ADMIN_SEED_PASSWORD`.

---

## 9. 📌 Live session state (not stored here)

**Current shipped / in-flight / blocked work lives in `AGENT_HANDOFF.md`** — update that file every task, not this one.

This file is for **durable** facts only (architecture, domain math, schema, gotchas). When a handoff gotcha becomes permanent, promote it to §7 here and trim it from the handoff.

---
*Living document — update when rules, schema, or domain facts change. Follow `SESSION_MEMORY.md` for read/write protocol.*
