import "server-only";

import { adminDrizzle } from "@/lib/admin-db";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import { backendApi } from "@/lib/backend-api/client";
import {
  pnlDealsApi,
  type PnlDealResponse,
} from "@/lib/backend-api/pnl-deals";
import { queryMainRows, queryRows } from "@/lib/drizzle-query";
import { calculateFrameSitePnlUsd, roundSettlementMoney } from "@/lib/creator-pnl-settlement-math";
import { getFrameAffiliatePnlByUserUncached } from "@/app/(creator-hub)/creator-hub/profitability/_queries/frame-affiliate-pnl-by-user";

type ApprovalLinks = {
  leaderboard_id: string | null;
  leaderboard_payload: Record<string, unknown> | null;
  reward_program_id: string | null;
};

type GameplayRow = {
  category: string;
  wager_usd: string;
  payout_usd: string;
  weighted_wager_usd: string;
  weighted_payout_usd: string;
  session_count: string;
  weighted_session_count: string;
};

export type WeightedCreatorGameplay = {
  wagerUsd: number;
  payoutUsd: number;
  weightedWagerUsd: number;
  weightedPayoutUsd: number;
  weightedPnlUsd: number;
  betCount: number;
  weightedBetCount: number;
  categories: Array<{
    category: string;
    wagerUsd: number;
    payoutUsd: number;
    weightedWagerUsd: number;
    weightedPayoutUsd: number;
    weightedPnlUsd: number;
    betCount: number;
    weightedBetCount: number;
  }>;
};

type CostsRow = {
  fill_cashout_usd: string;
  tips_usd: string;
  sponsorships_usd: string;
};

const WEIGHTED_CREATOR_GAMEPLAY_CTES = `tagged AS (
       SELECT gs.id, gs.game_id, gs.game_type::text AS game_type,
              gs.created_at, gs.bet_amount::numeric AS bet_amount,
              gs.creator_pnl_real_money_bps::numeric AS real_bps
         FROM game_sessions gs
        WHERE ($1::uuid IS NULL OR gs.creator_pnl_deal_id = $1::uuid)
          AND ($2::text IS NULL OR gs.user_id = $2)
          AND gs.currency::text = 'real'
          AND gs.created_at >= $3::timestamptz
          AND gs.created_at < $4::timestamptz
          AND gs.creator_pnl_real_money_bps IS NOT NULL
     ), inventory_payout AS (
       SELECT ui.source_id AS session_id,
              SUM(ui.value_at_obtained::numeric) AS amount
         FROM user_inventory ui
         JOIN tagged t ON t.id = ui.source_id
        WHERE ui.source_type::text IN ('pack', 'battle')
        GROUP BY ui.source_id
     ), ledger_payout AS (
       SELECT lt.game_session_id AS session_id,
              SUM(ABS(lt.amount::numeric)) AS amount
         FROM ledger_transactions lt
         JOIN tagged t ON t.id = lt.game_session_id
        WHERE lt.status = 'completed'
          AND lt.type::text = 'battle_refund'
        GROUP BY lt.game_session_id
     ), voucher_payout AS (
       SELECT t.id AS session_id, SUM(v.value::numeric) AS amount
         FROM tagged t
         JOIN vouchers v ON (
           (v.origin::text = 'battle_excess_to_voucher' AND v.origin_id = t.id)
           OR (
             v.origin::text = 'battle_double_down_payout'
             AND t.game_type = 'battle_double_down'
             AND v.origin_id IN (t.id, t.game_id)
           )
         )
        GROUP BY t.id
     ), game_payout AS (
       SELECT t.id AS session_id,
              CASE
                WHEN t.game_type = 'upgrader' THEN COALESCE(ug.won_amount::numeric, 0)
                WHEN t.game_type = 'keno' THEN COALESCE(kg.won_amount::numeric, 0)
                ELSE 0
              END AS amount
         FROM tagged t
         LEFT JOIN upgrader_games ug ON t.game_type = 'upgrader' AND ug.id = t.game_id
         LEFT JOIN keno_games kg ON t.game_type = 'keno' AND kg.id = t.game_id
     ), per_session AS (
       SELECT t.id, t.game_type, t.created_at, t.bet_amount, t.real_bps,
              COALESCE(i.amount, 0) + COALESCE(l.amount, 0)
                + COALESCE(v.amount, 0) + COALESCE(g.amount, 0) AS payout
         FROM tagged t
         LEFT JOIN inventory_payout i ON i.session_id = t.id
         LEFT JOIN ledger_payout l ON l.session_id = t.id
         LEFT JOIN voucher_payout v ON v.session_id = t.id
         LEFT JOIN game_payout g ON g.session_id = t.id
     )`;

