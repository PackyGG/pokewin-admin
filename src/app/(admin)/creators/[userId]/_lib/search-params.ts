import { z } from "zod";

import {
  parseDashboardPeriod,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";

const StreamSessionStatus = z.enum(["active", "ended", "converted"]);
const PendingConversionStatus = z.enum(["pending", "claimed"]);
const TabValue = z.enum(["deals", "sessions", "pending"]);

const CreatorDetailSearchParamsSchema = z.object({
  tab: TabValue.default("deals"),

  // Raw `period` chip — sanitised to a real DashboardPeriod by
  // `parseDashboardPeriod` after parse (reuses the dashboard's own
  // validator so the chip set + fallback stay identical). Drives the
  // WINDOWED Code-User GGR trend on the Net Creator P&L band; the
  // headline net stays lifetime regardless.
  period: z.string().optional(),

  dealsPage: z.coerce.number().int().min(1).default(1),
  dealsPerPage: z.coerce.number().int().min(1).max(100).default(20),

  sessionsPage: z.coerce.number().int().min(1).default(1),
  sessionsPerPage: z.coerce.number().int().min(1).max(100).default(20),
  sessionsStatus: StreamSessionStatus.optional(),

  pendingStatus: PendingConversionStatus.default("pending"),
});

export type CreatorDetailSearchParams = Omit<
  z.infer<typeof CreatorDetailSearchParamsSchema>,
  "period"
> & {
  /** Sanitised active GGR-trend window. */
  period: DashboardPeriod;
};

/**
 * Parse raw search params for the creator detail page. Invalid values
 * silently fall back to defaults so a bad URL never blocks the render.
 */
export function parseCreatorDetailSearchParams(
  raw: Record<string, string | undefined>,
): CreatorDetailSearchParams {
  const parsed = CreatorDetailSearchParamsSchema.safeParse(raw);
  const data = parsed.success
    ? parsed.data
    : CreatorDetailSearchParamsSchema.parse({});
  return {
    ...data,
    period: parseDashboardPeriod(data.period),
  };
}
