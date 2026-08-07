# ONBOARDING.md — architecture & domain knowledge

> **Durable facts only** — what the code and git history don't tell you: domain math, money model,
> non-obvious contracts. Rules live in `CLAUDE.md`; repository layout lives in `ARCHITECTURE.md`.
>
> **Read on demand, not on session start.** Open the section you need.

| Also available (read-on-demand) | |
|---|---|
| Repository layout and dependency boundaries | `ARCHITECTURE.md` |
| Query / caching / streaming mechanics | `docs/BACKEND_QUERY_SYSTEM.md` |
| Fraud, Fiat, KYC, Discord, Whop contracts | `docs/ANTIFRAUD_CONTRACTS.md` |

---

## 0. What this is

**pokewin-admin** is the internal staff admin dashboard for **Packy.GG** — a pack-opening / battles /
upgrader gambling-style game. It is back-office (admin, support, marketing, creator, pack_creator),
not the player-facing site. `main` = Vercel **production** (`pokewin-admin.vercel.app`); every push to
`main` deploys. Other branches are previews.

---

## 1. The two databases

| | ADMIN DB | MAIN / prod game DB |
|---|---|---|
| Client | `adminDrizzle` (`src/lib/admin-db.ts`) | resolver in `src/lib/db.ts` |
| Schema snapshot | `src/lib/db-schema/admin/schema.ts` | `src/lib/db-schema/main/schema.ts` |
| Env | `ADMIN_DATABASE_URL` | `DATABASE_URL` (+ `DEV_DATABASE_URL`) |
| Access | full — the agent applies migrations itself | **read-only, always** |

- **Admin holds only admin-panel data**: `admin_users`, `admin_sessions`, `admin_audit_events`,
  `admin_notes`, gift-card/voucher actions, `admin_balance_limits`, `creator_deals`,
  `creator_webhooks`, expenses, salaries, Balance-2.0 exclusions, Whop refund batches/items.
- **MAIN holds the live game**: users, balances, ledger, packs, cards, battles, inventory, rewards,
  affiliate, deposits/withdrawals, promo/gift/vouchers, rain/raffles/races. Real users, real money.
- **`gift_cards` and `vouchers` live in MAIN**, not admin — bulk-deleting them would be a MAIN write.
- **No cross-DB joins.** Query each separately and merge in code.
- **Mirror routing (2026-07-27):** ordinary MAIN reads go through `MIRROR_PRODUCTION_DB` /
  `MIRROR_DEV_DB`; those pools force `default_transaction_read_only` and fail closed rather than
  falling back to the primary. Mutation workflows use `DATABASE_URL` / `DEV_DATABASE_URL` explicitly.
  Concurrent index DDL on the *mirrors* is allowed via `npm run db:index:mirrors -- <prod|dev|all>`.
- **Mirror capacity (do not widen blindly):** the prod mirror role `fraud_app` has a 30-session limit
  shared by the dashboard and the Antifraud reader. Dashboard pools allow 2 concurrent reads per warm
  serverless instance, 100 checkouts per connection, 1s client idle cleanup, with the server's 5s
  `idle_session_timeout` as the authoritative backstop when Vercel freezes an isolate. The shared read
  boundary retries exactly one confirmed transient failure (incl. SQLSTATE `57P05`); SQL, schema, and
  permission failures stay fail-closed. Primary mutation pool stays capped at 3. Raising the mirror
  pool above 2 requires more role capacity or a transaction pooler first.
- **Drizzle schemas are catalog snapshots.** After an approved ADMIN migration, re-introspect
  (`npm run db:pull:admin`) and review the generated diff before committing it.
- **Protected operator audit visibility:** audit activity by `hifoen` is retained normally but is
  displayed only to DB-fresh owners/superowners, via `src/lib/audit-visibility.ts`. Operational state
  derived from audit events is unaffected.

---

## 2. Architecture

- **Stack:** Next.js 15.5 (App Router, Turbopack), React 19.1, TS strict, Tailwind 4 + shadcn/ui
  (base-nova), PostgreSQL via Drizzle (two isolated DBs), JWT (`jose`) + TOTP 2FA (`otpauth`), Zod 4,
  `sonner`, TanStack Table 8, Recharts, `@dnd-kit`, `cmdk`, `next-themes` (dark default).
