"use server";

import { getDb } from "@/lib/db";
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
 * Both read the MAIN game DB read-only (SELECT only — no writes, ever) and
 * are gated exactly like the create action: page access to /notifications
 * plus `__can_manage_announcements`.
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

/** Active packs, searchable by name / slug / id. Max 20 rows. */
export async function searchAnnouncementPacks(
  query: string,
): Promise<AnnouncementPackOption[]> {
  const session = await requirePageAccess("/notifications");
  await requireCapability(
    session,
    "__can_manage_announcements",
    "compose announcements",
  );

  const db = await getDb();
  const q = query.trim();
  const or: Record<string, unknown>[] = [];
  if (q) {
    or.push({ name: { contains: q, mode: "insensitive" } });
    or.push({ slug: { contains: q, mode: "insensitive" } });
    if (UUID_RE.test(q)) or.push({ id: q });
  }
  // Only active packs — announcing a disabled pack would link users to a
  // page they can't open.
  const where: Record<string, unknown> = { active: true };
  if (or.length > 0) where.OR = or;

  const packs = await db.packs.findMany({
    where,
    select: { id: true, name: true, slug: true, image_url: true, price: true },
    orderBy: { name: "asc" },
    take: 20,
  });

  return packs.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    imageUrl: p.image_url,
    priceUsd: toNumber(p.price),
  }));
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

  const db = await getDb();
  const now = new Date();
  const codes = await db.promo_codes.findMany({
    where: { OR: [{ expires_at: null }, { expires_at: { gt: now } }] },
    orderBy: { created_at: "desc" },
    take: 50,
  });

  // Redemption counts for the returned page only — same scoped groupBy the
  // /promo-codes list uses, so a heavily-redeemed code can't drag an
  // unbounded row set into the request.
  const ids = codes.map((c) => c.id);
  const counts =
    ids.length > 0
      ? await db.promo_code_redemptions.groupBy({
          by: ["promo_code_id"],
          where: { promo_code_id: { in: ids } },
          _count: { _all: true },
        })
      : [];
  const countById = new Map(
    counts.map((c) => [c.promo_code_id, c._count._all]),
  );

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
        redeemedCount: countById.get(c.id) ?? 0,
        requiresDiscord: c.requires_discord,
        minimumLevel: c.minimum_level,
        expiresAt: c.expires_at ? c.expires_at.toISOString() : null,
      } satisfies AnnouncementPromoOption;
    })
    .filter((c): c is AnnouncementPromoOption => c !== null)
    .filter((c) => (q ? c.code.toUpperCase().includes(q) : true))
    .slice(0, 20);

  return { items, restricted: false };
}
