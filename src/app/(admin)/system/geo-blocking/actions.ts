"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import countries from "i18n-iso-countries";
import { eq, sql } from "drizzle-orm";

import { getPrimaryDrizzleDb } from "@/lib/db";
import {
  country_restrictions,
  site_config,
} from "@/lib/db-schema/main/schema";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { invalidateCountryRestrictionsCache } from "@/lib/invalidate-country-restrictions-cache";
import { GEO_BLOCKING_CACHE_TAG } from "@/lib/queries/geo-blocking";
import { FIAT_CACHE_TAG } from "@/lib/queries/fiat";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { backendApi } from "@/lib/backend-api";
import { resolveBackendApiConfig } from "@/lib/backend-api/config";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import {
  CREDIT_CARD_DEPOSIT_METHOD,
  hasAllWhopFiatDepositLocks,
  hasAnyWhopFiatDepositLock,
  isMandatoryFiatJurisdiction,
  LEGACY_FIAT_DEPOSIT_METHOD,
  MANDATORY_FIAT_JURISDICTION_CODES,
  WHOP_FIAT_DEPOSIT_LOCK_TOKENS,
  withWhopFiatDepositLocks,
  withoutWhopFiatDepositLocks,
} from "@/lib/fiat-jurisdiction-policy";

const SITE_FIAT_LOCK_KEY = "locked_deposits_fiat";
const WHOP_FIAT_DEPOSIT_LOCK_ALIASES = [
  LEGACY_FIAT_DEPOSIT_METHOD,
  ...WHOP_FIAT_DEPOSIT_LOCK_TOKENS,
];

function normalizedWhopFiatLocksSql(locked: boolean) {
  const retainedLocks = sql`
    ARRAY(
      SELECT DISTINCT method
      FROM unnest(locked_deposits_fiat) AS method
      WHERE method <> ALL(
        ${pgArrayParam(WHOP_FIAT_DEPOSIT_LOCK_ALIASES)}::text[]
      )
    )
  `;
  return locked
    ? sql`${retainedLocks} || ${pgArrayParam(WHOP_FIAT_DEPOSIT_LOCK_TOKENS)}::text[]`
    : retainedLocks;
}

function parseSiteFiatLocks(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    throw new Error(
      "The site-wide fiat lock list is invalid JSON. Fix the configured value before changing global fiat access.",
    );
  }
}

function revalidateFiatPolicyPages(): void {
  revalidateTag(GEO_BLOCKING_CACHE_TAG);
  revalidateTag(FIAT_CACHE_TAG);
  revalidatePath("/system/geo-blocking");
  revalidatePath("/fiat");
  revalidatePath("/security");
}

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
): Promise<void> {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_country_restriction", "update country restrictions");

  const validFields = [
    "locked_deposits_crypto",
    "locked_deposits_fiat",
    "locked_withdrawals_crypto",
  ];
  if (!validFields.includes(field)) throw new Error("Invalid field");

  const normalizedValues =
    field === "locked_deposits_fiat"
      ? hasAnyWhopFiatDepositLock(values)
        ? withWhopFiatDepositLocks(values)
        : withoutWhopFiatDepositLocks(values)
      : [...new Set(values)];

  if (
    field === "locked_deposits_fiat" &&
    isMandatoryFiatJurisdiction(countryCode) &&
    !hasAllWhopFiatDepositLocks(normalizedValues)
  ) {
    throw new Error(
      "Whop fiat deposits are required to stay locked for this policy jurisdiction.",
    );
  }

  const updated = await db
    .update(country_restrictions)
    .set({
      [field]: sql.param(normalizedValues),
      updated_at: new Date().toISOString(),
    })
    .where(eq(country_restrictions.country_code, countryCode))
    .returning({ country_code: country_restrictions.country_code });
  if (!updated[0]) throw new Error("Country restriction not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: { country_code: countryCode, field, values: normalizedValues },
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
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_toggle_country_restriction",
    "seed country restrictions",
  );

  const existing = await db
    .select({ country_code: country_restrictions.country_code })
    .from(country_restrictions);
  const existingSet = new Set(existing.map((r) => r.country_code));

  const allCodes = Object.keys(countries.getAlpha2Codes());
  const missing = allCodes.filter((code) => !existingSet.has(code));

  if (missing.length === 0) {
    return { seeded: 0, total: existingSet.size };
  }

  const inserted = await db
    .insert(country_restrictions)
    // Item/physical withdrawal OFF baseline; the rest use the schema defaults.
    .values(
      missing.map((country_code) => ({
        country_code,
        physical_withdrawal: false,
      })),
    )
    .onConflictDoNothing()
    .returning({ country_code: country_restrictions.country_code });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restrictions_seeded",
    metadata: {
      seeded_count: inserted.length,
      seeded_codes: inserted.map((row) => row.country_code),
    },
  });

  after(() => {
    invalidateCountryRestrictionsCache().catch(() => {});
  });
  revalidateTag(GEO_BLOCKING_CACHE_TAG);
  revalidatePath("/system/geo-blocking");
  return { seeded: inserted.length, total: existingSet.size + inserted.length };
}

