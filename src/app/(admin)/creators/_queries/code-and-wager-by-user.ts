import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export type CreatorCodeAndWager = {
  /** user.affiliate_code — the referral code this creator owns. */
  code: string | null;
  /** balances.total_wagered — lifetime wager amount, USD. */
  totalWagered: number;
};

/**
 * Fetch (code, totalWagered) for a list of creator user_ids in one
 * round-trip per source table. Keyed on user_id; missing users get a
 * zeroed/null record so callers can `.get(id) ?? EMPTY` without guards.
 *
 * The /creators page sources its list from the backend API, but the
 * code + lifetime wager fields live on the main DB (`user.affiliate_code`,
 * `balances.total_wagered`) which the backend list endpoint doesn't
 * currently surface. Doing this enrichment here avoids touching the
 * backend contract.
 */
export async function getCodeAndWagerByUser(
  userIds: string[],
): Promise<Map<string, CreatorCodeAndWager>> {
  const result = new Map<string, CreatorCodeAndWager>();
  if (userIds.length === 0) return result;

  const db = await getDb();
  const [users, balances] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, affiliate_code: true },
    }),
    db.balances.findMany({
      where: { user_id: { in: userIds } },
      select: { user_id: true, total_wagered: true },
    }),
  ]);

  const codeById = new Map(users.map((u) => [u.id, u.affiliate_code]));
  const wagerById = new Map(
    balances.map((b) => [b.user_id, toNumber(b.total_wagered)]),
  );

  for (const id of userIds) {
    result.set(id, {
      code: codeById.get(id) ?? null,
      totalWagered: wagerById.get(id) ?? 0,
    });
  }
  return result;
}