export type CreatorPnlSettlementBreakdown = {
  computation_version: "creator-pnl-v1";
  deal_id: string;
  creator_user_id: string;
  frame_start_utc: string;
  frame_end_utc: string;
  positive_pnl_share_bps: number;
  funding_mode: PnlDealResponse["funding_mode"];
  linked_fill_deal_id: string | null;
  linked_multiplier_deal_id: string | null;
  fills_allowed: number | null;
  fills_used: number | null;
  per_fill_amount_usd: number | null;
  cooldown_minutes: number | null;
  max_tip_per_stream_usd: number | null;
  max_tip_per_user_usd: number | null;
  max_sponsored_battle_usd: number | null;
  max_sponsorship_per_stream_usd: number | null;
  affiliate_contribution_usd: number;
  affiliate_deposits_usd: number;
  affiliate_withdrawals_usd: number;
  affiliate_claims_usd: number;
  creator_gameplay_wager_usd: number;
  creator_gameplay_payout_usd: number;
  creator_gameplay_weighted_wager_usd: number;
  creator_gameplay_weighted_payout_usd: number;
  creator_gameplay_weighted_pnl_usd: number;
  creator_gameplay_session_count: number;
  creator_gameplay_weighted_session_count: number;
  creator_gameplay_categories: WeightedCreatorGameplay["categories"];
  leaderboard_id: string | null;
  leaderboard_gross_prize_usd: number;
  leaderboard_refund_usd: number;
  leaderboard_sponsored_pct: number;
  leaderboard_house_cost_usd: number;
  fill_cashout_cost_usd: number;
  tip_cost_usd: number;
  sponsorship_cost_usd: number;
  reward_program_id: string | null;
  reward_program_cost_usd: number;
  frame_site_pnl_usd: number;
  terms: Record<string, unknown> | null;
};

export type CreatorPnlSettlementResult = {
  deal: PnlDealResponse;
  breakdown: CreatorPnlSettlementBreakdown;
};

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number): number {
  return roundSettlementMoney(value);
}

function sponsoredPct(payload: Record<string, unknown> | null): number | null {
  const raw = payload?.sponsoredPct;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100) {
    return null;
  }
  return raw;
}

async function getApprovalLinks(
  sourceApprovalRequestId: string | null,
): Promise<ApprovalLinks> {
  if (!sourceApprovalRequestId) {
    return {
      leaderboard_id: null,
      leaderboard_payload: null,
      reward_program_id: null,
    };
  }
  const rows = await queryRows<ApprovalLinks[]>(
    adminDrizzle,
    `SELECT leaderboard_id::text,
            leaderboard_payload,
            reward_program_id::text
       FROM creator_deal_approval_requests
      WHERE id = $1::uuid
      LIMIT 1`,
    sourceApprovalRequestId,
  );
  return (
    rows[0] ?? {
      leaderboard_id: null,
      leaderboard_payload: null,
      reward_program_id: null,
    }
  );
}

