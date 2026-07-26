import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { WAGER_TYPES_SQL } from "@/lib/metrics/ledger-sets";

export type TopPack24hRow = {
  id: string;
  name: string;
  imageUrl: string | null;
  opens: number;
};

/**
 * Top N packs by REAL opening count over the rolling last 24 hours.
 * Combines solo opens AND battle opens — a pack that runs mostly in
 * battles still ranks correctly. Reward packs
 * (`packs.pack_type = 'reward'`) are excluded, since the panel is
 * meant to surface what real users are actually paying to open.
 * Used by the Analytics → Pack & Battle tab as a "what's hot RIGHT
 * NOW" leaderboard.
 *
 * Counting:
 *   • Solo   — one row per `game_sessions` with `game_type = 'pack'`.
 *   • Battle — one row per (`battle_participants` row, pack-in
 *     `battles.pack_ids`) pair. Each participant opens every pack
 *     listed on the battle, so UNNEST gives the right granularity.
 *     Bot participants (`battle_participants.user_id IS NULL`) and
 *     staff + creators (admin / support / creator) are filtered out,
 *     matching the canonical customer scope (scope.ts).
 *
 * Pack openings via `user_packs` (legacy reward grants, gift-card
 * grants, etc.) are still not counted, matching the rest of the
 * analytics layer.
 */
async function computeTopOpenedPacks24h(
  limit: number,
  excluded: string[],
): Promise<TopPack24hRow[]> {
  const db = await getDrizzleDb();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  // Clamp the limit so a caller-side bug can't pull thousands of rows.
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

  const rows = await queryRows<
    { id: string; name: string; image_url: string | null; opens: string }[]
  >(db, `
    WITH solo_opens AS (
      SELECT gs.game_id AS pack_id, COUNT(*) AS opens
      FROM game_sessions gs
      WHERE gs.game_type = 'pack'
        AND gs.created_at >= NOW() - INTERVAL '24 hours'
        AND gs.user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
        )
      GROUP BY gs.game_id
    ),
    battle_opens AS (
      -- Each battle_participant opens every pack listed on the battle.
      -- UNNEST(pack_ids) yields one row per (participant, pack) pair —
      -- counting those rows gives real per-pack open counts that match
      -- the user's intuition ("this pack was opened N times"). Bots
      -- have user_id IS NULL and are excluded by both filters below.
      SELECT pid::uuid AS pack_id, COUNT(*) AS opens
      FROM battle_participants bp
      JOIN battles b ON b.id = bp.battle_id
      CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
      WHERE bp.created_at >= NOW() - INTERVAL '24 hours'
        AND bp.user_id IS NOT NULL
        AND bp.user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
        )
      GROUP BY pid
    ),
    total_opens AS (
      SELECT pack_id, SUM(opens) AS opens
      FROM (
        SELECT pack_id, opens FROM solo_opens
        UNION ALL
        SELECT pack_id, opens FROM battle_opens
      ) x
      GROUP BY pack_id
    )
    SELECT
      p.id::text       AS id,
      p.name,
      p.image_url,
      t.opens::text    AS opens
    FROM total_opens t
    JOIN packs p ON p.id = t.pack_id
    WHERE p.pack_type <> 'reward'
    ORDER BY t.opens DESC
    LIMIT ${safeLimit}
  `);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    imageUrl: r.image_url,
    opens: Number(r.opens),
  }));
}

/**
 * Cross-request cache for the "top opened packs (24h)" leaderboard.
 * `/analytics` → Pack & Battle tab re-runs on every 5-minute `AutoRefresh`
 * tick for every viewer; without a shared cache this solo+battle opens scan
 * re-ran per tick per viewer. 60s `unstable_cache` keyed on `(limit,
 * sortedBlacklist)` — the window is a fixed rolling 24h so a single short
 * layer suffices. Logic identical to `computeTopOpenedPacks24h`; mirrors the
 * `getAnalyticsData` cache idiom in `analytics.ts`.
 */
const cachedTopOpenedPacks24h = unstable_cache(
  computeTopOpenedPacks24h,
  ["analytics-top-opened-packs-24h-v1"],
  { revalidate: 60, tags: ["analytics"] },
);

export async function getTopOpenedPacks24h(
  limit = 20,
): Promise<TopPack24hRow[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cachedTopOpenedPacks24h(limit, sorted);
}

