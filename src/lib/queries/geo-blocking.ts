import { unstable_cache } from "next/cache";
import { dbForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";

export type CountryRestrictionRow = {
  countryCode: string;
  physicalWithdrawal: boolean;
  digitalWithdrawal: boolean;
  giftCardDeposit: boolean;
  promoCodeDeposit: boolean;
  blocked: boolean;
  lockedDepositsCrypto: string[];
  lockedDepositsFiat: string[];
  lockedWithdrawalsCrypto: string[];
};

/**
 * Cache tag for the Geo Blocking restrictions list. The mutations in
 * `system/geo-blocking/actions.ts` (`toggleCountryRestriction` /
 * `updateCountryRestrictionArray`) call `revalidateTag(GEO_BLOCKING_CACHE_TAG)`
 * right after writing so a just-toggled restriction is never served stale —
 * `revalidatePath` alone does NOT evict `unstable_cache` entries. Exported so
 * the actions import the exact same string (no drift between writer and
 * reader). Mirrors `SETS_CACHE_TAG` / `WITHDRAWALS_LIST_TAG`.
 */
export const GEO_BLOCKING_CACHE_TAG = "geo-blocking-restrictions";

// `env` is threaded in (resolved in the request scope by the public entry
// point below) so the cache callback never calls `getDb()` — which reads the
// request cookie via `cookies()`, illegal inside `unstable_cache` — and so a
// dev-DB-toggled admin's cache entries never collide with prod. Mirrors
// `computeSetsList` in `queries/sets.ts`.
async function computeCountryRestrictions(
  env: DbEnv,
): Promise<CountryRestrictionRow[]> {
  const db = dbForEnv(env);
  const rows = await db.country_restrictions.findMany({
    orderBy: { country_code: "asc" },
  });

  return rows.map((c) => ({
    countryCode: c.country_code,
    physicalWithdrawal: c.physical_withdrawal,
    digitalWithdrawal: c.digital_withdrawal,
    giftCardDeposit: c.gift_card_deposit,
    promoCodeDeposit: c.promo_code_deposit,
    blocked: c.blocked,
    lockedDepositsCrypto: c.locked_deposits_crypto,
    lockedDepositsFiat: c.locked_deposits_fiat,
    lockedWithdrawalsCrypto: c.locked_withdrawals_crypto,
  }));
}

/**
 * Cross-request cache for the Geo Blocking list. This is small (250 rows,
 * confirmed via a read-only prod `EXPLAIN ANALYZE` — sub-millisecond, PK seq
 * scan) config data that changes rarely (an admin occasionally toggles one
 * country), so a 300s `unstable_cache` (mirrors the `sets-series` /
 * `sets-stats` TTL) means a repeat navigation is an instant cache hit that
 * touches NO DB connection at all — avoiding the shared MAIN-DB pool
 * entirely (see the `max: 3` pool-contention note in `src/lib/db.ts`)
 * instead of just making an already-fast query faster.
 */
const cachedCountryRestrictions = unstable_cache(
  computeCountryRestrictions,
  ["geo-blocking-restrictions-v1"],
  { revalidate: 300, tags: [GEO_BLOCKING_CACHE_TAG] },
);

/**
 * Geo Blocking — per-country restriction rows for the
 * /system/geo-blocking page (formerly the "Country Restrictions" section of
 * /settings). Same MAIN-DB source the old `getSettings` read used:
 * `country_restrictions` ordered by ascending country code. Read-only.
 * Resolves the request's DB env (the cookie read happens HERE, in the
 * request scope) then delegates to the cached fn.
 */
export async function getCountryRestrictions(): Promise<CountryRestrictionRow[]> {
  const env = await readDbEnv();
  return cachedCountryRestrictions(env);
}
