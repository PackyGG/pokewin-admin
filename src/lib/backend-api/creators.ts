import "server-only";

import { logWarn } from "@/lib/errors/logger";

import { backendApi } from "./client";
import {
  parsePaginatedSuccess,
  type PaginatedResponse,
} from "./paginated-response";
import {
  getCreatorApiKeyStatusFromPostgres,
  getCreatorDealFromPostgres,
  listCreatorDealsFromPostgres,
  listCreatorSessionsFromPostgres,
  listCreatorSocialsFromPostgres,
  listCreatorsFromPostgres,
  listPendingConversionsFromPostgres,
} from "./postgres-reads";

import type {
  AdminCreatorSocial,
  CreatorDealResponse,
  CreatorListItem,
  CreatorSessionResponse,
  CreatorSocialResponse,
  CreatorSocialStatus,
  PendingConversionResponse,
  PendingConversionStatus,
  StreamSessionStatus,
} from "./contracts";

export type {
  AdminCreatorSocial,
  CreatorDealResponse,
  CreatorDealStatus,
  CreatorListItem,
  CreatorSessionResponse,
  CreatorSocialPlatform,
  CreatorSocialResponse,
  CreatorSocialStatus,
  PendingConversionResponse,
  PendingConversionStatus,
  StreamSessionStatus,
} from "./contracts";

export type CreateDealInput = {
  week_start_utc: string;
  week_end_utc: string;
  status?: "scheduled" | "active";
  fills_allowed: number;
  per_fill_amount_usd: number;
  conversion_rate_bps: number;
  total_withdraw_cap_usd?: number | null;
  cooldown_minutes?: number;
  max_tip_per_stream_usd: number;
  max_tip_per_user_usd: number;
  max_sponsored_battle_usd: number;
  max_sponsorship_per_stream_usd: number;
  allow_site_leaderboards?: boolean;
  allow_code_leaderboards?: boolean;
  terms?: Record<string, unknown> | null;
};

export type UpdateDealInput = {
  expected_version: number;
  patch: Partial<{
    week_start_utc: string;
    week_end_utc: string;
    fills_allowed: number;
    per_fill_amount_usd: number;
    conversion_rate_bps: number;
    total_withdraw_cap_usd: number | null;
    cooldown_minutes: number;
    max_tip_per_stream_usd: number;
    max_tip_per_user_usd: number;
    max_sponsored_battle_usd: number;
    max_sponsorship_per_stream_usd: number;
    allow_site_leaderboards: boolean;
    allow_code_leaderboards: boolean;
    terms: Record<string, unknown> | null;
    // Admin overrides for usage counters. Sent only when admin
    // explicitly corrects fill/cap state — never auto-populated.
    fills_used: number;
    withdraw_cap_used_usd: number;
  }>;
};

type Paginated<T> = PaginatedResponse<T>;

type Success<T> = { success: boolean; data: T };

