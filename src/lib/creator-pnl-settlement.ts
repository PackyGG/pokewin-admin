import "server-only";

import { adminDrizzle } from "@/lib/admin-db";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import { queryMainRows, queryRows } from "@/lib/drizzle-query";
import { calculateFrameSitePnlUsd, roundSettlementMoney } from "@/lib/creator-pnl-settlement-math";
import { getFrameAffiliatePnlByUserUncached } from "@/app/(creator-hub)/creator-hub/profitability/_queries/frame-affiliate-pnl-by-user";
import { advanceDueCreatorPnlDeals } from "@/lib/creator-deal-approvals";

export type AdminCreatorPnlDeal = {
  id: string;
  creator_user_id: string;
  source_approval_request_id: string | null;
  status: "scheduled" | "active" | "settlement_pending" | "calculated" | "crediting" | "settled" | "cancelled";
  frame_start_utc: string;
  frame_end_utc: string;
  positive_pnl_share_bps: number;
  funding_mode: "non_withdrawable_fills" | "linked_multiplier" | "new_multiplier";
  funding_config: Record<string, unknown>;
  linked_fill_deal_id: string | null;
  linked_multiplier_deal_id: string | null;
  max_tip_per_stream_usd: string | null;
  max_tip_per_user_usd: string | null;
  max_sponsored_battle_usd: string | null;
  max_sponsorship_per_stream_usd: string | null;
  terms_snapshot: Record<string, unknown>;
  frame_site_pnl_usd: string | null;
  creator_share_usd: string | null;
  settlement_breakdown: CreatorPnlPreview | null;
  settlement_reason: string | null;
  credited_amount_usd: string | null;
  credit_ledger_id: string | null;
  credited_by_admin_user_id: string | null;
  credited_at: string | null;
  settled_at: string | null;
  credit_status: "not_ready" | "ready" | "crediting" | "credited" | "failed";
  credit_idempotency_key: string;
  credit_error: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type ApprovalLinks = {
  leaderboard_id: string | null;
  leaderboard_payload: Record<string, unknown> | null;
  reward_program_id: string | null;
};

export type CreatorPnlPreview = {
  computation_version: "admin-pnl-v2";
  computed_at: string;
  frame_start_at: string;
  frame_end_at: string;
  affiliate_contribution_usd: number;
  affiliate_deposits_usd: number;
  affiliate_withdrawals_usd: number;
  affiliate_claims_usd: number;
  creator_own_gameplay_pnl_usd: number;
  creator_own_gameplay_wager_usd: number;
  creator_own_gameplay_payout_usd: number;
  creator_own_gameplay_status: "not_applicable" | "computed" | "ambiguous";
  creator_own_gameplay_note: string;
  leaderboard_house_cost_usd: number;
  fill_cashout_cost_usd: number;
  tip_cost_usd: number;
  sponsorship_cost_usd: number;
  reward_program_cost_usd: number;
  audit: {
    pnl_deal_id: string;
    source_approval_request_id: string | null;
    positive_pnl_share_bps: number;
    funding_mode: AdminCreatorPnlDeal["funding_mode"];
    funding_config: Record<string, unknown>;
    linked_fill_deal_id: string | null;
    linked_multiplier_deal_id: string | null;
    leaderboard_id: string | null;
    leaderboard_start_utc: string | null;
    leaderboard_end_utc: string | null;
    leaderboard_gross_prize_usd: number;
    leaderboard_refund_usd: number;
    leaderboard_sponsored_pct: number | null;
    reward_program_id: string | null;
    terms_snapshot: Record<string, unknown>;
  };
  frame_site_pnl_usd: number;
  limitations: string[];
};

const n = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = roundSettlementMoney;

export async function listAdminCreatorPnlDeals(
  creatorUserId: string,
): Promise<AdminCreatorPnlDeal[]> {
  await advanceDueCreatorPnlDeals();
  return queryRows<AdminCreatorPnlDeal[]>(
    adminDrizzle,
    `SELECT id::text, creator_user_id, source_approval_request_id::text,
            status, frame_start_utc::text, frame_end_utc::text,
            positive_pnl_share_bps, funding_mode, funding_config,
            linked_fill_deal_id, linked_multiplier_deal_id,
            max_tip_per_stream_usd::text, max_tip_per_user_usd::text,
            max_sponsored_battle_usd::text,
            max_sponsorship_per_stream_usd::text, terms_snapshot,
            frame_site_pnl_usd::text, creator_share_usd::text,
            settlement_breakdown, settlement_reason, credited_amount_usd::text,
            credit_ledger_id, credited_by_admin_user_id::text,
            credited_at::text, settled_at::text, credit_status,
            credit_idempotency_key, credit_error,
            cancelled_at::text, cancellation_reason, version,
            created_at::text, updated_at::text
       FROM creator_pnl_deals
      WHERE creator_user_id = $1
      ORDER BY frame_start_utc DESC, id DESC
      LIMIT 100`,
    creatorUserId,
  );
}

export async function getAdminCreatorPnlDeal(
  creatorUserId: string,
  dealId: string,
): Promise<AdminCreatorPnlDeal | null> {
  const deals = await listAdminCreatorPnlDeals(creatorUserId);
  return deals.find((deal) => deal.id === dealId) ?? null;
}

export type WeightedCreatorGameplay = {
  weightedWagerUsd: number;
  weightedPayoutUsd: number;
  weightedPnlUsd: number;
  weightedBetCount: number;
};

export type WeightedCreatorGameplayDay = Omit<WeightedCreatorGameplay, "weightedPnlUsd"> & { date: string };

type EffectiveMultiplierInterval = {
  deal_id: string; user_id: string; start_at: string; end_at: string; real_bps: number;
};

async function effectiveMultiplierIntervals(startIso: string, endIso: string): Promise<EffectiveMultiplierInterval[]> {
  const adminRows = await queryRows<Array<{
    deal_id: string; user_id: string; multiplier_id: string; frame_start: string; frame_end: string;
  }>>(adminDrizzle,
    `SELECT id::text deal_id, creator_user_id user_id, linked_multiplier_deal_id::text multiplier_id,
            frame_start_utc::text frame_start, frame_end_utc::text frame_end
       FROM creator_pnl_deals
      WHERE status <> 'cancelled' AND funding_mode IN ('linked_multiplier','new_multiplier')
        AND linked_multiplier_deal_id IS NOT NULL
        AND frame_end_utc > $1::timestamptz AND frame_start_utc < $2::timestamptz`, startIso, endIso);
  if (adminRows.length === 0) return [];
  const lifecycle = await queryMainRows<Array<{
    id: string; user_id: string; multiplier_bps: string; activated_at: string | null; ended_at: string | null;
    user_funding_usd: string | null; total_loaded_usd: string | null;
  }>>(
    `SELECT m.id::text, m.user_id, m.multiplier_bps::text, m.activated_at::text, m.ended_at::text,
            m.user_funding_usd::text,m.total_loaded_usd::text
       FROM creator_multiplier_deals m
       JOIN jsonb_to_recordset($1::jsonb) AS wanted(id uuid) ON wanted.id=m.id`,
    JSON.stringify(adminRows.map((row) => ({ id: row.multiplier_id }))));
  const byId = new Map(lifecycle.map((row) => [row.id, row]));
  return adminRows.map((row) => {
    const linked = byId.get(row.multiplier_id);
    if (!linked || linked.user_id !== row.user_id || !linked.activated_at || n(linked.multiplier_bps) < 20_000
      || n(linked.user_funding_usd) <= 0 || n(linked.total_loaded_usd) <= 0) {
      throw new Error(`PnL multiplier lifecycle is ambiguous for Admin deal ${row.deal_id}.`);
    }
    const start = new Date(Math.max(new Date(startIso).getTime(), new Date(row.frame_start).getTime(), new Date(linked.activated_at).getTime()));
    const end = new Date(Math.min(new Date(endIso).getTime(), new Date(row.frame_end).getTime(), linked.ended_at ? new Date(linked.ended_at).getTime() : Infinity));
    return { deal_id: row.deal_id, user_id: row.user_id, start_at: start.toISOString(), end_at: end.toISOString(), real_bps: 10_000 / n(linked.multiplier_bps) * 10_000 };
  }).filter((row) => row.start_at < row.end_at);
}

const LIFECYCLE_WEIGHTED_GAMEPLAY_CTES = `intervals AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(deal_id uuid,user_id text,start_at timestamptz,end_at timestamptz,real_bps numeric)
     ), candidates AS (
       SELECT gs.id,gs.game_id,gs.game_type::text game_type,gs.created_at,gs.bet_amount::numeric bet,i.real_bps,
              COUNT(*) OVER (PARTITION BY gs.id) match_count
         FROM intervals i JOIN game_sessions gs ON gs.user_id=i.user_id
          AND gs.currency::text='real' AND gs.created_at>=i.start_at AND gs.created_at<i.end_at
     ), tagged AS (SELECT * FROM candidates WHERE match_count=1),
     inv AS (SELECT source_id,SUM(value_at_obtained::numeric) amount FROM user_inventory
       WHERE source_id IN (SELECT id FROM tagged) AND source_type::text IN ('pack','battle') GROUP BY source_id),
     led AS (SELECT game_session_id,SUM(ABS(amount::numeric)) amount FROM ledger_transactions
       WHERE game_session_id IN (SELECT id FROM tagged) AND status='completed' AND type::text='battle_refund' GROUP BY game_session_id),
     vou AS (SELECT t.id,SUM(v.value::numeric) amount FROM tagged t JOIN vouchers v ON
       (v.origin::text='battle_excess_to_voucher' AND v.origin_id=t.id) OR
       (v.origin::text='battle_double_down_payout' AND t.game_type='battle_double_down' AND v.origin_id IN (t.id,t.game_id)) GROUP BY t.id),
     per_session AS (SELECT t.id,t.created_at,t.bet,t.real_bps,
       COALESCE(i.amount,0)+COALESCE(l.amount,0)+COALESCE(v.amount,0)+
       CASE WHEN t.game_type='upgrader' THEN COALESCE(u.won_amount::numeric,0)
            WHEN t.game_type='keno' THEN COALESCE(k.won_amount::numeric,0) ELSE 0 END payout
       FROM tagged t LEFT JOIN inv i ON i.source_id=t.id LEFT JOIN led l ON l.game_session_id=t.id
       LEFT JOIN vou v ON v.id=t.id LEFT JOIN upgrader_games u ON t.game_type='upgrader' AND u.id=t.game_id
       LEFT JOIN keno_games k ON t.game_type='keno' AND k.id=t.game_id),
     ambiguity AS (SELECT COUNT(*)::int count FROM candidates WHERE match_count>1)`;

async function weightedCreatorGameplayRows(params: { startIso?: string; endIso: string; byDay: boolean }) {
  const intervals = await effectiveMultiplierIntervals(params.startIso ?? "1970-01-01T00:00:00.000Z", params.endIso);
  if (intervals.length === 0) return [];
  const overlaps = await queryMainRows<Array<{ id: string }>>(
    `WITH intervals AS (SELECT * FROM jsonb_to_recordset($1::jsonb)
       AS i(deal_id uuid,user_id text,start_at timestamptz,end_at timestamptz,real_bps numeric))
     SELECT gs.id::text FROM intervals i JOIN game_sessions gs ON gs.user_id=i.user_id
       AND gs.currency::text='real' AND gs.created_at>=i.start_at AND gs.created_at<i.end_at
     GROUP BY gs.id HAVING COUNT(*)>1 LIMIT 1`, JSON.stringify(intervals));
  if (overlaps[0]) throw new Error("A creator session maps to multiple PnL multiplier frames; global metrics refused to double-count it.");
  const group = params.byDay ? "GROUP BY 1 ORDER BY 1" : "";
  const date = params.byDay ? "to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') date," : "NULL::text date,";
  const rows = await queryMainRows<Array<{ date: string | null; wager: string; payout: string; bets: string; ambiguous: string }>>(
    `WITH ${LIFECYCLE_WEIGHTED_GAMEPLAY_CTES}
     SELECT ${date} COALESCE(SUM(p.bet*p.real_bps/10000),0)::text wager,
       COALESCE(SUM(p.payout*p.real_bps/10000),0)::text payout,COUNT(p.id)::text bets,
       (SELECT count::text FROM ambiguity) ambiguous FROM per_session p ${group}`,
    JSON.stringify(intervals));
  if (rows.some((row) => n(row.ambiguous) > 0)) throw new Error("A creator session maps to multiple PnL multiplier frames; global metrics refused to double-count it.");
  return rows;
}

export async function getWeightedCreatorGameplayForWindow(params: { startIso?: string; endIso: string }): Promise<WeightedCreatorGameplay> {
  const row = (await weightedCreatorGameplayRows({ ...params, byDay: false }))[0];
  const weightedWagerUsd = money(n(row?.wager));
  const weightedPayoutUsd = money(n(row?.payout));
  return { weightedWagerUsd, weightedPayoutUsd, weightedPnlUsd: money(weightedWagerUsd-weightedPayoutUsd), weightedBetCount: Math.trunc(n(row?.bets)) };
}

export async function getWeightedCreatorGameplayByDay(params: { startIso?: string; endIso: string }): Promise<WeightedCreatorGameplayDay[]> {
  return (await weightedCreatorGameplayRows({ ...params, byDay: true })).map((row) => ({
    date: row.date!, weightedWagerUsd: money(n(row.wager)), weightedPayoutUsd: money(n(row.payout)), weightedBetCount: Math.trunc(n(row.bets)),
  }));
}

async function approvalLinks(id: string | null): Promise<ApprovalLinks> {
  if (!id) return { leaderboard_id: null, leaderboard_payload: null, reward_program_id: null };
  const rows = await queryRows<ApprovalLinks[]>(adminDrizzle,
    `SELECT leaderboard_id::text, leaderboard_payload, reward_program_id::text
       FROM creator_deal_approval_requests WHERE id = $1::uuid LIMIT 1`, id);
  return rows[0] ?? { leaderboard_id: null, leaderboard_payload: null, reward_program_id: null };
}

async function rewardCost(programId: string | null, start: string, end: string) {
  if (!programId) return { total: 0, unresolved: 0 };
  const rows = await queryRows<{ total: string; unresolved: string }[]>(adminDrizzle,
    `SELECT COALESCE(SUM(amount_usd::numeric) FILTER (
              WHERE status = 'approved' AND ledger_tx_id IS NOT NULL), 0)::text AS total,
            COUNT(*) FILTER (WHERE status = 'pending' OR
              (status = 'approved' AND ledger_tx_id IS NULL))::text AS unresolved
       FROM creator_reward_claims
      WHERE program_id = $1::uuid AND requested_at >= $2::timestamptz
        AND requested_at < $3::timestamptz`, programId, start, end);
  return {
    total: n(rows[0]?.total),
    unresolved: Math.trunc(n(rows[0]?.unresolved)),
  };
}

async function creatorOwnGameplay(deal: AdminCreatorPnlDeal, calculationEnd = deal.frame_end_utc): Promise<{
  wager: number; payout: number; pnl: number;
  status: CreatorPnlPreview["creator_own_gameplay_status"]; note: string;
}> {
  if (deal.funding_mode === "non_withdrawable_fills") {
    return { wager: 0, payout: 0, pnl: 0, status: "not_applicable", note: "Fill-funded creator play has 0% real-money attribution." };
  }
  if (!deal.linked_multiplier_deal_id) {
    return { wager: 0, payout: 0, pnl: 0, status: "ambiguous", note: "No linked multiplier deal is recorded; creator own-play was not inferred." };
  }
  const rows = await queryMainRows<Array<{
    multiplier_bps: string; activated_at: string | null; ended_at: string | null;
    user_funding_usd: string | null; total_loaded_usd: string | null;
  }>>(
    `SELECT multiplier_bps::text, activated_at::text, ended_at::text,
            user_funding_usd::text,total_loaded_usd::text
       FROM creator_multiplier_deals
      WHERE id = $1::uuid AND user_id = $2 LIMIT 1`,
    deal.linked_multiplier_deal_id, deal.creator_user_id,
  );
  const multiplier = rows[0];
  if (!multiplier?.activated_at || n(multiplier.multiplier_bps) < 20_000
    || n(multiplier.user_funding_usd) <= 0 || n(multiplier.total_loaded_usd) <= 0) {
    return { wager: 0, payout: 0, pnl: 0, status: "ambiguous", note: "Linked multiplier lifecycle or multiplier is incomplete; creator own-play was not inferred." };
  }
  const start = new Date(Math.max(new Date(deal.frame_start_utc).getTime(), new Date(multiplier.activated_at).getTime())).toISOString();
  const lifecycleEnd = multiplier.ended_at ? new Date(multiplier.ended_at).getTime() : new Date(calculationEnd).getTime();
  const end = new Date(Math.min(new Date(calculationEnd).getTime(), lifecycleEnd)).toISOString();
  if (start >= end) return { wager: 0, payout: 0, pnl: 0, status: "computed", note: "Linked multiplier lifecycle did not overlap the frame." };
  const game = await queryMainRows<Array<{ wager: string; payout: string }>>(
    `WITH sessions AS (
       SELECT id, game_id, game_type::text AS game_type, bet_amount::numeric AS bet
         FROM game_sessions
        WHERE user_id = $1 AND currency::text = 'real'
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
     ), inv AS (
       SELECT source_id, SUM(value_at_obtained::numeric) amount FROM user_inventory
        WHERE source_id IN (SELECT id FROM sessions) AND source_type::text IN ('pack','battle') GROUP BY source_id
     ), led AS (
       SELECT game_session_id, SUM(ABS(amount::numeric)) amount FROM ledger_transactions
        WHERE game_session_id IN (SELECT id FROM sessions) AND status='completed' AND type::text='battle_refund' GROUP BY game_session_id
     ), vou AS (
       SELECT s.id, SUM(v.value::numeric) amount FROM sessions s JOIN vouchers v ON
         (v.origin::text='battle_excess_to_voucher' AND v.origin_id=s.id) OR
         (v.origin::text='battle_double_down_payout' AND s.game_type='battle_double_down' AND v.origin_id IN (s.id,s.game_id)) GROUP BY s.id
     )
     SELECT COALESCE(SUM(s.bet),0)::text wager,
            COALESCE(SUM(COALESCE(i.amount,0)+COALESCE(l.amount,0)+COALESCE(v.amount,0)+
              CASE WHEN s.game_type='upgrader' THEN COALESCE(u.won_amount::numeric,0)
                   WHEN s.game_type='keno' THEN COALESCE(k.won_amount::numeric,0) ELSE 0 END),0)::text payout
       FROM sessions s LEFT JOIN inv i ON i.source_id=s.id LEFT JOIN led l ON l.game_session_id=s.id
       LEFT JOIN vou v ON v.id=s.id LEFT JOIN upgrader_games u ON s.game_type='upgrader' AND u.id=s.game_id
       LEFT JOIN keno_games k ON s.game_type='keno' AND k.id=s.game_id`,
    deal.creator_user_id, start, end,
  );
  const weight = 10_000 / n(multiplier.multiplier_bps);
  const wager = money(n(game[0]?.wager) * weight);
  const payout = money(n(game[0]?.payout) * weight);
  return { wager, payout, pnl: money(wager - payout), status: "computed", note: `Weighted at the linked multiplier's 1/X real-money share (${money(weight * 100)}%).` };
}

async function realizedSpend(deal: AdminCreatorPnlDeal, calculationEnd = deal.frame_end_utc) {
  const zero = "00000000-0000-0000-0000-000000000000";
  const rows = await queryMainRows<Array<{ fill: string; tips: string; sponsors: string }>>(
    `WITH sessions AS (SELECT id FROM creator_stream_sessions WHERE deal_id=$1::uuid),
     fill AS (SELECT COALESCE(SUM(v.value::numeric),0) amount FROM vouchers v JOIN sessions s ON s.id=v.origin_id WHERE v.origin::text='creator_fill_conversion' AND v.created_at >= $4::timestamptz AND v.created_at < $5::timestamptz),
     spend AS (SELECT
       COALESCE(SUM(ABS(amount::numeric)) FILTER (WHERE type::text IN ('creator_fill_spend_tip','creator_multiplier_spend_tip','rain_tip')),0) tips,
       COALESCE(SUM(ABS(amount::numeric)) FILTER (WHERE type::text IN ('creator_fill_spend_battle','creator_multiplier_spend_battle')),0) sponsors
       FROM ledger_transactions WHERE user_id=$3 AND status='completed' AND created_at >= $4::timestamptz AND created_at < $5::timestamptz AND metadata->>'deal_id' IN ($1,$2))
     SELECT fill.amount::text fill, spend.tips::text tips, spend.sponsors::text sponsors FROM fill CROSS JOIN spend`,
    deal.linked_fill_deal_id ?? zero, deal.linked_multiplier_deal_id ?? zero,
    deal.creator_user_id, deal.frame_start_utc, calculationEnd,
  );
  return { fill: n(rows[0]?.fill), tips: n(rows[0]?.tips), sponsors: n(rows[0]?.sponsors) };
}

export async function computeCreatorPnlPreview(
  deal: AdminCreatorPnlDeal,
  options: { allowOpenFrame?: boolean; now?: Date } = {},
): Promise<CreatorPnlPreview> {
  const now = options.now ?? new Date();
  const frameIsOpen = new Date(deal.frame_end_utc).getTime() > now.getTime();
  if (frameIsOpen && !options.allowOpenFrame) throw new Error("PnL frame has not ended.");
  const calculationEnd = frameIsOpen ? now.toISOString() : deal.frame_end_utc;
  const [affiliateMap, own, spend, links] = await Promise.all([
    getFrameAffiliatePnlByUserUncached([{ userId: deal.creator_user_id, startIso: deal.frame_start_utc, endIso: calculationEnd }]),
    creatorOwnGameplay(deal, calculationEnd), realizedSpend(deal, calculationEnd), approvalLinks(deal.source_approval_request_id),
  ]);
  const affiliate = affiliateMap.get(deal.creator_user_id) ?? { affiliatesMadeUs: 0, deposits: 0, cardWithdrawals: 0, affiliateClaims: 0 };
  const [leaderboard, rewards] = await Promise.all([
    links.leaderboard_id ? affiliateLeaderboardsApi.get(links.leaderboard_id) : Promise.resolve(null),
    rewardCost(links.reward_program_id, deal.frame_start_utc, calculationEnd),
  ]);
  if (links.leaderboard_id && leaderboard?.approval_status !== "approved") throw new Error("Bundled leaderboard is not in an authoritative final state.");
  if (leaderboard && leaderboard.time_status !== "ended" && !options.allowOpenFrame) throw new Error("Bundled leaderboard has not ended; its realized cost is not final.");
  if (leaderboard && (
    new Date(leaderboard.start_date).getTime() !== new Date(deal.frame_start_utc).getTime()
    || new Date(leaderboard.end_date).getTime() !== new Date(deal.frame_end_utc).getTime()
  )) throw new Error("Bundled leaderboard does not exactly match the PnL frame.");
  const pctRaw = links.leaderboard_payload?.sponsoredPct;
  if (links.leaderboard_id && (typeof pctRaw !== "number" || pctRaw < 0 || pctRaw > 100)) throw new Error("Bundled leaderboard house share is missing.");
  const lb = leaderboard ? Math.max(0, n(leaderboard.total_prize_usd) - n(leaderboard.refund_amount_usd)) * (n(pctRaw) / 100) : 0;
  if (rewards.unresolved > 0 && !options.allowOpenFrame) throw new Error("In-frame reward claims are still unresolved.");
  const framePnl = calculateFrameSitePnlUsd({ affiliateContributionUsd: money(affiliate.affiliatesMadeUs), weightedCreatorGameplayPnlUsd: own.pnl, leaderboardHouseCostUsd: money(lb), fillCashoutCostUsd: money(spend.fill), tipCostUsd: money(spend.tips), sponsorshipCostUsd: money(spend.sponsors), rewardProgramCostUsd: money(rewards.total) });
  const limitations = own.status === "ambiguous" ? [own.note] : [];
  if (frameIsOpen) limitations.push(`Live provisional calculation through ${calculationEnd}; the deal frame is still open.`);
  if (rewards.unresolved > 0) limitations.push(`${rewards.unresolved} in-frame reward claim(s) are unresolved and not included yet.`);
  return { computation_version: "admin-pnl-v2", computed_at: now.toISOString(), frame_start_at: deal.frame_start_utc, frame_end_at: deal.frame_end_utc,
    affiliate_contribution_usd: money(affiliate.affiliatesMadeUs), affiliate_deposits_usd: money(affiliate.deposits), affiliate_withdrawals_usd: money(affiliate.cardWithdrawals), affiliate_claims_usd: money(affiliate.affiliateClaims),
    creator_own_gameplay_pnl_usd: own.pnl, creator_own_gameplay_wager_usd: own.wager, creator_own_gameplay_payout_usd: own.payout, creator_own_gameplay_status: own.status, creator_own_gameplay_note: own.note,
    leaderboard_house_cost_usd: money(lb), fill_cashout_cost_usd: money(spend.fill), tip_cost_usd: money(spend.tips), sponsorship_cost_usd: money(spend.sponsors), reward_program_cost_usd: money(rewards.total), frame_site_pnl_usd: framePnl,
    audit: {
      pnl_deal_id: deal.id,
      source_approval_request_id: deal.source_approval_request_id,
      positive_pnl_share_bps: deal.positive_pnl_share_bps,
      funding_mode: deal.funding_mode,
      funding_config: deal.funding_config,
      linked_fill_deal_id: deal.linked_fill_deal_id,
      linked_multiplier_deal_id: deal.linked_multiplier_deal_id,
      leaderboard_id: links.leaderboard_id,
      leaderboard_start_utc: leaderboard?.start_date ?? null,
      leaderboard_end_utc: leaderboard?.end_date ?? null,
      leaderboard_gross_prize_usd: money(n(leaderboard?.total_prize_usd)),
      leaderboard_refund_usd: money(n(leaderboard?.refund_amount_usd)),
      leaderboard_sponsored_pct: links.leaderboard_id ? n(pctRaw) : null,
      reward_program_id: links.reward_program_id,
      terms_snapshot: deal.terms_snapshot,
    },
    limitations };
}
