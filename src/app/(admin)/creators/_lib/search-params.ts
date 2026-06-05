import { z } from "zod";

import {
  DASHBOARD_PERIODS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";

/**
 * /creators-specific period floor.
 *
 * The shared dashboard chip set starts at "1h", but on /creators the owner
 * wants 48h to be the SHORTEST selectable window — the sub-48h windows
 * (1h/3h/6h/12h/24h) are too noisy for creator-cohort GGR. So /creators:
 *   • renders only the chips from 48h up (`CREATORS_PERIODS`),
 *   • clamps any incoming `?period=` below 48h (or absent → the global 24h
 *     default) UP to 48h (`clampCreatorsPeriod`), used by BOTH the server
 *     page's param parse and the client period control so they agree.
 *
 * Other pages that consume `DASHBOARD_PERIODS` are untouched — this floor
 * lives entirely in the /creators surface.
 */
export const CREATORS_MIN_PERIOD: DashboardPeriod = "48h";

// Index of the floor in the canonical chip order. The windows at or after
// this index are the ones /creators exposes; everything before it (the
// sub-48h windows) is hidden + clamped away.
const CREATORS_MIN_PERIOD_INDEX = DASHBOARD_PERIODS.indexOf(CREATORS_MIN_PERIOD);

/**
 * The /creators chip set — `DASHBOARD_PERIODS` from 48h onward
 * (48h · 3d · 7d · 30d · all). Derived from the canonical order so a future
 * chip added after 48h shows up here automatically.
 */
export const CREATORS_PERIODS: readonly DashboardPeriod[] =
  DASHBOARD_PERIODS.slice(CREATORS_MIN_PERIOD_INDEX);

/**
 * Resolve a raw `?period=` value to the effective /creators window:
 *   • an unknown / missing value → the 48h floor,
 *   • a recognised window SHORTER than 48h (1h…24h) → clamped up to 48h,
 *   • a recognised window AT or ABOVE 48h → itself.
 * Shared by the Zod schema (server) and `<CreatorsPeriodControl>` (client)
 * so the loaded window and the highlighted chip never disagree.
 */
export function clampCreatorsPeriod(
  value: string | undefined | null,
): DashboardPeriod {
  const idx = (DASHBOARD_PERIODS as readonly string[]).indexOf(value ?? "");
  if (idx < 0 || idx < CREATORS_MIN_PERIOD_INDEX) return CREATORS_MIN_PERIOD;
  return DASHBOARD_PERIODS[idx];
}

/**
 * Sort modes for /creators.
 *   • recent   — default backend-paginated view (creation-order
 *                tiebreak); active-deal creators are pinned to the
 *                top of each page client-side.
 *   • ggr_desc — biggest house win first. Orders the page rows by the
 *                windowed code-user GGR (`getAllCreatorsNetGgr`) merged
 *                onto each visible creator — positive = the cohort lost
 *                money to us (house win). GGR-side only; the full Net
 *                PnL (GGR − cost) lives on /creators/[id].
 *   • ggr_asc  — biggest house loss first (cohorts we paid out to).
 *   • ftd_desc — most first-time depositors first.
 *   • ftd_asc  — fewest first-time depositors first.
 *
 * The ggr_* / ftd_* sorts re-order ONLY the current page's rows in
 * memory (after the per-row GGR/FTD enrichment lands) — the same model
 * the `recent` active-deal pin uses. They do NOT trigger a full-pool
 * walk; the proper roster-wide ranking lives on the detail surfaces.
 */
export const CreatorsSortMode = z.enum([
  "recent",
  "ggr_desc",
  "ggr_asc",
  "ftd_desc",
  "ftd_asc",
]);
export type CreatorsSortMode = z.infer<typeof CreatorsSortMode>;

/**
 * Which creator-deal program the list is filtered to — the page's
 * Fill / Multiplier / Past-creators tabs.
 *   • fill       — creators with at least one fill (weekly) deal.
 *   • multiplier — creators with at least one multiplier deal.
 *   • past       — CANCELED / ex-creators: users whose creator role was
 *                  removed but who were creators before (own an affiliate
 *                  code, or have an admin audit role-change → creator).
 *                  Sourced from the DB, not the live backend creator list
 *                  (which only returns current creators). See
 *                  `_queries/list-ex-creators.ts`.
 * Default `fill`. An active creator with neither deal type appears on
 * neither the fill nor multiplier tab.
 */
export const CreatorsTab = z.enum(["fill", "multiplier", "past"]);
export type CreatorsTab = z.infer<typeof CreatorsTab>;

/**
 * Grid / List render mode for the roster.
 *   • grid — self-contained cards (default; matches SSR first paint).
 *   • list — compact one-creator-per-row table.
 *
 * URL-bound (Item C, 2026-06-05) for bookmark + share parity with the
 * rest of the controls. Pure presentation over the SAME already-fetched
 * data, so the server page deliberately omits `view` from the Suspense
 * `key=` — switching it is a router.replace that the client provider
 * picks up via `useSearchParams` and re-renders the existing rows in
 * place with NO refetch / NO skeleton. localStorage hydration was dropped
 * with the URL move — the URL is now the source of truth across reloads.
 */
export const CreatorsViewMode = z.enum(["grid", "list"]);
export type CreatorsViewMode = z.infer<typeof CreatorsViewMode>;

const CreatorsSearchParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * Username / email substring filter for the loaded roster. Lives in
   * the URL (`?q=`) for bookmark + share parity, but is NEVER read by
   * heavy server queries: the server page reads `q` only to render the
   * input's initial value, and the Suspense `key=` deliberately omits
   * it so a keystroke does not re-trigger the roster-wide GGR ledger
   * scan / backend roster walk. The provider filters the already-
   * fetched rows client-side (matchesCreatorSearch), preserving the
   * instant-filter UX while still making `?q=…` round-trippable.
   */
  q: z.string().trim().max(200).optional(),
  /**
   * Grid / List render mode for the roster. Pure client presentation —
   * see CreatorsViewMode docs above. Default is implicit (`grid`); a
   * missing param resolves to grid without polluting the URL.
   */
  view: CreatorsViewMode.optional(),
  // `filter` powers the click-through from the Live Now / Active Deals
  // tiles. Optional — when absent the page renders the normal
  // paginated list. When set, the page switches to
  // `listCreatorsFiltered` and shows the matching subset on a single
  // page (pagination is hidden). `z.enum` rejects unknown values so a
  // URL-fuzzer can't smuggle garbage into the page's render path.
  filter: z.enum(["live", "active-deals"]).optional(),
  sortBy: CreatorsSortMode.default("recent"),
  tab: CreatorsTab.default("fill"),
  // `period` scopes the per-creator windowed code-user GGR shown on the
  // list (and the roster-wide Net Code-User GGR tile). Reuses the
  // dashboard period set so the chip values line up with the rest of
  // the app, but FLOORED to 48h on /creators: any sub-48h value (or a
  // missing param → the global 24h default) is clamped up to 48h via
  // `clampCreatorsPeriod`, so the only windows the server ever loads here
  // are 48h/3d/7d/30d/all — matching the rendered chip set. Coerced from
  // a free string (not `z.enum`) precisely so an out-of-range/legacy value
  // clamps instead of resetting to a hidden default.
  // Active-timeframe-only: only this one window is fetched per render —
  // switching it is a fresh `?period=` navigation, never an eager preload.
  period: z
    .string()
    .optional()
    .transform((v) => clampCreatorsPeriod(v)),
});

