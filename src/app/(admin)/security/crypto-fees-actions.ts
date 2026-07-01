"use server";

import { revalidateTag } from "next/cache";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { z } from "zod";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  CRYPTO_FEE_ASSETS,
  getCryptoFees,
  updateCryptoFees,
  type UpdateCryptoFeesInput,
  type CryptoFees,
} from "@/lib/backend-api/crypto-fees";

/**
 * Update the per-coin crypto deposit/withdrawal exchange-rate fees.
 *
 * Admin-only — these knobs add a hidden fee on every crypto deposit /
 * withdrawal, so the action sits behind requireAdmin() (same precedent as
 * the wager-weight cards) on top of the /security page-access gate. The
 * card sends only the fields the admin actually changed, already converted
 * from percent to bps ints. We read the old config first so the audit event
 * records exactly what moved (old → new), then write through the backend
 * API (which re-validates and 400s if a merged pair ends up min > max).
 */

// Mirror the backend's FeeBps: int 0..500 (100 bps = 1%, cap 5%).
const Bps = z.number().int().min(0).max(500);

const FeePatch = z
  .object({
    enabled: z.boolean().optional(),
    min_bps: Bps.optional(),
    max_bps: Bps.optional(),
  })
  .refine(
    (v) =>
      v.min_bps === undefined ||
      v.max_bps === undefined ||
      v.min_bps <= v.max_bps,
    { message: "Min fee must be ≤ max fee" },
  );

const DirectionPatch = z
  .partialRecord(z.enum(CRYPTO_FEE_ASSETS), FeePatch)
  .optional();

const InputSchema = z
  .object({
    deposit: DirectionPatch,
    withdrawal: DirectionPatch,
  })
  .refine(
    (data) =>
      [data.deposit, data.withdrawal].some(
        (dir) =>
          dir &&
          Object.values(dir).some(
            (patch) =>
              patch && Object.values(patch).some((v) => v !== undefined),
          ),
      ),
    { message: "At least one value is required" },
  );

export async function updateCryptoFeesAction(
  input: UpdateCryptoFeesInput,
): Promise<
  | { success: true; data: CryptoFees }
  | { success: false; error: string }
> {
  await requirePageAccess("/security");
  const session = await requireAdmin();

  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  let oldFees: CryptoFees | null = null;
  try {
    oldFees = await getCryptoFees();
  } catch {
    // Best-effort: if the backend is unreachable we still attempt the write
    // below (which will surface the real error). The audit "old" side just
    // records null in that case.
    oldFees = null;
  }

  let updated: CryptoFees;
  try {
    updated = await updateCryptoFees(parsed.data);
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error
          ? err.message
          : "Backend not updated yet — feature awaiting backend deploy",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "crypto_fees_updated",
    metadata: {
      changed: parsed.data,
      old: oldFees,
      new: updated,
    },
  });

  // Narrow tag revalidation only — the client card updates optimistically in
  // place (no router.refresh), so a broad revalidatePath("/security") would
  // just re-render the whole route and jump scroll. The tag busts the cached
  // /security reads so a genuine future load shows fresh data.
  revalidateTag(SECURITY_CACHE_TAG);
  return { success: true, data: updated };
}
