import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import {
  realCustomersScopeSql,
} from "@/lib/queries/insights-games/_shared";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import {
  daysForInsightsPeriodCapped,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";
import { getInsightsRewardsBlacklist } from "./_cache";

/**
 * Daily / free packs — the house giveaway cost that shows up nowhere else.
 *
 * WHAT A DAILY PACK IS (evidence-based identifier):
 *   `packs.pack_type = 'reward'`. These are the zero-price packs the
 *   site hands users for free (the daily reward + welcome reward grants
 *   reference them via `rewards.pack_ids`; every such pack has
 *   `price = 0`). This is the SAME identifier the gaming-edge query
 *   uses to EXCLUDE them from pack P&L — see
 *   `insights-games/packs.ts` (`WHERE p.pack_type <> 'reward'`). A free
 *   pack is ~$0 wager but the user still wins real cards, so it is a
 *   pure house cost that the gaming edge deliberately drops and that no
 *   reward surface counted until now.
 *
 * THE COST (House-POV → rose):
 *   When a reward pack is opened it spins a `game_session`
 *   (`game_type = 'pack'`, `game_id = pack.id`) and the won card lands
 *   in `user_inventory` with `source_id = game_session.id`. The won-card
 *   rows split across BOTH `source_type = 'pack'` AND
 *   `source_type = 'reward'` depending on the grant path, so we join on
 *   the session id (NOT on a single source_type) to capture every card a
 *   reward-pack open delivered — this reconciles 1:1 with the
 *   `provably_fair_results.inventory_item_id` delivery linkage.
 *
 *     giveawayPayout = Σ user_inventory.value_at_obtained   (cards out)
 *     wager          = Σ game_sessions.bet_amount           (≈ $0)
 *     netCost        = giveawayPayout − wager               (house cost)
 *
 *   `netCost` is the figure surfaced as the headline cost — the value of
 *   cards we gave away, net of the (near-zero) wager the open collected.
 *   A reward pack that was somehow charged (a rare data artefact where
 *   `bet_amount > 0`) nets its wager back out so it is not double-counted
 *   as a giveaway.
 *
 * SCOPE (canonical, not hand-rolled):
 *   `realCustomersScopeSql()` (drops staff — admin/support/creator — and
 *   the admin-managed excluded-users blacklist) + the
 *   `getCreatorSessionWindowsCte()` stream-window exclusion applied to
 *   `user_inventory.obtained_at`, exactly as the /insights/games pack
 *   query scopes its payout side. Period-scoped on `obtained_at`.
 *
 * Read-only. Two-layer cache (60s finite / 300s lifetime) keyed on the
 * blacklist signature, same as every other insights-rewards helper.
 */

export type DailyPackRow = {
  packId: string;
  name: string;
  slug: string;
  /** Distinct reward-pack opens (game_sessions) in the window. */
  opens: number;
  /** Distinct users who opened this pack in the window. */
  claimers: number;
  /** Σ value_at_obtained of cards delivered from this pack's opens. */
  giveawayPayout: number;
  /** Σ bet_amount on this pack's opens (≈ 0). */
  wager: number;
  /** giveawayPayout − wager — the house giveaway cost for this pack. */
  netCost: number;
};

export type DailyPacksGiveaway = {
  period: InsightsRewardsPeriod;
  /** Σ value_at_obtained across every reward-pack open in the window. */
  giveawayPayout: number;
  /** Σ bet_amount across those opens (≈ 0). */
  wager: number;
  /** giveawayPayout − wager — total house giveaway cost (House-POV). */
  netCost: number;
  /** Distinct reward-pack opens in the window. */
  opens: number;
  /** Distinct users who claimed at least one reward pack in the window. */
  claimers: number;
  /** Number of cards handed out from reward-pack opens. */
  cards: number;
  /** giveawayPayout / opens — average house cost per daily pack opened. */
  avgCostPerPack: number;
  /** Per-pack breakdown (e.g. Daily Tier 1 / Daily Tier 10). */
  packs: DailyPackRow[];
  /**
   * Daily giveaway-cost series for the in-page chart (ascending date).
   * `total` is the value of cards handed out that day (the giveaway
   * cost curve, House-POV → rose). Stays non-negative: the near-zero
   * wager is excluded from the curve — it's gameplay revenue that lives
   * on the GGR side, not a reduction of the giveaway.
   */
  dailySeries: Array<{ date: string; total: number }>;
};

async function computeDailyPacksGiveaway(
  period: InsightsRewardsPeriod,
  _blacklistIds: string[],
): Promise<DailyPacksGiveaway> {
  // `realCustomersScopeSql()` already folds in the resolved blacklist; the
  // `_blacklistIds` arg only participates in the cache key so an admin edit
  // to the excluded-users list busts the cache (mirrors the other helpers).
  void _blacklistIds;
  return withTiming("insights-rewards.daily-packs", async () => {
    const db = await getDb();
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();

    // Lifetime (`all`) CAPPED to INSIGHTS_LIFETIME_LOOKBACK_DAYS (365d) via
    // daysForInsightsPeriodCapped so the giveaway sweep over the full
    // user_inventory history never runs unbounded (CLAUDE.md "Performance
    // & Daten-Laden"). Finite windows are unchanged.
    const uiCutoff = `AND ui.obtained_at >= NOW() - INTERVAL '${daysForInsightsPeriodCapped(period)} days'`;

    // The not-on-stream guard: drop cards a creator obtained while live
    // on a deal (house-funded promo play). Applied to obtained_at, the
    // same column the window is scoped on. `scope` already drops every
    // creator wholesale, so this is belt-and-suspenders symmetric with
    // the games-pack payout side.
    const notOnStream = `
      AND NOT EXISTS (
        SELECT 1 FROM session_windows sw
        WHERE sw.uid = ui.user_id
          AND ui.obtained_at >= sw.win_start
          AND ui.obtained_at <  sw.win_end
      )`;

    // ── Per-pack rollup ──────────────────────────────────────────────
    // One row per reward pack: distinct opens (sessions), distinct
    // claimers, Σ card value handed out, Σ wager collected on those
    // opens. Cards join through the originating session id, so both
    // source_type='pack' and source_type='reward' rows are captured.
    type PackRow = {
      pack_id: string;
      name: string;
      slug: string;
      opens: string;
      claimers: string;
      giveaway_payout: string;
      wager: string;
    };
    const packRows = await db.$queryRawUnsafe<PackRow[]>(
      `WITH ${sessionWindowsCte},
        reward_cards AS (
          SELECT
            gs.game_id        AS pack_id,
            ui.user_id        AS user_id,
            ui.source_id      AS session_id,
            ui.value_at_obtained::numeric AS card_value
          FROM user_inventory ui
          JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
          JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
          WHERE ui.user_id IN ${scope}
            ${uiCutoff}
            ${notOnStream}
        ),
        per_session_wager AS (
          -- One wager figure per distinct opened session (bet_amount is
          -- per-session, not per-card — dedupe before summing so a
          -- multi-card open doesn't multiply the wager).
          SELECT DISTINCT rc.session_id, rc.pack_id, gs.bet_amount::numeric AS bet_amount
          FROM reward_cards rc
          JOIN game_sessions gs ON gs.id = rc.session_id
        )
        SELECT
          p.id::text AS pack_id,
          p.name AS name,
          p.slug AS slug,
          COALESCE((SELECT COUNT(DISTINCT rc.session_id) FROM reward_cards rc WHERE rc.pack_id = p.id), 0)::text AS opens,
          COALESCE((SELECT COUNT(DISTINCT rc.user_id) FROM reward_cards rc WHERE rc.pack_id = p.id), 0)::text AS claimers,
          COALESCE((SELECT SUM(rc.card_value) FROM reward_cards rc WHERE rc.pack_id = p.id), 0)::text AS giveaway_payout,
          COALESCE((SELECT SUM(psw.bet_amount) FROM per_session_wager psw WHERE psw.pack_id = p.id), 0)::text AS wager
        FROM packs p
        WHERE p.pack_type = 'reward'
        ORDER BY giveaway_payout DESC`,
    );

    // ── Top-line totals ──────────────────────────────────────────────
    // Distinct opens / claimers across ALL reward packs (a user opening
    // two different tiers is one claimer overall, so we can't just sum
    // the per-pack claimer counts). Card count + payout + wager too.
    type TotalRow = {
      opens: string;
      claimers: string;
      cards: string;
      giveaway_payout: string;
      wager: string;
    };
    const totalRows = await db.$queryRawUnsafe<TotalRow[]>(
      `WITH ${sessionWindowsCte},
        reward_cards AS (
          SELECT
            ui.id             AS inv_id,
            ui.user_id        AS user_id,
            ui.source_id      AS session_id,
            ui.value_at_obtained::numeric AS card_value
          FROM user_inventory ui
          JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
          JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
          WHERE ui.user_id IN ${scope}
            ${uiCutoff}
            ${notOnStream}
        ),
        per_session_wager AS (
          SELECT DISTINCT rc.session_id, gs.bet_amount::numeric AS bet_amount
          FROM reward_cards rc
          JOIN game_sessions gs ON gs.id = rc.session_id
        )
        SELECT
          COALESCE((SELECT COUNT(DISTINCT session_id) FROM reward_cards), 0)::text AS opens,
          COALESCE((SELECT COUNT(DISTINCT user_id) FROM reward_cards), 0)::text AS claimers,
          COALESCE((SELECT COUNT(inv_id) FROM reward_cards), 0)::text AS cards,
          COALESCE((SELECT SUM(card_value) FROM reward_cards), 0)::text AS giveaway_payout,
          COALESCE((SELECT SUM(bet_amount) FROM per_session_wager), 0)::text AS wager`,
    );

    // ── Daily series ─────────────────────────────────────────────────
    // Per-day giveaway cost = value of cards handed out that day. The
    // near-zero wager is intentionally NOT subtracted here (see the
    // dailySeries doc on the return type) so the curve is the pure
    // giveaway and stays non-negative.
    type DailyRow = { date: Date; payout: string };
    const dailyRows = await db.$queryRawUnsafe<DailyRow[]>(
      `WITH ${sessionWindowsCte},
        reward_cards AS (
          SELECT
            DATE(ui.obtained_at) AS date,
            ui.value_at_obtained::numeric AS card_value
          FROM user_inventory ui
          JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
          JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
          WHERE ui.user_id IN ${scope}
            ${uiCutoff}
            ${notOnStream}
        )
        SELECT
          rc.date AS date,
          COALESCE(SUM(rc.card_value), 0)::text AS payout
        FROM reward_cards rc
        GROUP BY rc.date
        ORDER BY rc.date ASC`,
    );

    const packs: DailyPackRow[] = packRows.map((r) => {
      const giveawayPayout = toNumber(r.giveaway_payout);
      const wager = toNumber(r.wager);
      return {
        packId: r.pack_id,
        name: r.name,
        slug: r.slug,
        opens: Number(r.opens),
        claimers: Number(r.claimers),
        giveawayPayout,
        wager,
        netCost: giveawayPayout - wager,
      };
    });

    const t = totalRows[0];
    const giveawayPayout = toNumber(t?.giveaway_payout);
    const wager = toNumber(t?.wager);
    const netCost = giveawayPayout - wager;
    const opens = Number(t?.opens ?? 0);
    const claimers = Number(t?.claimers ?? 0);
    const cards = Number(t?.cards ?? 0);

    const dailySeries = dailyRows.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      total: toNumber(d.payout),
    }));

    return {
      period,
      giveawayPayout,
      wager,
      netCost,
      opens,
      claimers,
      cards,
      avgCostPerPack: opens > 0 ? giveawayPayout / opens : 0,
      packs,
      dailySeries,
    };
  });
}

