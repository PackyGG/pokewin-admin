import "server-only";

import { backendApi } from "./client";

/**
 * Typed client for the backend's multiplier-deal admin surface. Mirrors
 * `creatorsApi` shape — every method maps 1:1 onto a single backend
 * endpoint under `/v1/admin/creators/:userId/multiplier-deals/*` plus the
 * global `/v1/admin/multiplier-deals/review-queue`.
 *
 * The backend is the source of truth for multiplier-deal lifecycle: this
 * client only forwards requests, the admin layer wraps each call with auth
 * + audit in `creators/multiplier-actions.ts`.
 */

export type MultiplierDealStatus =
  | "pending_deposit"
  | "funded"
  | "live"
  | "pending_review"
  | "flagged"
  | "approved"
  | "rejected"
  | "cancelled"
  | "completed";

/**
 * Single flag entry attached to a deal at end-stream. Code names mirror
 * the backend's MultiplierFlagCode enum; manually-flagged reasons get a
 * `MANUAL:` prefix on the code so UI can distinguish auto vs human flags.
 */
type MultiplierFlagEntry = {
  code: string;
  detail: Record<string, unknown>;
  at: string;
};

export type MultiplierDealResponse = {
  id: string;
  user_id: string;
  status: MultiplierDealStatus;

  // Contract
  required_deposit_usd: string;
  multiplier_bps: number;
  withdrawable_bps: number;
  wager_requirement_bps: number;
  max_total_wager_usd: string | null;
  max_payout_usd: string | null;
  min_session_duration_seconds: number;
  min_bet_count: number;
  min_wager_to_funding_ratio_bps: number;
  kick_vod_required: boolean;
  auto_renew: boolean;

  // TOS snapshot
  terms_text: string;
  terms_version: string;
  tos_accepted_at: string | null;
  tos_accepted_ip: string | null;

  // Lifecycle
  deposit_locked_at: string | null;
  activated_at: string | null;
  ended_at: string | null;
  auto_end_at: string | null;
  reviewed_at: string | null;
  settled_at: string | null;

  // Funding snapshot (set at activation)
  user_funding_usd: string | null;
  platform_funding_usd: string | null;
  total_loaded_usd: string | null;

  // Spend counters
  fill_spent_usd: string;
  fill_refunded_usd: string;
  fill_remaining_usd: string | null;
  wager_accumulated_usd: string;
  bet_count: number;
  tips_spent_this_session_usd: string;
  sponsorship_spent_this_session_usd: string;

  // End / settlement
  ending_balance_usd: string | null;
  kick_vod_url: string | null;
  flagged_reasons: MultiplierFlagEntry[] | null;
  review_decision: string | null;
  review_reason: string | null;
  reviewed_by: string | null;
  withdrawable_voucher_usd: string | null;
  forfeited_usd: string | null;
  deposit_refunded_usd: string | null;
  deposit_forfeited_usd: string | null;
  payout_voucher_id: string | null;
  deposit_ledger_id: string | null;
  settlement_ledger_id: string | null;

  // Audit
  state_log: Array<Record<string, unknown>> | null;
  created_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type CreateMultiplierDealInput = {
  required_deposit_usd: number;
  multiplier_bps: number;
  withdrawable_bps?: number;
  wager_requirement_bps?: number;
  max_total_wager_usd?: number | null;
  max_payout_usd?: number | null;
  min_session_duration_seconds?: number;
  min_bet_count?: number;
  min_wager_to_funding_ratio_bps?: number;
  kick_vod_required?: boolean;
  auto_renew?: boolean;
  terms_text: string;
  terms_version: string;
};

export type UpdateMultiplierDealInput = {
  expected_version: number;
  patch: Partial<{
    required_deposit_usd: number;
    multiplier_bps: number;
    withdrawable_bps: number;
    wager_requirement_bps: number;
    max_total_wager_usd: number | null;
    max_payout_usd: number | null;
    min_session_duration_seconds: number;
    min_bet_count: number;
    min_wager_to_funding_ratio_bps: number;
    kick_vod_required: boolean;
    auto_renew: boolean;
    terms_text: string;
    terms_version: string;
  }>;
};

export type ApproveMultiplierDealInput = {
  override_wager_requirement?: boolean;
  payout_override_usd?: number;
  reason?: string;
};

export type RejectMultiplierDealInput = {
  reason: string;
  forfeit_deposit_usd?: number;
};

export type FlagMultiplierDealInput = {
  code: string;
  detail?: Record<string, unknown>;
  reason?: string;
};

type Paginated<T> = {
  data: T[];
  total: number;
  offset: number;
  limit: number;
};

type Success<T> = { success: boolean; data: T };

export const multiplierDealsApi = {
  list: (
    userId: string,
    query: {
      offset?: number;
      limit?: number;
      status?: MultiplierDealStatus;
    } = {},
  ) =>
    backendApi
      .get<Success<Paginated<MultiplierDealResponse>>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals`,
        { query },
      )
      .then((r) => r.data),

  get: (userId: string, dealId: string) =>
    backendApi
      .get<Success<MultiplierDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals/${encodeURIComponent(dealId)}`,
      )
      .then((r) => r.data),

  create: (userId: string, input: CreateMultiplierDealInput) =>
    backendApi
      .post<Success<MultiplierDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals`,
        input,
      )
      .then((r) => r.data),

  update: (
    userId: string,
    dealId: string,
    input: UpdateMultiplierDealInput,
  ) =>
    backendApi
      .patch<Success<MultiplierDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals/${encodeURIComponent(dealId)}`,
        input,
      )
      .then((r) => r.data),

  cancel: (userId: string, dealId: string, input: { reason?: string } = {}) =>
    backendApi
      .post<Success<MultiplierDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals/${encodeURIComponent(dealId)}/cancel`,
        input,
      )
      .then((r) => r.data),

  forceEnd: (
    userId: string,
    dealId: string,
    input: { reason?: string } = {},
  ) =>
    backendApi
      .post<Success<MultiplierDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals/${encodeURIComponent(dealId)}/force-end`,
        input,
      )
      .then((r) => r.data),

  approve: (
    userId: string,
    dealId: string,
    input: ApproveMultiplierDealInput,
  ) =>
    backendApi
      .post<Success<MultiplierDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals/${encodeURIComponent(dealId)}/approve`,
        input,
      )
      .then((r) => r.data),

  reject: (
    userId: string,
    dealId: string,
    input: RejectMultiplierDealInput,
  ) =>
    backendApi
      .post<Success<MultiplierDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals/${encodeURIComponent(dealId)}/reject`,
        input,
      )
      .then((r) => r.data),

  flag: (userId: string, dealId: string, input: FlagMultiplierDealInput) =>
    backendApi
      .post<Success<MultiplierDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/multiplier-deals/${encodeURIComponent(dealId)}/flag`,
        input,
      )
      .then((r) => r.data),

  listReviewQueue: (
    query: {
      offset?: number;
      limit?: number;
      flagged_only?: boolean;
    } = {},
  ) =>
    backendApi
      .get<Success<Paginated<MultiplierDealResponse>>>(
        `/admin/multiplier-deals/review-queue`,
        { query },
      )
      .then((r) => r.data),
};
