import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

import { getRewardCostsTodayDbFromClickHouse } from "../queries/dashboard/reward-costs-today";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard "Reward Costs (today)" tile
 * (`getRewardCostsToday`). No-op unless the `dashboard_reward_costs_today`
 * surface is in `comparison` mode (forced off whenever ClickHouse is dormant).
 * Swallows every error — the served Postgres payload is never affected.
 *
 * Compares only the DATABASE-DERIVED lines cent-exact, over the SAME window
 * start the PG path computed (today 00:00 UTC, carried as `dayStartIso`):
 * deposit_bonus, daily_packs, signup_balance, rakeback, affiliate, promo_gift,
 * race, raffles, motha, manual_voucher, counted_adjustments — plus the DB
 * sub-total `dbTotal` (the PG card `total` minus its non-DB rain line).
 *
 * The RAIN line stays 100% Postgres: it is a flat NON-DB `$2 × hoursElapsed`
 * the operator passes through unchanged, with no DB source to mirror, so it is
 * deliberately EXCLUDED from this comparison (we subtract `rainCost` from the PG
 * total to compare the DB-derived sub-total). Scope mirrors the PG twin EXACTLY
 * (3-role wholesale customer scope + blacklist for the ledger/raffle/daily-pack
 * legs; no scope for motha); the blacklist is fed identically to both engines.
 */
export async function compareDashboardRewardCostsToday(pgValues: {
  lines: { key: string; amount: number }[];
  total: number;
  rainCost: number;
  dayStartIso: string;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_reward_costs_today");
    if (mode !== "comparison") return;

    const since = new Date(pgValues.dayStartIso);
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRewardCostsTodayDbFromClickHouse(since, blacklist);
    });

    const pgByKey = new Map(pgValues.lines.map((l) => [l.key, l.amount]));
    const pgLine = (key: string) => pgByKey.get(key) ?? 0;
    // DB-derived sub-total = the displayed total minus the non-DB rain line.
    const pgDbTotal = pgValues.total - pgValues.rainCost;

    const drift = computeDrift(
      {
        depositBonus: pgLine("deposit_bonus"),
        dailyPacks: pgLine("daily_packs"),
        signupBalance: pgLine("signup_balance"),
        rakeback: pgLine("rakeback"),
        affiliate: pgLine("affiliate"),
        promoGift: pgLine("promo_gift"),
        race: pgLine("race"),
        raffles: pgLine("raffles"),
        motha: pgLine("motha"),
        manualVoucher: pgLine("manual_voucher"),
        countedAdjustments: pgLine("counted_adjustments"),
        dbTotal: pgDbTotal,
      },
      {
        depositBonus: ch.depositBonus,
        dailyPacks: ch.dailyPacks,
        signupBalance: ch.signupBalance,
        rakeback: ch.rakeback,
        affiliate: ch.affiliate,
        promoGift: ch.promoGift,
        race: ch.race,
        raffles: ch.raffles,
        motha: ch.motha,
        manualVoucher: ch.manualVoucher,
        countedAdjustments: ch.countedAdjustments,
        dbTotal: ch.dbTotal,
      },
      // All compared fields are money (the non-DB rain line is excluded).
      [
        "depositBonus",
        "dailyPacks",
        "signupBalance",
        "rakeback",
        "affiliate",
        "promoGift",
        "race",
        "raffles",
        "motha",
        "manualVoucher",
        "countedAdjustments",
        "dbTotal",
      ],
    );
    logComparison("dashboard.rewardCostsToday", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_reward_costs_today",
      "comparison failed (ignored)",
      err,
    );
  }
}