export const creatorsApi = {
  list: async (
    query: { search?: string; offset?: number; limit?: number } = {},
  ): Promise<Paginated<CreatorListItem>> => {
    try {
      return await backendApi
        .get<Success<Paginated<CreatorListItem>>>("/admin/creators", { query })
        .then((r) => r.data);
    } catch (error) {
      console.warn(
        "[creators-api] roster backend read failed; using PostgreSQL",
        error,
      );
      return listCreatorsFromPostgres(query);
    }
  },

  promote: (userId: string) =>
    backendApi
      .post<
        Success<{ user_id: string; role: string; already_creator: boolean }>
      >(`/admin/creators/${encodeURIComponent(userId)}/promote`, {})
      .then((r) => r.data),

  demote: (userId: string) =>
    backendApi
      .post<Success<{ user_id: string; role: string }>>(
        `/admin/creators/${encodeURIComponent(userId)}/demote`,
        {}
      )
      .then((r) => r.data),

  listDeals: async (
    userId: string,
    query: { offset?: number; limit?: number } = {},
  ): Promise<Paginated<CreatorDealResponse>> => {
    try {
      return await backendApi
        .get<Success<Paginated<CreatorDealResponse>>>(
          `/admin/creators/${encodeURIComponent(userId)}/deals`,
          { query },
        )
        .then((r) => r.data);
    } catch (error) {
      console.warn(
        `[creators-api] deal list backend read failed for ${userId}; using PostgreSQL`,
        error,
      );
      return listCreatorDealsFromPostgres(userId, query);
    }
  },

  getDeal: async (
    userId: string,
    dealId: string,
  ): Promise<CreatorDealResponse> => {
    try {
      return await backendApi
        .get<Success<CreatorDealResponse>>(
          `/admin/creators/${encodeURIComponent(userId)}/deals/${encodeURIComponent(dealId)}`,
        )
        .then((r) => r.data);
    } catch (error) {
      console.warn(
        `[creators-api] deal backend read failed for ${dealId}; using PostgreSQL`,
        error,
      );
      const deal = await getCreatorDealFromPostgres(userId, dealId);
      if (!deal) throw error;
      return deal;
    }
  },

  createDeal: (userId: string, input: CreateDealInput) =>
    backendApi
      .post<Success<CreatorDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/deals`,
        input
      )
      .then((r) => r.data),

  updateDeal: (userId: string, dealId: string, input: UpdateDealInput) =>
    backendApi
      .patch<Success<CreatorDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/deals/${encodeURIComponent(dealId)}`,
        input
      )
      .then((r) => r.data),

  terminateDeal: (
    userId: string,
    dealId: string,
    input: { reason?: string; force_end_active_session?: boolean } = {}
  ) =>
    backendApi
      .post<Success<CreatorDealResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/deals/${encodeURIComponent(dealId)}/terminate`,
        input
      )
      .then((r) => r.data),

  listSessions: async (
    userId: string,
    query: {
      status?: StreamSessionStatus;
      offset?: number;
      limit?: number;
    } = {},
  ): Promise<Paginated<CreatorSessionResponse>> => {
    try {
      return await backendApi
        .get<Success<Paginated<CreatorSessionResponse>>>(
          `/admin/creators/${encodeURIComponent(userId)}/sessions`,
          { query },
        )
        .then((payload) =>
          parsePaginatedSuccess<CreatorSessionResponse>(
            payload,
            "Creator session list",
          ),
        );
    } catch (error) {
      logWarn(
        "creators-api.sessions",
        "backend session read failed; using PostgreSQL fallback",
        error,
      );
      return listCreatorSessionsFromPostgres(userId, query);
    }
  },

  forceEndSession: (
    userId: string,
    sessionId: string,
    input: { reason?: string } = {}
  ) =>
    backendApi
      .post<Success<CreatorSessionResponse>>(
        `/admin/creators/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/force-end`,
        input
      )
      .then((r) => r.data),

  listPendingConversions: async (
    userId: string,
    query: { status?: PendingConversionStatus } = {},
  ): Promise<PendingConversionResponse[]> => {
    try {
      return await backendApi
        .get<Success<{ data: PendingConversionResponse[] }>>(
          `/admin/creators/${encodeURIComponent(userId)}/pending-conversions`,
          { query },
        )
        .then((r) => r.data.data);
    } catch (error) {
      console.warn(
        `[creators-api] pending conversions backend read failed for ${userId}; using PostgreSQL`,
        error,
      );
      return listPendingConversionsFromPostgres(userId, query);
    }
  },

  listSocials: async (
    query: {
      status?: CreatorSocialStatus;
      offset?: number;
      limit?: number;
    } = {},
  ): Promise<{ items: AdminCreatorSocial[]; total: number }> => {
    try {
      return await backendApi
        .get<Success<{ items: AdminCreatorSocial[]; total: number }>>(
          `/admin/creators/socials`,
          { query },
        )
        .then((r) => r.data);
    } catch (error) {
      console.warn(
        "[creators-api] socials backend read failed; using PostgreSQL",
        error,
      );
      return listCreatorSocialsFromPostgres(query);
    }
  },

  approveSocial: (id: string) =>
    backendApi
      .post<Success<CreatorSocialResponse>>(
        `/admin/creators/socials/${encodeURIComponent(id)}/approve`,
        {}
      )
      .then((r) => r.data),

  rejectSocial: (id: string, reason?: string) =>
    backendApi
      .post<Success<CreatorSocialResponse>>(
        `/admin/creators/socials/${encodeURIComponent(id)}/reject`,
        reason ? { reason } : {}
      )
      .then((r) => r.data),

  getApiKeyStatus: async (
    userId: string,
  ): Promise<{ has_api_key: boolean }> => {
    try {
      return await backendApi
        .get<Success<{ has_api_key: boolean }>>(
          `/admin/creators/${encodeURIComponent(userId)}/api-key`,
        )
        .then((r) => r.data);
    } catch (error) {
      console.warn(
        `[creators-api] API key status backend read failed for ${userId}; using PostgreSQL`,
        error,
      );
      const status = await getCreatorApiKeyStatusFromPostgres(userId);
      if (!status) throw error;
      return status;
    }
  },

  rotateApiKey: (userId: string) =>
    backendApi
      .post<Success<{ api_key: string; has_api_key: true }>>(
        `/admin/creators/${encodeURIComponent(userId)}/api-key/rotate`,
        {}
      )
      .then((r) => r.data),
};
