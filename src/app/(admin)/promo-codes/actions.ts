"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";

import { getPrimaryDrizzleDb } from "@/lib/db";
import {
  promo_code_redemptions,
  promo_codes,
  user,
} from "@/lib/db-schema/main/schema";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createHash } from "crypto";
import { resolveCodePepper } from "@/lib/reward-campaign-codes";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { safeQuery } from "@/lib/errors/safe-query";
import { fail, ok, type ServerActionResult } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";
import {
  getPromoCodeClaims,
  getDeletablePromoCodeIds,
  type PromoCodeClaimsDetail,
  type DeletablePromoCodeIds,
} from "@/lib/queries/promo-codes";

const createPromoCodeSchema = z.object({
  code: z.string().trim().min(1, "Code is required").max(64, "Code is too long"),
  value: z
    .number()
    .finite()
    .nonnegative("Value cannot be negative")
    .max(10_000_000),
  region: z.enum(["NA", "EU"]),
  minimumLevel: z.number().int().nonnegative().max(1_000),
  minimumWagerAmount: z.number().finite().nonnegative().max(10_000_000),
  wagerPeriodDays: z.number().int().nonnegative().max(3650),
  minimumAccountAgeDays: z.number().int().nonnegative().max(3650),
  // Brand-new-signup gate. 0 = no maximum. Up to 30 days expressed in hours
  // so admins can express sub-day windows (e.g. 24 = "first 24 hours").
  maximumAccountAgeHours: z.number().int().nonnegative().max(720),
  minimumDepositAmount: z.number().finite().nonnegative().max(10_000_000),
  // Windowed deposit gate. Both must be > 0 to enable; either at 0 disables.
  // Window capped at 30 days expressed in minutes (43_200) so admins can pick
  // anything from "60" (1h) to multi-day windows without DB churn.
  minimumRecentDepositAmount: z
    .number()
    .finite()
    .nonnegative()
    .max(10_000_000),
  recentDepositPeriodMinutes: z.number().int().nonnegative().max(43_200),
  // Trim+uppercase here so the DB stores the canonical form. The
  // backend matches case-insensitively but normalising at write time
  // means the admin UI always shows the same shape on read-back.
  requiredAffiliateCode: z
    .string()
    .trim()
    .max(64)
    .transform((s) => (s.length === 0 ? null : s.toUpperCase()))
    .nullable(),
  requiresDiscord: z.boolean(),
  maxUses: z.number().int().nonnegative().max(10_000_000),
  expiresAt: z.string().nullable(),
});

export async function createPromoCode(
  data: z.infer<typeof createPromoCodeSchema>,
): Promise<ServerActionResult> {
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(session, "__can_create_promo_code", "create promo codes");

  const parsed = createPromoCodeSchema.safeParse(data);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "Invalid promo code input",
      "INVALID_INPUT",
    );
  }
  const v = parsed.data;

  // Per-environment, and it must match the backend that will resolve the code.
  // This was `process.env.GIFT_CARD_PEPPER ?? ""`, which silently peppered with
  // the empty string when unset and with PROD's secret while the admin was
  // toggled to dev — either way producing a hash the target backend can never
  // look up, so the code redeems as "Code not found". `resolveCodePepper`
  // picks by env and throws rather than minting an unredeemable code.
  let pepper: string;
  try {
    pepper = await resolveCodePepper();
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : "Promo-code hashing is not configured for this environment.",
      "PEPPER_NOT_CONFIGURED",
    );
  }
  const normalizedCode = v.code.toUpperCase().trim();
  const codeHash = createHash("sha256").update(normalizedCode + pepper).digest("hex");

  try {
    const db = await getPrimaryDrizzleDb();
    const [existing] = await db
      .select({ id: promo_codes.id })
      .from(promo_codes)
      .where(eq(promo_codes.code_hash, codeHash))
      .limit(1);
    if (existing) {
      return fail(
        "A promo code with this value already exists",
        "PROMO_CODE_EXISTS",
      );
    }

    await db.insert(promo_codes).values({
      id: crypto.randomUUID(),
      code_hash: codeHash,
      value: String(v.value),
      region: v.region,
      minimum_level: v.minimumLevel,
      minimum_wager_amount: String(v.minimumWagerAmount),
      wager_period_days: v.wagerPeriodDays,
      minimum_account_age_days: v.minimumAccountAgeDays,
      maximum_account_age_hours: v.maximumAccountAgeHours,
      minimum_deposit_amount: String(v.minimumDepositAmount),
      minimum_recent_deposit_amount: String(v.minimumRecentDepositAmount),
      recent_deposit_period_minutes: v.recentDepositPeriodMinutes,
      required_affiliate_code: v.requiredAffiliateCode,
      requires_discord: v.requiresDiscord,
      max_uses: v.maxUses,
      expires_at: v.expiresAt ? new Date(v.expiresAt).toISOString() : null,
      metadata: { code: normalizedCode },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      return fail(
        "A promo code with this value already exists",
        "PROMO_CODE_EXISTS",
      );
    }
    logError("promoCodes.create", "promo code database write failed", error);
    return fail(
      "Couldn't create the promo code. Please try again.",
      "PROMO_CODE_CREATE_FAILED",
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "promo_code_created",
    metadata: { code_hash: codeHash, value: v.value, region: v.region },
  });

  revalidatePath("/rewards");
  // Bust the cached KPI-strip aggregates so the count tiles + the money strip
  // ("Allocated / offered", "Given out / claimed") recompute with the new code
  // instead of serving the (60s / 300s) stale cache. `revalidatePath` does NOT
  // bust tagged data-cache entries — each tag has to be busted explicitly.
  revalidateTag("promo-codes-list-stats");
  revalidateTag("promo-codes-money-stats");
  return ok();
}

