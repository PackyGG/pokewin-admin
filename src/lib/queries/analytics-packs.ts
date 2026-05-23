import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";

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
 *     staff (admin / support) are filtered out.
 *
 * Pack openings via `user_packs` (legacy reward grants, gift-card
 * grants, etc.) are still not counted, matching the rest of the
 * analytics layer.
 */
export async function getTopOpenedPacks24h(
  limit = 20,
): Promise<TopPack24hRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  // Clamp the limit so a caller-side bug can't pull thousands of rows.
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

  const rows = await db.$queryRawUnsafe<
    { id: string; name: string; image_url: string | null; opens: string }[]
  >(`
    WITH solo_opens AS (
      SELECT gs.game_id AS pack_id, COUNT(*) AS opens
      FROM game_sessions gs
      WHERE gs.game_type = 'pack'
        AND gs.created_at >= NOW() - INTERVAL '24 hours'
        AND gs.user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn}
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
          WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn}
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
 * Pack + battle profitability deep-dive.
 *
 * Per-pack stats (from `packs` + ledger_transactions):
 *   • opens — count of completed pack_opening transactions
 *   • revenue — sum of wager amounts
 *   • payouts — sum of card_sale + reward_card_sale + card_exchange
 *     amounts from game_sessions tied to this pack
 *   • gross_margin — revenue − payouts (house POV)
 *   • margin_pct — gross_margin / revenue (house edge realized)
 *
 * Per-battle-pack stats (from battles → pack_ids):
 *   • battles_played — count of battles that included this pack
 *   • revenue — sum of bet_amount across those battles
 *   • payouts — sum of card_sale tied to the battle's game_sessions
 *   • gross_margin — revenue − payouts
 *
 * Period-scoped. Staff excluded (joined through the user role filter).
 */

export type PacksPeriod = "7d" | "30d" | "90d" | "all";

function daysForPeriod(period: PacksPeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return null;
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

export async function getPackProfitability(
  period: PacksPeriod,
): Promise<PacksProfitData> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const ltWhere =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  const [packRows, battleRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        id: string;
        name: string;
        opens: string;
        revenue: string;
        payouts: string;
      }[]
    >(`
      WITH pack_opens AS (
        SELECT
          gs.game_id AS pack_id,
          COUNT(*)::text AS opens,
          COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS revenue
        FROM ledger_transactions lt
        JOIN game_sessions gs ON gs.id = lt.game_session_id AND gs.game_type = 'pack'
        WHERE lt.type = 'pack_opening' AND lt.status = 'completed'
          AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn})
          ${ltWhere}
        GROUP BY gs.game_id
      ),
      pack_payouts AS (
        -- Payouts = card sales + exchanges from inventory items whose
        -- originating game_session is a pack opening. user_inventory.source_id
        -- holds the game_session_id when source_type = 'pack'; from there we
        -- look up packs via game_sessions.game_id.
        SELECT
          gs.game_id AS pack_id,
          COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS payouts
        FROM ledger_transactions lt
        JOIN user_inventory ui ON ui.id = (lt.metadata->>'inventory_item_id')::uuid
          AND ui.source_type = 'pack'
        JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
        WHERE lt.type IN ('card_sale','reward_card_sale','card_exchange','exchange_excess_credit')
          AND lt.status = 'completed'
          AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn})
          ${ltWhere}
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
      ORDER BY COALESCE(po.revenue::numeric, 0) DESC
      LIMIT 20
    `),
    db.$queryRawUnsafe<
      {
        id: string;
        name: string;
        battles_played: string;
        revenue: string;
        payouts: string;
      }[]
    >(`
      WITH battle_packs AS (
        SELECT
          pid::uuid AS pack_id,
          b.id AS battle_id,
          b.bet_amount,
          b.created_at
        FROM battles b
        CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
        WHERE b.status = 'completed'
          AND b.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn})
          ${days !== null ? `AND b.created_at >= NOW() - INTERVAL '${days} days'` : ""}
      ),
      battle_agg AS (
        SELECT
          pack_id,
          COUNT(DISTINCT battle_id)::text AS battles_played,
          COALESCE(SUM(bet_amount::numeric), 0)::text AS revenue
        FROM battle_packs
        GROUP BY pack_id
      )
      SELECT
        p.id::text AS id,
        p.name,
        COALESCE(ba.battles_played, '0') AS battles_played,
        COALESCE(ba.revenue, '0') AS revenue,
        '0' AS payouts
      FROM packs p
      LEFT JOIN battle_agg ba ON ba.pack_id = p.id
      WHERE ba.battles_played IS NOT NULL
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
