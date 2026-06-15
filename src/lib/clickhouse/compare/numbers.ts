import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { SignupMethodStats } from "@/lib/queries/signup-methods";
import type { PackMaxWinStats } from "@/lib/queries/pack-max-wins";

import { getSignupMethodStatsFromClickHouse } from "../queries/numbers/signup-methods";
import { getPackMaxWinStatsFromClickHouse } from "../queries/numbers/pack-max-wins";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /numbers page. No-op unless the `numbers`
 * surface is in `comparison` mode (itself forced off whenever ClickHouse is
 * dormant). Swallows every error — the served Postgres payload is never
 * affected.
 *
 * Two legs are diffed against their ClickHouse twins:
 *   • signup methods — totalUsers + the six per-method counts (all exact ints).
 *   • pack max wins — totalPacks + the 20× split counts (exact ints); the catalog
 *     peak multiplier is a derived ratio diffed within half a cent (both engines
 *     divide identical Decimal price strings, so it should match to the cent).
 */
function signupRecord(s: SignupMethodStats): Record<string, number> {
  const rec: Record<string, number> = { totalUsers: s.totalUsers };
  for (const m of s.methods) rec[m.key] = m.count;
  return rec;
}

function packRecord(p: PackMaxWinStats): Record<string, number> {
  return {
    totalPacks: p.totalPacks,
    above20: p.twentyXSplit.above.count,
    atOrBelow20: p.twentyXSplit.atOrBelow.count,
    peakMultiplier: p.peak?.maxWinMultiplier ?? 0,
  };
}

export async function compareNumbers(
  pgSignup: SignupMethodStats,
  pgPackMaxWins: PackMaxWinStats,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("numbers");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      const [signup, packMaxWins] = await Promise.all([
        getSignupMethodStatsFromClickHouse(blacklist),
        getPackMaxWinStatsFromClickHouse(),
      ]);
      return { signup, packMaxWins };
    });

    const signupDrift = computeDrift(
      signupRecord(pgSignup),
      signupRecord(ch.signup),
    );
    logComparison("numbers.signup_methods", signupDrift, durationMs);

    const packDrift = computeDrift(
      packRecord(pgPackMaxWins),
      packRecord(ch.packMaxWins),
      ["peakMultiplier"],
    );
    logComparison("numbers.pack_max_wins", packDrift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.numbers", "comparison failed (ignored)", err);
  }
}