export async function toggleCountryRestriction(
  countryCode: string,
  field: string,
  value: boolean
) {
  const db = await getPrimaryDrizzleDb();
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

  const valuesToSet = {
    [field]: value,
    updated_at: new Date().toISOString(),
    ...(isMandatoryFiatJurisdiction(countryCode)
      ? {
          locked_deposits_fiat: normalizedWhopFiatLocksSql(true),
        }
      : {}),
  };
  const updated = await db
    .update(country_restrictions)
    .set(valuesToSet)
    .where(eq(country_restrictions.country_code, countryCode))
    .returning({ country_code: country_restrictions.country_code });
  if (!updated[0]) throw new Error("Country restriction not found");

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

  // Direct + awaited (NOT the swallowing helpers) so a backend/CF failure
  // throws back to the button instead of vanishing into a logged catch.
  await Promise.all([
    backendApi.post("/admin/refresh-site-config"),
    backendApi.post("/admin/invalidate-country-restrictions-cache"),
  ]);

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

/**
 * Global Whop-fiat switch. Enabling removes the site-wide card/wallet locks,
 * opens every non-policy location, and keeps all mandatory jurisdictions
 * locked. Disabling locks the site and every location. The site_config row and
 * location rows move atomically, and legacy aliases are normalized away.
 */
export async function setGlobalFiatDeposits(
  allowed: boolean,
): Promise<{
  affected: number;
  protected: number;
  seeded: number;
  lockedMethods: string[];
  siteConfigCacheReloaded: boolean;
  countryRestrictionsCacheReloaded: boolean;
}> {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_update_country_restriction",
    "update country restrictions",
  );
  await requireCapability(
    session,
    "__can_upsert_site_config",
    "update fiat configuration",
  );

  const result = await db.transaction(async (tx) => {
    const siteResult = await tx.execute<{ value: string }>(sql`
      SELECT value
      FROM site_config
      WHERE key = ${SITE_FIAT_LOCK_KEY}
      FOR UPDATE
    `);
    const siteRow = siteResult.rows[0];
    if (!siteRow) {
      throw new Error(
        "The site-wide fiat lock list is not configured in this environment. The global switch cannot safely create a missing money-control key.",
      );
    }

    const currentSiteLocks = parseSiteFiatLocks(siteRow.value);
    const nextSiteLocks = allowed
      ? withoutWhopFiatDepositLocks(currentSiteLocks)
      : withWhopFiatDepositLocks(currentSiteLocks);

    await tx
      .update(site_config)
      .set({
        value: JSON.stringify(nextSiteLocks.sort()),
        updated_at: new Date().toISOString(),
      })
      .where(eq(site_config.key, SITE_FIAT_LOCK_KEY));

    const inserted = await tx
      .insert(country_restrictions)
      .values(
        MANDATORY_FIAT_JURISDICTION_CODES.map((country_code) => ({
          country_code,
        })),
      )
      .onConflictDoNothing()
      .returning({ country_code: country_restrictions.country_code });

    const updated = allowed
      ? await tx.execute<{ country_code: string }>(sql`
          UPDATE country_restrictions
          SET
            locked_deposits_fiat = CASE
              WHEN country_code = ANY(
                ${pgArrayParam(MANDATORY_FIAT_JURISDICTION_CODES)}::text[]
              )
                THEN ${normalizedWhopFiatLocksSql(true)}
              ELSE ${normalizedWhopFiatLocksSql(false)}
            END,
            updated_at = NOW()
          RETURNING country_code
        `)
      : await tx.execute<{ country_code: string }>(sql`
          UPDATE country_restrictions
          SET
            locked_deposits_fiat = ${normalizedWhopFiatLocksSql(true)},
            updated_at = NOW()
          RETURNING country_code
        `);

    return {
      affected: updated.rows.length,
      protected: MANDATORY_FIAT_JURISDICTION_CODES.length,
      seeded: inserted.length,
      lockedMethods: nextSiteLocks,
    };
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: {
      action: "global_fiat_deposits",
      allowed,
      affected: result.affected,
      protected: result.protected,
      seeded: result.seeded,
      method: CREDIT_CARD_DEPOSIT_METHOD,
    },
  });

  const [siteConfigCache, countryRestrictionsCache] =
    await Promise.allSettled([
      backendApi.post("/admin/refresh-site-config"),
      backendApi.post("/admin/invalidate-country-restrictions-cache"),
    ]);
  revalidateFiatPolicyPages();
  return {
    ...result,
    siteConfigCacheReloaded: siteConfigCache.status === "fulfilled",
    countryRestrictionsCacheReloaded:
      countryRestrictionsCache.status === "fulfilled",
  };
}

