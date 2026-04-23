import "server-only";

import {
  BackendApiError,
  creatorsApi,
  type CreatorDealResponse,
  type CreatorSessionResponse,
  type PendingConversionResponse,
  type PendingConversionStatus,
  type StreamSessionStatus,
} from "@/lib/backend-api";

import type { PaginatedSlice } from "../_lib/types";

export type CreatorDealData = {
  deals: PaginatedSlice<CreatorDealResponse>;
  sessions: PaginatedSlice<CreatorSessionResponse>;
  pending: PendingConversionResponse[];
};

type Params = {
  dealsPage: number;
  dealsPerPage: number;
  sessionsPage: number;
  sessionsPerPage: number;
  sessionsStatus?: StreamSessionStatus;
  pendingStatus: PendingConversionStatus;
};

/**
 * Fetches everything the creator-detail page needs from the backend admin
 * API in a single parallelised block. Each slice paginates independently
 * via its own URL query params so tabs don't clobber each other on
 * navigation.
 *
 * Returns null when the target user has no creator-scoped data on the
 * backend (e.g. the user exists locally but isn't promoted) so the page
 * can render an empty-state without blowing up.
 */
export async function getCreatorDealData(
  userId: string,
  params: Params,
): Promise<CreatorDealData | null> {
  try {
    const [dealsPage, sessionsPage, pending] = await Promise.all([
      creatorsApi.listDeals(userId, {
        limit: params.dealsPerPage,
        offset: (params.dealsPage - 1) * params.dealsPerPage,
      }),
      creatorsApi.listSessions(userId, {
        limit: params.sessionsPerPage,
        offset: (params.sessionsPage - 1) * params.sessionsPerPage,
        status: params.sessionsStatus,
      }),
      creatorsApi.listPendingConversions(userId, {
        status: params.pendingStatus,
      }),
    ]);

    return {
      deals: {
        data: dealsPage.data,
        total: dealsPage.total,
        page: params.dealsPage,
        perPage: params.dealsPerPage,
        totalPages: Math.max(
          1,
          Math.ceil(dealsPage.total / params.dealsPerPage),
        ),
      },
      sessions: {
        data: sessionsPage.data,
        total: sessionsPage.total,
        page: params.sessionsPage,
        perPage: params.sessionsPerPage,
        totalPages: Math.max(
          1,
          Math.ceil(sessionsPage.total / params.sessionsPerPage),
        ),
      },
      pending,
    };
  } catch (err) {
    // A 404 from any of these means the user isn't a creator on the
    // backend — not a hard error for the admin page. Anything else should
    // bubble so the page surfaces it.
    if (err instanceof BackendApiError && err.isNotFound) return null;
    throw err;
  }
}
