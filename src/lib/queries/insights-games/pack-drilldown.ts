import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import {
  ggr as ggrFormula,
  empiricalRtp,
} from "@/lib/metrics/formulas";
import {
  type GamesPeriod,
  hoursForPeriod,
  realCustomersScopeSql,
} from "./_shared";
import { ratioToPct } from "./_metrics";

/**
 * Per-pack drilldown for /insights/games packs tab. One pack id +
 * the same period the parent tab uses → five focused datasets:
 *
 *   1. dailyVolume    — day-bucketed wager / payout / pnl curve for
 *                       this specific pack.
 *   2. topUsers       — top 10 users by borrow-corrected wager on
 *                       the pack in the period.
 *   3. cardDistribution — most-pulled cards out of this pack during
 *                       the window. Lets the operator see whether the
 *                       chase cards came out (high price + few hits =
 *                       lucky period; low price + many hits = grind).
 *   4. borrowSplit    — opens / wager broken into borrow vs non-borrow
 *                       buckets for the pack in the period.
 *   5. rtpDrift       — theoretical RTP from pack_cards.weight ×
 *                       cards.price (set in pack config) vs realized
 *                       RTP for the period. The delta is the house's
 *                       luck/skill drift indicator — large negative
 *                       drift = pack ran cold for users, positive =
 *                       ran hot.
 *
 * All five reuse the same scope conventions as the parent tab:
 * borrow-corrected wager (non-borrow plays only on wager + payout
 * sides where applicable), creator-on-stream rows excluded, real
 * customers only (no staff/admins/blacklist).
 *
 * The pack id is validated to be a UUID before being inlined — comes
 * from the table row's existing href, so it should never be a free
 * user input, but defense in depth.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PackDailyVolumePoint = {
  date: string;
  opens: number;
  wager: number;
  payout: number;
  pnl: number;
};

export type PackTopUserRow = {
  userId: string;
  username: string | null;
  image: string | null;
  opens: number;
  wager: number;
  payout: number;
  pnl: number;
};

export type PackCardDistributionRow = {
  cardId: string;
  name: string;
  imageUrl: string;
  pulls: number;
  totalValue: number;
  unitPrice: number;
  /** True when the row sits in the top-decile of pack price (chase). */
  isChase: boolean;
};

export type PackBorrowSplitRow = {
  label: "Borrow" | "Non-borrow";
  opens: number;
  wager: number;
  avgBorrowPct: number;
};

export type PackRtpDrift = {
  theoreticalRtpPct: number;
  /** Empirical realized RTP % — null below MIN_SAMPLE opens (insufficient sample). */
  realizedRtpPct: number | null;
  /** Realized − theoretical, in points. Null when realized is below sample. */
  driftPct: number | null;
};

export type PackDrilldownData = {
  packId: string;
  packName: string;
  packImage: string | null;
  packPrice: number;
  dailyVolume: PackDailyVolumePoint[];
  topUsers: PackTopUserRow[];
  cardDistribution: PackCardDistributionRow[];
  borrowSplit: PackBorrowSplitRow[];
  rtpDrift: PackRtpDrift;
};