async function getRewardProgramCost(
  rewardProgramId: string | null,
  startIso: string,
  endIso: string,
): Promise<number> {
  if (!rewardProgramId) return 0;
  const rows = await queryRows<{ total: string; unresolved: string }[]>(
    adminDrizzle,
    `SELECT COALESCE(SUM(amount_usd::numeric) FILTER (
              WHERE status = 'approved' AND ledger_tx_id IS NOT NULL
            ), 0)::text AS total,
            COUNT(*) FILTER (
              WHERE status = 'pending'
                 OR (status = 'approved' AND ledger_tx_id IS NULL)
            )::text AS unresolved
       FROM creator_reward_claims
      WHERE program_id = $1::uuid
        AND requested_at >= $2::timestamptz
        AND requested_at < $3::timestamptz`,
    rewardProgramId,
    startIso,
    endIso,
  );
  if (number(rows[0]?.unresolved) > 0) {
    throw new Error("PnL settlement is waiting for in-frame reward claims to be reviewed.");
  }
  return number(rows[0]?.total);
}

export async function getWeightedCreatorGameplay(params: {
  userId?: string;
  startIso: string;
  endIso: string;
  pnlDealId?: string;
}): Promise<WeightedCreatorGameplay> {
  const rows = await queryMainRows<GameplayRow[]>(
    `WITH ${WEIGHTED_CREATOR_GAMEPLAY_CTES}
     SELECT game_type AS category,
            COALESCE(SUM(bet_amount), 0)::text AS wager_usd,
            COALESCE(SUM(payout), 0)::text AS payout_usd,
            COALESCE(SUM(bet_amount * real_bps / 10000), 0)::text
              AS weighted_wager_usd,
            COALESCE(SUM(payout * real_bps / 10000), 0)::text
              AS weighted_payout_usd,
            COUNT(*)::text AS session_count,
            COUNT(*) FILTER (WHERE real_bps > 0)::text AS weighted_session_count
       FROM per_session
      GROUP BY game_type`,
    params.pnlDealId ?? null,
    params.userId ?? null,
    params.startIso,
    params.endIso,
  );
  const categories = rows.map((row) => ({
    category: row.category,
    wagerUsd: money(number(row.wager_usd)),
    payoutUsd: money(number(row.payout_usd)),
    weightedWagerUsd: money(number(row.weighted_wager_usd)),
    weightedPayoutUsd: money(number(row.weighted_payout_usd)),
    weightedPnlUsd: money(
      number(row.weighted_wager_usd) - number(row.weighted_payout_usd),
    ),
    betCount: Math.trunc(number(row.session_count)),
    weightedBetCount: Math.trunc(number(row.weighted_session_count)),
  }));
  return categories.reduce<WeightedCreatorGameplay>(
    (total, row) => ({
      wagerUsd: money(total.wagerUsd + row.wagerUsd),
      payoutUsd: money(total.payoutUsd + row.payoutUsd),
      weightedWagerUsd: money(total.weightedWagerUsd + row.weightedWagerUsd),
      weightedPayoutUsd: money(total.weightedPayoutUsd + row.weightedPayoutUsd),
      weightedPnlUsd: money(
        total.weightedWagerUsd + row.weightedWagerUsd
          - total.weightedPayoutUsd - row.weightedPayoutUsd,
      ),
      betCount: total.betCount + row.betCount,
      weightedBetCount: total.weightedBetCount + row.weightedBetCount,
      categories: [...total.categories, row],
    }),
    {
      wagerUsd: 0,
      payoutUsd: 0,
      weightedWagerUsd: 0,
      weightedPayoutUsd: 0,
      weightedPnlUsd: 0,
      betCount: 0,
      weightedBetCount: 0,
      categories: [],
    },
  );
}

/** Site-wide counterpart for canonical global gaming stats. */
export function getWeightedCreatorGameplayForWindow(params: {
  startIso?: string;
  endIso: string;
}): Promise<WeightedCreatorGameplay> {
  return getWeightedCreatorGameplay({
    startIso: params.startIso ?? "1970-01-01T00:00:00.000Z",
    endIso: params.endIso,
  });
}

