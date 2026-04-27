import "server-only";

import { backendApi } from "./client";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type TimeStatus = "upcoming" | "active" | "ended";

export type PrizeTier = {
  position: number;
  prize_amount_usd: string;
};

export type LeaderboardAdminRow = {
  id: string;
  creator_user_id: string;
  title: string;
  affiliate_codes: string[];
  creator_prize_usd: string;
  site_bonus_usd: string;
  total_prize_usd: string;
  is_sponsored: boolean;
  start_date: string;
  end_date: string;
  created_at: string;
  approval_status: ApprovalStatus;
  approved_at: string | null;
  approved_by: string | null;
  rejection_reason: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  refunded_at: string | null;
  refund_amount_usd: string | null;
  creation_ledger_tx_id: string | null;
  refund_ledger_tx_id: string | null;
  time_status: TimeStatus;
  prize_tiers: PrizeTier[];
};

export type ListQuery = {
  status?: ApprovalStatus;
  creator_user_id?: string;
  offset?: number;
  limit?: number;
};

export type ListResult = {
  leaderboards: LeaderboardAdminRow[];
  total: number;
  offset: number;
  limit: number;
};

export type RejectInput = { rejection_reason: string };

export type SponsorInput = { additional_bonus_usd: number };

export type EditInput = {
  title?: string;
  affiliate_codes?: string[];
  start_date?: string;
  end_date?: string;
  prize_tiers?: Array<{ position: number; prize_amount_usd: number }>;
};

type Success<T> = { success: boolean; data: T };

const BASE = "/admin/affiliate-leaderboards";

function adminHeaders(adminUserId: string): Record<string, string> {
  return { "x-admin-user-id": adminUserId };
}

export const affiliateLeaderboardsApi = {
  list: (query: ListQuery = {}) =>
    backendApi
      .get<Success<ListResult>>(BASE, { query })
      .then((r) => r.data),

  get: (id: string) =>
    backendApi
      .get<Success<LeaderboardAdminRow>>(`${BASE}/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  approve: (id: string, adminUserId: string) =>
    backendApi
      .post<Success<LeaderboardAdminRow>>(
        `${BASE}/${encodeURIComponent(id)}/approve`,
        {},
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),

  reject: (id: string, input: RejectInput, adminUserId: string) =>
    backendApi
      .post<Success<LeaderboardAdminRow>>(
        `${BASE}/${encodeURIComponent(id)}/reject`,
        input,
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),

  edit: (id: string, input: EditInput, adminUserId: string) =>
    backendApi
      .patch<Success<LeaderboardAdminRow>>(
        `${BASE}/${encodeURIComponent(id)}`,
        input,
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),

  sponsor: (id: string, input: SponsorInput, adminUserId: string) =>
    backendApi
      .post<Success<LeaderboardAdminRow>>(
        `${BASE}/${encodeURIComponent(id)}/sponsor`,
        input,
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),

  cancel: (id: string, adminUserId: string) =>
    backendApi
      .post<Success<LeaderboardAdminRow>>(
        `${BASE}/${encodeURIComponent(id)}/cancel`,
        {},
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),
};
