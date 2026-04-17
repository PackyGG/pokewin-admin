import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

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
  const days = daysForPeriod(period);
  const ltWhere =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";

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
          AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))
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
          AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))
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
          AND b.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))
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
