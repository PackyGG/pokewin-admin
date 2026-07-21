"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import countries from "i18n-iso-countries";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { invalidateCountryRestrictionsCache } from "@/lib/invalidate-country-restrictions-cache";
import { GEO_BLOCKING_CACHE_TAG } from "@/lib/queries/geo-blocking";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { backendApi } from "@/lib/backend-api";
import { resolveBackendApiConfig } from "@/lib/backend-api/config";

/**
 * Geo Blocking (formerly "Country Restrictions") server actions — relocated
 * verbatim from the old `/settings` page into the /system/geo-blocking
 * feature. The guards/capabilities are unchanged: requireAdmin + the same
 * `__can_update_country_restriction` / `__can_toggle_country_restriction`
 * capabilities. Only `revalidatePath` now targets /system/geo-blocking (the
 * new home) instead of the removed /settings route.
 *
 * Cache-invalidation note: these mutations write to `country_restrictions`,
 * which lives in its own Redis cache on the backend — NOT `site_config`.
 * They call `invalidateCountryRestrictionsCache()` (dedicated backend
 * endpoint) rather than `refreshSiteConfig()`, which was a mismatched-cache
 * bug fixed 2026-07-12 (see src/lib/refresh-site-config.ts for the
 * site_config sibling). They ALSO call `revalidateTag(GEO_BLOCKING_CACHE_TAG)`
 * (added 2026-07-12 alongside the admin-page's own `unstable_cache` read, see
 * `src/lib/queries/geo-blocking.ts`) — `revalidatePath` alone does not evict
 * an `unstable_cache` entry, so without this a toggle would keep serving the
 * pre-toggle row for up to the cache's 300s TTL. `revalidateTag` is kept on
 * the synchronous, awaited path (not inside `after()` below) so the local
 * Next.js cache is guaranteed evicted before the response returns.
 *
 * Perf fix (2026-07-12, owner: "when i click blocked it takes rly long to
 * load"): `invalidateCountryRestrictionsCache()` used to be awaited here,
 * putting a cross-service HTTP round-trip (its own dedicated 8s timeout, see
 * src/lib/backend-api/client.ts DEFAULT_TIMEOUT_MS) on the critical path of
 * every single toggle/array edit. The function already swallows and only
 * logs its own errors (its result was never surfaced to the UI either way),
 * so awaiting it bought zero error-visibility at the cost of the entire
 * round-trip's latency. Moved behind `after()` (same fire-and-forget
 * pattern as the tip-limit webhook dispatch in
 * src/app/(admin)/creators/actions.ts) so the DB write / audit event / page
 * revalidation — the parts the admin actually waits on and the only parts
 * that were ever reflected back to them — return immediately, while the
 * best-effort backend cache-bust still happens right after the response.
 *
 * These WRITE the MAIN/PROD game DB at runtime (operator-triggered). The
 * relocation does not change that behaviour.
 */
export async function updateCountryRestrictionArray(
  countryCode: string,
  field: string,
  values: string[]
) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_country_restriction", "update country restrictions");

  const validFields = [
    "locked_deposits_crypto",
    "locked_deposits_fiat",
    "locked_withdrawals_crypto",
  ];
  if (!validFields.includes(field)) throw new Error("Invalid field");

  await db.country_restrictions.update({
    where: { country_code: countryCode },
    data: { [field]: values },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: { country_code: countryCode, field, values },
  });

  after(() => {
    invalidateCountryRestrictionsCache().catch(() => {});
  });
  revalidateTag(GEO_BLOCKING_CACHE_TAG);
  revalidatePath("/system/geo-blocking");
}

