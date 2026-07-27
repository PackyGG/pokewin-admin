import "server-only";

import { unstable_cache } from "next/cache";

import { readDrizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { asc, and, eq, inArray } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import { admin_audit_events } from "@/lib/db-schema/admin/schema";
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

function metadataCode(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).code;
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The six parallel round-trips behind {@link getCodeAndWagerByUser},
 * wrapped in `unstable_cache` (180s revalidate — per-creator card
 * metadata, roster-like, so a ≤3-min staleness is fine) so the card
 * enrichment isn't re-paid on every /creators render / tab flip.
 *
 * Env + blacklist are env-dependent (Main-DB via the env toggle + an
 * admin-DB read) and CANNOT be resolved inside an `unstable_cache`
 * callback (it reads the request cookie), so they're resolved OUTSIDE and
 * threaded in via this factory closure — exactly how all-creators-net-pnl.ts
 * handles it. They're folded into the key parts so prod/dev and each
 * blacklist land in a separate slot; the resolved `userIds` are appended
 * after a sentinel so two id lists can't collide in the key. Returns
 * serializable entries (an `unstable_cache` callback can't store a `Map`);
 * the public helper rebuilds the Map.
 */
const cachedCodeAndWagerEntries = (
  env: DbEnv,
  excludedIds: string[],
  userIds: string[],
) =>
  unstable_cache(
    async (): Promise<[string, CreatorCodeAndWager][]> => {
      const db = readDrizzleForEnv(env);
      const blacklistAnd =
        excludedIds.length > 0
          ? ` AND u.id NOT IN (${excludedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
          : "";

      // EXPLAIN (read-only, no ANALYZE, 2026-07-01) — all acu-keyed reads
      // below hit an index, no seq-scan on affiliate_code_usages:
      //   • FTD / deposits_3d / wagers reads → Bitmap Index Scan on
      //     idx_affiliate_code_usages_affiliate_referred
      //     (btree affiliate_user_id, referred_user_id) satisfies the
      //     `affiliate_user_id = ANY($1)` predicate. `usage_type::text` and
      //     `created_at >= NOW()-3d` are applied as post-index recheck/heap
      //     filters (not indexed); the balances/"user" joins ride
      //     balances_user_id_unique / user_pkey.
      //   • codeRows → Bitmap Index Scan on idx_affiliate_codes_user_created_at.
      // Path-1 satisfied. Index flag to consolidate (NOT applied here — MAIN
      // is read-only): a composite/partial index carrying usage_type +
      // created_at (e.g. (affiliate_user_id, usage_type, created_at)) would
      // let the deposit/wager legs skip the recheck-filter step, but current
      // cost is low and index-driven so it's an optimization, not a blocker.
      const [
        codeRows,
        signupRows,
        ftdRows,
        depositRows,
        wagerRows,
        auditCodeRows,
      ] = await Promise.all([
      // Oldest affiliate_codes row per user_id — same convention as
      // `/creators/[id]`'s primaryCode.
      queryRows<{ user_id: string; code: string }[]>(db,
        `SELECT DISTINCT ON (user_id) user_id, code
           FROM affiliate_codes
          WHERE user_id = ANY($1::text[])
          ORDER BY user_id, created_at ASC`,
        userIds,
      ),

      queryRows<{ user_id: string; signups: string }[]>(db,
        `SELECT referred_by AS user_id, COUNT(*)::text AS signups
           FROM "user"
          WHERE referred_by = ANY($1::text[])
          GROUP BY referred_by`,
        userIds,
      ),

      // Lifetime FTDs per creator: DISTINCT referred users (via acu
      // `usage_type='deposit'`) who have non-zero `balances.total_deposited`.
      queryRows<{ user_id: string; ftds: string }[]>(db,
        `SELECT acu.affiliate_user_id AS user_id,
                COUNT(DISTINCT acu.referred_user_id)::text AS ftds
           FROM affiliate_code_usages acu
           JOIN balances b
             ON b.user_id = acu.referred_user_id
            AND b.total_deposited > 0
          WHERE acu.affiliate_user_id = ANY($1::text[])
            AND acu.usage_type::text = 'deposit'
          GROUP BY acu.affiliate_user_id`,
        userIds,
      ),

      // Per-creator 3-day deposits — `acu.deposit_amount_usd` with
      // `usage_type='deposit'` in the last 3 days.
      queryRows<DepositRow[]>(db,
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
      queryRows<WagerRow[]>(db,
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

      adminDrizzle
        .select({
          target_user_id: admin_audit_events.target_user_id,
          metadata: admin_audit_events.metadata,
          created_at: admin_audit_events.created_at,
        })
        .from(admin_audit_events)
        .where(
          and(
            inArray(admin_audit_events.target_user_id, userIds),
            eq(admin_audit_events.event_type, "user_made_creator"),
          ),
        )
        .orderBy(asc(admin_audit_events.created_at)),
    ]);

      const codeById = new Map(codeRows.map((r) => [r.user_id, r.code]));
      for (const row of auditCodeRows) {
        if (!row.target_user_id || codeById.has(row.target_user_id)) continue;
        const code = metadataCode(row.metadata);
        if (code) codeById.set(row.target_user_id, code);
      }
      const signupsById = new Map(
        signupRows.map((r) => [r.user_id, Number(r.signups)]),
      );
      const ftdsById = new Map(ftdRows.map((r) => [r.user_id, Number(r.ftds)]));
      const depById = new Map(depositRows.map((r) => [r.creator_user_id, r]));
      const wagById = new Map(wagerRows.map((r) => [r.creator_user_id, r]));

      const entries: [string, CreatorCodeAndWager][] = [];
      for (const userId of userIds) {
        const dep = depById.get(userId);
        const wag = wagById.get(userId);

        entries.push([
          userId,
          {
            code: codeById.get(userId) ?? null,
            wagerVolumeUsd: wag ? toNumber(wag.total_wagered) : 0,
            signups: signupsById.get(userId) ?? 0,
            ftds: ftdsById.get(userId) ?? 0,
            deposits3dUsd: dep ? toNumber(dep.deposits_3d) : 0,
            wagers3dUsd: wag ? toNumber(wag.wagers_3d) : 0,
          },
        ]);
      }

      return entries;
    },
    [
      "creators-code-and-wager-v1",
      env,
      ...excludedIds,
      "|users|",
      ...userIds,
    ],
    { revalidate: 180, tags: ["creators-code-and-wager"] },
  );

/**
 * Fetch (code, wagerVolumeUsd, signups, ftds, deposits3d, wagers3d)
 * for a list of creator user_ids in batch. Keyed on user_id; missing
 * creators get a zero/null record so callers can `.get(id) ?? EMPTY`
 * without guards.
 */
export async function getCodeAndWagerByUser(
  userIds: string[],
): Promise<Map<string, CreatorCodeAndWager>> {
  if (userIds.length === 0) return new Map();

  // Resolve env + blacklist in REQUEST scope (cookie + admin-DB reads that
  // can't run inside the unstable_cache callback) and thread them in so
  // prod/dev and each blacklist land in a separate slot — same handling as
  // all-creators-net-pnl.ts. The userIds are sorted so the cache key is
  // stable regardless of roster order (the result Map is keyed by userId,
  // so order doesn't affect the shape).
  const env = await readDbEnv();
  const excludedIds = [...(await getExcludedUserIds())].sort();
  const sortedUserIds = [...userIds].sort();

  return new Map(
    await cachedCodeAndWagerEntries(env, excludedIds, sortedUserIds)(),
  );
}