/**
 * Pack + battle profitability deep-dive.
 *
 * Payout model is the VERIFIED inventory-delta one (CLAUDE.md / pnl.ts
 * `getPackBattlePurePnl` / insights-games `packs.ts`): a pack/battle open
 * writes ONE ledger row = the gross stake (`pack_opening` / `battle_bet` /
 * `battle_sponsorship`); the WIN is NOT a ledger row — it lands ONLY in
 * `user_inventory.value_at_obtained` (`source_type IN ('pack','battle')`,
 * keyed by `obtained_at`). So a pack's payout = the inventory value of what
 * was won from it, NOT a `card_sale` ledger sum. Card sales / exchanges are
 * NEUTRAL disposals of value the user already owns (see
 * `@/lib/metrics/ledger-sets` NEUTRAL_TYPES) and must never sit on the
 * payout side — folding them in is what the old query did, double-counting
 * the auto-resale leg.
 *
 * Type sets come from the canonical `@/lib/metrics/ledger-sets`
 * (`WAGER_TYPES_SQL` = pack_opening / battle_bet / battle_sponsorship) — no
 * inline type list. The
 * scope (real customers: admin/support/creator dropped + excluded-users
 * blacklist) and the borrow exclusion (symmetric on wager AND payout) match
 * the canonical migration in `analytics-cohorts.ts` and the verified
 * `getPackBattlePurePnl` / insights-games scope. Creators are now dropped
 * here too (they were not before) so this surface reports REAL customer
 * gaming economics, consistent with every other gaming-margin surface.
 *
 * Per-pack stats (solo opens — `packs` + ledger + user_inventory):
 *   • opens — count of completed non-borrow pack_opening transactions
 *   • revenue — Σ |amount| of those non-borrow pack_opening rows (the
 *     user's actual cash stake; the borrowed leg never lands on the ledger)
 *   • payouts — Σ `user_inventory.value_at_obtained` for cards obtained
 *     from this pack's non-borrow solo opens (source_type='pack',
 *     source_id = the originating game_session, joined to packs via
 *     game_sessions.game_id)
 *   • gross_margin — revenue − payouts (house POV)
 *   • margin_pct — gross_margin / revenue (house edge realized)
 *
 * Per-battle-pack stats (from battles → pack_ids):
 *   • battles_played — count of non-borrow battles that included this pack
 *   • revenue — Σ |battle_bet|+|battle_sponsorship| stake, split EVENLY
 *     across the packs on each battle (a 2-pack battle = half the stake per
 *     pack) so a pack's slice isn't double-counted on multi-pack battles
 *   • payouts — Σ `user_inventory.value_at_obtained` for cards won in those
 *     battles (source_type='battle', source_id = participant's
 *     game_session), split evenly across the battle's packs on the SAME
 *     basis as revenue. No more hardcoded `'0'`. The `battle_refund` cash
 *     winner leg (the only ledger-resident gaming payout per
 *     `@/lib/metrics` GAMING_PAYOUT_TYPES) is NOT attributed here: it
 *     carries no verified per-pack linkage, and the two authoritative
 *     per-pack references (`getPackBattlePurePnl`, insights-games
 *     `packs.ts`) both compute battle-pack payout from the inventory delta
 *     ALONE for exactly this reason.
 *   • gross_margin — revenue − payouts
 *
 * Period-scoped. Borrow plays excluded entirely (both sides).
 */

export type PacksPeriod = "7d" | "30d" | "90d" | "all";

/**
 * Lifetime lookback cap (days) so the `all` window never triggers an
 * unbounded full-history scan (CLAUDE.md "Performance & Daten-Laden").
 * Mirrors the reward-insights / shard / xp-sales 365d cap.
 */
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(period: PacksPeriod): number {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return LIFETIME_LOOKBACK_DAYS;
  }
}

export type PackProfitRow = {
  id: string;
  name: string;
  opens: number;
  revenue: number;
  payouts: number;
  grossMargin: number;
  marginPct: number;
};

export type BattlePackProfitRow = {
  id: string;
  name: string;
  battlesPlayed: number;
  revenue: number;
  payouts: number;
  grossMargin: number;
  marginPct: number;
};

export type PacksProfitData = {
  period: PacksPeriod;
  packs: PackProfitRow[];
  battles: BattlePackProfitRow[];
};

