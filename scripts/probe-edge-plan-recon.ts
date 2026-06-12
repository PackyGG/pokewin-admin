/**
 * probe-edge-plan-recon.ts — Edge Plan 2.0 reconciliation probe (READ-ONLY).
 *
 * Diagnoses the /insights/edge-plan-2 headline-stat bug and captures the
 * canonical per-leg table the v2 baseline must reproduce. Runs the SAME
 * canonical query builders the dashboard / /ggr use (`getWindowMetrics`,
 * `getGamingLegs`, `upgraderMetrics`, `sumLedgerTypes`) plus a handful of
 * bounded ad-hoc scans (deposits by asset, adjustment categories, rains,
 * deposit-size histogram, deposit-bonus per-user-day, XP-vs-level).
 *
 * STRICTLY READ-ONLY: SELECT / aggregate only. Every ad-hoc scan runs inside
 * a transaction with `SET LOCAL statement_timeout` (the ledger has no
 * secondary indexes — bounded scans only). No secrets are printed.
 *
 * Run from the repo root:
 *   npx tsx scripts/probe-edge-plan-recon.ts
 *
 * The canonical metric modules import the bare "server-only" specifier,
 * which Next maps to its own compiled shim — outside Next that specifier
 * does not resolve, so this probe patches CJS resolution to Next's
 * `server-only/empty.js` BEFORE dynamically importing them. `readDbEnv`
 * falls back to prod outside a request scope, which is exactly the DB the
 * page reads.
 */

import Module from "node:module";
import path from "node:path";

// ── Resolve "server-only" to Next's compiled no-op shim (probe-only) ──
const SERVER_ONLY_SHIM = path.resolve(
  __dirname,
  "../node_modules/next/dist/compiled/server-only/empty.js",
);
type ResolverHost = {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const moduleHost = Module as unknown as ResolverHost;
const originalResolve = moduleHost._resolveFilename.bind(moduleHost);
moduleHost._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") return SERVER_ONLY_SHIM;
  return originalResolve(request, ...rest);
};

// Canonical modules are imported DYNAMICALLY (after the resolver patch).
type MetricsQueries = typeof import("@/lib/metrics/queries");
type MetricWindow = import("@/lib/metrics/queries").MetricWindow;

const WINDOW_DAYS = 30;
const PROBE_STATEMENT_TIMEOUT_MS = 20_000;

const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
const window30: MetricWindow = { since };

