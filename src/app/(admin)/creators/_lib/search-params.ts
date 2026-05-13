import { z } from "zod";

// `filter` powers the click-through from the Live Now / Active Deals
// tiles. Optional — when absent the page renders the normal paginated
// list. When set, the page switches to `listCreatorsFiltered` and
// shows the matching subset on a single page (pagination is hidden).
// `z.enum` rejects unknown values so an URL-fuzzer can't smuggle
// garbage into the page's render path.
const CreatorsSearchParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  filter: z.enum(["live", "active-deals"]).optional(),
});

export type CreatorsSearchParams = z.infer<typeof CreatorsSearchParamsSchema>;

/**
 * Parse the raw search params from a Next.js page and coerce to a typed,
 * defaulted object. Invalid values silently fall back to defaults so that
 * a bad URL never breaks the page render — we only care about valid ones.
 */
export function parseCreatorsSearchParams(
  raw: Record<string, string | undefined>,
): CreatorsSearchParams {
  const parsed = CreatorsSearchParamsSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : CreatorsSearchParamsSchema.parse({});
}