export type WeightedCreatorGameplayDay = {
  date: string;
  weightedWagerUsd: number;
  weightedPayoutUsd: number;
  weightedBetCount: number;
};

export async function getWeightedCreatorGameplayByDay(params: {
  startIso?: string;
  endIso: string;
}): Promise<WeightedCreatorGameplayDay[]> {
  const rows = await queryMainRows<
    Array<{
      date: string;
      weighted_wager_usd: string;
      weighted_payout_usd: string;
      weighted_bet_count: string;
    }>
  >(
    `WITH ${WEIGHTED_CREATOR_GAMEPLAY_CTES}
     SELECT to_char(created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
            COALESCE(SUM(bet_amount * real_bps / 10000), 0)::text AS weighted_wager_usd,
            COALESCE(SUM(payout * real_bps / 10000), 0)::text AS weighted_payout_usd,
            COUNT(*) FILTER (WHERE real_bps > 0)::text AS weighted_bet_count
       FROM per_session
      GROUP BY 1
      ORDER BY 1`,
    null,
    null,
    params.startIso ?? "1970-01-01T00:00:00.000Z",
    params.endIso,
  );
  return rows.map((row) => ({
    date: row.date,
    weightedWagerUsd: money(number(row.weighted_wager_usd)),
    weightedPayoutUsd: money(number(row.weighted_payout_usd)),
    weightedBetCount: Math.trunc(number(row.weighted_bet_count)),
  }));
}

async function getRealizedDealCosts(deal: PnlDealResponse): Promise<CostsRow> {
  const rows = await queryMainRows<CostsRow[]>(
    `WITH linked_sessions AS (
       SELECT id
         FROM creator_stream_sessions
        WHERE deal_id = $1::uuid
     ), fill_cashout AS (
       SELECT COALESCE(SUM(v.value::numeric), 0) AS amount
         FROM vouchers v
         JOIN linked_sessions s ON s.id = v.origin_id
        WHERE v.origin::text = 'creator_fill_conversion'
          AND v.created_at >= $3::timestamptz
          AND v.created_at < $4::timestamptz
     ), spend AS (
       SELECT
         COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
           WHERE lt.type::text IN ('creator_fill_spend_tip', 'creator_multiplier_spend_tip', 'rain_tip')
         ), 0) AS tips,
         COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
           WHERE lt.type::text IN ('creator_fill_spend_battle', 'creator_multiplier_spend_battle')
         ), 0) AS sponsorships
       FROM ledger_transactions lt
       WHERE lt.user_id = $2
         AND lt.status = 'completed'
         AND lt.created_at >= $3::timestamptz
         AND lt.created_at < $4::timestamptz
         AND (
           lt.metadata->>'pnl_deal_id' = $6
           OR lt.metadata->>'deal_id' IN ($1, $5)
         )
     )
     SELECT fill_cashout.amount::text AS fill_cashout_usd,
            spend.tips::text AS tips_usd,
            spend.sponsorships::text AS sponsorships_usd
       FROM fill_cashout CROSS JOIN spend`,
    deal.linked_fill_deal_id ?? "00000000-0000-0000-0000-000000000000",
    deal.user_id,
    deal.frame_start_utc,
    deal.frame_end_utc,
    deal.linked_multiplier_deal_id ?? "00000000-0000-0000-0000-000000000000",
    deal.id,
  );
  return rows[0] ?? {
    fill_cashout_usd: "0",
    tips_usd: "0",
    sponsorships_usd: "0",
  };
}