/**
 * Server-side typed view of the URL params. Adds a `search` alias of `q`
 * so the existing DB/backend query helpers that already destructure
 * `search` (list-ex-creators, list-creators-by-tab, list-creators) keep
 * working without rewrites. The two are always equal — `q` is the new
 * canonical URL token (matches /insights conventions), `search` is the
 * helper-side name.
 */
export type CreatorsSearchParams = z.infer<typeof CreatorsSearchParamsSchema> & {
  /** Alias of `q` for backend/DB query helpers that destructure `search`. */
  search: string | undefined;
};

/**
 * Parse the raw search params from a Next.js page and coerce to a typed,
 * defaulted object. Invalid values silently fall back to defaults so that
 * a bad URL never breaks the page render — we only care about valid ones.
 * Also: legacy `?search=` URLs (the prior search-param name) are accepted
 * as an alias of `?q=` on read so existing bookmarks keep working;
 * outgoing writes always use `?q=`.
 */
export function parseCreatorsSearchParams(
  raw: Record<string, string | undefined>,
): CreatorsSearchParams {
  // Honour legacy `?search=` bookmarks: if the new `?q=` token is absent
  // but the old token is present, surface the old value as `q`. The schema
  // sees a normalised input so the rest of the page only ever reads `q`.
  const merged: Record<string, string | undefined> = { ...raw };
  if (!merged.q && raw.search) merged.q = raw.search;

  const parsed = CreatorsSearchParamsSchema.safeParse(merged);
  const data = parsed.success
    ? parsed.data
    : CreatorsSearchParamsSchema.parse({});
  return {
    ...data,
    // Pass-through alias so backend/DB query helpers that still
    // destructure `search` keep compiling without churning their
    // signatures.
    search: data.q,
  };
}
