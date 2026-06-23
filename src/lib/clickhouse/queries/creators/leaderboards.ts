import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { LeaderboardRanking } from "@/lib/queries/creators-leaderboards";

import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * Phase 2B — Affiliate-leaderboard live standings, read from the ClickHouse prod
 * game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getAffiliateLeaderboardRankings`
 * (src/lib/queries/creators-leaderboards.ts) — the `/creators/leaderboards/[id]`
 * standings panel. Returns the SAME {@link LeaderboardRanking}[] shape so
 * comparison mode can diff the two engines.
 *
 * ─── What is replicated (the cent/count-exact, scalar-diffable core) ─────────
 *   • position           — 1-based rank by wager DESC (same ORDER + LIMIT as PG).
 *   • userId / username / email — joined from public_user.
 *   • totalWageredUsd    — Σ coalesce(weighted_wager_amount_usd, wager_amount_usd)
 *                          attributed to the leaderboard's code(s) in [start,end),
 *                          grouped per referred user (one usage_type='wager' row
 *                          per wager). The WEIGHTED amount mirrors the PG twin +
 *                          backend. Money kept Decimal end-to-end.
 *   • prizeUsd           — matched from the caller-supplied prize tiers by exact
 *                          position, IDENTICALLY to the PG twin (pure TS), so it
 *                          is parity-exact whenever the positions match.
 *   • housePnlUsd        — House P&L over the bounded window [start,end) for each
 *                          standing user, the CH twin of
 *                          `calculateUsersBoundedWindowedPnlBatch` (pnl.ts) — the
 *                          five-term windowed-delta formula, mirrored leg-for-leg.
 *
 * ─── SCOPE — mirrors the PG twin EXACTLY ─────────────────────────────────────
 * The standings JOIN excludes `role IN ('admin','support')` (a 2-ROLE scope —
 * creators are KEPT, this is a creator-run event) plus the excluded-users
 * blacklist on the user id, exactly like the PG `u.role NOT IN ('admin','support')
 * ${blacklist}` clause. The wholesale 3-role `customerScopeCte` is deliberately
 * NOT used (it would drop creators and make comparison drift signal an intended
 * scope difference rather than a real engine/CDC bug). The bounded windowed PnL
 * batch carries NO role/blacklist filter of its own — exactly like the PG batch,
 * which is already scoped to the standings user ids it is handed.
 *
 * Code resolution mirrors PG: an explicit `affiliateCodes` list scopes by code
 * string; an EMPTY list ("all codes") resolves every code owned by the
 * participating creators AND additionally narrows usage rows to
 * `affiliate_user_id IN <participatingCreators>` so a transferred code can't leak
 * pre-transfer activity into the standings. Casing is normalised exactly like PG
 * (`upper(acu.code)` vs uppercased input codes).
 *
 * ─── Scoped OUT of the comparison (documented, mirrors the code-analytics twin)
 *   • positionReachedAt  — a per-row TIMESTAMP enrichment (when the user first
 *     crossed into their current place), derived from a running-total window over
 *     the CDC-laggy wager stream. It is NOT a money/count field, so the drift
 *     primitives (which diff numbers) cannot measure it; replicating the PG
 *     window+FILTER + uuid tie-break across the live mirror adds engine-specific
 *     divergence with zero scalar-diffable value. It is returned as `null` (a
 *     valid `string | null`); the served Postgres payload carries the real value
 *     (comparison mode never swaps the served value). The wager standings + house
 *     P&L are what the comparison validates.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • FINAL + `_peerdb_is_deleted = 0` on EVERY mirror table (incl. JOINs/sub-selects).
 *   • Money stays Decimal — toString(sum(...)) in SQL, toNumber() in TS, never Float.
 *   • `if()` money zero-branches use a scale-matched `toDecimal128(0, 2)` so the
 *     cents survive (a bare `0` would coerce the whole expression to scale 0).
 *   • The `jsonb` `metadata` column is mirrored as Nullable(String);
 *     `metadata->>'k'` maps to `JSONExtractString(ifNull(metadata, ''), 'k')`
 *     (the `ifNull` makes the predicate FALSE — never NULL — for uncategorized
 *     rows, matching the PG `IS NOT NULL` 3VL guard so a negated CASE keeps them).
 *   • All inputs bound as `{name:Type}` params — never string-concatenated.
 *
 * The blacklist is passed IN by the caller (resolved from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres/Prisma client.
 */

/** Stats-excluded `admin_balance_adjustment` predicate (CH twin of
 * `statsExcludedAdjustmentSqlPredicate`). NULL-safe via ifNull so a negated
 * (CASE ... ELSE delta) use keeps uncategorized rows — matches PG. */
const STATS_EXCLUDED_CH =
  "lt.type = 'admin_balance_adjustment' AND JSONExtractString(ifNull(lt.metadata, ''), 'adjustment_category') IN ('official_stream','remove_locked_balance')";

type Opts = {
  creatorUserId: string;
  coCreatorUserIds?: string[];
  affiliateCodes: string[];
  startDate: Date;
  endDate: Date;
  prizeTiers: { position: number; prize_amount_usd: string }[];
  limit?: number;
};

type StandingRow = {
  user_id: string;
  username: string | null;
  email: string | null;
  total_wagered: string;
};

/**
 * ClickHouse twin of `getAffiliateLeaderboardRankings`. Returns the SAME
 * `LeaderboardRanking[]` (positionReachedAt scoped out → null; see header).
 */
export async function getAffiliateLeaderboardRankingsFromClickHouse(
  opts: Opts,
  blacklist: string[],
): Promise<LeaderboardRanking[]> {
  const { creatorUserId, startDate, endDate, prizeTiers } = opts;
  const coCreatorUserIds = (opts.coCreatorUserIds ?? []).filter(
    (id) => id && id !== creatorUserId,
  );
  const participatingCreatorIds = [creatorUserId, ...coCreatorUserIds];
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), 500));

  const hasBlacklist = blacklist.length > 0;
  const start = chDateTime(startDate);
  const end = chDateTime(endDate);

  // Resolve the code set: explicit list, or "all codes" owned by the
  // participating creators (mirrors the PG fallback branch).
  const codeFallback = opts.affiliateCodes.length === 0;
  let codes = opts.affiliateCodes;
  if (codeFallback) {
    const ownedRows = await clickhouseRead.query<{ code: string }>({
      queryName: "creators.leaderboards.codes",
      sql: `
        SELECT ac.code AS code
        FROM ${CH_DB}.public_affiliate_codes AS ac FINAL
        WHERE ac._peerdb_is_deleted = 0
          AND ac.user_id IN {creators:Array(String)}`,
      params: { creators: participatingCreatorIds },
    });
    codes = ownedRows.map((c) => c.code);
  }
  if (codes.length === 0) return [];

  const upperCodes = Array.from(new Set(codes.map((c) => c.toUpperCase())));

  // ─── Wager standings ────────────────────────────────────────────────────
  // 2-role scope + blacklist on the user id (mirrors PG `u.role NOT IN
  // ('admin','support') ${blacklist}`). The codeFallback path additionally
  // narrows usage rows to the participating creators (transferred-code guard).
  const standingsParams: Record<string, unknown> = {
    codes: upperCodes,
    start,
    end,
    blacklist,
    creators: participatingCreatorIds,
    lim: limit,
  };
  const standingsSql = `
    WITH real_users AS (
      SELECT id, username, email
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )
    SELECT
      acu.referred_user_id AS user_id,
      u.username AS username,
      u.email AS email,
      toString(sum(coalesce(acu.weighted_wager_amount_usd, acu.wager_amount_usd))) AS total_wagered
    FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
    INNER JOIN real_users AS u ON u.id = acu.referred_user_id
    WHERE acu._peerdb_is_deleted = 0
      AND acu.usage_type = 'wager'
      AND upper(acu.code) IN {codes:Array(String)}
      AND acu.created_at >= {start:DateTime64(6)}
      AND acu.created_at <  {end:DateTime64(6)}
      ${codeFallback ? "AND acu.affiliate_user_id IN {creators:Array(String)}" : ""}
    GROUP BY acu.referred_user_id, u.username, u.email
    HAVING sum(coalesce(acu.weighted_wager_amount_usd, acu.wager_amount_usd)) > 0
    ORDER BY sum(coalesce(acu.weighted_wager_amount_usd, acu.wager_amount_usd)) DESC
    LIMIT {lim:UInt32}`;

  const rows = await clickhouseRead.query<StandingRow>({
    queryName: "creators.leaderboards.standings",
    sql: standingsSql,
    params: standingsParams,
  });

  // position → prize lookup (identical to PG).
  const prizeByPosition = new Map<number, number>();
  for (const t of prizeTiers) {
    prizeByPosition.set(t.position, toNumber(t.prize_amount_usd));
  }

  const userIds = rows.map((r) => r.user_id);
  const totals = rows.map((r) => toNumber(r.total_wagered));

  const pnlByUser = await getBoundedWindowedPnlFromClickHouse(
    userIds,
    startDate,
    endDate,
  );

  return rows.map((r, i) => {
    const position = i + 1;
    return {
      position,
      userId: r.user_id,
      username: r.username ?? null,
      email: r.email ?? null,
      totalWageredUsd: totals[i]!,
      housePnlUsd: pnlByUser.get(r.user_id) ?? 0,
      prizeUsd: prizeByPosition.get(position) ?? null,
      // Scoped out of the CH comparison twin (per-row timestamp enrichment —
      // see module header). The served Postgres payload keeps the real value.
      positionReachedAt: null,
    };
  });
}

