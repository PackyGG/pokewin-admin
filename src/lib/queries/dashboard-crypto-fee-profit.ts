import "server-only";

import { unstable_cache } from "next/cache";
import { dbForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";

/**
 * Estimated cumulative house profit from the hidden crypto exchange-rate fee
 * — the dashboard "Crypto fee profit" tile.
 *
 * ─── Why this is an ESTIMATE, not an exactly-recorded figure ─────────────
 *
 * The fee is config-only. The platform shaves a small spread off the
 * market exchange rate on every crypto deposit (and a smaller one on
 * withdrawals), but it does NOT record the fee amount per transaction.
 * The `exchange_rate` stored on `ledger_transactions` is already the
 * POST-fee rate (the fee is baked in), and there is no gross/market-rate
 * column to diff against — so `crypto_amount × exchange_rate − amount`
 * nets to rounding dust across all history (~$38 total), NOT the fee.
 *
 * The fee bands live in `site_config` as bps of the market price:
 *   • deposit fee  ≈ 40–50 bps  (midpoint 45 bps  = 0.45%)
 *   • withdrawal fee ≈ 5–10 bps (midpoint 7.5 bps = 0.075%)
 * for the enabled assets (BTC/DOGE/ETH/LTC/SOL/XRP). The realized fee per
 * tx is a per-deposit RANDOM draw inside the [min,max] band, so the owner's
 * model is "take the average": every $100 a user deposits, we make on
 * average ~$0.45.
 *
 * So this tile is the owner-confirmed estimate:
 *
 *   estimatedFee = Σ(crypto deposit USD vol)    × depositMidpointBps/10000
 *                + Σ(crypto withdrawal USD vol)  × withdrawalMidpointBps/10000
 *
 * applied to the recorded USD `amount` of the transaction (the "$100 → $0.45"
 * model — NOT grossed up). It is cumulative ALL-TIME and monotonic.
 *
 * ─── Volume sources (confirmed read-only on live prod, 2026-06-14) ───────
 *
 *   • Deposit volume: `ledger_transactions` rows with `type = 'deposit'`,
 *     `status = 'completed'`, `crypto_asset IS NOT NULL`
 *     (≈ 7,686 rows / ≈ $1.067M).
 *   • Withdrawal volume: completed crypto withdrawals across BOTH withdrawal
 *     ledger types — `card_withdrawal` (card sold → crypto out, the bulk:
 *     ≈ 4,201 rows / ≈ $897.7K) + `balance_withdrawal` (≈ 4 rows / ≈ $521)
 *     — `status = 'completed'`, `crypto_asset IS NOT NULL` (≈ 4,205 rows /
 *     ≈ $898K). Failed/pending rows are excluded (no fee was actually
 *     realized on a withdrawal that never settled).
 *
 * NOTE this is NOT customer-scoped (no staff/creator exclusion): the fee is
 * realized on EVERY crypto deposit/withdrawal regardless of who made it, so
 * the house-profit estimate counts all completed crypto flow.
 *
 * ─── DB-env correctness (prod-only cache) ────────────────────────────────
 *
 * `env` is resolved in request scope via `readDbEnv()` and passed as an
 * ARGUMENT into the cached callback so it's part of the cache key (prod and
 * dev never share an entry). The callback uses the sync `dbForEnv(env)` —
 * never reads the cookie inside `unstable_cache` (that throws out of request
 * scope and silently falls back to prod). Same pattern as
 * `_ledger-tx-types.ts` / `users-detail-cache.ts`.
 */

/** Fallback midpoints (bps) if `site_config` can't be cleanly read — the
 *  owner-confirmed defaults: deposit 40–50 → 45; withdrawal 5–10 → 7.5. */
const FALLBACK_DEPOSIT_BPS = 45;
const FALLBACK_WITHDRAWAL_BPS = 7.5;

export type CryptoFeeProfit = {
  /** False when a required column / table is absent on the connected DB —
   *  the tile then renders a muted "not available" state instead of crashing. */
  available: boolean;
  /** Combined cumulative estimated fee profit (USD). */
  totalFeeUsd: number;
  depositFeeUsd: number;
  withdrawalFeeUsd: number;
  depositVolumeUsd: number;
  withdrawalVolumeUsd: number;
  /** Deposit-fee midpoint actually applied (bps). */
  depositBps: number;
  /** Withdrawal-fee midpoint actually applied (bps). */
  withdrawalBps: number;
  /** True when the bps midpoints were read live from `site_config`, false
   *  when the fallback constants were used (surfaced in tile subtext). */
  bpsFromConfig: boolean;
};

const UNAVAILABLE: CryptoFeeProfit = {
  available: false,
  totalFeeUsd: 0,
  depositFeeUsd: 0,
  withdrawalFeeUsd: 0,
  depositVolumeUsd: 0,
  withdrawalVolumeUsd: 0,
  depositBps: FALLBACK_DEPOSIT_BPS,
  withdrawalBps: FALLBACK_WITHDRAWAL_BPS,
  bpsFromConfig: false,
};

const cachedCryptoFeeProfit = unstable_cache(
  async (env: DbEnv): Promise<CryptoFeeProfit> => {
    return withTiming("dashboard.cryptoFeeProfit", async () => {
      const db = dbForEnv(env);

      // ── Drift-guard: prove the schema this query depends on exists ──────
      // Prod has swapped hosts twice this week; never assume. If any
      // required column or the config table is missing, degrade to the
      // muted "not available" tile rather than throwing the route boundary.
      const guard = await db.$queryRaw<
        {
          has_crypto_asset: boolean;
          has_crypto_amount: boolean;
          has_exchange_rate: boolean;
          has_amount: boolean;
          has_site_config: boolean;
        }[]
      >`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ledger_transactions'
              AND column_name = 'crypto_asset'
          ) AS has_crypto_asset,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ledger_transactions'
              AND column_name = 'crypto_amount'
          ) AS has_crypto_amount,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ledger_transactions'
              AND column_name = 'exchange_rate'
          ) AS has_exchange_rate,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ledger_transactions'
              AND column_name = 'amount'
          ) AS has_amount,
          to_regclass('public.site_config') IS NOT NULL AS has_site_config
      `;
      const g = guard[0];
      if (
        !g ||
        !g.has_crypto_asset ||
        !g.has_crypto_amount ||
        !g.has_exchange_rate ||
        !g.has_amount
      ) {
        return UNAVAILABLE;
      }

      // ── Fee bps midpoints — read live from site_config when possible ────
      // The fee is a uniform random draw inside [min,max] bps; the expected
      // (average) fee is the band midpoint. Average the midpoint across the
      // ENABLED assets so a per-asset band change is reflected. site_config
      // is a (key,value) text table; the keys are
      //   crypto_<deposit|withdrawal>_fee_<min|max>_bps_<asset>
      //   crypto_<deposit|withdrawal>_fee_enabled_<asset>  (value 'true'/'false')
      // Only enabled assets contribute (a disabled asset realizes no fee).
      let depositBps = FALLBACK_DEPOSIT_BPS;
      let withdrawalBps = FALLBACK_WITHDRAWAL_BPS;
      let bpsFromConfig = false;
      if (g.has_site_config) {
        try {
          const bpsRows = await db.$queryRaw<
            { direction: string; avg_mid_bps: number | null }[]
          >`
            WITH cfg AS (
              SELECT
                split_part(key, '_', 2) AS direction,                 -- deposit | withdrawal
                split_part(key, '_', 4) AS kind,                      -- min | max | enabled
                regexp_replace(key, '^crypto_[a-z]+_fee_[a-z]+_bps_', '') AS bps_asset,
                regexp_replace(key, '^crypto_[a-z]+_fee_enabled_', '') AS enabled_asset,
                key,
                value
              FROM site_config
              WHERE key LIKE 'crypto_deposit_fee_%'
                 OR key LIKE 'crypto_withdrawal_fee_%'
            ),
            enabled AS (
              SELECT direction, enabled_asset AS asset
              FROM cfg
              WHERE key LIKE '%_fee_enabled_%' AND lower(value) = 'true'
            ),
            mins AS (
              SELECT direction, bps_asset AS asset, NULLIF(value, '')::numeric AS bps
              FROM cfg WHERE kind = 'min' AND key LIKE '%_bps_%'
            ),
            maxs AS (
              SELECT direction, bps_asset AS asset, NULLIF(value, '')::numeric AS bps
              FROM cfg WHERE kind = 'max' AND key LIKE '%_bps_%'
            )
            SELECT
              e.direction,
              AVG((mn.bps + mx.bps) / 2.0)::float8 AS avg_mid_bps
            FROM enabled e
            JOIN mins mn ON mn.direction = e.direction AND mn.asset = e.asset
            JOIN maxs mx ON mx.direction = e.direction AND mx.asset = e.asset
            WHERE mn.bps IS NOT NULL AND mx.bps IS NOT NULL
            GROUP BY e.direction
          `;
          let gotDeposit = false;
          let gotWithdrawal = false;
          for (const row of bpsRows) {
            if (row.avg_mid_bps == null) continue;
            if (row.direction === "deposit") {
              depositBps = toNumber(row.avg_mid_bps);
              gotDeposit = true;
            } else if (row.direction === "withdrawal") {
              withdrawalBps = toNumber(row.avg_mid_bps);
              gotWithdrawal = true;
            }
          }
          // Only claim "from config" when BOTH directions resolved cleanly;
          // otherwise keep the fallback for the missing one and label honestly.
          bpsFromConfig = gotDeposit && gotWithdrawal;
        } catch {
          // Keep fallback midpoints — never let a config-shape change crash
          // the tile. The volume sums below are independent and still run.
          bpsFromConfig = false;
        }
      }

      // ── Cumulative completed crypto volume (all-time) ───────────────────
      const volRows = await db.$queryRaw<
        { deposit_usd: string | null; withdrawal_usd: string | null }[]
      >`
        SELECT
          SUM(amount) FILTER (
            WHERE type::text = 'deposit'
          )::text AS deposit_usd,
          SUM(amount) FILTER (
            WHERE type::text IN ('card_withdrawal', 'balance_withdrawal')
          )::text AS withdrawal_usd
        FROM ledger_transactions
        WHERE crypto_asset IS NOT NULL
          AND status::text = 'completed'
          AND type::text IN ('deposit', 'card_withdrawal', 'balance_withdrawal')
      `;
      const depositVolumeUsd = toNumber(volRows[0]?.deposit_usd);
      const withdrawalVolumeUsd = toNumber(volRows[0]?.withdrawal_usd);

      const depositFeeUsd = depositVolumeUsd * (depositBps / 10_000);
      const withdrawalFeeUsd = withdrawalVolumeUsd * (withdrawalBps / 10_000);

      return {
        available: true,
        totalFeeUsd: depositFeeUsd + withdrawalFeeUsd,
        depositFeeUsd,
        withdrawalFeeUsd,
        depositVolumeUsd,
        withdrawalVolumeUsd,
        depositBps,
        withdrawalBps,
        bpsFromConfig,
      };
    });
  },
  ["dashboard-crypto-fee-profit-v1"],
  // 5 min: this is a cumulative all-time aggregate that drifts slowly; it
  // does not need the 60s freshness of the today-window tiles.
  { revalidate: 300, tags: ["dashboard-crypto-fee-profit"] },
);

export async function getCryptoFeeProfit(): Promise<CryptoFeeProfit> {
  // Resolve env OUTSIDE the cache (in request scope) and pass it in so the
  // cached entry is keyed per env — see module doc.
  const env = await readDbEnv();
  return cachedCryptoFeeProfit(env);
}
