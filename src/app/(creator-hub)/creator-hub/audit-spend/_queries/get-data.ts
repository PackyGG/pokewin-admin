import "server-only";

import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";

import {
  getSpendEventsPage,
  type SpendBucketKey,
  type SpendEventsPage,
  AUDIT_SPEND_PER_PAGE,
} from "./spend-events";

/** A page result paired with the safeQuery failure metadata so the table
 *  + pagination can render a truthful degraded state. */
export type SpendEventsResult = {
  data: SpendEventsPage;
  error: string | null;
  kind: "timeout" | "error" | null;
};

function emptyPage(
  bucket: SpendBucketKey,
  page: number,
): SpendEventsPage {
  return {
    rows: [],
    page,
    perPage: AUDIT_SPEND_PER_PAGE,
    total: 0,
    totalPages: 1,
    lifetimeTotalUsd: null,
    countDegraded: true,
  };
}

export async function getAuditSpendPage(
  bucket: SpendBucketKey,
  page: number,
): Promise<SpendEventsResult> {
  const result = await safeQuery(
    () => getSpendEventsPage(bucket, page),
    emptyPage(bucket, page),
    `creator-hub.audit-spend.${bucket}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  return {
    data: result.data,
    error: result.error,
    kind: result.kind ?? null,
  };
}