export async function computeCreatorPnlSettlement(
  deal: PnlDealResponse,
): Promise<CreatorPnlSettlementBreakdown> {
  const now = Date.now();
  if (new Date(deal.frame_end_utc).getTime() > now) {
    throw new Error("PnL frame has not ended.");
  }
  if (!['active', 'settlement_pending'].includes(deal.status)) {
    throw new Error(`PnL deal cannot be settled from ${deal.status}.`);
  }

  const [affiliateMap, gameplay, costs, links] = await Promise.all([
    getFrameAffiliatePnlByUserUncached([
      {
        userId: deal.user_id,
        startIso: deal.frame_start_utc,
        endIso: deal.frame_end_utc,
      },
    ]),
    getWeightedCreatorGameplay({
      userId: deal.user_id,
      startIso: deal.frame_start_utc,
      endIso: deal.frame_end_utc,
      pnlDealId: deal.id,
    }),
    getRealizedDealCosts(deal),
    getApprovalLinks(deal.source_approval_request_id),
  ]);
  const affiliate = affiliateMap.get(deal.user_id) ?? {
    affiliatesMadeUs: 0,
    deposits: 0,
    cardWithdrawals: 0,
    affiliateClaims: 0,
  };

  const [leaderboard, rewardCost] = await Promise.all([
    links.leaderboard_id
      ? affiliateLeaderboardsApi.get(links.leaderboard_id)
      : Promise.resolve(null),
    getRewardProgramCost(
      links.reward_program_id,
      deal.frame_start_utc,
      deal.frame_end_utc,
    ),
  ]);
  if (links.leaderboard_id && leaderboard?.approval_status !== "approved") {
    throw new Error("PnL settlement is waiting for the bundled leaderboard to reach an authoritative approved/refund state.");
  }
  if (
    leaderboard &&
    (new Date(leaderboard.start_date).getTime() !== new Date(deal.frame_start_utc).getTime()
      || new Date(leaderboard.end_date).getTime() !== new Date(deal.frame_end_utc).getTime())
  ) {
    throw new Error("Bundled leaderboard window does not exactly match the PnL frame.");
  }
  const lbGross = leaderboard?.approval_status === "approved"
    ? number(leaderboard.total_prize_usd)
    : 0;
  const lbRefund = leaderboard?.approval_status === "approved"
    ? number(leaderboard.refund_amount_usd)
    : 0;
  const lbPct = links.leaderboard_id
    ? sponsoredPct(links.leaderboard_payload)
    : 0;
  if (links.leaderboard_id && lbPct == null) {
    throw new Error("Bundled leaderboard is missing its snapshotted house-share percentage.");
  }
  const leaderboardCost = Math.max(0, lbGross - lbRefund) * ((lbPct ?? 0) / 100);

  const affiliateContribution = money(affiliate.affiliatesMadeUs);
  const weightedGameplay = gameplay.weightedPnlUsd;
  const fillCashout = money(number(costs.fill_cashout_usd));
  const tips = money(number(costs.tips_usd));
  const sponsorships = money(number(costs.sponsorships_usd));
  const reward = money(rewardCost);
  const lbCost = money(leaderboardCost);
  const frameSitePnl = calculateFrameSitePnlUsd({
    affiliateContributionUsd: affiliateContribution,
    weightedCreatorGameplayPnlUsd: weightedGameplay,
    leaderboardHouseCostUsd: lbCost,
    fillCashoutCostUsd: fillCashout,
    tipCostUsd: tips,
    sponsorshipCostUsd: sponsorships,
    rewardProgramCostUsd: reward,
  });

  return {
    computation_version: "creator-pnl-v1",
    deal_id: deal.id,
    creator_user_id: deal.user_id,
    frame_start_utc: deal.frame_start_utc,
    frame_end_utc: deal.frame_end_utc,
    positive_pnl_share_bps: deal.positive_pnl_share_bps,
    funding_mode: deal.funding_mode,
    linked_fill_deal_id: deal.linked_fill_deal_id,
    linked_multiplier_deal_id: deal.linked_multiplier_deal_id,
    fills_allowed: deal.fills_allowed,
    fills_used: deal.fills_used,
    per_fill_amount_usd:
      deal.per_fill_amount_usd == null ? null : money(number(deal.per_fill_amount_usd)),
    cooldown_minutes: deal.cooldown_minutes,
    max_tip_per_stream_usd:
      deal.max_tip_per_stream_usd == null ? null : money(number(deal.max_tip_per_stream_usd)),
    max_tip_per_user_usd:
      deal.max_tip_per_user_usd == null ? null : money(number(deal.max_tip_per_user_usd)),
    max_sponsored_battle_usd:
      deal.max_sponsored_battle_usd == null ? null : money(number(deal.max_sponsored_battle_usd)),
    max_sponsorship_per_stream_usd:
      deal.max_sponsorship_per_stream_usd == null
        ? null
        : money(number(deal.max_sponsorship_per_stream_usd)),
    affiliate_contribution_usd: affiliateContribution,
    affiliate_deposits_usd: money(affiliate.deposits),
    affiliate_withdrawals_usd: money(affiliate.cardWithdrawals),
    affiliate_claims_usd: money(affiliate.affiliateClaims),
    creator_gameplay_wager_usd: gameplay.wagerUsd,
    creator_gameplay_payout_usd: gameplay.payoutUsd,
    creator_gameplay_weighted_wager_usd: gameplay.weightedWagerUsd,
    creator_gameplay_weighted_payout_usd: gameplay.weightedPayoutUsd,
    creator_gameplay_weighted_pnl_usd: weightedGameplay,
    creator_gameplay_session_count: gameplay.betCount,
    creator_gameplay_weighted_session_count: gameplay.weightedBetCount,
    creator_gameplay_categories: gameplay.categories,
    leaderboard_id: links.leaderboard_id,
    leaderboard_gross_prize_usd: money(lbGross),
    leaderboard_refund_usd: money(lbRefund),
    leaderboard_sponsored_pct: lbPct ?? 0,
    leaderboard_house_cost_usd: lbCost,
    fill_cashout_cost_usd: fillCashout,
    tip_cost_usd: tips,
    sponsorship_cost_usd: sponsorships,
    reward_program_id: links.reward_program_id,
    reward_program_cost_usd: reward,
    frame_site_pnl_usd: frameSitePnl,
    terms: deal.terms,
  };
}

