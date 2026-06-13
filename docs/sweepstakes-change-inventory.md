# Sweepstakes admin — change inventory

Date: 2026-06-13. A code-grounded enumeration of the sweepstakes-model admin surfaces. The vast
majority is **already built and merged to `main`**; this branch adds only the user-profile
wager-progress panel. Paths are relative to the repo root.

## Backend API client layer — `src/lib/backend-api/`
The admin talks to the game backend over HTTP for all sweepstakes **config** (the game DB stays
read-only). Env-resolved by the `admin_db_env` cookie via `config.ts` (`resolveBackendApiConfig`,
`resolveEffectiveEnv`); `client.ts` adds bounded 429/503 retry for idempotent GETs.

| Module | Purpose |
|---|---|
| `wager-requirements.ts` | Withdrawal wager-requirement defaults (5 buckets × bps + 3 game weights) + per-user override (`getUserWagerRequirement`, `setUserWagerRequirement`, `clearUserWagerRequirement`) |
| `leaderboard-wager-weights.ts`, `rakeback-wager-weights.ts`, `source-wager-weights.ts`, `shard-wager-weights.ts`, `multiplier-wager-weights.ts` | The five wager-weight configs |
| `reward-expiry.ts` | Per-type reward claim windows |
| `crypto-fees.ts`, `crypto-fees-assets.ts` | Per-coin deposit/withdrawal exchange-rate fees |
| `challenges.ts` | Challenge CRUD |
| `creators.ts`, `affiliate-leaderboards.ts`, `multiplier-deals.ts`, `upgrader.ts`, `testing.ts` | Adjacent backend-driven admin features |

## `/security` — `src/app/(admin)/security/`
Server page (`page.tsx`) renders 8 backend-driven config cards, each read in its own try/catch→null
("awaiting backend deploy" muted state). Cards + their server actions + site-config keys:
`wager-requirement-card`, `leaderboard-wager-weights-card`, `rakeback-wager-weights-card`,
`shard-wager-weights-card`, `source-wager-weights-card`, `multiplier-wager-weights-card`,
`reward-expiry-card`, `crypto-fees-card` (+ `*-actions.ts`, `*-keys.ts`). Generic remaining keys via
`security-content.tsx`. Gated by `requirePageAccess("/security")`.

## `/challenges` — `src/app/(admin)/challenges/`
Full CRUD over the backend `challenges` API: `page.tsx`, `challenges-table.tsx`,
`create-challenge-button.tsx`, `edit-challenge-button.tsx`, `archive-challenge-button.tsx`,
`item-picker.tsx`, `actions.ts`. (PR #56 "challenges integration".)

## `/rewards` — `src/app/(admin)/rewards/`
`rewards-overview` + `rewards-table` + create/edit/delete reward; subfolders `rakeback/` (config +
claims), `shards/` (shard-pack management + create), `leaderboards/`, `raffles/`, `level-up/`,
`settings/`, `analytics/`.

## `/users/[id]` — `src/app/(admin)/users/[id]/`
- `user-wager-requirement-card.tsx` + `wager-requirement-actions.ts` — per-user override CONFIG
  (site default / override / effective ×; 0 = exempt). Backend-API backed.
- **NEW (this branch):** `user-wager-progress-card.tsx` + `src/lib/queries/users-wager-progress.ts`
  — read-only PROGRESS panel: requirement / completed / remaining + per-source breakdown with
  weighting, derived from the backend-written `balances` columns; streamed into the Account tab.

## Drift / schema-safety helpers (existing, reused)
- `src/lib/queries/_ledger-tx-types.ts` — `filterLedgerTxTypesLive` (live `pg_enum` probe, 5-min
  cache, fail-open) so a `type IN (...)` can't 22P02 on a migration-lagged enum.
- `src/lib/queries/insights-streamers/_schema-probe.ts` — `to_regclass`/`pg_enum` table+enum probe.
- The new progress query uses an `information_schema.columns` probe in the same spirit.

## DEV-only dependency note (corrected)
Earlier analysis claimed the sweepstakes tables/columns/ledger-types were dev-only. **Direct probing
disproved this** — they exist in BOTH dev and prod (see `dev-admin-verification.md`). So none of these
surfaces actually risk a prod-absence crash on the current prod DB; the env/drift guards remain as
forward-looking protection. The real dev↔prod gap is backend-endpoint availability, covered in
`prod-admin-migration-plan.md`.

> Cross-checked against the multi-agent review's inventory pass (36+ surfaces enumerated, all
> backend-driven config + the new progress panel). Correctness/security findings from that review are
> in `sweepstakes-review-findings.md`.