/**
 * Lazy-loaded claim detail for the promo-code click-through dialog.
 *
 * Gated by `__can_view_promo_redemptions` (same capability the legacy
 * `getRedemptions` uses). Wraps the cached query in `safeQuery` with a
 * statement timeout so a slow/large claim scan degrades to an error
 * payload the dialog can surface as a graceful error state instead of
 * hanging the transition or throwing into the page boundary.
 *
 * The returned `error` is a boolean flag only — the raw query message is
 * logged server-side by `safeQuery` and never shipped to the client (per
 * the safe-query SECURITY note).
 */
export async function getPromoCodeClaimDetail(promoCodeId: string): Promise<{
  data: PromoCodeClaimsDetail | null;
  error: boolean;
}> {
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(
    session,
    "__can_view_promo_redemptions",
    "view promo redemptions",
  );

  const result = await safeQuery(
    () => getPromoCodeClaims(promoCodeId),
    null,
    "promo-codes.claims",
    10_000,
  );

  return { data: result.data, error: result.error !== null };
}

export async function getRedemptions(promoCodeId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(session, "__can_view_promo_redemptions", "view promo redemptions");
  const redemptions = await db
    .select({
      id: promo_code_redemptions.id,
      user_id: promo_code_redemptions.user_id,
      ip_address: promo_code_redemptions.ip_address,
      redeemed_at: promo_code_redemptions.redeemed_at,
      username: user.username,
      email: user.email,
      image: user.image,
    })
    .from(promo_code_redemptions)
    .leftJoin(user, eq(user.id, promo_code_redemptions.user_id))
    .where(eq(promo_code_redemptions.promo_code_id, promoCodeId))
    .orderBy(desc(promo_code_redemptions.redeemed_at))
    .limit(100);
  return redemptions.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username ?? null,
    email: r.email ?? null,
    image: r.image ?? null,
    ipAddress: r.ip_address,
    redeemedAt: new Date(r.redeemed_at).toISOString(),
  }));
}

/**
 * Ids of every used-up and every expired promo code across the WHOLE
 * table (all pages). Powers the toolbar "Select used-up" / "Select
 * expired" buttons, which on /promo-codes is SERVER-side paginated — the
 * client only holds one page, so the full candidate sets have to come
 * from the server.
 *
 * Gated by the same `/promo-codes` page access as the rest of the page.
 * No extra delete capability is required just to LIST the ids — the
 * actual destructive step still goes through `deletePromoCodesBulk`,
 * which enforces `__can_delete_promo_code`. Wrapped in `safeQuery` with a
 * statement timeout so a slow scan degrades to empty sets (buttons fall
 * back to their per-page candidates) instead of hanging the click.
 */
export async function getAllDeletablePromoCodeIds(): Promise<{
  data: DeletablePromoCodeIds;
  error: boolean;
}> {
  await requirePageAccess("/promo-codes");

  const result = await safeQuery(
    () => getDeletablePromoCodeIds(),
    { exhaustedIds: [], expiredIds: [] } as DeletablePromoCodeIds,
    "promo-codes.deletableIds",
    10_000,
  );

  return { data: result.data, error: result.error !== null };
}