const usd = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      });
const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(3)}%`;

function header(title: string) {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

/** Run a bounded ad-hoc scan with SET LOCAL statement_timeout. */
async function boundedScan<T>(
  getDb: typeof import("@/lib/db").getDb,
  sql: string,
): Promise<T[] | null> {
  const db = await getDb();
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${PROBE_STATEMENT_TIMEOUT_MS}`,
      );
      return tx.$queryRawUnsafe<T[]>(sql);
    });
  } catch (err) {
    console.log(
      `  [scan failed/timed out] ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
    );
    return null;
  }
}

async function main() {
  // Dynamic imports AFTER the server-only resolver patch above.
  const { getDb } = await import("@/lib/db");
  const { getMetricsScope } = await import("@/lib/metrics/scope");
  const metrics: MetricsQueries = await import("@/lib/metrics/queries");
  const { getWindowMetrics, getGamingLegs, upgraderMetrics, sumLedgerTypes } =
    metrics;
  const { getCanonicalMoneyKpis } = await import("@/lib/queries/house-kpis");
  const { toNumber } = await import("@/lib/utils/decimal");
  const scan = <T,>(sql: string) => boundedScan<T>(getDb, sql);

  console.log(
    `Edge Plan 2.0 recon probe — window: last ${WINDOW_DAYS}d (since ${since.toISOString()})`,
  );

  // ── A. Canonical headline (getWindowMetrics — same source as /ggr + dashboard)
  header("A. Canonical 30d headline — getWindowMetrics (GGR/NGR source of truth)");
  const canonical = await getWindowMetrics({ window: window30 });
  console.log(`  wager (incl. upgrader):   ${usd(canonical.wager)}`);
  console.log(`  gamingPayout:             ${usd(canonical.gamingPayout)}`);
  console.log(`  GGR:                      ${usd(canonical.ggr)}`);
  console.log(`  NGR:                      ${usd(canonical.ngr)}`);
  console.log(`  rewardCost (GGR−NGR):     ${usd(canonical.ggr - canonical.ngr)}`);
  console.log(`  houseEdge:                ${pct(canonical.houseEdge)}`);
  console.log(`  bets:                     ${canonical.bets}`);
  console.log(`  rain win/tip/houseCost:   ${usd(canonical.rainWinTotal)} / ${usd(canonical.rainTipTotal)} / ${usd(canonical.rainHouseCost)}`);

  // ── B. getCanonicalMoneyKpis (the topbar read the page scales against)
  header("B. getCanonicalMoneyKpis — the wager the page rescales to (Bug A input)");
  const money = await getCanonicalMoneyKpis(since);
  console.log(`  money.wager (pack/battle ledger, NO upgrader): ${usd(money.wager)}`);
  console.log(`  money.wagerOrganic:                            ${usd(money.wagerOrganic)}`);
  console.log(`  money.upgraderOrganic:                         ${usd(money.upgraderOrganic)}`);
  console.log(`  money.organicCustomerStake:                    ${usd(money.organicCustomerStake)}`);
  console.log(`  money.ggr (= getWindowMetrics ggr):            ${usd(money.ggr)}`);
  console.log(`  deposits / withdrawals:                        ${usd(money.deposits)} / ${usd(money.withdrawals)}`);

  // ── C. Per-type legs (getGamingLegs + upgraderMetrics)
  header("C. Per-type gaming legs (canonical scope)");
  const [legs, upg] = await Promise.all([
    getGamingLegs(window30),
    upgraderMetrics(window30),
  ]);
  console.log(`  legs.wager (pack/battle/upgrader incl.): ${usd(legs.wager)}`);
  console.log(`  legs.inventoryPayout + battleRefund:     ${usd(legs.inventoryPayout)} + ${usd(legs.battleRefund)}`);
  console.log(`  legs upgraderWager / upgraderPayout:     ${usd(legs.upgraderWager)} / ${usd(legs.upgraderPayout)}`);
  if (upg) {
    console.log(`  upgrader wager:  ${usd(upg.wager)}   payout: ${usd(upg.payout)}   ggr: ${usd(upg.ggr)}   edge: ${pct(upg.wager > 0 ? upg.ggr / upg.wager : null)}`);
  } else {
    console.log("  upgrader: table missing on this DB (null)");
  }

  // ── D. Bug A verdict
  header("D. BUG A verdict — applyOrganicWagerScale distortion");
  const v1Wager = canonical.wager; // buildBaseline: v1.wager = getWindowMetrics().wager
  const scale = v1Wager > 0 ? money.wager / v1Wager : 1;
  const wouldRescale = money.wager > 0 && v1Wager > 0 && Math.abs(v1Wager - money.wager) > 1;
  const upgShare = v1Wager > 0 && upg ? upg.wager / v1Wager : 0;
  console.log(`  v1.wager (getWindowMetrics, incl. upgrader): ${usd(v1Wager)}`);
  console.log(`  money.wager (pack/battle only):              ${usd(money.wager)}`);
  console.log(`  page rescales? ${wouldRescale} — scale factor = ${scale.toFixed(6)}`);
  console.log(`  upgrader share of v1 wager:                  ${pct(upgShare)}`);
  console.log(`  → page GGR after downscale:  ${usd(canonical.ggr * scale)}  (canonical ${usd(canonical.ggr)}, distortion ${usd(canonical.ggr * scale - canonical.ggr)})`);
  console.log(
    wouldRescale && Math.abs(1 - scale) > 0.005
      ? `  VERDICT: CONFIRMED — every game-type leg (incl. upgrader itself) is downscaled by ×${scale.toFixed(4)}.`
      : "  VERDICT: NOT REPRODUCED at this window — scale ≈ 1; root-cause further before coding.",
  );

  // ── E. Reward legs (sumLedgerTypes — the per-lever costs)
  header("E. Reward legs (sumLedgerTypes, canonical scope) + unclamped other");
  const [
    rakeback,
    affiliateClaim,
    affiliateLb,
    depositBonus,
    racePrize,
    signup,
    giftCard,
    promoCode,
  ] = await Promise.all([
    sumLedgerTypes({ types: ["rakeback_claim"], window: window30 }),
    sumLedgerTypes({ types: ["affiliate_claim"], window: window30 }),
    sumLedgerTypes({ types: ["affiliate_leaderboard_prize"], window: window30 }),
    sumLedgerTypes({ types: ["deposit_bonus"], window: window30 }),
    sumLedgerTypes({ types: ["race_prize"], window: window30 }),
    sumLedgerTypes({ types: ["balance_reward_claim"], window: window30 }),
    sumLedgerTypes({ types: ["gift_card_redeemed"], window: window30 }),
    sumLedgerTypes({ types: ["promo_code_redeemed"], window: window30 }),
  ]);
  console.log(`  rakeback_claim:              ${usd(rakeback)}`);
  console.log(`  affiliate_claim:             ${usd(affiliateClaim)}`);
  console.log(`  affiliate_leaderboard_prize: ${usd(affiliateLb)}`);
  console.log(`  deposit_bonus:               ${usd(depositBonus)}`);
  console.log(`  race_prize:                  ${usd(racePrize)}`);
  console.log(`  balance_reward_claim:        ${usd(signup)}`);
  console.log(`  gift_card_redeemed:          ${usd(giftCard)}`);
  console.log(`  promo_code_redeemed:         ${usd(promoCode)}`);
  const canonicalRewardCost = canonical.ggr - canonical.ngr;
  const ledgerLeverCost =
    rakeback + affiliateClaim + affiliateLb + depositBonus + racePrize + signup + canonical.rainHouseCost;
  const otherUnclamped = canonicalRewardCost - ledgerLeverCost;
  console.log(`  canonical rewardCost:        ${usd(canonicalRewardCost)}`);
  console.log(`  Σ itemized ledger levers:    ${usd(ledgerLeverCost)} (incl. rain ${usd(canonical.rainHouseCost)})`);
  console.log(`  otherRewardCost UNCLAMPED:   ${usd(otherUnclamped)}  ${otherUnclamped < 0 ? "← NEGATIVE (page clamps to 0; reconciliation gap!)" : ""}`);
  console.log(`  other minus giftCard+promo:  ${usd(otherUnclamped - giftCard - promoCode)} (residual after itemizing gift cards + promo codes)`);

  // ── F. Deposits by asset
  header("F. Deposits by asset (30d, canonical scope) — deposit-fee lever input");
  {
    const scope = await getMetricsScope();
    const rows = await scan<{ asset: string; n: string; vol: string }>(
      `WITH ${scope.sessionWindowsCte}
       SELECT COALESCE(NULLIF(TRIM(lt.crypto_asset), ''), da.asset_id, 'unknown') AS asset,
              COUNT(*)::text AS n,
              COALESCE(SUM(lt.amount::numeric), 0)::text AS vol
       FROM ledger_transactions lt
       LEFT JOIN deposit_addresses da ON da.id = lt.deposit_address_id
       WHERE lt.status = 'completed'
         AND lt.type::text = 'deposit'
         AND lt.user_id IN ${scope.userScopeSql}
         AND lt.created_at >= '${since.toISOString()}'::timestamptz
       GROUP BY 1
       ORDER BY SUM(lt.amount::numeric) DESC`,
    );
    for (const r of rows ?? []) {
      console.log(`  ${r.asset.padEnd(16)} n=${r.n.padStart(5)}  ${usd(toNumber(r.vol))}`);
    }
  }

  // ── G. Balance-adjustment categories (credits/debits, incl. NULL bucket)
  header("G. Balance adjustments by category (30d) — adjustments box input");
  {
    const rows = await scan<{
      category: string;
      n: string;
      credits: string;
      debits: string;
    }>(
      `SELECT COALESCE(metadata->>'adjustment_category', '«not itemized»') AS category,
              COUNT(*)::text AS n,
              COALESCE(SUM(CASE WHEN amount::numeric > 0 THEN amount::numeric ELSE 0 END), 0)::text AS credits,
              COALESCE(SUM(CASE WHEN amount::numeric < 0 THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS debits
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text = 'admin_balance_adjustment'
         AND created_at >= '${since.toISOString()}'::timestamptz
       GROUP BY 1
       ORDER BY 1`,
    );
    for (const r of rows ?? []) {
      console.log(`  ${r.category.padEnd(24)} n=${r.n.padStart(4)}  credits=${usd(toNumber(r.credits))}  debits=${usd(toNumber(r.debits))}`);
    }
  }

  // ── H. Rains anchor
  header("H. Rains anchor (30d) — rain lever seeds");
  {
    const rows = await scan<{
      status: string;
      n: string;
      avg_hours: string;
      avg_pool: string;
      sum_pool: string;
      avg_base: string;
    }>(
      `SELECT status::text AS status,
              COUNT(*)::text AS n,
              COALESCE(AVG(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 3600.0), 0)::text AS avg_hours,
              COALESCE(AVG(total_pool_usd::numeric), 0)::text AS avg_pool,
              COALESCE(SUM(total_pool_usd::numeric), 0)::text AS sum_pool,
              COALESCE(AVG(base_amount_usd::numeric), 0)::text AS avg_base
       FROM rains
       WHERE created_at >= '${since.toISOString()}'::timestamptz
       GROUP BY 1 ORDER BY 1`,
    );
    for (const r of rows ?? []) {
      console.log(
        `  ${r.status.padEnd(10)} n=${r.n.padStart(5)}  avgDur=${toNumber(r.avg_hours).toFixed(2)}h  avgPool=${usd(toNumber(r.avg_pool))}  ΣPool=${usd(toNumber(r.sum_pool))}  avgBase=${usd(toNumber(r.avg_base))}`,
      );
    }
  }

  // ── I. Deposit-size histogram (min-deposit gate input)
  header("I. Deposit-size distribution (30d, canonical scope)");
  {
    const scope = await getMetricsScope();
    const rows = await scan<{
      n: string;
      min: string;
      p10: string;
      p25: string;
      p50: string;
      p75: string;
      p90: string;
      max: string;
    }>(
      `WITH ${scope.sessionWindowsCte}
       SELECT COUNT(*)::text AS n,
              COALESCE(MIN(amount::numeric), 0)::text AS min,
              COALESCE(percentile_cont(0.10) WITHIN GROUP (ORDER BY amount::numeric), 0)::text AS p10,
              COALESCE(percentile_cont(0.25) WITHIN GROUP (ORDER BY amount::numeric), 0)::text AS p25,
              COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY amount::numeric), 0)::text AS p50,
              COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY amount::numeric), 0)::text AS p75,
              COALESCE(percentile_cont(0.90) WITHIN GROUP (ORDER BY amount::numeric), 0)::text AS p90,
              COALESCE(MAX(amount::numeric), 0)::text AS max
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text = 'deposit'
         AND user_id IN ${scope.userScopeSql}
         AND created_at >= '${since.toISOString()}'::timestamptz`,
    );
    const r = rows?.[0];
    if (r) {
      console.log(`  n=${r.n}  min=${usd(toNumber(r.min))}  p10=${usd(toNumber(r.p10))}  p25=${usd(toNumber(r.p25))}  p50=${usd(toNumber(r.p50))}  p75=${usd(toNumber(r.p75))}  p90=${usd(toNumber(r.p90))}  max=${usd(toNumber(r.max))}`);
    }
  }

  // ── J. Deposit-bonus per-user-day (time-bonus anchor)
  header("J. Deposit-bonus per-user-day histogram (30d) — time-bonus anchor");
  {
    const rows = await scan<{
      user_days: string;
      users: string;
      avg_amt: string;
      p50: string;
      p90: string;
      max: string;
      at_cap: string;
    }>(
      `WITH per AS (
         SELECT user_id, date_trunc('day', created_at) AS d, SUM(ABS(amount::numeric)) AS amt
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'deposit_bonus'
           AND created_at >= '${since.toISOString()}'::timestamptz
         GROUP BY 1, 2
       )
       SELECT COUNT(*)::text AS user_days,
              COUNT(DISTINCT user_id)::text AS users,
              COALESCE(AVG(amt), 0)::text AS avg_amt,
              COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY amt), 0)::text AS p50,
              COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY amt), 0)::text AS p90,
              COALESCE(MAX(amt), 0)::text AS max,
              SUM(CASE WHEN amt >= 100 THEN 1 ELSE 0 END)::text AS at_cap
       FROM per`,
    );
    const r = rows?.[0];
    if (r) {
      console.log(`  user-days=${r.user_days}  users=${r.users}  avg=${usd(toNumber(r.avg_amt))}  p50=${usd(toNumber(r.p50))}  p90=${usd(toNumber(r.p90))}  max=${usd(toNumber(r.max))}  ≥$100 cap=${r.at_cap}`);
    }
  }

  // ── K. XP vs level (XP_TO_USD pin)
  header("K. XP per level (user_statistics) — XP_TO_USD calibration");
  {
    const rows = await scan<{
      level: number;
      users: string;
      min_xp: string;
      max_xp: string;
    }>(
      `SELECT level, COUNT(*)::text AS users, MIN(xp)::text AS min_xp, MAX(xp)::text AS max_xp
       FROM user_statistics
       GROUP BY level
       ORDER BY level
       LIMIT 50`,
    );
    for (const r of rows ?? []) {
      console.log(`  level ${String(r.level).padStart(3)}  users=${r.users.padStart(6)}  min_xp=${r.min_xp.padStart(10)}  max_xp=${r.max_xp.padStart(10)}`);
    }
    console.log(
      "  (owner: level ≈ $10 wager-loss per level @ XP≈$ 1:1 — compare min_xp steps against 10×level)",
    );
  }

  // ── L. Daily-reward configs (re-lock % + level requirement context)
  header("L. rewards (type=daily) — level_required + daily_unlock_percentage");
  {
    const rows = await scan<{
      slug: string;
      level_required: number;
      daily_unlock_percentage: string | null;
      pack_ids: string[];
    }>(
      `SELECT slug, level_required, daily_unlock_percentage::text AS daily_unlock_percentage, pack_ids
       FROM rewards
       WHERE type::text = 'daily'
       ORDER BY level_required ASC`,
    );
    for (const r of rows ?? []) {
      console.log(`  ${r.slug.padEnd(28)} lvl_req=${String(r.level_required).padStart(3)}  relock=${r.daily_unlock_percentage ?? "NULL(=1%)"}  packs=${r.pack_ids?.length ?? 0}`);
    }
  }

  // ── M. Ledger freshness
  header("M. Ledger freshness (MAX created_at, 7d bound)");
  {
    const rows = await scan<{ max_created: string | null }>(
      `SELECT MAX(created_at)::text AS max_created
       FROM ledger_transactions
       WHERE created_at >= NOW() - INTERVAL '7 days'`,
    );
    console.log(`  ledgerMaxCreatedAt: ${rows?.[0]?.max_created ?? "null (no rows in 7d or timed out)"}`);
  }

  // ── N. Live raffles (context cards input)
  header("N. Live raffles (status=active) — context-card input");
  {
    const rows = await scan<{
      id: string;
      title: string | null;
      prizes: unknown;
      total_entries: number | null;
      ends_at: string | null;
    }>(
      `SELECT id, COALESCE(to_jsonb(r)->>'title', to_jsonb(r)->>'name') AS title, prizes, total_entries, ends_at::text
       FROM raffles r
       WHERE status::text = 'active'
       ORDER BY ends_at ASC NULLS LAST
       LIMIT 10`,
    );
    console.log(`  active raffles: ${rows?.length ?? "scan failed"}`);
    for (const r of rows ?? []) {
      console.log(`  ${r.id}  «${r.title ?? "?"}»  entries=${r.total_entries ?? 0}  ends=${r.ends_at ?? "?"}  prizes=${JSON.stringify(r.prizes)?.slice(0, 100)}`);
    }
  }

  console.log("\nProbe complete (read-only — no writes were issued).");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("PROBE FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
