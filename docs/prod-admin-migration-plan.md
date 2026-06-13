# Prod admin — sweepstakes migration plan (plan only, no prod execution)

Date: 2026-06-13. Scope: how to bring the **production** admin dashboard to the same state as dev for
the sweepstakes model. This is a written plan; nothing here is executed against prod.

## TL;DR — the gap is the BACKEND API, not the game DB

The new "sweepstakes admin" code is **already merged to `main`** and ships to production with every
deploy (the admin is one Next.js app; there is no separate dev codebase — dev vs prod is the
`admin_db_env` cookie toggle). Direct read-only probing confirms the **prod game DB already carries
the full sweepstakes schema** (tables, `balances` columns, ledger enum members) — identical to dev.

So there is **no game-DB migration to perform** for the admin (and the admin must never write the game
DB regardless). What makes dev "have more configs / be more connected" is the **backend admin API**:
the `/security` cards and the per-user wager-requirement config read from `src/lib/backend-api/*`
(HTTP), env-resolved by the cookie via `resolveBackendApiConfig`. On dev the dev backend exposes those
endpoints; on prod they light up only once the **prod backend** exposes them and the prod admin
deployment is wired with the prod backend URL/key.

## 1. Change map (dev admin change → prod)

All admin **code** is already on `main`, so "applying to prod" = merging this branch + deploying.
Per surface:

| Surface | Code state | Prod activation depends on |
|---|---|---|
| `/security` 8 cards (wager-req defaults, 5 weight types, reward-expiry, crypto-fees) | shipped | prod backend exposing `/admin/wager-requirement/default`, `/admin/*-wager-weights`, `/admin/reward-expiry`, `/admin/crypto-fees` |
| `/challenges` CRUD | shipped | prod backend `/admin/challenges*` endpoints |
| `/rewards` (shards, rakeback, …) | shipped | prod backend reward endpoints where used |
| `/users/[id]` per-user wager override card | shipped | prod backend `/admin/users/:id/wager-requirement` |
| `/users/[id]` **wager-progress panel (this branch)** | this PR | nothing extra — reads prod `balances` columns (present) + the same backend bps endpoints |

## 2. Ordering & prerequisites

1. **Prod backend first.** Deploy/confirm the prod backend exposes the sweepstakes admin endpoints
   (the same routes the dev backend serves). Until then the `/security` cards degrade to their muted
   "awaiting backend deploy" state (try/catch→null) — safe, not a crash.
2. **Wire the prod admin's backend config.** Set `BACKEND_API_URL_PROD` (or `BACKEND_API_URL`) +
   `BACKEND_ADMIN_KEY_PROD` (or `BACKEND_API_KEY`) on the prod admin (Vercel project
   `packy-admin-dashboard`). If the backend is behind Cloudflare Access, set `CF_ACCESS_CLIENT_ID` /
   `CF_ACCESS_CLIENT_SECRET`. (Note `resolveEffectiveEnv` falls back to the other env's backend if one
   is unset — avoid relying on that in prod.)
3. **Merge + deploy this branch.** `productionBranch: main` → pushing `main` auto-deploys prod.

## 3. Schema / data migrations

None for the admin. The prod game DB already has the sweepstakes schema (verified). The admin is
read-only on the game DB. The two columns still missing from `prisma/schema.prisma`
(`rakeback_claims.wagered_amount_usd`, `rakeback_config.expiration_days`) are read via raw SQL where
needed, so no prisma migration is required; add them to the schema only if a future prisma-typed read
needs them.

## 4. Feature flags / config differences (dev vs prod)

- DB target: `admin_db_env` cookie (admin-only toggle); prod is the default. `DEV_DATABASE_URL` enables
  the dev option locally/in preview.
- Backend: `BACKEND_API_URL[_DEV|_PROD]` + `BACKEND_ADMIN_KEY[_DEV|_PROD]` resolve per env.
- No code-level feature flag gates the sweepstakes UI; it is governed by backend reachability (cards
  self-degrade) + game-DB column presence (panels self-mute).

## 5. Prod verification (after activation)

- `/security`: all 8 cards render live values (not the muted state).
- `/users/[id]` Account tab: the override card shows the effective multiplier; the **wager-progress
  panel** shows requirement/completed/remaining + per-source breakdown for the 3 trace shapes
  (not-met / met / reward-sourced), numbers matching the prod `balances` columns.
- `/challenges`, `/rewards/*`: list + config load without the muted/awaiting state.
- Confirm no page 500s with the prod DB selected (game schema present → no 42703/42P01/22P02).

## 6. Rollback

- The admin changes are display/config only and read-only on the game DB, so rollback = revert the
  merge + redeploy; no data migration to undo.
- Backend endpoint issues: unset/point-away the prod backend config → cards return to the muted state
  (no crash). Per-user override/config writes go through the backend's own audited endpoints; rolling
  those back is a backend concern, not an admin-DB one.

## 7. Risk notes (money / wager / compliance — needs human sign-off)

- The wager-progress panel's `required`/`remaining` are **derived** in the admin from backend-written
  inputs. Before treating them as authoritative for any operational/withdrawal decision, reconcile the
  `required` formula (5-bucket × bps, override semantics) against the backend's exact gating rule.
- Withdrawal gating itself is enforced by the backend, not the admin — the admin only displays it. No
  admin change weakens a gate.
- Never point the admin's game-DB connection at anything writable; all game-DB access stays read-only.

---

## 8. Requested follow-up feature (planned, NOT built) — "Adjustments" box under Tips & Rain

Requested 2026-06-13. Add a dedicated **Adjustments** box to the user-detail **Overview tab**, directly
under the existing **Tips & Rain** section, listing every admin balance adjustment for that user with
its **category tag**.

**Where:** `src/app/(admin)/users/[id]/user-view-modern-tabs.tsx` — insert a
`<SectionHeading icon={…} title="Adjustments" />` + the new box between the `Tips & Rain` section
(line ~244-245) and `Recent Activity` (line ~250).

**Data — reuse what's already fetched (no new query):** the Overview tab already kicks
`adjustmentsTxPromise` (the user's `admin_balance_adjustment` ledger rows, fetched in `page.tsx` and
streamed into `RecentActivityStreamed`). The new box `use()`s that same promise. Each row already
carries its category/reason (Reload / Bonus / Giveaway / `official_stream` / etc.) and the admin who
made it — render that as a **tag/badge** next to each amount.

**Rules to respect:**
- **Owner-gated:** admin balance adjustments are visible only to the owner (`motha`) — the box must
  honor the existing `viewerIsAdjustmentOwner` gate (the server already returns zero adjustment rows
  for non-owners, so the box self-hides). Do not surface them to other admins.
- **House-POV colors:** a credit to the user (user gains) → rose; a debit (user loses) → emerald;
  signs from the house perspective, same rule as the rest of the site.
- **Exclude FAKE balance:** `official_stream` adjustments are fake balance — keep them tagged but do
  not let them distort any total (consistent with the existing exclusion).
- Reuse the existing adjustment-row formatting from `user-tabs-transactions.tsx` /
  `RecentActivityStreamed` rather than re-implementing the category labels.

**Why it's useful:** today these adjustments are only visible buried in the unified Recent-Activity
timeline; a dedicated tagged box surfaces "what did admins credit/debit this user, and why" at a
glance. Buildable read-only against the already-fetched data; no game-DB write, no backend change.

