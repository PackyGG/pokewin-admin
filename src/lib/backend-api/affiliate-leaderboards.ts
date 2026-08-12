import "server-only";

import { backendApi } from "./client";
import {
  getAffiliateLeaderboardFromPostgres,
  listAffiliateLeaderboardsFromPostgres,
} from "./postgres-reads";

import type {
  ApprovalStatus,
  LeaderboardAdminRow,
  LeaderboardListQuery,
  LeaderboardListResult,
} from "./contracts";

export type {
  ApprovalStatus,
  LeaderboardAdminRow,
  PrizeTier,
  TimeStatus,
} from "./contracts";

export type ListQuery = LeaderboardListQuery;
export type ListResult = LeaderboardListResult;

export type RejectInput = { rejection_reason: string };

export type SponsorInput = { additional_bonus_usd: number };

export type ManualPaymentInput = {
  paid_manually: boolean;
  // Pass null (or omit) to clear. When paid_manually is false the backend
  // always clears the note regardless of what's sent here.
  payout_note?: string | null;
};

export type EditInput = {
  title?: string;
  affiliate_codes?: string[];
  co_creator_user_ids?: string[];
  start_date?: string;
  end_date?: string;
  prize_tiers?: Array<{ position: number; prize_amount_usd: number }>;
  // Site-funded prize pool — editable so admins can lower / raise a
  // leaderboard after creation. The backend rejects a new pool that
  // would fall below the existing tier sum; the admin edit dialog
  // guards that case client-side too with a friendlier message.
  site_bonus_usd?: number;
};

export type CreateInput = {
  requested_id?: string;
  creator_user_id: string;
  co_creator_user_ids?: string[];
  title: string;
  affiliate_codes: string[];
  site_bonus_usd: number;
  start_date: string;
  end_date: string;
  prize_tiers: Array<{ position: number; prize_amount_usd: number }>;
};

// A claim hold (freeze) placed on a (leaderboard, user) pair so the user
// cannot claim their prize while a wager-abuse review is open. At most one
// active hold exists per pair; releasing sets released_at but keeps the row
// for the audit trail. Shape mirrors the backend's serializeHold().
export type ClaimHold = {
  id: string;
  leaderboard_id: string;
  user_id: string;
  reason: string;
  created_by: string;
  released_at: string | null;
  released_by: string | null;
  release_reason: string | null;
  created_at: string;
};

export type FreezeClaimInput = { reason: string };

export type UnfreezeClaimInput = { release_reason?: string | null };

type Success<T> = { success: boolean; data: T };

const BASE = "/admin/affiliate-leaderboards";

function adminHeaders(adminUserId: string): Record<string, string> {
  return { "x-admin-user-id": adminUserId };
}

export const affiliateLeaderboardsApi = {
  list: async (query: ListQuery = {}): Promise<ListResult> => {
    try {
      return await backendApi
        .get<Success<ListResult>>(BASE, { query })
        .then((r) => r.data);
    } catch (error) {
      console.warn(
        "[affiliate-leaderboards-api] backend list read failed; using PostgreSQL",
        error,
      );
      return listAffiliateLeaderboardsFromPostgres(query);
    }
  },

  create: (input: CreateInput, adminUserId: string) =>
    backendApi
      .post<Success<LeaderboardAdminRow>>(
        BASE,
        input,
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),

  get: async (id: string): Promise<LeaderboardAdminRow> => {
    try {
      return await backendApi
        .get<Success<LeaderboardAdminRow>>(`${BASE}/${encodeURIComponent(id)}`)
        .then((r) => r.data);
    } catch (error) {
      console.warn(
        `[affiliate-leaderboards-api] backend detail read failed for ${id}; using PostgreSQL`,
        error,
      );
      const row = await getAffiliateLeaderboardFromPostgres(id);
      if (!row) throw error;
      return row;
    }
  },

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

  setManualPayment: (
    id: string,
    input: ManualPaymentInput,
    adminUserId: string,
  ) =>
    backendApi
      .post<Success<LeaderboardAdminRow>>(
        `${BASE}/${encodeURIComponent(id)}/manual-payment`,
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

  hardDelete: (
    id: string,
    input: HardDeleteInput,
    adminUserId: string,
  ) =>
    backendApi
      .delete<Success<HardDeleteResult>>(
        `${BASE}/${encodeURIComponent(id)}`,
        input,
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),

  // List claim holds (freezes) for a leaderboard. Defaults to active-only;
  // pass activeOnly=false to include released holds for the full audit trail.
  listClaimHolds: (id: string, activeOnly: boolean = true) =>
    backendApi
      .get<Success<{ holds: ClaimHold[] }>>(
        `${BASE}/${encodeURIComponent(id)}/holds`,
        { query: { active_only: activeOnly } },
      )
      .then((r) => r.data.holds),

  // Freeze a participant's prize claim. 409 if already claimed or already
  // frozen; reason is required and recorded in the audit trail.
  freezeClaim: (
    id: string,
    userId: string,
    input: FreezeClaimInput,
    adminUserId: string,
  ) =>
    backendApi
      .post<Success<ClaimHold>>(
        `${BASE}/${encodeURIComponent(id)}/claims/${encodeURIComponent(userId)}/freeze`,
        input,
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),

  // Lift the active freeze on a participant's prize claim. 404 if there is
  // no active hold. release_reason is optional.
  unfreezeClaim: (
    id: string,
    userId: string,
    input: UnfreezeClaimInput,
    adminUserId: string,
  ) =>
    backendApi
      .post<Success<ClaimHold>>(
        `${BASE}/${encodeURIComponent(id)}/claims/${encodeURIComponent(userId)}/unfreeze`,
        input,
        { headers: adminHeaders(adminUserId) },
      )
      .then((r) => r.data),
};

export type HardDeleteInput = { confirmation_id: string };

export type HardDeleteResult = {
  deleted_id: string;
  previous_status: ApprovalStatus;
  refund_amount_usd: string;
};
