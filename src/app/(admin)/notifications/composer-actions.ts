"use server";

import { and, count, desc, eq, gt, ilike, isNull, or } from "drizzle-orm";

import { getProdReadDrizzleDb, getReadDrizzleDb } from "@/lib/db";
import {
  packs,
  promo_code_redemptions,
  promo_codes,
} from "@/lib/db-schema/main/schema";
import {
  requirePageAccess,
  getUserPermissions,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import { pageAccessGranted } from "@/lib/admin-pages";
import { requireCapability } from "@/lib/require-capability";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Lookups behind the announcement composer's Pack and Promo-code templates.
 *
 * These read the MAIN game DB read-only (SELECT only — no writes, ever).
 * Announcement lookups follow the selected DB environment and require
 * `__can_manage_announcements`; direct pack notifications use the live pack
 * catalog and their separate `__can_send_user_notifications` capability.
 *
 * Query shape: `packs` is a small catalog table (282 rows / 196 active,
 * verified read-only against prod on 2026-07-22) and `promo_codes` holds a
 * handful of rows, so a bounded `findMany` over them is optimal — an index
 * would never be chosen for a table this size. This is the same read shape
 * the /challenges (`item-picker`) and /rewards (`prize-search-actions`)
 * pickers already use.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnnouncementPackOption = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  priceUsd: number;
  createdAt: string;
};

export type AnnouncementPromoOption = {
  id: string;
  /** Plaintext code — only stored in `promo_codes.metadata.code`; the column
   * itself is a hash, so a code created outside the admin has no plaintext. */
  code: string;
  valueUsd: number;
  region: string;
  maxUses: number;
  redeemedCount: number;
  requiresDiscord: boolean;
  minimumLevel: number;
  expiresAt: string | null;
};

export type PromoCodeLookup = {
  items: AnnouncementPromoOption[];
  /** True when the admin may compose announcements but has no access to the
   * promo-code list — the composer then falls back to manual code entry. */
  restricted: boolean;
};

async function queryActivePacks(
  query: string,
  catalog: "selected-env" | "production" = "selected-env",
): Promise<AnnouncementPackOption[]> {
  const db =
    catalog === "production"
      ? getProdReadDrizzleDb()
      : await getReadDrizzleDb();
  const q = query.trim();
  const search = q
    ? or(
        ilike(packs.name, `%${q}%`),
        ilike(packs.slug, `%${q}%`),
        ...(UUID_RE.test(q) ? [eq(packs.id, q)] : []),
      )
    : undefined;
  // Only active packs — announcing a disabled pack would link users to a
  // page they can't open.
  const packRows = await db
    .select({
      id: packs.id,
      name: packs.name,
      slug: packs.slug,
      image_url: packs.image_url,
      price: packs.price,
      created_at: packs.created_at,
    })
    .from(packs)
    .where(and(eq(packs.active, true), search))
    .orderBy(desc(packs.created_at), desc(packs.id))
    .limit(20);

  return packRows.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    imageUrl: p.image_url,
    priceUsd: toNumber(p.price),
    createdAt: new Date(p.created_at).toISOString(),
  }));
}

/** Active packs for the broadcast-announcement composer. */
export async function searchAnnouncementPacks(
  query: string,
): Promise<AnnouncementPackOption[]> {
  const session = await requirePageAccess("/notifications");
  await requireCapability(
    session,
    "__can_manage_announcements",
    "compose announcements",
  );
  return queryActivePacks(query);
}

/** Active packs for the personal-notification composer. Kept behind its
 * separate money-adjacent capability rather than borrowing announcement
 * access merely because both surfaces share the same catalog picker. */
export async function searchDirectNotificationPacks(
  query: string,
): Promise<AnnouncementPackOption[]> {
  const session = await requirePageAccess("/notifications");
  await requireCapability(
    session,
    "__can_send_user_notifications",
    "send user notifications",
  );
  // Recipient lookup and delivery still follow the DEV/PROD toggle. The pack
  // here is content for the notification, though, and the public link points
  // at the live site. Pinning this picker to the read-only production catalog
  // keeps DEV test sends useful even when the dev database has no seeded packs.
  return queryActivePacks(query, "production");
}

/**
 * Live (non-expired) promo codes with their plaintext, so an announcement can
 * broadcast one without the admin retyping it. Soft-gated on /promo-codes
 * page access: an announcement author without it gets `restricted: true` and
 * types the code by hand instead of seeing the code list.
 */
export async function searchAnnouncementPromoCodes(
  query: string,
): Promise<PromoCodeLookup> {
  const session = await requirePageAccess("/notifications");
  await requireCapability(
    session,
    "__can_manage_announcements",
    "compose announcements",
  );

  const allowedPages = await getUserPermissions(session.userId);
  const canSeeCodes =
    sessionIsAdmin(session) ||
    sessionIsOwner(session) ||
    pageAccessGranted(allowedPages, "/promo-codes");
  if (!canSeeCodes) return { items: [], restricted: true };

  const db = await getReadDrizzleDb();
  const codes = await db
    .select({
      id: promo_codes.id,
      value: promo_codes.value,
      region: promo_codes.region,
      max_uses: promo_codes.max_uses,
      requires_discord: promo_codes.requires_discord,
      minimum_level: promo_codes.minimum_level,
      expires_at: promo_codes.expires_at,
      metadata: promo_codes.metadata,
      redeemed_count: count(promo_code_redemptions.id),
    })
    .from(promo_codes)
    .leftJoin(
      promo_code_redemptions,
      eq(promo_code_redemptions.promo_code_id, promo_codes.id),
    )
    .where(
      or(
        isNull(promo_codes.expires_at),
        gt(promo_codes.expires_at, new Date().toISOString()),
      ),
    )
    .groupBy(promo_codes.id)
    .orderBy(desc(promo_codes.created_at))
    .limit(50);

  // Redemption counts for the returned page only — same scoped groupBy the
  // /promo-codes list uses, so a heavily-redeemed code can't drag an
  // unbounded row set into the request.
  const q = query.trim().toUpperCase();
  const items = codes
    .map((c) => {
      const meta = c.metadata as Record<string, unknown> | null;
      const code = typeof meta?.code === "string" ? meta.code : null;
      if (!code) return null;
      return {
        id: c.id,
        code,
        valueUsd: toNumber(c.value),
        region: c.region as string,
        maxUses: c.max_uses,
        redeemedCount: c.redeemed_count,
        requiresDiscord: c.requires_discord,
        minimumLevel: c.minimum_level,
        expiresAt: c.expires_at ? new Date(c.expires_at).toISOString() : null,
      } satisfies AnnouncementPromoOption;
    })
    .filter((c): c is AnnouncementPromoOption => c !== null)
    .filter((c) => (q ? c.code.toUpperCase().includes(q) : true))
    .slice(0, 20);

  return { items, restricted: false };
}