async function computePackProfitability(
  period: PacksPeriod,
  excluded: string[],
): Promise<PacksProfitData> {
  const db = await getDrizzleDb();
  const days = daysForPeriod(period);
  const ltWhere = `AND lt.created_at >= NOW() - INTERVAL '${days} days'`;
  // Inventory rows are bucketed by `obtained_at` (when the card landed),
  // not the ledger `created_at`, so the payout side gets its own cutoff —
  // same split the canonical inventory-payout queries use.
  const uiWhere = `AND ui.obtained_at >= NOW() - INTERVAL '${days} days'`;
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  // Canonical real-customers scope (matches getPackBattlePurePnl /
  // insights-games / analytics-cohorts): drop admin + support + creator and
  // the admin-managed excluded-users blacklist. Creator stream play is
  // house-funded promo, never a real customer's economics, so it does not
  // belong in a gaming-margin surface. Inlined here as a subquery because
  // the per-pack attribution joins are row-level (the aggregate
  // `@/lib/metrics/queries` scope helper can't be reused for per-row joins).
  const realCustomers = `(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn})`;
  // Non-borrow solo-pack sessions (same fragment as analytics-cohorts.ts /
  // insights-games _shared.ts), applied SYMMETRICALLY on the solo wager +
  // payout so borrow plays drop out of both (canonical GGR excludes borrow
  // entirely). Only the solo payout CTE needs it as a subquery — its CTE
  // does not join battles; the battle CTEs join `battles b` directly and
  // check `b.borrow_percentage = 0` inline.
  const nonBorrowPackSessions = `(
    SELECT game_session_id FROM ledger_transactions
    WHERE type::text = 'pack_opening' AND status = 'completed'
      AND game_session_id IS NOT NULL
      AND (description IS NULL OR description NOT ILIKE '%borrow%')
  )`;

  const [packRows, battleRows] = await Promise.all([
    queryRows<
      {
        id: string;
        name: string;
        opens: string;
        revenue: string;
        payouts: string;
      }[]
    >(db, `
      WITH pack_opens AS (
        -- Solo wager: completed, non-borrow pack_opening rows. The ledger
        -- amount is the user's ACTUAL paid stake (the borrowed leg never
        -- bills through the ledger). WAGER_TYPES_SQL is the canonical
        -- @/lib/metrics set; pack_opening is its solo member.
        SELECT
          gs.game_id AS pack_id,
          COUNT(*)::text AS opens,
          COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS revenue
        FROM ledger_transactions lt
        JOIN game_sessions gs ON gs.id = lt.game_session_id AND gs.game_type = 'pack'
        WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
          AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
          AND lt.user_id IN ${realCustomers}
          ${ltWhere}
        GROUP BY gs.game_id
      ),
      pack_payouts AS (
        -- Payout = the inventory value of the cards the user KEPT from this
        -- pack's non-borrow solo opens (the verified inventory-delta model;
        -- card_sale / card_exchange are NEUTRAL disposals, deliberately NOT
        -- counted here). user_inventory.source_id holds the originating
        -- game_session_id when source_type = 'pack'; join to game_sessions
        -- to map to the pack. Borrow plays excluded to match the wager side.
        SELECT
          gs.game_id AS pack_id,
          COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text AS payouts
        FROM user_inventory ui
        JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
        WHERE ui.source_type = 'pack'
          AND ui.user_id IN ${realCustomers}
          AND ui.source_id IN ${nonBorrowPackSessions}
          ${uiWhere}
        GROUP BY gs.game_id
      )
      SELECT
        p.id::text AS id,
        p.name,
        COALESCE(po.opens, '0') AS opens,
        COALESCE(po.revenue, '0') AS revenue,
        COALESCE(pp.payouts, '0') AS payouts
      FROM packs p
      LEFT JOIN pack_opens po ON po.pack_id = p.id
      LEFT JOIN pack_payouts pp ON pp.pack_id = p.id
      WHERE po.pack_id IS NOT NULL
      ORDER BY COALESCE(po.revenue::numeric, 0) DESC
      LIMIT 20
    `),
    queryRows<
      {
        id: string;
        name: string;
        battles_played: string;
        revenue: string;
        payouts: string;
      }[]
    >(db, `
      WITH battle_wager AS (
        -- Battle wager per pack: each participant's battle_bet /
        -- battle_sponsorship ledger row (their ACTUAL cash stake across all
        -- real participants, NOT just the creator's bet_amount), joined to
        -- its battle via battle_participants.game_session_id, then split
        -- EVENLY across the packs on that battle (a 2-pack battle = half the
        -- stake per pack) so multi-pack battles don't double-count a pack's
        -- slice. WAGER_TYPES_SQL is the canonical @/lib/metrics set; the
        -- battle_participants join restricts it to the battle members
        -- (pack_opening rows never match a participant session). Non-borrow
        -- battles only.
        SELECT
          pid::uuid AS pack_id,
          bp.battle_id,
          ABS(lt.amount::numeric) / GREATEST(array_length(b.pack_ids, 1), 1) AS wager
        FROM ledger_transactions lt
        JOIN battle_participants bp ON bp.game_session_id = lt.game_session_id
        JOIN battles b ON b.id = bp.battle_id
        CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
        WHERE lt.type::text IN ${WAGER_TYPES_SQL} AND lt.status = 'completed'
          AND COALESCE(b.borrow_percentage, 0) = 0
          AND lt.user_id IN ${realCustomers}
          ${ltWhere}
      ),
      battle_wager_agg AS (
        SELECT
          pack_id,
          COUNT(DISTINCT battle_id)::text AS battles_played,
          COALESCE(SUM(wager), 0)::text AS revenue
        FROM battle_wager
        GROUP BY pack_id
      ),
      battle_payouts AS (
        -- Battle payout per pack: the inventory value of cards won from
        -- battle plays (source_type='battle', source_id = the participant's
        -- game_session_id), mapped to the battle via battle_participants,
        -- then split EVENLY across the battle's packs on the SAME basis as
        -- the wager. This is the verified inventory-delta payout (the only
        -- pack/battle win record); card_sale / card_exchange are NEUTRAL and
        -- not counted. Non-borrow battles only, real customers only.
        SELECT
          pid::uuid AS pack_id,
          COALESCE(SUM(ui.value_at_obtained::numeric / GREATEST(array_length(b.pack_ids, 1), 1)), 0)::text AS payouts
        FROM user_inventory ui
        JOIN battle_participants bp ON bp.game_session_id = ui.source_id
        JOIN battles b ON b.id = bp.battle_id
        CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
        WHERE ui.source_type = 'battle'
          AND COALESCE(b.borrow_percentage, 0) = 0
          AND ui.user_id IN ${realCustomers}
          ${uiWhere}
        GROUP BY pid
      )
      SELECT
        p.id::text AS id,
        p.name,
        COALESCE(ba.battles_played, '0') AS battles_played,
        COALESCE(ba.revenue, '0') AS revenue,
        COALESCE(bpay.payouts, '0') AS payouts
      FROM packs p
      LEFT JOIN battle_wager_agg ba ON ba.pack_id = p.id
      LEFT JOIN battle_payouts bpay ON bpay.pack_id = p.id
      WHERE ba.pack_id IS NOT NULL
      ORDER BY COALESCE(ba.revenue::numeric, 0) DESC
      LIMIT 20
    `),
  ]);

  const packs: PackProfitRow[] = packRows.map((r) => {
    const revenue = toNumber(r.revenue);
    const payouts = toNumber(r.payouts);
    const grossMargin = revenue - payouts;
    const marginPct = revenue > 0 ? grossMargin / revenue : 0;
    return {
      id: r.id,
      name: r.name,
      opens: Number(r.opens),
      revenue,
      payouts,
      grossMargin,
      marginPct,
    };
  });

  const battles: BattlePackProfitRow[] = battleRows.map((r) => {
    const revenue = toNumber(r.revenue);
    const payouts = toNumber(r.payouts);
    const grossMargin = revenue - payouts;
    const marginPct = revenue > 0 ? grossMargin / revenue : 0;
    return {
      id: r.id,
      name: r.name,
      battlesPlayed: Number(r.battles_played),
      revenue,
      payouts,
      grossMargin,
      marginPct,
    };
  });

  return { period, packs, battles };
}