type LedgerRow = {
  user_id: string;
  deposits: string;
  manual_wd: string;
  balance_change: string;
};
type AmountRow = { user_id: string; amount: string };
type InvRow = { user_id: string; obtained: string; ui_disposed: string };

/**
 * House P&L per user over the bounded window `[start, end)` — the ClickHouse
 * twin of `calculateUsersBoundedWindowedPnlBatch` (src/lib/queries/pnl.ts). The
 * five-term windowed-delta formula:
 *
 *   pnl = deposits − (manualWd + cardWd) − balanceΔ − inventoryΔ − voucherΔ
 *
 * mirrored leg-for-leg (seven aggregates, combined per user in TS exactly like
 * the PG batch). Users absent from the result map default to 0.
 */
async function getBoundedWindowedPnlFromClickHouse(
  userIds: string[],
  startDate: Date,
  endDate: Date,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (userIds.length === 0) return result;

  const params: Record<string, unknown> = {
    uids: userIds,
    start: chDateTime(startDate),
    end: chDateTime(endDate),
  };

  const ledgerSql = `
    SELECT lt.user_id AS user_id,
      toString(sum(if(lt.type = 'deposit', abs(lt.amount), toDecimal128(0, 2)))) AS deposits,
      toString(sum(if(lt.type = 'admin_balance_adjustment'
                       AND lt.balance_after < lt.balance_before
                       AND lt.description ILIKE 'Manual withdrawal:%',
                      lt.amount, toDecimal128(0, 2)))) AS manual_wd,
      toString(sum(if(${STATS_EXCLUDED_CH}, toDecimal128(0, 2), lt.balance_after - lt.balance_before))) AS balance_change
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {start:DateTime64(6)}
      AND lt.created_at <  {end:DateTime64(6)}
      AND lt.user_id IN {uids:Array(String)}
    GROUP BY lt.user_id`;

  const cardSql = `
    SELECT cwr.user_id AS user_id,
      toString(sum(cwr.total_value_usd)) AS amount
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND coalesce(cwr.shipped_at, cwr.completed_at) >= {start:DateTime64(6)}
      AND coalesce(cwr.shipped_at, cwr.completed_at) <  {end:DateTime64(6)}
      AND cwr.user_id IN {uids:Array(String)}
    GROUP BY cwr.user_id`;

  const invSql = `
    SELECT ui.user_id AS user_id,
      toString(sum(if(ui.obtained_at >= {start:DateTime64(6)} AND ui.obtained_at < {end:DateTime64(6)},
                      ui.value_at_obtained, toDecimal128(0, 2)))) AS obtained,
      toString(sum(if((ui.sold_at >= {start:DateTime64(6)} AND ui.sold_at < {end:DateTime64(6)})
                       OR (ui.exchanged_at >= {start:DateTime64(6)} AND ui.exchanged_at < {end:DateTime64(6)}),
                      ui.value_at_obtained, toDecimal128(0, 2)))) AS ui_disposed
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.user_id IN {uids:Array(String)}
      AND (
        (ui.obtained_at >= {start:DateTime64(6)} AND ui.obtained_at < {end:DateTime64(6)})
        OR (ui.sold_at >= {start:DateTime64(6)} AND ui.sold_at < {end:DateTime64(6)})
        OR (ui.exchanged_at >= {start:DateTime64(6)} AND ui.exchanged_at < {end:DateTime64(6)})
      )
    GROUP BY ui.user_id`;

  // Ledger-only admin inventory disposals (rows hard-deleted before sold_at
  // stamping). NOT-EXISTS → NOT IN over the same users' inventory ids (an item
  // referenced by a user's removal row, if it still exists, belongs to that
  // user — so scoping the subquery to {uids} is equivalent and bounded).
  const adminInvSql = `
    SELECT lt.user_id AS user_id,
      toString(sum(abs(lt.amount))) AS amount
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {start:DateTime64(6)}
      AND lt.created_at <  {end:DateTime64(6)}
      AND lt.type = 'admin_balance_adjustment'
      AND JSONExtractString(ifNull(lt.metadata, ''), 'kind') = 'inventory_removal'
      AND lt.user_id IN {uids:Array(String)}
      AND JSONExtractString(ifNull(lt.metadata, ''), 'inventory_item_id') NOT IN (
        SELECT toString(ui2.id)
        FROM ${CH_DB}.public_user_inventory AS ui2 FINAL
        WHERE ui2._peerdb_is_deleted = 0
          AND ui2.user_id IN {uids:Array(String)}
      )
    GROUP BY lt.user_id`;

  const vchIssuedSql = `
    SELECT v.user_id AS user_id,
      toString(sum(v.value)) AS amount
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.user_id IN {uids:Array(String)}
      AND v.created_at >= {start:DateTime64(6)}
      AND v.created_at <  {end:DateTime64(6)}
    GROUP BY v.user_id`;

  const vchClaimedSql = `
    SELECT v.user_id AS user_id,
      toString(sum(v.value)) AS amount
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.user_id IN {uids:Array(String)}
      AND v.claimed_at >= {start:DateTime64(6)}
      AND v.claimed_at <  {end:DateTime64(6)}
    GROUP BY v.user_id`;

  const adminVchSql = `
    SELECT lt.user_id AS user_id,
      toString(sum(abs(lt.amount))) AS amount
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {start:DateTime64(6)}
      AND lt.created_at <  {end:DateTime64(6)}
      AND lt.type = 'admin_balance_adjustment'
      AND JSONExtractString(ifNull(lt.metadata, ''), 'kind') = 'voucher_removal'
      AND lt.user_id IN {uids:Array(String)}
      AND JSONExtractString(ifNull(lt.metadata, ''), 'voucher_id') NOT IN (
        SELECT toString(v2.id)
        FROM ${CH_DB}.public_vouchers AS v2 FINAL
        WHERE v2._peerdb_is_deleted = 0
          AND v2.user_id IN {uids:Array(String)}
      )
    GROUP BY lt.user_id`;

  const [ledger, card, inv, adminInv, vchIssued, vchClaimed, adminVch] =
    await Promise.all([
      clickhouseRead.query<LedgerRow>({
        queryName: "creators.leaderboards.pnl.ledger",
        sql: ledgerSql,
        params,
      }),
      clickhouseRead.query<AmountRow>({
        queryName: "creators.leaderboards.pnl.card",
        sql: cardSql,
        params,
      }),
      clickhouseRead.query<InvRow>({
        queryName: "creators.leaderboards.pnl.inventory",
        sql: invSql,
        params,
      }),
      clickhouseRead.query<AmountRow>({
        queryName: "creators.leaderboards.pnl.adminInventory",
        sql: adminInvSql,
        params,
      }),
      clickhouseRead.query<AmountRow>({
        queryName: "creators.leaderboards.pnl.voucherIssued",
        sql: vchIssuedSql,
        params,
      }),
      clickhouseRead.query<AmountRow>({
        queryName: "creators.leaderboards.pnl.voucherClaimed",
        sql: vchClaimedSql,
        params,
      }),
      clickhouseRead.query<AmountRow>({
        queryName: "creators.leaderboards.pnl.adminVoucher",
        sql: adminVchSql,
        params,
      }),
    ]);

  const ledgerByUser = new Map(ledger.map((r) => [r.user_id, r]));
  const cardByUser = new Map(card.map((r) => [r.user_id, r]));
  const invByUser = new Map(inv.map((r) => [r.user_id, r]));
  const adminInvByUser = new Map(adminInv.map((r) => [r.user_id, r]));
  const vchIssuedByUser = new Map(vchIssued.map((r) => [r.user_id, r]));
  const vchClaimedByUser = new Map(vchClaimed.map((r) => [r.user_id, r]));
  const adminVchByUser = new Map(adminVch.map((r) => [r.user_id, r]));

  for (const userId of userIds) {
    const lt = ledgerByUser.get(userId);
    const deposits = toNumber(lt?.deposits);
    const manualWd = toNumber(lt?.manual_wd);
    const cardWd = toNumber(cardByUser.get(userId)?.amount);
    const balanceChange = toNumber(lt?.balance_change);
    const invRow = invByUser.get(userId);
    const inventoryChange =
      toNumber(invRow?.obtained) -
      (toNumber(invRow?.ui_disposed) +
        toNumber(adminInvByUser.get(userId)?.amount));
    const voucherChange =
      toNumber(vchIssuedByUser.get(userId)?.amount) -
      (toNumber(vchClaimedByUser.get(userId)?.amount) +
        toNumber(adminVchByUser.get(userId)?.amount));
    const pnl =
      deposits -
      (manualWd + cardWd) -
      balanceChange -
      inventoryChange -
      voucherChange;
    result.set(userId, pnl);
  }

  return result;
}