/**
 * Backfill any ISO country that has no `country_restrictions` row yet, so every country is
 * present and editable on the page (owner: "item withdrawal is disabled for all countries,
 * not just 247"). Idempotent — only INSERTs the missing codes, never touches existing rows —
 * so it's safe to re-run. New rows get the item/physical-withdrawal-OFF baseline
 * (`physical_withdrawal=false`); everything else falls to the schema defaults (not blocked,
 * digital/promo allowed, no locked currencies).
 *
 * NOTE: the country universe is `i18n-iso-countries`' alpha-2 set (~249) — the SAME list the
 * page resolves names/flags from. If the game needs a broader list (territories / custom
 * codes to reach ~301), swap the source here; the insert stays idempotent. Operator-triggered
 * (a button on the page) + audited, since it WRITES the prod game DB.
 */
export async function seedMissingCountryRestrictions(): Promise<{
  seeded: number;
  total: number;
}> {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_toggle_country_restriction",
    "seed country restrictions",
  );

  const existing = await db.country_restrictions.findMany({
    select: { country_code: true },
  });
  const existingSet = new Set(existing.map((r) => r.country_code));

  const allCodes = Object.keys(countries.getAlpha2Codes());
  const missing = allCodes.filter((code) => !existingSet.has(code));

  if (missing.length === 0) {
    return { seeded: 0, total: existingSet.size };
  }

  await db.country_restrictions.createMany({
    // Item/physical withdrawal OFF baseline; the rest use the schema defaults.
    data: missing.map((country_code) => ({ country_code, physical_withdrawal: false })),
    skipDuplicates: true,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restrictions_seeded",
    metadata: { seeded_count: missing.length, seeded_codes: missing },
  });

  after(() => {
    invalidateCountryRestrictionsCache().catch(() => {});
  });
  revalidateTag(GEO_BLOCKING_CACHE_TAG);
  revalidatePath("/system/geo-blocking");
  return { seeded: missing.length, total: existingSet.size + missing.length };
}

export async function toggleCountryRestriction(
  countryCode: string,
  field: string,
  value: boolean
) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_toggle_country_restriction", "toggle country restrictions");

  const validFields = [
    "physical_withdrawal",
    "digital_withdrawal",
    "gift_card_deposit",
    "promo_code_deposit",
    "blocked",
  ];
  if (!validFields.includes(field)) throw new Error("Invalid field");

  await db.country_restrictions.update({
    where: { country_code: countryCode },
    data: { [field]: value },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: { country_code: countryCode, field, value },
  });

  after(() => {
    invalidateCountryRestrictionsCache().catch(() => {});
  });
  revalidateTag(GEO_BLOCKING_CACHE_TAG);
  revalidatePath("/system/geo-blocking");
}

/**
 * Manually bust the game backend's country-restriction Redis cache NOW instead
 * of waiting for its ~1h TTL, and report WHICH backend env was hit.
 *
 * Unlike the fire-and-forget `invalidateCountryRestrictionsCache()` on every
 * toggle (which swallows its result), this AWAITS the call so a failure
 * surfaces to the operator, and returns the requested vs. resolved env. When
 * the admin is in `dev` mode but the dev backend isn't configured
 * (`BACKEND_API_URL_DEV` / `BACKEND_ADMIN_KEY_DEV` missing), `resolveEffective
 * Env` silently falls back to the PROD backend — so a "dev" reload would bust
 * the prod cache and look like it worked while the dev cache stayed stale.
 * Returning both envs lets the UI warn on that mismatch. Audited; writes no DB.
 */
export async function reloadCountryRestrictionsCache(): Promise<{
  requestedEnv: DbEnv;
  resolvedEnv: DbEnv;
}> {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_toggle_country_restriction",
    "reload country restriction cache",
  );

  const [requestedEnv, config] = await Promise.all([
    readDbEnv(),
    resolveBackendApiConfig(),
  ]);
  const resolvedEnv = config.env;

  // Direct + awaited (NOT the swallowing helper) so a backend/CF failure
  // throws back to the button instead of vanishing into a logged catch.
  await backendApi.post("/admin/invalidate-country-restrictions-cache");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: {
      action: "reload_cache",
      requested_env: requestedEnv,
      resolved_env: resolvedEnv,
    },
  });

  return { requestedEnv, resolvedEnv };
}