- **Server Components first:** pages are `async` Server Components, interactivity in `"use client"`
  islands, mutations via Server Actions + `revalidatePath`. No SWR / React Query.
- **Routing:** ~85 routes under `src/app/(admin)/` plus `(auth)`, `(creator-hub)`, and the Fraud
  webapp; sub-apps are segmented by host (see `src/middleware.ts`).
- **Shell:** `src/app/(admin)/layout.tsx` — `SidebarProvider` + `AppSidebar` (Sheet drawer on mobile)
  + `SidebarInset` + sticky `AdminHeader` + `TopProgressBar` + right-rail docks.
- **Nav is single-source in `src/lib/nav-config.ts`.** Icon strings must be registered in the `ICONS`
  map in `app-sidebar.tsx` — an unregistered icon renders `<undefined/>` and crashes the whole shell
  (React #130). A `?? ScrollText` fallback now guards it, but register the icon anyway.

---

## 3. Auth & permissions

- **Use the DAL only** (`src/lib/dal.ts`): `verifySession()`, `requireAdmin()`, `requireRole(roles)`,
  `requirePageAccess(pageKey)`. They `redirect()` on failure — never reimplement them.
  `src/middleware.ts` enforces the flow (decrypts the `admin_session` JWT, checks expiry).
- **Roles** (`src/lib/admin-roles.ts`): `admin`, `support`, `marketing`, `creator`, `pack_creator`,
  `creator_manager`. `ROLE_PRIORITY` (admin wins); `getEffectiveRoles()` normalizes `role` + `roles`;
  per-page access via `allowed_pages`.
- **`pack_creator` displays as "Pack Builder"** — 19 page/capability tokens, Pack Studio plus only
  `/packs`, `/cards`, `/sets`. No Upgrader, no Shards. Middleware denies everything else; multi-role
  staff keep the union of their jobs.
- **Login:** either a direct discoverable passkey (device user verification required, no password and
  no `/verify-2fa` step) or password → second factor (TOTP / recovery / passkey). Passkeys live in
  ADMIN `admin_passkeys`; RP/origin checks in `src/lib/webauthn.ts`; the signed 5-minute challenge
  cookie is `admin_webauthn_challenge`. Older non-discoverable credentials must be re-added to work
  with direct login.
- **Passkey grace:** after an admin/owner verifies a passkey for a sensitive action, the signed
  HttpOnly `admin_passkey_grace` cookie suppresses further `StepUpField` prompts for 10 minutes.
  `require2FA` rechecks DB-fresh admin/owner status and binds the proof to that user each use. Other
  roles get one-action proofs; TOTP is always single-use; logout clears the grace cookie.
- **Staff password recovery is admin-driven** from `/admin-users/[id]` after the acting admin's
  step-up: bcrypt cost 12, revokes all target sessions, owners protected from non-main-owner resets,
  no password material in audit. No email provider needed.
- **Every mutating action calls `createAdminAuditEvent()`.** 2FA-gate sensitive mutations (balance,
  XP, withdrawals).

### Pack Builder rules

- Inactive builds are ADMIN-only saved drafts (`pack_creation_requests.requested_active = false`) at
  `/pack-studio/builder-drafts`. Saving needs no approval, may omit artwork, never touches MAIN.
- **The exact displayed ticket weights, colors, and animations are the saved contract.** Drafts carry
  an optimistic `revision` guard, browser-local recovery, and durable `pack_build_draft_revisions`
  snapshots that restore forward as a new revision.
- Builders see only their own drafts; owners/admins see the shared workspace. A valid image is
  required server-side before direct live submission, draft promotion, and final approval. Only live
  requests reach the owner-only System → Approval Queue, where approval revalidates and materializes
  the pack in MAIN (one click, no extra 2FA; direct activation stays blocked for non-owner
  `pack_creator` users).
- **Production math is strict:** house edge inside the inclusive **10.95%–11.50%** band, every card
  unique with positive odds, max win under the configured cap, and final persisted weights totalling
  exactly **1,000,000 integer tickets (100.0000%)**. Auto mode additionally requires a feasible solver
  result; manual mode validates the displayed pool directly without the solver. Submission preview,
  saved-build/approval UI, queued-request validation, the fresh owner approval, and a second check
  over the exact rows entering the transaction all fail closed.
- Full `/packs/[id]` edits use the same 1M-ticket invariant: validate the complete replacement pool
  before deleting rows, reject stale `updated_at` under `FOR UPDATE`, snapshot the locked before-state
  only after the MAIN transaction commits.

---

## 4. Money & rewards (the domain math)

- **The ledger is the source of truth.** Every balance change goes through `ledger_transactions`
  (immutable, `balance_before` / `balance_after`). Never `balances.update()` without a ledger row.
  Multi-step = one transaction. Money is `Decimal(20,2)` — use Decimal utils, never JS float math.
- **Voucher = Card**, same item. `battle_excess_to_voucher` + `battle_refund` are two legs of one
  normal battle win → merge into "Pack & battle wins", never separate cost lines. Exchanging or
  redeeming a voucher/card is neutral (value was booked at creation) — never a house loss.
- **Canonical customer scope:** `getMetricsScope()` (`src/lib/metrics/scope.ts`), where
  `CUSTOMER_EXCLUDED_ROLES = ['admin','support','creator']` plus the `excluded_users` blacklist. Use
  it for GGR/NGR/PnL/wager. The legacy `EXCL_STAFF_FRAG` keeps creators in — not canonical.
- **P&L** (per-user and global):
  `pnl = deposits − withdrawals − onSiteBalance − inventoryValue − unclaimedVouchers`.
  The `official_stream` adjustment category is FAKE balance — exclude it everywhere, including
  onSiteBalance and PnL.
- **Edge / GGR:** GGR = house edge × wager. Canonical per-type wager (real, recent window): packs
  ~82.2M + battles ~5.5M, GGR ~3.08M. Planned default house edge: Packs & Battles **10.99%**,
  Upgrader **10%**.

### Reward programs and their real cost

| Program | Real config / cost | Notes |
|---|---|---|
| Rakeback | daily 0.25% / weekly 0.1% / monthly 0.05% (0.40% blended) | `rakeback_config` |
| Affiliate | 8 tiers, 3%→10%, thresholds $0→$1.5M | `commission_rate` is a share of referred **house edge / GGR**, not of wager. Tier 8 = 10% of edge @ 10.5% edge → 1.05% of referred wager. |
| Deposit bonus | 5% of a deposit, **only inside a 30-minute window** (`user.affiliate_bonus_expires_at`), then capped **$20 per rolling 6h** | Two filters stack: only ~37% of deposit volume is in-window, and the cap clamps 5%→2.7% ⇒ **real cost ≈ 1% of all deposits**. Window + rate are backend constants, not admin-editable; only cap/period are (from `/security`). Staff + creators excluded. |
| Races | `race_prize`, ~$6,907.50 | on-site competitive races |
| Raffles | reconstructed from raffle `prizes` JSON (no ledger type), ~$15.59 | tickets per $X wagered; distinct from races |
| Daily packs | ~$9.27 (`getDailyPacksTotalCost`) | free daily packs; EV editable; 30-day XP-unlock % |
| Signup | "avg $5.71" = total signup-bonus cost amortized across **every** signup incl. non-claimers — an efficiency metric, **not the grant** | the real cost is the cash `balance_reward_claim` per claimant (`signupAvgGrant`); `avgPerSignup = avgPerClaim × conversionPct`. The 3 welcome packs (EV ~$0.01–0.02) are display-only context. |
| Rain | net house slice = `max(0, rain_win − tips)`, ~$928.68 | system-automatic, mixed-funded |
| Motha giveaways | founder account: `creator_tip` + `battle_sponsorship` + motha `rain_tips` | named line only, not in canonical reward cost — no double-count |

- The dashboard **Reward Costs** box breaks out every program with an explicit sum = total. Motha and
  raffle are named lines only, with no standalone pages.
- **Leaderboard cost attribution:** affiliate leaderboards are 100% creator cost; on-site competitive
  boards are races (`race_prize`). Never put leaderboard prizes in on-site Reward Costs.

### Fiat refund accounting (financial reporting)

- Every deposit total and derived P&L in dashboard, analytics, creator, user, and export reporting is
  **net of finalized Fiat credit reversals**. The immutable deposit ledger is the gross credit source;
  `fiat_deposit_intents` is the authoritative refund lifecycle.
- Full refund reverses the full credited amount. A partial refund uses an explicit reversed-credit
  amount when present; otherwise it converts the provider refund proportionally against the original
  customer total, so adaptive-pricing currencies are not mistaken for USD.
- Windowed reports recognize the reversal at the intent's refund update time; lifetime and
  transaction-linked reports subtract it from the original credited total. Completed-deposit counts
  and immutable transaction history stay gross event records.
- **All reporting SQL must use `src/lib/queries/fiat-refund-credits.ts`** — never reimplement
  partial-refund metadata parsing per surface.

### Deposit accounting

Once a fiat intent is completed and credited, its linked completed `ledger_transactions.type =
'deposit'` row is the same authoritative source used for crypto deposits across Dashboard and
Analytics. Deposit aggregates must **not** require `crypto_asset IS NOT NULL`. Provider-paid events
without a credited ledger row stay out of financial totals until reconciliation completes.

### Direct personal notifications

- `/notifications?tab=direct` targets the backend environment returned by `resolveBackendApiConfig`;
  the composer always displays the resolved target and production sends require confirmation.
- Reward campaigns create deterministic, single-use, account-bound `promo_codes` through the explicit
  MAIN mutation client. The action fails closed unless the notification backend and the writable game
  DB resolve to the same environment; retrying reuses the same codes and dedupe keys.
- Broadcast read analytics are exact via `announcement_reads`. Direct notifications are attributable
  through the indexed `(user_id, dedupe_key)` pair; older bulk sends without them are untrackable.
  A read marker is not proof of an impression, view duration, or CTA click.

### Fiat controls (backend-owned)

- `/fiat` reads card intents, recorded provider fees, and webhook processing from the MAIN mirror.
  Provider-paid, provider-net, credited-balance, and fee totals are **independently recorded fields** —
  differences are investigation signals, never automatically labelled profit or loss.
- Per-user Fiat deposit access: GET/PUT `https://packy.gg/v1/admin/users/:userId/fiat-deposit-access`.
  Controls require explicit confirmation and treat only the exact
  `{ success: true, data: { user_id, enabled } }` response *for the requested account* as success.
- Backend reward locks: GET `/v1/admin/users/:userId/feature-locks`, PUT `…/rewards-lock`. Six
  independent categories — `tips`, `rain`, `daily_packs`, `sponsored_battles`, `rakeback`,
  `leaderboards` (races share the `leaderboards` lock). A whole-rewards lock = all six selected.
- **Automatic Fiat credit has two deliberately separate controls.** The manager-only global one lives
  at Fraud System → Config (`/antifraud/config`), GET/PUT `/v1/admin/fiat-deposits/config` field
  `fiat_deposit_automatic_credit_enabled`. The per-user Account one is PUT
  `/v1/admin/users/:userId/fiat-deposit-auto-approval` field `fiat_deposit_auto_approval_enabled`.
  A **true** per-user value overrides a **false** global value; users without an override need admin
  approval while the global value is false. Fraud, KYC, payment-binding, dispute/refund, amount,
  country, and compliance checks stay independent of both.
- Fraud System → Config also owns the separate site-wide Fiat availability switch. It updates the
  existing `locked_deposits_fiat` policy for card and wallet methods and refreshes the backend
  site-config cache. Enabling it never bypasses narrower account, country, KYC, payment, or fraud
  restrictions.
- The retired Fiat screening workspace, monitor routes/services, access batches, and eligibility
  grant gate must stay absent. Historical migrations 048/050/051 and stored Antifraud evidence
  remain untouched for audit history; they are not active runtime contracts.

### Keno engine

- Backend truth is `backend/src/utils/keno.ts`: 40 positions, 10 draws, 1–10 picks, Low/Medium/High
  compile-time payout curves, fixed $0.25 minimum bet. Live max bet (`keno_max_bet_usd`, default $20,
  up to $1,000) and max payout (`keno_max_win_usd`, default $20,000) come from
  `GET/PUT /v1/admin/keno-config` and apply immediately to new games.
- Analytics → Games → Keno → Configuration edits **only** the live maximum bet and maximum win.
  **Security is the sole editor** for the three active DB-backed Keno weights: withdrawal requirement
  (`wager_weight_keno_bps`), leaderboard (`leaderboard_wager_weight_keno_bps`), and rakeback
  (`rakeback_wager_weight_keno_bps`). The legacy `shard_wager_weight_keno_bps` is deliberately not
  editable — Shards are retired site-wide.
- Exact hit probability is hypergeometric:
  `C(picks,hits) × C(40-picks,10-hits) / C(40,10)`. Uncapped RTP = `Σ(probability × multiplier)`,
  edge = `1 − RTP`; all 30 clean payout rows land near 92.5% RTP / 7.5% edge. Effective payout is
  `min(bet × multiplier, max_win_usd)`, so effective RTP and edge become **bet-dependent** whenever
  the win cap binds.
- The dashboard Keno KPI and the Keno overview are **settled-performance** views over `keno_games`
  scoped to real customers — wager, payouts, profit (`wager − payouts`), realized edge. That is not
  the configured mathematical edge shown on Odds & Chances.
- The backend registers no Keno routes in production, so `/keno?tab=odds` uses the tested compile-time
  mirror in `src/lib/keno/payouts.ts`. Any backend payout edit must update that mirror and
  `scripts/__fixtures__/keno-payouts.test.ts` in the same release.

---

## 5. UI conventions beyond CLAUDE.md

`CLAUDE.md` carries the binding UI rules (house stack, modern-page pattern, House-POV colors). These
are the additional durable details:

- **Responsive:** mobile-first, standard Tailwind breakpoints. Grid ladder
  `grid-cols-1 sm:grid-cols-2 lg:grid-cols-N` — never a fixed `grid-cols-N` at base. `min-w-0` on
  every flex text column. **No `shrink-0` on grids that must wrap** (this broke the `/users/[id]`
  hero). Breakpoint-qualify negative margins. Tables collapse to mobile card-lists
  (`lg:hidden` ↔ `hidden lg:block`) or `overflow-x-auto`. Dialogs are bottom-sheets on mobile with
  safe-area insets.
- **Smoothness primitives** (`@/components/ux`): `motion.ts` (DURATION/EASING tokens, motion-safe
  `transition()` / `enter()` / `pressable()`, cubic-bezier(0.16,1,0.3,1)), `TopProgressBar`,
  `AnimatedNumber`, dimension-matched skeletons (`SkeletonTable` / `KpiStrip` / `Chart`), CLS wrappers
  (`StableCard` / `StableTable` / `PageReadyBoundary`), pending primitives (`RouteTransitionShell`,
  `LinkPending`, `Spinner`). The gold-standard non-blocking switch is
  `dashboard-period-selector.tsx` — `useTransition` + `router.replace(scroll:false)` + dim +
  in-chip spinner.

---

## 6. Key files

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
| UX / motion primitives | `src/components/ux/*` |
| Nav (single source) | `src/lib/nav-config.ts` + `app-sidebar.tsx` ICONS |
| Admin shell | `src/app/(admin)/layout.tsx` |
| Schemas | `src/lib/db-schema/{main,admin}/schema.ts` |
| Query modules | `src/lib/queries/**` |
| Period system | `src/lib/queries/dashboard-period.ts` |
| Fiat refund credits | `src/lib/queries/fiat-refund-credits.ts` |

**Scripts:** `npm run dev` · `build` · `lint` · `admin:seed` · `db:pull:main` · `db:pull:admin` ·
`admin:sql -- <file>` · `db:index:mirrors -- <prod|dev|all>`.

**Env:** `DATABASE_URL` · `ADMIN_DATABASE_URL` · `SESSION_SECRET` · `DEV_DATABASE_URL` ·
`MIRROR_PRODUCTION_DB` · `MIRROR_DEV_DB` · `ADMIN_SEED_PASSWORD`.
