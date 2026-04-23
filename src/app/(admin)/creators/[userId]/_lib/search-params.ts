import { z } from "zod";

const StreamSessionStatus = z.enum(["active", "ended", "converted"]);
const PendingConversionStatus = z.enum(["pending", "claimed"]);
const TabValue = z.enum(["deals", "sessions", "pending"]);

const CreatorDetailSearchParamsSchema = z.object({
  tab: TabValue.default("deals"),

  dealsPage: z.coerce.number().int().min(1).default(1),
  dealsPerPage: z.coerce.number().int().min(1).max(100).default(20),

  sessionsPage: z.coerce.number().int().min(1).default(1),
  sessionsPerPage: z.coerce.number().int().min(1).max(100).default(20),
  sessionsStatus: StreamSessionStatus.optional(),

  pendingStatus: PendingConversionStatus.default("pending"),
});

export type CreatorDetailSearchParams = z.infer<
  typeof CreatorDetailSearchParamsSchema
>;

/**
 * Parse raw search params for the creator detail page. Invalid values
 * silently fall back to defaults so a bad URL never blocks the render.
 */
export function parseCreatorDetailSearchParams(
  raw: Record<string, string | undefined>,
): CreatorDetailSearchParams {
  const parsed = CreatorDetailSearchParamsSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : CreatorDetailSearchParamsSchema.parse({});
}