/**
 * Cross-request cache for the pack/battle profitability deep-dive.
 * `/analytics` → Pack & Battle tab re-runs on every 5-minute `AutoRefresh`
 * tick for every viewer; without a shared cache the two per-pack
 * attribution scans re-ran per tick per viewer. Two `unstable_cache`
 * layers — 60s for the finite windows, 300s for the (365d-capped) lifetime
 * view — keyed on `(period, sortedBlacklist)`. Logic identical to
 * `computePackProfitability`; mirrors the `getAnalyticsData` cache idiom in
 * `analytics.ts`. The `all` window is already bounded to
 * `LIFETIME_LOOKBACK_DAYS` (365d), so no unbounded scan remains here.
 */
const cachedPackProfitability = unstable_cache(
  computePackProfitability,
  ["analytics-pack-profitability-v1"],
  { revalidate: 60, tags: ["analytics"] },
);

const cachedPackProfitabilityLifetime = unstable_cache(
  computePackProfitability,
  ["analytics-pack-profitability-lifetime-v1"],
  { revalidate: 300, tags: ["analytics"] },
);

export async function getPackProfitability(
  period: PacksPeriod,
): Promise<PacksProfitData> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return period === "all"
    ? cachedPackProfitabilityLifetime(period, sorted)
    : cachedPackProfitability(period, sorted);
}