export async function settleCreatorPnlDeal(params: {
  userId: string;
  dealId: string;
  expectedVersion: number;
}): Promise<CreatorPnlSettlementResult> {
  const current = await pnlDealsApi.get(params.userId, params.dealId);
  if (current.status === "settled") {
    const stored = current.settlement_breakdown;
    if (
      !stored ||
      stored.deal_id !== current.id ||
      typeof stored.frame_site_pnl_usd !== "number"
    ) {
      throw new Error("Settled PnL deal is missing its immutable settlement breakdown.");
    }
    return {
      deal: current,
      breakdown: stored as CreatorPnlSettlementBreakdown,
    };
  }
  if (current.version !== params.expectedVersion) {
    throw new Error("PnL deal changed. Refresh and retry settlement.");
  }
  const breakdown = await computeCreatorPnlSettlement(current);
  const settlementInput = {
    expected_version: current.version,
    frame_site_pnl_usd: breakdown.frame_site_pnl_usd,
    settlement_breakdown: breakdown,
    reason: "Canonical pokewin-admin exact-frame settlement",
  };
  const settled = await pnlDealsApi.settle(
    current.user_id,
    current.id,
    settlementInput,
  );
  return { deal: settled, breakdown };
}

type SettlementQueueResponse = {
  data: PnlDealResponse[];
  total: number;
  limit: number;
};

/** Global due queue supplied by the backend; no local roster fan-out. */
export async function listDueCreatorPnlDeals(limit: number) {
  return backendApi
    .get<{ success: boolean; data: SettlementQueueResponse }>(
      "/admin/creator-pnl-deals/settlement-queue",
      { query: { limit } },
    )
    .then((response) => response.data);
}
