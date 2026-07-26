import "server-only";

import { unstable_cache } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { crypto_fee_profit_counter } from "@/lib/db-schema/admin/schema";
import { drizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { formatDate } from "@/lib/utils/format";
import { withTiming } from "@/lib/observability/query-timings";
import { isPostgresError } from "@/lib/postgres-errors";

/**
 * Crypto fee profit — ANCHORED, DURABLE, MONOTONIC counter.
 *
 * Backs the dashboard "Crypto Fee" KPI box. The figure is the house's
 * estimated cumulative profit from the hidden crypto exchange-rate fee
 * (completed crypto deposit/withdrawal USD volume × the avg fee-band
 * midpoint), but UNLIKE the old all-time crypto-fee tile it replaces, it is:
 *
 *   1. ANCHORED — counted only from `count_start_at` (seeded ~2h before the
 *      first deploy of this feature), so it starts near $0 and grows, rather
 *      than showing the ~$5.5k lifetime figure.
 *   2. DURABLE + MONOTONIC — the running high-water total is persisted in the
 *      ADMIN DB (`crypto_fee_profit_counter`, single 'singleton' row). The
 *      prod GAME DB has swapped hosts twice this week; a number read purely
 *      live from game-DB history could DROP if that history moves to a fresh
 *      host. So we take `GREATEST(stored, live)` and write the high back —
 *      the displayed value is provably non-decreasing and survives a host
 *      swap (it holds the last high).
 *
 * ─── How it's computed ───────────────────────────────────────────────────
 *
 *   liveTotal = Σ(completed crypto deposit USD  since count_start_at) × depositBps/10000
 *             + Σ(completed crypto withdrawal USD since count_start_at) × withdrawalBps/10000
 *
 *   newTotal  = max(stored.total, liveTotal)   (same for each split leg)
 *
 * The bps are the LOCKED midpoints stored on the admin row (read once at seed
 * time) — NOT the live `site_config` bands — so a later band change can't
 * retroactively move the historical fee math. The "$100 → $0.45" model: the
 * fee is applied to the recorded USD `amount` (not grossed up), exactly like
 * the original all-time tile.
 *
 * ─── Caching / write discipline ──────────────────────────────────────────
 *
 * ONLY the inner game-DB volume SELECT is wrapped in `unstable_cache`
 * (env-keyed, 60s) — writes inside a cached fn would NOT re-run, so the
 * high-water write-back lives in the OUTER (uncached) function. The write is
 * idempotent: `SET total_fee_usd = GREATEST(total_fee_usd, $live)…`, so
 * concurrent re-renders are harmless and never lower the stored value.
 *
 * ─── Drift / degrade ─────────────────────────────────────────────────────
 *
 *   • Admin row missing (table/row not provisioned) → `available: false`
 *     (the muted card renders). Caught via SQLSTATE 42P01.
 *   • Game-DB crypto columns absent (host swap to a partial schema) → fall
 *     back to the STORED admin value (still shows the number) rather than
 *     throwing; the monotonic guarantee holds because we never lower it.
 */

export type CryptoFeeCounter = {
  /** False when the admin counter row is absent — the muted card renders. */
  available: boolean;
  /** Monotonic high-water total estimated fee profit (USD). */
  totalFeeUsd: number;
  depositFeeUsd: number;
  withdrawalFeeUsd: number;
  /** Locked deposit-fee midpoint actually applied (bps). */
  depositBps: number;
  /** Locked withdrawal-fee midpoint actually applied (bps). */
  withdrawalBps: number;
  /** Short "since Jun 14" label derived from `count_start_at`. */
  sinceLabel: string;
};

const UNAVAILABLE: CryptoFeeCounter = {
  available: false,
  totalFeeUsd: 0,
  depositFeeUsd: 0,
  withdrawalFeeUsd: 0,
  depositBps: 0,
  withdrawalBps: 0,
  sinceLabel: "",
};

const COUNTER_ID = "singleton";

/** Postgres error codes meaning the table/row isn't provisioned (degrade). */
function isMissingObjectError(err: unknown): boolean {
  return isPostgresError(err, "42P01");
}

/**
 * Cached inner read: live since-anchor crypto volume from the GAME DB.
 * Env-keyed (prod/dev never share an entry) + 60s revalidate. NO write here
 * (writes inside unstable_cache don't re-run). Returns a drift flag so the
 * caller can fall back to the stored value when the crypto schema is absent.
 */
const cachedSinceAnchorVolume = unstable_cache(
  async (
    env: DbEnv,
    countStartIso: string,
  ): Promise<{
    available: boolean;
    depositVolumeUsd: number;
    withdrawalVolumeUsd: number;
  }> => {
    return withTiming("dashboard.cryptoFeeCounter.volume", async () => {
      const db = drizzleForEnv(env);

      // Drift-guard: prove the crypto columns this query needs exist.
      const guard = await queryRows<
        { has_crypto_asset: boolean; has_amount: boolean }[]
      >(db, `
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ledger_transactions'
              AND column_name = 'crypto_asset'
          ) AS has_crypto_asset,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ledger_transactions'
              AND column_name = 'amount'
          ) AS has_amount
      `);
      const g = guard[0];
      if (!g || !g.has_crypto_asset || !g.has_amount) {
        return {
          available: false,
          depositVolumeUsd: 0,
          withdrawalVolumeUsd: 0,
        };
      }

      // Completed crypto volume SINCE the anchor. Same source set as the
      // all-time tile, bounded by created_at >= count_start_at.
      const volRows = await queryRows<
        { deposit_usd: string | null; withdrawal_usd: string | null }[]
      >(db, `
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
          AND created_at >= $1::timestamptz
      `, countStartIso);
      return {
        available: true,
        depositVolumeUsd: toNumber(volRows[0]?.deposit_usd),
        withdrawalVolumeUsd: toNumber(volRows[0]?.withdrawal_usd),
      };
    });
  },
  ["dashboard-crypto-fee-counter-volume-v1"],
  { revalidate: 60, tags: ["dashboard-crypto-fee-counter"] },
);

/**
 * Resolve the dashboard "Crypto Fee" counter — anchored, monotonic, durable.
 *
 * NOT wrapped in unstable_cache (it performs a high-water write-back). The
 * heavy game-DB scan it depends on IS cached (see cachedSinceAnchorVolume).
 */
export async function getCryptoFeeProfitCounter(): Promise<CryptoFeeCounter> {
  // 1. Read the admin counter row. Missing table/row → unavailable.
  let row;
  try {
    [row] = await adminDrizzle.select().from(crypto_fee_profit_counter)
      .where(eq(crypto_fee_profit_counter.id, COUNTER_ID)).limit(1);
  } catch (err) {
    if (isMissingObjectError(err)) return UNAVAILABLE;
    throw err;
  }
  if (!row) return UNAVAILABLE;

  const depositBps = toNumber(row.deposit_fee_bps);
  const withdrawalBps = toNumber(row.withdrawal_fee_bps);
  const storedTotal = toNumber(row.total_fee_usd);
  const storedDeposit = toNumber(row.deposit_fee_usd);
  const storedWithdrawal = toNumber(row.withdrawal_fee_usd);
  // count_start_at can come back as a Date (driver) or a string (cache hit on
  // a future caller); coerce defensively for the ISO param + label.
  const countStart = new Date(row.count_start_at);
  const countStartIso = countStart.toISOString();
  const sinceLabel = `since ${formatDate(countStart)}`;

  // 2. Live since-anchor volume from the game DB (env-keyed cached read).
  const env = await readDbEnv();
  const vol = await cachedSinceAnchorVolume(env, countStartIso);

  // 3. If the game-DB crypto schema is absent (host swap to a partial host),
  //    we can't recompute the live total — show the STORED high-water value
  //    rather than dropping to 0. The monotonic guarantee is preserved.
  if (!vol.available) {
    return {
      available: true,
      totalFeeUsd: storedTotal,
      depositFeeUsd: storedDeposit,
      withdrawalFeeUsd: storedWithdrawal,
      depositBps,
      withdrawalBps,
      sinceLabel,
    };
  }

  // 4. Live fee total from since-anchor volume × LOCKED bps.
  const liveDeposit = vol.depositVolumeUsd * (depositBps / 10_000);
  const liveWithdrawal = vol.withdrawalVolumeUsd * (withdrawalBps / 10_000);
  const liveTotal = liveDeposit + liveWithdrawal;

  // 5. High-water mark. When live ≥ stored, the split follows live; else keep
  //    the stored split (so a transient game-DB dip can't lower a leg).
  const useLive = liveTotal >= storedTotal;
  const newTotal = useLive ? liveTotal : storedTotal;
  const newDeposit = useLive ? liveDeposit : storedDeposit;
  const newWithdrawal = useLive ? liveWithdrawal : storedWithdrawal;

  // 6. Idempotent write-back ONLY when the live figure advanced the high.
  //    GREATEST() in SQL makes concurrent renders harmless and never lowers
  //    a stored value (belt-and-braces with the useLive gate above).
  if (useLive && liveTotal > storedTotal) {
    try {
      await adminDrizzle.execute(sql`
        UPDATE "crypto_fee_profit_counter"
        SET
          "total_fee_usd"      = GREATEST("total_fee_usd", ${newTotal}),
          "deposit_fee_usd"    = GREATEST("deposit_fee_usd", ${newDeposit}),
          "withdrawal_fee_usd" = GREATEST("withdrawal_fee_usd", ${newWithdrawal}),
          "updated_at"         = now()
        WHERE "id" = ${COUNTER_ID}
      `);
    } catch (err) {
      // A failed high-water write must never take the tile down — the
      // returned value is still correct for this render; the next render
      // retries the write. Only swallow missing-object errors; rethrow
      // anything unexpected so it's visible in logs via safeQuery.
      if (!isMissingObjectError(err)) throw err;
    }
  }

  return {
    available: true,
    totalFeeUsd: newTotal,
    depositFeeUsd: newDeposit,
    withdrawalFeeUsd: newWithdrawal,
    depositBps,
    withdrawalBps,
    sinceLabel,
  };
}
