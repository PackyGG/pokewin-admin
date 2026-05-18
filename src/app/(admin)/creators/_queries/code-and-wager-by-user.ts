import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Card-display metadata for a list-page creator card: code, wager
 * volume, signups, FTDs, and last-3-day deposit/wager momentum.
 *
 * PnL fields used to live here too (`pnlByPeriod`, `lifetimePnl`).
 * They were removed when /creators dropped its PnL surface — the
 * acu-based attribution + per-(creator, user) cap that makes those
 * numbers correct lives on /creators/[id] only. Showing summary
 * numbers in the list without the same treatment was misleading,
 * especially for the case where one referred user makes a large
 * non-coded deposit and the resulting card withdrawal lands fully on
 * the creator's books.
 */
export type CreatorCodeAndWager = {
  /**
   * Code this creator OWNS. Sourced from `affiliate_codes`, oldest-
   * first — same convention `/creators/[id]`'s `primaryCode` uses.
   */
  code: string | null;
  /**
   * Lifetime wager volume booked against this creator's code — sum of
   * `acu.wager_amount_usd` for `usage_type='wager'` rows. Replaces the
   * prior source (`affiliate_accounts.total_wager_volume_usd`) which
   * was silently incremented by `deposit_amount_usd` at deposit time,
   * conflating deposits with wagers.
   */
  wagerVolumeUsd: number;
  /**
   * Total signup count — `user` rows with `referred_by = creator.id`.
   */
  signups: number;
  /**
   * Lifetime first-time depositors — distinct referred users with an
   * acu deposit row under this creator AND a non-zero
   * `balances.total_deposited`. Same as `/creators/[id]`'s
   * `ftdByPeriod.all`.
   */
  ftds: number;
  /**
   * 3-day rolling deposit volume from this creator's affiliates,
   * sourced from `acu.deposit_amount_usd` — event-level code
   * attribution.
   */
  deposits3dUsd: number;
  /** 3-day rolling wager volume — `acu.wager_amount_usd`. */
  wagers3dUsd: number;
};

type DepositRow = {
  creator_user_id: string;
  deposits_3d: string;
};

type WagerRow = {
  creator_user_id: string;
  wagers_3d: string;
  total_wagered: string;
};

/**
 * Fetch (code, wagerVolumeUsd, signups, ftds, deposits3d, wagers3d)
 * for a list of creator user_ids in batch. Keyed on user_id; missing
 * creators get a zero/null record so callers can `.get(id) ?? EMPTY`
 * without guards.
 *
 * Five parallel round-trips.
 */
async function buildBlacklistAnd(): Promise<string> {
  const excluded = await getExcludedUserIds();
  return excluded.length > 0
    ? ` AND u.id NOT IN (${excluded.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
    : "";
}

export async function getCodeAndWagerByUser(
  userIds: string[],
): Promise<Map<string, CreatorCodeAndWager>> {
  const result = new Map<string, CreatorCodeAndWager>();
  if (userIds.length === 0) return result;

  const db = await getDb();
  const blacklistAnd = await buildBlacklistAnd();

  const [codeRows, signupRows, ftdRows, depositRows, wagerRows] =
    await Promise.all([
      // Oldest affiliate_codes row per user_id — same convention as
      // `/creators/[id]`'s primaryCode.
      db.$queryRawUnsafe<{ user_id: string; code: string }[]>(
        `SELECT DISTINCT ON (user_id) user_id, code
           FROM affiliate_codes
          WHERE user_id = ANY($1::text[])
          ORDER BY user_id, created_at ASC`,
        userIds,
      ),

      db.$queryRawUnsafe<{ user_id: string; signups: string }[]>(
        `SELECT referred_by AS user_id, COUNT(*)::text AS signups
           FROM "user"
          WHERE referred_by = ANY($1::text[])
          GROUP BY referred_by`,
        userIds,
      ),

      // Lifetime FTDs per creator: DISTINCT referred users (via acu
      // `usage_type='deposit'`) who have non-zero `balances.total_deposited`.
      db.$queryRawUnsafe<{ user_id: string; ftds: string }[]>(
        `SELECT acu.affiliate_user_id AS user_id,
                COUNT(DISTINCT acu.referred_user_id)::text AS ftds
           FROM affiliate_code_usages acu
           JOIN balances b
             ON b.user_id = acu.referred_user_id
            AND b.total_deposited > 0
          WHERE acu.affiliate_user_id = ANY($1::text[])
            AND acu.usage_type = 'deposit'
          GROUP BY acu.affiliate_user_id`,
        userIds,
      ),

      // Per-creator 3-day deposits — `acu.deposit_amount_usd` with
      // `usage_type='deposit'` in the last 3 days.
      db.$queryRawUnsafe<DepositRow[]>(
        `SELECT acu.affiliate_user_id AS creator_user_id,
                COALESCE(SUM(acu.deposit_amount_usd::numeric), 0)::text AS deposits_3d
           FROM affiliate_code_usages acu
           JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = ANY($1::text[])
            AND acu.usage_type::text = 'deposit'
            AND acu.created_at >= NOW() - INTERVAL '3 days'
            AND u.role NOT IN ('admin', 'support', 'creator')
            AND u.id != acu.affiliate_user_id${blacklistAnd}
          GROUP BY acu.affiliate_user_id`,
        userIds,
      ),

      // Per-creator wager totals — 3-day and lifetime, in one scan.
      db.$queryRawUnsafe<WagerRow[]>(
        `SELECT acu.affiliate_user_id AS creator_user_id,
                COALESCE(SUM(CASE WHEN acu.created_at >= NOW() - INTERVAL '3 days'
                                   THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS wagers_3d,
                COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS total_wagered
           FROM affiliate_code_usages acu
           JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = ANY($1::text[])
            AND acu.usage_type::text = 'wager'
            AND u.role NOT IN ('admin', 'support', 'creator')
            AND u.id != acu.affiliate_user_id${blacklistAnd}
          GROUP BY acu.affiliate_user_id`,
        userIds,
      ),
    ]);

  const codeById = new Map(codeRows.map((r) => [r.user_id, r.code]));
  const signupsById = new Map(
    signupRows.map((r) => [r.user_id, Number(r.signups)]),
  );
  const ftdsById = new Map(ftdRows.map((r) => [r.user_id, Number(r.ftds)]));
  const depById = new Map(depositRows.map((r) => [r.creator_user_id, r]));
  const wagById = new Map(wagerRows.map((r) => [r.creator_user_id, r]));

  for (const userId of userIds) {
    const dep = depById.get(userId);
    const wag = wagById.get(userId);

    result.set(userId, {
      code: codeById.get(userId) ?? null,
      wagerVolumeUsd: wag ? toNumber(wag.total_wagered) : 0,
      signups: signupsById.get(userId) ?? 0,
      ftds: ftdsById.get(userId) ?? 0,
      deposits3dUsd: dep ? toNumber(dep.deposits_3d) : 0,
      wagers3dUsd: wag ? toNumber(wag.wagers_3d) : 0,
    });
  }

  return result;
}
