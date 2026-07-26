import "server-only";

/**
 * Shared cache settings for the per-creator "Deal Costs (House)" panel
 * sources (`leaderboard-cost-by-creator`, `multiplier-cost-by-creator`,
 * `fill-conversion-cost-by-creator`, `tips-sponsor-cost-by-creator`).
 *
 * ─── WHY THESE ARE CACHED ────────────────────────────────────────────
 *
 * Each of the four cost sources is a LIFETIME / stable aggregate keyed on a
 * single creator (no time-window arg): the Σ over `creator_fill_conversion`
 * vouchers, the Σ over the house-funded tip/sponsor ledger legs, the
 * paginated walk of every approved leaderboard, and the paginated walk of
 * every multiplier deal. None of them change second-to-second, yet they were
 * re-run cold on EVERY render of /creators/[userId] — including every press
 * of the page's "Refresh to retry" banner after a different (heavy) panel
 * timed out. That repeated cold work is pure waste and piles onto the same
 * `max: 5` connection pool the rest of the page contends for.
 *
 * Wrapping each source in `unstable_cache` keyed on the creator id means a
 * repeat load (or a retry) serves the warmed result instead of re-scanning.
 * TTL is a few minutes — long enough to absorb repeat loads + retries, short
 * enough that a newly-recorded payout / tip / leaderboard shows up promptly.
 * On TTL expiry the next read transparently refills, so correctness is
 * preserved (the figure is at most this-many-seconds stale).
 *
 * ─── ENV NOTE (matches the existing repo pattern) ────────────────────
 *
 * The Main-DB sources resolve their pool INSIDE the cached function, exactly like
 * the existing `cachedCreatorsCodesListStats` (creators-codes.ts) and the
 * insights-rewards cached helpers. Inside an `unstable_cache` scope the
 * request cookie jar isn't readable, so `readDbEnv()` falls back to PROD
 * (its `cookies()` read is wrapped in try/catch → "prod"). The cache key
 * therefore does not vary by the admin's dev/prod toggle — a cached cost
 * always reflects PROD, the same behaviour every other cached query in this
 * codebase already has. That's correct for this admin panel (prod is the
 * real surface); a dev-DB admin simply shares the prod-warmed cost cache.
 */
export const CREATOR_COST_CACHE_TTL_SECONDS = 180;
