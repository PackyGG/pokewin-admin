# Sweepstakes admin — verification record

Date: 2026-06-13 · Branch: `feat/dev-admin-sweepstakes-review`

This records what was actually verified for the sweepstakes admin work. "Verified" here
means observed against a real database / a real rendered response, not just "code written".

## 1. dev↔prod schema parity (read-only probe of BOTH game DBs)

Probed `DEV_DATABASE_URL` and the live `DATABASE_URL` (prod) directly, SELECT-only. **The full
sweepstakes schema exists in BOTH dev and prod** — correcting an earlier discovery agent's
"dev-only" matrix, which was wrong.

| Object | dev | prod |
|---|---|---|
| Tables `challenges`, `challenge_claims`, `challenge_requirements`, `coin_transactions`, `creator_tip_tracking`, `user_wager_requirements` | ✓ | ✓ |
| `balances` cols `shards`, `coin_*`, `wager_requirement_progress`, `total_bonus_won`, `total_affiliate_won`, `total_rakeback_won`, `total_tips_won`, `shard_wager_progress`, `unwagered_*_usd` | ✓ | ✓ |
| `rakeback_claims.wagered_amount_usd`, `rakeback_config.expiration_days` | ✓ | ✓ |
| `ledger_transaction_type` members `challenge_prize`, `xp_purchase` | ✓ | ✓ |

Consequence: the prod-absence "everything must be env-guarded or it crashes" premise is **moot** —
the game DBs are at parity. The real dev↔prod gap is the **backend API** (see prod-migration plan),
not the game schema. (`rakeback_claims.wagered_amount_usd` + `rakeback_config.expiration_days` are
still missing from `prisma/schema.prisma` — a typed-model drift, harmless for raw-SQL reads.)

## 2. Wager-progress panel (Part A) — build + render verification

- `npx tsc --noEmit` ✓ · `npm run lint` (0 new warnings; my files clean) ✓ · `npm run build` exit 0 ✓
- Rendered the Account tab against the **dev DB** with a real authed `admin_session` (minted from an
  active admin in the ADMIN DB, read-only) + `admin_db_env=dev`, via the local dev server. HTTP 200,
  no crash, the Suspense-streamed card resolved with real data.

### Trace cases (brief's acceptance criteria)

| Case | User | Rendered result | ✓ |
|---|---|---|---|
| **Not met** (below requirement) | `dobTQ…` | Deposits $547.57 → Requirement $547.57, Completed $0.00, Remaining $547.57 (0% bar) | ✓ |
| **Met / over** | `6bwK…` | Completed **$17,691,856.20** ≫ Requirement $51,238.69 → Remaining $0.00 | ✓ |
| **Reward-sourced** | `6bwK…` | Per-source: Bonus $44,223.03 + Rakeback $46.66 + Tips $6,969.00, each ×1, contributions summing to the $51,238.69 total | ✓ |

The per-source contributions sum **exactly** to the requirement total (auditable math). `completed`
and the five lifetime totals are read straight from the backend-written `balances` columns; the
backend bps (1× per bucket; game weight upgrader 0.8×) were applied via the backend admin API.

### Env-guard (prod-absence safety)

The `information_schema` column probe was exercised against both DBs: present → panel renders;
absent → returns `null` → muted card (no `42703` throw). Both game DBs currently have the columns, so
the panel renders on either; the guard remains as drift protection.

## 3. Honest verification gaps

- **Backend reachability is cross-env locally.** Only the PROD backend (`BACKEND_API_URL`/
  `BACKEND_API_KEY`) is configured locally; there is no `BACKEND_API_URL_DEV`. So when the dev DB is
  selected, `resolveEffectiveEnv` falls back to the **prod** backend for the bps config. The render
  above therefore mixed dev game data with prod-backend bps. The backend-truth figures (completed,
  lifetime totals, locked) are unaffected (they come from the dev DB); the derived `required`/
  `remaining` used prod-backend bps. In a real dev deployment with `BACKEND_API_URL_DEV` set this
  resolves to the dev backend.
- **`required` math vs backend rule.** The single per-user override → 5-bucket interaction (0 = exempt
  all; non-zero scales deposit only) is encoded per the backend doc but should be reconciled against
  the live backend rule; the card labels `required`/`remaining` as estimates and leads with the
  backend-truth `completed`.
- Verification was via a minted-session SSR fetch, not a human point-and-click through the live admin.
  A logged-in click-through on the deployed preview is recommended as a final confirmation.