const cachedDailyPacks = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDailyPacksGiveaway(period, blacklistIds),
  ["insights-rewards-daily-packs-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedDailyPacksLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDailyPacksGiveaway(period, blacklistIds),
  ["insights-rewards-daily-packs-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

/**
 * Cached entry-point. Cache key carries the period + the sorted
 * blacklist signature so admin edits to the excluded-users list bust
 * stale aggregates on the next tick. 60s revalidate for finite windows,
 * 300s for lifetime — same split as every other insights-rewards helper.
 */
export async function getDailyPacksGiveaway(
  period: InsightsRewardsPeriod,
): Promise<DailyPacksGiveaway> {
  const blacklist = await getInsightsRewardsBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedDailyPacksLifetime(period, blacklist)
    : cachedDailyPacks(period, blacklist);
}

/**
 * Lightweight total-only accessor for the cross-category rollup +
 * per-category breakdown so the Overview tab stops under-counting reward
 * cost.
 *
 * The rollup's "marketing cost" lens is the value the house GIVES users.
 * For daily packs that is `giveawayPayout` — the worth of the cards
 * handed out — NOT the net-of-wager figure: the (near-zero) wager those
 * opens collect already flows through the `pack_opening` ledger into GGR,
 * so netting it here would double-count it AND could perversely shrink
 * the marketing total. Cost = cards out. Derived from the identical
 * cached query (no second DB sweep — the full result is already cached).
 */
export async function getDailyPacksTotalCost(
  period: InsightsRewardsPeriod,
): Promise<{ cost: number; count: number; claimers: number }> {
  const g = await getDailyPacksGiveaway(period);
  return { cost: g.giveawayPayout, count: g.opens, claimers: g.claimers };
}
