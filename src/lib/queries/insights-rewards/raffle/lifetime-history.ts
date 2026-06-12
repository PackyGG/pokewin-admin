import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import {
  parseRafflePrizes,
  buildRafflePrizeValuator,
} from "./prize-valuation";

/**
 * lifetime-history.ts — EVERY raffle ever run (owner spec #10, Edge Plan
 * 2.0 raffle block). ADDITIVE module — nothing existing in `raffle/`
 * changes.
 *
 * ONE bounded read over the `raffles` table (a small table — probe
 * 2026-06-12: ~32 rows lifetime), statuses `completed` + `active` ("ever
 * run"; cancelled raffles never ran). Prize value is reconstructed with the
 * SHARED prize-valuation helper at LIVE item prices (`packs.price` /
 * `cards.price` × quantity) — the same math as the raffle detail page, the
 * forecast baseline and the Edge Plan live-raffle cards. Two `IN (…)` price
 * lookups across the whole batch, never per-raffle.
 *
 * SCOPE NOTE (deliberate, labeled in the UI): this is a HISTORY LISTING of
 * raffles the house ran — it does NOT drop raffles whose winner is staff /
 * blacklisted the way the customer-scoped `getRaffleForecastBaseline`
 * does, so its all-time total can sit slightly above the forecast
 * baseline's scoped cost. The 30d keep-slider planning basis is unchanged.
 *
 * READ-ONLY against the main (production) DB. House-POV: raffle prizes are
 * house cost → rose.
 */

export type RaffleHistoryRow = {
  id: string;
  /** Raffle name (null when unnamed). */
  title: string | null;
  status: "active" | "completed";
  /** Σ prize line value at LIVE prices (shared prize-valuation helper). */
  prizeValueUsd: number;
  totalEntries: number;
  participantCount: number;
  /** ISO end date (ends_at), null when open-ended. */
  endsAtIso: string | null;
  /** ISO completion date, null while active. */
  completedAtIso: string | null;
};

export type RaffleLifetimeHistory = {
  /** Newest first (completed_at, else ends_at, else created_at). */
  rows: RaffleHistoryRow[];
  /** Σ prize value of COMPLETED raffles — "Total raffle prize cost — all time". */
  completedPrizeCostUsd: number;
  /** Σ prize value currently committed on ACTIVE raffles (not yet awarded). */
  activePrizeValueUsd: number;
  completedCount: number;
  activeCount: number;
  /** True when the bounded read hit its row cap (loud band, totals under-count). */
  truncated: boolean;
};

/** Hard bound on the listing — far above today's lifetime count, still bounded. */
const RAFFLE_HISTORY_ROW_CAP = 400;

type RawRaffleRow = {
  id: string;
  name: string | null;
  prizes: unknown;
  total_entries: number | null;
  participant_count: number | null;
  ends_at: Date | null;
  completed_at: Date | null;
  status: string;
};

async function computeRaffleLifetimeHistory(): Promise<RaffleLifetimeHistory> {
  const db = await getDb();

  const raw = await db.$queryRawUnsafe<RawRaffleRow[]>(
    `SELECT id, name, prizes, total_entries, participant_count, ends_at, completed_at, status::text AS status
     FROM raffles
     WHERE status::text IN ('active', 'completed')
     ORDER BY COALESCE(completed_at, ends_at, created_at) DESC
     LIMIT ${RAFFLE_HISTORY_ROW_CAP + 1}`,
  );

  const truncated = raw.length > RAFFLE_HISTORY_ROW_CAP;
  const bounded = truncated ? raw.slice(0, RAFFLE_HISTORY_ROW_CAP) : raw;

  const parsed = bounded.map((row) => ({
    row,
    lines: parseRafflePrizes(row.prizes),
  }));
  const valuator = await buildRafflePrizeValuator(
    db,
    parsed.flatMap((p) => p.lines),
  );

  const rows: RaffleHistoryRow[] = [];
  let completedPrizeCostUsd = 0;
  let activePrizeValueUsd = 0;
  let completedCount = 0;
  let activeCount = 0;

  for (const { row, lines } of parsed) {
    const status: RaffleHistoryRow["status"] =
      row.status === "active" ? "active" : "completed";
    const prizeValueUsd = valuator.valueLines(lines);
    if (status === "completed") {
      completedPrizeCostUsd += prizeValueUsd;
      completedCount += 1;
    } else {
      activePrizeValueUsd += prizeValueUsd;
      activeCount += 1;
    }
    rows.push({
      id: row.id,
      title: row.name,
      status,
      prizeValueUsd,
      totalEntries: Number(row.total_entries ?? 0),
      participantCount: Number(row.participant_count ?? 0),
      endsAtIso: row.ends_at ? row.ends_at.toISOString() : null,
      completedAtIso: row.completed_at ? row.completed_at.toISOString() : null,
    });
  }

  return {
    rows,
    completedPrizeCostUsd,
    activePrizeValueUsd,
    completedCount,
    activeCount,
    truncated,
  };
}

const cachedHistory = unstable_cache(
  () => computeRaffleLifetimeHistory(),
  ["insights-rewards-raffle-lifetime-history-v1"],
  {
    revalidate: 300,
    tags: ["insights-rewards", "insights-rewards-raffle", "edge-plan-2"],
  },
);

/** Cached (300s) lifetime raffle history — the table is tiny, prices move slowly. */
export async function getRaffleLifetimeHistory(): Promise<RaffleLifetimeHistory> {
  return cachedHistory();
}