export async function deletePromoCode(promoCodeId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(session, "__can_delete_promo_code", "delete promo codes");

  // `deleteMany` is idempotent — returns `{ count: 0 }` instead of
  // throwing when the record is already gone. Important for the
  // list-page UX where a stuck-open AlertDialog could let an admin
  // double-click and trigger a second delete on a row that already
  // disappeared from the table on the first click. The audit row only
  // gets written if at least one record was actually deleted.
  const deletedRows = await db
    .delete(promo_codes)
    .where(eq(promo_codes.id, promoCodeId))
    .returning({ id: promo_codes.id });
  const result = { count: deletedRows.length };

  if (result.count > 0) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "promo_code_deleted",
      metadata: { promo_code_id: promoCodeId },
    });
  }

  revalidatePath("/rewards");
  // Bust the cached list-stats + the full-dataset deletable-id set (both
  // share this tag) so the KPI strip counts and the Quick-select totals
  // recompute without the deleted code instead of serving the 60s-stale
  // cache.
  revalidateTag("promo-codes-list-stats");
  // Also bust the lifetime money strip — deleting a code drops its
  // value × max_uses from "Allocated / offered", so the money tiles must
  // recompute too (they'd otherwise stay 300s stale).
  revalidateTag("promo-codes-money-stats");
  return { deleted: result.count };
}

// Per-statement chunk size for the bulk delete. Keeps each
// `id IN (...)` prepared statement reasonable while letting a selection
// that spans the WHOLE table (the Quick-select buttons can now select
// every used-up / expired code across all pages, not just the visible
// one) delete in full instead of being truncated to a single page.
const BULK_DELETE_CHUNK = 1000;
// Overall safety bound on a single bulk-delete request — far above any
// realistic interactive selection, but stops a malformed/huge payload
// from issuing an unbounded number of statements.
const BULK_DELETE_MAX = 20_000;

/**
 * Delete a batch of promo codes by id. Used by the row-selection
 * bulk-delete on /promo-codes. Idempotent — already-deleted ids are
 * just no-ops, the same way the single-delete handles double-clicks.
 *
 * The selection can now span the entire table (Quick-select "used-up" /
 * "expired" select across ALL pages, not just the visible one), so the
 * id list is deleted in chunked `deleteMany` statements rather than a
 * single capped one. Total request still bounded by BULK_DELETE_MAX.
 */
export async function deletePromoCodesBulk(promoCodeIds: string[]) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(session, "__can_delete_promo_code", "delete promo codes");

  const ids = Array.from(new Set(promoCodeIds.filter(Boolean))).slice(
    0,
    BULK_DELETE_MAX,
  );
  if (ids.length === 0) {
    return { deleted: 0 };
  }

  // Chunked delete so a cross-page selection larger than one page still
  // deletes completely. Each chunk is its own `id IN (...)` statement;
  // `deleteMany` is idempotent so already-gone ids in a chunk are no-ops.
  const deleted = await db.transaction(async (tx) => {
    let count = 0;
    for (let i = 0; i < ids.length; i += BULK_DELETE_CHUNK) {
      const chunk = ids.slice(i, i + BULK_DELETE_CHUNK);
      const rows = await tx
        .delete(promo_codes)
        .where(inArray(promo_codes.id, chunk))
        .returning({ id: promo_codes.id });
      count += rows.length;
    }
    return count;
  });

  if (deleted > 0) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "promo_codes_bulk_deleted",
      // Cap the id list stored on the audit row so a huge bulk delete
      // doesn't bloat the audit metadata; `count` / `requested` carry
      // the real totals regardless.
      metadata: {
        count: deleted,
        requested: ids.length,
        ids: ids.slice(0, BULK_DELETE_CHUNK),
      },
    });
  }

  revalidatePath("/rewards");
  // Bust the cached list-stats + the full-dataset deletable-id set (both
  // share this tag) so the KPI strip counts and the Quick-select totals
  // recompute without the deleted codes instead of serving the 60s-stale
  // cache.
  revalidateTag("promo-codes-list-stats");
  // Also bust the lifetime money strip — a bulk delete drops the deleted
  // codes' value × max_uses from "Allocated / offered", so the money tiles
  // must recompute too (they'd otherwise stay 300s stale).
  revalidateTag("promo-codes-money-stats");
  return { deleted };
}
