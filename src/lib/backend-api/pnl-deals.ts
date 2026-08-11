import "server-only";

import { backendApi } from "./client";

export type PnlDealStatus =
  | "scheduled"
  | "active"
  | "settlement_pending"
  | "settled"
  | "cancelled";

export type PnlDealFunding =
  | {
      mode: "non_withdrawable_fills";
      fills_allowed: number;
      per_fill_amount_usd: number;
      cooldown_minutes?: number;
    }
  | {
      mode: "linked_multiplier";
      multiplier_deal_id: string;
    }
  | {
      mode: "new_multiplier";
      multiplier: {
        required_deposit_usd: number;
        multiplier_bps: number;
        wager_requirement_bps?: number;
        max_total_wager_usd?: number | null;
        max_payout_usd?: number | null;
        min_session_duration_seconds?: number;
        min_bet_count?: number;
        min_wager_to_funding_ratio_bps?: number;
        kick_vod_required?: boolean;
        auto_renew?: false;
        terms_text: string;
        terms_version: string;
      };
    };

export type CreatePnlDealInput = {
  frame_start_utc: string;
  frame_end_utc: string;
  positive_pnl_share_bps: number;
  funding: PnlDealFunding;
  max_tip_per_stream_usd?: number | null;
  max_tip_per_user_usd?: number | null;
  max_sponsored_battle_usd?: number | null;
  max_sponsorship_per_stream_usd?: number | null;
  terms?: Record<string, unknown> | null;
  source_approval_request_id?: string | null;
};

export type PnlDealResponse = {
  id: string;
  user_id: string;
  status: PnlDealStatus;
  frame_start_utc: string;
  frame_end_utc: string;
  positive_pnl_share_bps: number;
  funding_mode:
    | "non_withdrawable_fills"
    | "linked_multiplier"
    | "new_multiplier";
  linked_fill_deal_id: string | null;
  linked_multiplier_deal_id: string | null;
  fills_allowed: number | null;
  fills_used: number | null;
  per_fill_amount_usd: string | null;
  cooldown_minutes: number | null;
  max_tip_per_stream_usd: string | null;
  max_tip_per_user_usd: string | null;
  max_sponsored_battle_usd: string | null;
  max_sponsorship_per_stream_usd: string | null;
  terms: Record<string, unknown> | null;
  source_approval_request_id: string | null;
  frame_site_pnl_usd: string | null;
  creator_share_usd: string | null;
  settlement_breakdown: Record<string, unknown> | null;
  settled_at: string | null;
  settlement_ledger_id: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type Paginated<T> = {
  data: T[];
  total: number;
  offset: number;
  limit: number;
};

type Success<T> = { success: boolean; data: T };

export const pnlDealsApi = {
  list: (
    userId: string,
    query: { offset?: number; limit?: number; status?: PnlDealStatus } = {},
  ) =>
    backendApi
      .get<Success<Paginated<PnlDealResponse>>>(
        `/admin/creators/${encodeURIComponent(userId)}/pnl-deals`,
        { query },
      )
      .then((response) => response.data),

  get: (userId: string, dealId: string) =>
    backendApi
      .get<Success<PnlDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/pnl-deals/${encodeURIComponent(dealId)}`,
      )
      .then((response) => response.data),

  create: (userId: string, input: CreatePnlDealInput) =>
    backendApi
      .post<Success<PnlDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/pnl-deals`,
        input,
      )
      .then((response) => response.data),

  cancel: (userId: string, dealId: string, input: { reason?: string } = {}) =>
    backendApi
      .post<Success<PnlDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/pnl-deals/${encodeURIComponent(dealId)}/cancel`,
        input,
      )
      .then((response) => response.data),

  settle: (
    userId: string,
    dealId: string,
    input: {
      expected_version: number;
      frame_site_pnl_usd: number;
      settlement_breakdown: Record<string, unknown>;
      reason?: string;
    },
  ) =>
    backendApi
      .post<Success<PnlDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/pnl-deals/${encodeURIComponent(dealId)}/settle`,
        input,
      )
      .then((response) => response.data),
};
