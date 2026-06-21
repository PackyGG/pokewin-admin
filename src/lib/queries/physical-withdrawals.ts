import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export type PhysicalAvailability = {
  /** Countries where `country_restrictions.physical_withdrawal` is true. */
  physicalCountriesAllowed: number;
  /** Total country rows in `country_restrictions`. */
  totalCountries: number;
};

/**
 * Read the per-country physical-withdrawal coverage the /physical page
 * surfaces. Read-only; request-scope (uncached) — the two counts hit a
 * ~250-row table so a seq scan is the optimal plan.
 */
export async function getPhysicalAvailability(): Promise<PhysicalAvailability> {
  const db = await getDb();
  const [totalCountries, physicalCountriesAllowed] = await Promise.all([
    db.country_restrictions.count(),
    db.country_restrictions.count({ where: { physical_withdrawal: true } }),
  ]);

  return {
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
