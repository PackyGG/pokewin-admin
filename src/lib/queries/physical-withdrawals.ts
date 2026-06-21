import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getSiteConfigValues } from "./site-config";

/**
 * Global "withdrawals on/off" master switch key in the MAIN-DB
 * `site_config` K/V store. Description in prod:
 * "Turn off all withdrawals if turned off". Owns ALL withdrawal methods
 * (crypto + balance + physical) — there is no physical-only global flag.
 */
export const WITHDRAWALS_ENABLED_KEY = "withdrawals_enabled";

export type PhysicalAvailability = {
  /** `site_config.withdrawals_enabled` — defaults to ON when the row is absent. */
  withdrawalsEnabled: boolean;
  /** Countries where `country_restrictions.physical_withdrawal` is true. */
  physicalCountriesAllowed: number;
  /** Total country rows in `country_restrictions`. */
  totalCountries: number;
};

/**
 * Read the physical-withdrawal availability levers the /physical page
 * surfaces: the global withdrawals master switch and the per-country
 * physical-withdrawal coverage. Read-only; request-scope (uncached) — the
 * two counts hit a ~250-row table so a seq scan is the optimal plan.
 */
export async function getPhysicalAvailability(): Promise<PhysicalAvailability> {
  const db = await getDb();
  const [cfg, totalCountries, physicalCountriesAllowed] = await Promise.all([
    getSiteConfigValues([WITHDRAWALS_ENABLED_KEY]),
    db.country_restrictions.count(),
    db.country_restrictions.count({ where: { physical_withdrawal: true } }),
  ]);

  return {
    // Absent row → treat as ON (the backend default). Only an explicit
    // "false" disables withdrawals.
    withdrawalsEnabled: cfg[WITHDRAWALS_ENABLED_KEY] !== "false",
    physicalCountriesAllowed,
    totalCountries,
  };
}

export type PhysicalWithdrawalStats = {
  total: number;
  pending: number;
  processing: number;
  shipped: number;
  completed: number;
  failed: number;
  cancelled: number;
  totalValueUsd: number;
};

const EMPTY_STATS: PhysicalWithdrawalStats = {
  total: 0,
  pending: 0,
  processing: 0,
  shipped: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  totalValueUsd: 0,
};

/**
 * Status breakdown + summed value for physical-method withdrawal requests.
 * Read-only group-by over `card_withdrawal_requests` filtered to
 * `method = 'physical'`. The physical slice is currently empty in prod, and
 * the whole table is only ~5k rows, so this is a cheap scan.
 */
export async function getPhysicalWithdrawalStats(): Promise<PhysicalWithdrawalStats> {
  const db = await getDb();
  const grouped = await db.card_withdrawal_requests.groupBy({
    by: ["status"],
    where: { method: "physical" },
    _count: { _all: true },
    _sum: { total_value_usd: true },
  });

  const stats: PhysicalWithdrawalStats = { ...EMPTY_STATS };
  for (const g of grouped) {
    const n = g._count._all;
    stats.total += n;
    stats.totalValueUsd += toNumber(g._sum.total_value_usd ?? 0);
    switch (g.status) {
      case "pending":
        stats.pending = n;
        break;
      case "processing":
        stats.processing = n;
        break;
      case "shipped":
        stats.shipped = n;
        break;
      case "completed":
        stats.completed = n;
        break;
      case "failed":
        stats.failed = n;
        break;
      case "cancelled":
        stats.cancelled = n;
        break;
    }
  }
  return stats;
}
