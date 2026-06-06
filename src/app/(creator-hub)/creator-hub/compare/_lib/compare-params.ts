import { z } from "zod";

import {
  resolveRosterPeriod,
  ROSTER_DEFAULT_PERIOD,
} from "../../creators/_lib/roster-params";
import type { DashboardPeriod } from "@/lib/queries/dashboard-period";

/** Max creators in a single comparison (owner spec: 2–3). */
export const COMPARE_MAX = 3;
export const COMPARE_MIN = 2;

/**
 * Parse `?compare=id1,id2[,id3]` into a deduped, ordered list of creator IDs.
 * Invalid / empty tokens are dropped; more than COMPARE_MAX are truncated.
 */
export function parseCompareIds(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= COMPARE_MAX) break;
  }
  return ids;
}

const CompareSearchParamsSchema = z.object({
  compare: z
    .string()
    .optional()
    .transform((v) => parseCompareIds(v)),
  period: z
    .string()
    .optional()
    .transform((v) => resolveRosterPeriod(v)),
});

export type CompareSearchParams = z.infer<typeof CompareSearchParamsSchema> & {
  period: DashboardPeriod;
};

export function parseCompareSearchParams(
  raw: Record<string, string | undefined>,
): CompareSearchParams {
  const parsed = CompareSearchParamsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { compare: [], period: ROSTER_DEFAULT_PERIOD };
}

/** Serialize selected IDs back into a `?compare=` value. */
export function formatCompareParam(ids: string[]): string {
  return ids.slice(0, COMPARE_MAX).join(",");
}