/**
 * Global physical-item withdrawal switch. This changes only the
 * `country_restrictions.physical_withdrawal` availability flag for every
 * existing location; it does not touch the broader `withdrawals_enabled`
 * site-config key, crypto withdrawals, or balance withdrawals.
 */
export async function setGlobalPhysicalItemWithdrawals(
  enabled: boolean,
): Promise<{
  changed: number;
  total: number;
  countryRestrictionsCacheReloaded: boolean;
}> {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_toggle_country_restriction",
    "toggle physical item withdrawals",
  );

  const result = await db.execute<{ changed: number; total: number }>(sql`
    WITH changed_rows AS (
      UPDATE country_restrictions
      SET
        physical_withdrawal = ${enabled},
        updated_at = NOW()
      WHERE physical_withdrawal IS DISTINCT FROM ${enabled}
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*)::int FROM changed_rows) AS changed,
      (SELECT COUNT(*)::int FROM country_restrictions) AS total
  `);
  const counts = result.rows[0] ?? { changed: 0, total: 0 };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: {
      action: "global_physical_item_withdrawals",
      field: "physical_withdrawal",
      enabled,
      changed: counts.changed,
      total: counts.total,
    },
  });

  const countryRestrictionsCache = await Promise.allSettled([
    backendApi.post("/admin/invalidate-country-restrictions-cache"),
  ]);
  revalidateTag(GEO_BLOCKING_CACHE_TAG);
  revalidatePath("/system/geo-blocking");
  return {
    ...counts,
    countryRestrictionsCacheReloaded:
      countryRestrictionsCache[0]?.status === "fulfilled",
  };
}

export async function setMandatoryJurisdictionsGeoBlocked(
  blocked: boolean,
): Promise<{
  affected: number;
  seeded: number;
  countryRestrictionsCacheReloaded: boolean;
}> {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_toggle_country_restriction",
    "toggle country restrictions",
  );

  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(country_restrictions)
      .values(
        MANDATORY_FIAT_JURISDICTION_CODES.map((country_code) => ({
          country_code,
        })),
      )
      .onConflictDoNothing()
      .returning({ country_code: country_restrictions.country_code });

    const updated = await tx.execute<{ country_code: string }>(sql`
      UPDATE country_restrictions
      SET
        blocked = ${blocked},
        locked_deposits_fiat = ${normalizedWhopFiatLocksSql(true)},
        updated_at = NOW()
      WHERE country_code = ANY(
        ${pgArrayParam(MANDATORY_FIAT_JURISDICTION_CODES)}::text[]
      )
      RETURNING country_code
    `);

    return { affected: updated.rows.length, seeded: inserted.length };
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "country_restriction_updated",
    metadata: {
      action: "mandatory_jurisdictions_geo_block",
      blocked,
      affected: result.affected,
      seeded: result.seeded,
    },
  });

  const countryRestrictionsCache = await Promise.allSettled([
    backendApi.post("/admin/invalidate-country-restrictions-cache"),
  ]);
  revalidateFiatPolicyPages();
  return {
    ...result,
    countryRestrictionsCacheReloaded:
      countryRestrictionsCache[0]?.status === "fulfilled",
  };
}
