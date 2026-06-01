"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getPackDrilldown,
  type PackDrilldownData,
} from "@/lib/queries/insights-games/pack-drilldown";
import {
  getBattleDrilldown,
  type BattleDrilldownData,
} from "@/lib/queries/insights-games/battle-drilldown";
import {
  getUpgraderBucketTopUsers,
  type UpgraderBucketTopUser,
  type UpgraderBucketKey,
} from "@/lib/queries/insights-games/upgrader-drilldown";
import { parseGamesPeriod } from "@/lib/queries/insights-games/_shared";

/**
 * Server actions backing the lazy-loading drilldown popovers on
 * /insights/games.
 *
 * All three actions gate on `requirePageAccess('/insights/games')` so
 * a tampered RPC matches the page's permission model. Free strings
 * (period, bucket key) are sanitized via the same parsers the page
 * itself uses — unknown/invalid values fall through to safe defaults
 * rather than throwing.
 */

export async function fetchPackDrilldown(
  packId: string,
  periodParam: string,
): Promise<PackDrilldownData | null> {
  await requirePageAccess("/insights/games");
  const period = parseGamesPeriod(periodParam);
  return getPackDrilldown(packId, period);
}

export async function fetchBattleDrilldown(
  battleId: string,
): Promise<BattleDrilldownData | null> {
  await requirePageAccess("/insights/games");
  return getBattleDrilldown(battleId);
}

const VALID_BUCKETS: readonly UpgraderBucketKey[] = [
  "<2×",
  "2–5×",
  "5–10×",
  "10–25×",
  "25–100×",
  "100×+",
  "Unknown",
];

function parseBucket(value: string): UpgraderBucketKey | null {
  return (VALID_BUCKETS as readonly string[]).includes(value)
    ? (value as UpgraderBucketKey)
    : null;
}

export async function fetchUpgraderBucketTopUsers(
  periodParam: string,
  bucketParam: string,
): Promise<UpgraderBucketTopUser[]> {
  await requirePageAccess("/insights/games");
  const period = parseGamesPeriod(periodParam);
  const bucket = parseBucket(bucketParam);
  if (!bucket) return [];
  return getUpgraderBucketTopUsers(period, bucket);
}