export async function getPackDrilldown(
  packId: string,
  period: GamesPeriod,
): Promise<PackDrilldownData | null> {
  if (!UUID_RE.test(packId)) return null;
  return withTiming("insights-games.pack-drilldown", async () => {
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();
    const hours = hoursForPeriod(period);

    const ltCutoff =
      hours !== null
        ? `AND lt.created_at >= NOW() - INTERVAL '${hours} hours'`
        : "";
    const uiCutoff =
      hours !== null
        ? `AND ui.obtained_at >= NOW() - INTERVAL '${hours} hours'`
        : "";

    type PackRow = {
      id: string;
      name: string;
      image_url: string | null;
      price: string;
    };
    type DailyRow = {
      day: string;
      opens: string;
      wager: string;
      payout: string;
    };
    type UserRow = {
      user_id: string;
      username: string | null;
      image: string | null;
      opens: string;
      wager: string;
      payout: string;
    };
    type CardRow = {
      card_id: string;
      name: string;
      image_url: string;
      price: string;
      pulls: string;
      total_value: string;
    };
    type BorrowRow = {
      borrow_pct_avg: string | null;
      opens: string;
      wager: string;
      borrow_flag: string;
    };
    type RtpRow = {
      theoretical_rtp: string | null;
      realized_wager: string | null;
      realized_payout: string | null;
      realized_opens: string | null;
    };

    // Pack metadata — also serves as existence check; if NULL, the
    // ID is valid-shaped but doesn't correspond to a pack.
    //
    // Reward/daily packs (`pack_type = 'reward'`) are excluded (Fix 2):
    // they are a $0-wager house giveaway tracked in /insights/rewards
    // (daily-packs.ts), NOT gaming — the parent packs tab already drops
    // them (`packs.ts` WHERE p.pack_type <> 'reward'), so they are never
    // linkable here; the guard makes that structural (a reward pack id
    // returns null rather than rendering giveaway data as gaming P&L).
    const packRows = await queryMainRows<PackRow[]>(
      `SELECT id::text AS id, name, image_url, price::text AS price
       FROM packs WHERE id = '${packId}'::uuid AND pack_type <> 'reward' LIMIT 1`,
    );
    if (packRows.length === 0) return null;
    const pack = packRows[0];

    // Run all five queries in parallel — they share the same
    // session_windows CTE and the same scope SQL but each one
    // produces its own dataset.
    const [
      dailyRows,
      userRows,
      cardRows,
      borrowRows,
      rtpRows,
    ] = await Promise.all([
      // 1) Daily volume — borrow-corrected wager (non-borrow only)
      //    + payouts. Bucketed by DATE so the chart reads as a day
      //    curve.
      queryMainRows<DailyRow[]>(
        `WITH ${sessionWindowsCte},
              solo_wager AS (
           SELECT DATE(lt.created_at) AS day,
                  COUNT(*) AS opens,
                  COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager
           FROM ledger_transactions lt
           JOIN game_sessions gs ON gs.id = lt.game_session_id AND gs.game_type = 'pack'
           WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
             AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
             AND gs.game_id = '${packId}'::uuid
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
           GROUP BY day
         ),
         battle_wager AS (
           SELECT DATE(lt.created_at) AS day,
                  COUNT(*) AS opens,
                  COALESCE(SUM(ABS(lt.amount::numeric) / GREATEST(array_length(b.pack_ids, 1), 1)), 0) AS wager
           FROM ledger_transactions lt
           JOIN battle_participants bp ON bp.game_session_id = lt.game_session_id
           JOIN battles b ON b.id = bp.battle_id
           WHERE lt.type::text IN ('battle_bet','battle_sponsorship') AND lt.status = 'completed'
             AND COALESCE(b.borrow_percentage, 0) = 0
             AND '${packId}'::uuid = ANY(b.pack_ids::uuid[])
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
           GROUP BY day
         ),
         solo_payout AS (
           SELECT DATE(ui.obtained_at) AS day,
                  0 AS opens,
                  COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS payout
           FROM user_inventory ui
           JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
           WHERE ui.source_type = 'pack'
             AND gs.game_id = '${packId}'::uuid
             AND ui.user_id IN ${scope}
             AND ui.source_id IN (
               SELECT lt.game_session_id FROM ledger_transactions lt
               WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
                 AND lt.game_session_id IS NOT NULL
                 AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
             )
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
           GROUP BY day
         ),
         battle_payout AS (
           SELECT DATE(ui.obtained_at) AS day,
                  0 AS opens,
                  COALESCE(SUM(ui.value_at_obtained::numeric / GREATEST(array_length(b.pack_ids, 1), 1)), 0) AS payout
           FROM user_inventory ui
           JOIN battle_participants bp ON bp.game_session_id = ui.source_id
           JOIN battles b ON b.id = bp.battle_id
           WHERE ui.source_type = 'battle'
             AND COALESCE(b.borrow_percentage, 0) = 0
             AND '${packId}'::uuid = ANY(b.pack_ids::uuid[])
             AND ui.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
           GROUP BY day
         ),
         merged AS (
           SELECT day, opens, wager, 0::numeric AS payout FROM solo_wager
           UNION ALL
           SELECT day, opens, wager, 0::numeric AS payout FROM battle_wager
           UNION ALL
           SELECT day, opens, 0::numeric AS wager, payout FROM solo_payout
           UNION ALL
           SELECT day, opens, 0::numeric AS wager, payout FROM battle_payout
         )
         SELECT day::text AS day,
                SUM(opens)::text AS opens,
                COALESCE(SUM(wager), 0)::text AS wager,
                COALESCE(SUM(payout), 0)::text AS payout
         FROM merged
         GROUP BY day
         ORDER BY day`,
      ),
      // 2) Top users by borrow-corrected wager on the pack.
      queryMainRows<UserRow[]>(
        `WITH ${sessionWindowsCte},
              solo_wager AS (
           SELECT lt.user_id,
                  COUNT(*) AS opens,
                  COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager
           FROM ledger_transactions lt
           JOIN game_sessions gs ON gs.id = lt.game_session_id AND gs.game_type = 'pack'
           WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
             AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
             AND gs.game_id = '${packId}'::uuid
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
           GROUP BY lt.user_id
         ),
         battle_wager AS (
           SELECT lt.user_id,
                  COUNT(*) AS opens,
                  COALESCE(SUM(ABS(lt.amount::numeric) / GREATEST(array_length(b.pack_ids, 1), 1)), 0) AS wager
           FROM ledger_transactions lt
           JOIN battle_participants bp ON bp.game_session_id = lt.game_session_id
           JOIN battles b ON b.id = bp.battle_id
           WHERE lt.type::text IN ('battle_bet','battle_sponsorship') AND lt.status = 'completed'
             AND COALESCE(b.borrow_percentage, 0) = 0
             AND '${packId}'::uuid = ANY(b.pack_ids::uuid[])
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
           GROUP BY lt.user_id
         ),
         solo_payout AS (
           SELECT ui.user_id,
                  COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS payout
           FROM user_inventory ui
           JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
           WHERE ui.source_type = 'pack'
             AND gs.game_id = '${packId}'::uuid
             AND ui.user_id IN ${scope}
             AND ui.source_id IN (
               SELECT lt.game_session_id FROM ledger_transactions lt
               WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
                 AND lt.game_session_id IS NOT NULL
                 AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
             )
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
           GROUP BY ui.user_id
         ),
         battle_payout AS (
           SELECT ui.user_id,
                  COALESCE(SUM(ui.value_at_obtained::numeric / GREATEST(array_length(b.pack_ids, 1), 1)), 0) AS payout
           FROM user_inventory ui
           JOIN battle_participants bp ON bp.game_session_id = ui.source_id
           JOIN battles b ON b.id = bp.battle_id
           WHERE ui.source_type = 'battle'
             AND COALESCE(b.borrow_percentage, 0) = 0
             AND '${packId}'::uuid = ANY(b.pack_ids::uuid[])
             AND ui.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
           GROUP BY ui.user_id
         ),
         per_user AS (
           SELECT user_id, SUM(opens) AS opens, SUM(wager) AS wager, 0::numeric AS payout
           FROM (SELECT * FROM solo_wager UNION ALL SELECT * FROM battle_wager) w
           GROUP BY user_id
           UNION ALL
           SELECT user_id, 0::bigint AS opens, 0::numeric AS wager, SUM(payout) AS payout
           FROM (SELECT * FROM solo_payout UNION ALL SELECT * FROM battle_payout) p
           GROUP BY user_id
         )
         SELECT pu.user_id::text AS user_id,
                u.username AS username,
                u.image AS image,
                SUM(pu.opens)::text AS opens,
                SUM(pu.wager)::text AS wager,
                SUM(pu.payout)::text AS payout
         FROM per_user pu
         JOIN "user" u ON u.id = pu.user_id
         GROUP BY pu.user_id, u.username, u.image
         HAVING SUM(pu.wager) > 0
         ORDER BY SUM(pu.wager) DESC
         LIMIT 10`,
      ),
      // 3) Card distribution — top 15 cards pulled out of the pack in
      //    the period. ui rows whose value_at_obtained / unit_price
      //    rounds to a pull count. Joins to cards for price + image.
      queryMainRows<CardRow[]>(
        `WITH ${sessionWindowsCte},
              solo_pulls AS (
           SELECT ui.card_id, ui.value_at_obtained::numeric AS value
           FROM user_inventory ui
           JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
           WHERE ui.source_type = 'pack'
             AND gs.game_id = '${packId}'::uuid
             AND ui.user_id IN ${scope}
             AND ui.source_id IN (
               SELECT lt.game_session_id FROM ledger_transactions lt
               WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
                 AND lt.game_session_id IS NOT NULL
                 AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
             )
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
         ),
         battle_pulls AS (
           SELECT ui.card_id, ui.value_at_obtained::numeric AS value
           FROM user_inventory ui
           JOIN battle_participants bp ON bp.game_session_id = ui.source_id
           JOIN battles b ON b.id = bp.battle_id
           WHERE ui.source_type = 'battle'
             AND COALESCE(b.borrow_percentage, 0) = 0
             AND '${packId}'::uuid = ANY(b.pack_ids::uuid[])
             AND ui.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
         ),
         pulls AS (SELECT * FROM solo_pulls UNION ALL SELECT * FROM battle_pulls)
         SELECT
           c.id::text AS card_id,
           c.name AS name,
           c.image_url AS image_url,
           c.price::text AS price,
           COUNT(*)::text AS pulls,
           COALESCE(SUM(p.value), 0)::text AS total_value
         FROM pulls p
         JOIN cards c ON c.id = p.card_id
         GROUP BY c.id, c.name, c.image_url, c.price
         ORDER BY COUNT(*) DESC, COALESCE(SUM(p.value), 0) DESC
         LIMIT 15`,
      ),
      // 4) Borrow vs non-borrow split — every pack-opening ledger row
      //    for this pack in the period (battles excluded for clarity —
      //    borrow on battles is at battle level, not per-pack-open).
      //    Reads borrow_percentage off PF metadata for the per-row
      //    avg.
      queryMainRows<BorrowRow[]>(
        `WITH ${sessionWindowsCte},
              base AS (
           SELECT
             lt.id,
             ABS(lt.amount::numeric) AS cash_paid,
             COALESCE(
               (
                 SELECT NULLIF(pf.result_metadata->>'borrow_percentage', '')::numeric
                 FROM provably_fair_results pf
                 WHERE pf.game_session_id = lt.game_session_id
                 LIMIT 1
               ),
               0
             ) AS borrow_pct,
             CASE WHEN (lt.description IS NOT NULL AND lt.description ILIKE '%borrow%') THEN 1 ELSE 0 END AS is_borrow
           FROM ledger_transactions lt
           JOIN game_sessions gs ON gs.id = lt.game_session_id AND gs.game_type = 'pack'
           WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
             AND gs.game_id = '${packId}'::uuid
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
         )
         SELECT
           is_borrow::text AS borrow_flag,
           COUNT(*)::text AS opens,
           COALESCE(SUM(cash_paid), 0)::text AS wager,
           COALESCE(AVG(borrow_pct) FILTER (WHERE borrow_pct > 0), 0)::text AS borrow_pct_avg
         FROM base
         GROUP BY is_borrow`,
      ),
      // 5) RTP drift — theoretical vs realized.
      //    Theoretical: sum(weight × price) / sum(weight) over all
      //    pack_cards rows; that's the expected card value per slot,
      //    and the EV / pack price ratio is the RTP the pack is
      //    configured to pay. Multiply by cards_per_open and divide
      //    by pack price.
      //    Realized: payouts / borrow-corrected wager from the
      //    period — what the pack actually paid out vs collected.
      queryMainRows<RtpRow[]>(
        `WITH ${sessionWindowsCte},
              pack_meta AS (
           SELECT p.id, p.price::numeric AS pack_price, p.cards_per_open
           FROM packs p WHERE p.id = '${packId}'::uuid
         ),
         theoretical AS (
           SELECT
             COALESCE(SUM(pc.weight * c.price::numeric), 0) AS weighted_value,
             COALESCE(SUM(pc.weight), 0) AS total_weight
           FROM pack_cards pc
           JOIN cards c ON c.id = pc.card_id
           WHERE pc.pack_id = '${packId}'::uuid
         ),
         realized_wager AS (
           SELECT COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager,
                  COUNT(*) AS opens
           FROM ledger_transactions lt
           JOIN game_sessions gs ON gs.id = lt.game_session_id AND gs.game_type = 'pack'
           WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
             AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
             AND gs.game_id = '${packId}'::uuid
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
         ),
         realized_payout AS (
           SELECT COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS payout
           FROM user_inventory ui
           JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
           WHERE ui.source_type = 'pack'
             AND gs.game_id = '${packId}'::uuid
             AND ui.user_id IN ${scope}
             AND ui.source_id IN (
               SELECT lt.game_session_id FROM ledger_transactions lt
               WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
                 AND lt.game_session_id IS NOT NULL
                 AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
             )
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
         )
         SELECT
           CASE
             WHEN (SELECT total_weight FROM theoretical) > 0
              AND (SELECT pack_price FROM pack_meta) > 0
             THEN (
               (SELECT weighted_value FROM theoretical)
                 / (SELECT total_weight FROM theoretical)
                 * (SELECT cards_per_open FROM pack_meta)
                 / (SELECT pack_price FROM pack_meta) * 100
             )
           END::text AS theoretical_rtp,
           (SELECT wager FROM realized_wager)::text AS realized_wager,
           (SELECT payout FROM realized_payout)::text AS realized_payout,
           (SELECT opens FROM realized_wager)::text AS realized_opens`,
      ),
    ]);

    const dailyVolume: PackDailyVolumePoint[] = dailyRows.map((r) => {
      const opens = Number(r.opens);
      const wager = toNumber(r.wager);
      const payout = toNumber(r.payout);
      return {
        date: r.day,
        opens,
        wager,
        payout,
        pnl: ggrFormula({ wager, gamingPayout: payout }),
      };
    });

    // Join the per-user wager + payout sub-rows back into a single
    // row per user. They came back from a UNION ALL above so a single
    // user can appear twice — once with the wager fields populated,
    // once with the payout fields populated; merge here.
    const userMap = new Map<string, PackTopUserRow>();
    for (const r of userRows) {
      const opens = Number(r.opens);
      const wager = toNumber(r.wager);
      const payout = toNumber(r.payout);
      const existing = userMap.get(r.user_id);
      if (existing) {
        existing.opens += opens;
        existing.wager += wager;
        existing.payout += payout;
        existing.pnl = ggrFormula({
          wager: existing.wager,
          gamingPayout: existing.payout,
        });
      } else {
        userMap.set(r.user_id, {
          userId: r.user_id,
          username: r.username,
          image: r.image,
          opens,
          wager,
          payout,
          pnl: ggrFormula({ wager, gamingPayout: payout }),
        });
      }
    }
    const topUsers = [...userMap.values()]
      .sort((a, b) => b.wager - a.wager)
      .slice(0, 10);

    // Card distribution — flag chase cards as the top decile of pack
    // price (so the operator can spot whether the top hits actually
    // came out). Bound the count at 15 visible rows.
    const cardValues = cardRows.map((r) => toNumber(r.price));
    const sorted = [...cardValues].sort((a, b) => b - a);
    const chaseThreshold = sorted.length > 0 ? sorted[Math.max(0, Math.floor(sorted.length * 0.1) - 1)] : 0;
    const cardDistribution: PackCardDistributionRow[] = cardRows.map((r) => {
      const unitPrice = toNumber(r.price);
      return {
        cardId: r.card_id,
        name: r.name,
        imageUrl: r.image_url,
        pulls: Number(r.pulls),
        totalValue: toNumber(r.total_value),
        unitPrice,
        isChase: unitPrice >= chaseThreshold && chaseThreshold > 0,
      };
    });

    // Borrow split — convert the 2 grouped rows into a stable
    // 2-row response. Always emit both labels even when one bucket
    // is empty so the UI can render a consistent table.
    const split: Record<"Borrow" | "Non-borrow", PackBorrowSplitRow> = {
      Borrow: { label: "Borrow", opens: 0, wager: 0, avgBorrowPct: 0 },
      "Non-borrow": { label: "Non-borrow", opens: 0, wager: 0, avgBorrowPct: 0 },
    };
    for (const r of borrowRows) {
      const isBorrow = r.borrow_flag === "1";
      const row = isBorrow ? split.Borrow : split["Non-borrow"];
      row.opens = Number(r.opens);
      row.wager = toNumber(r.wager);
      row.avgBorrowPct = isBorrow ? toNumber(r.borrow_pct_avg) : 0;
    }
    const borrowSplit = [split["Non-borrow"], split.Borrow];

    const rtp = rtpRows[0];
    const theoreticalRtpPct =
      rtp?.theoretical_rtp != null ? toNumber(rtp.theoretical_rtp) : 0;
    // Realized RTP via the canonical sample-guarded helper — below
    // MIN_SAMPLE opens it is null (insufficient sample) rather than a
    // small-sample figure, and the drift is then undefined too.
    const realizedWager = toNumber(rtp?.realized_wager);
    const realizedPayout = toNumber(rtp?.realized_payout);
    const realizedOpens = Number(rtp?.realized_opens ?? "0");
    const realizedRtpPct = ratioToPct(
      empiricalRtp({
        gamingPayout: realizedPayout,
        wager: realizedWager,
        bets: realizedOpens,
      }),
    );
    const driftPct =
      realizedRtpPct === null ? null : realizedRtpPct - theoreticalRtpPct;

    return {
      packId: pack.id,
      packName: pack.name,
      packImage: pack.image_url,
      packPrice: toNumber(pack.price),
      dailyVolume,
      topUsers,
      cardDistribution,
      borrowSplit,
      rtpDrift: {
        theoreticalRtpPct,
        realizedRtpPct,
        driftPct,
      },
    };
  });
}
