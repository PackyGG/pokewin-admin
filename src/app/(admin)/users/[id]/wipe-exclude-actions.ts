"use server";

import { z } from "zod";

import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { excludeUserFromMetrics } from "@/lib/excluded-users/exclude";

/**
 * wipe-exclude-actions.ts — the server action behind the wipe popup's "Also
 * remove from all stats" step (and the always-on exclusion that WIPE ALL
 * performs). Adds the wiped user to the admin-managed excluded-users blacklist
 * so they vanish from EVERY metric surface (dashboard / GGR / analytics /
 * insights / P&L) via `getMetricsScope` / the blacklist fragments.
 *
 * ─── GATE (identical to the wipe actions → fits the single-2FA model) ───────
 *
 * Same gate as the recoverable wipes in this folder: requireAdmin +
 * `__can_wipe_accounts` + 2FA. The popup runs every selected wipe with ONE 2FA
 * code in sequence; this exclusion is one more step in that sequence and
 * re-uses the SAME code, so the single-2FA gate is preserved end-to-end. We do
 * NOT loosen or bypass the capability/2FA gate.
 *
 * ─── WHY EXCLUSION IS SAFE FOR EVERYONE (incl. creators) ────────────────────
 *
 * Exclusion deletes NOTHING — it only filters the user out of metric
 * aggregates. Creator-protection guards against DELETING creator data, which
 * this never does, so the exclusion applies regardless of creator status (the
 * owner's explicit ask: "when i wipe data also remove it from ALL stats
 * everywhere"). The destructive categories still hard-reject creators
 * server-side; this stat-exclusion is orthogonal and always allowed.
 *
 * Idempotent + audited + cache-invalidated: all handled by the shared
 * `excludeUserFromMetrics` helper (no duplicate row / audit / cache bust if the
 * user is already excluded).
 */

const excludeSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  totpCode: z.string().min(1, "2FA code is required"),
  /** Optional reason stored on the blacklist row + audit metadata. */
  reason: z.string().trim().max(500).optional(),
});

/**
 * Add the user to the excluded-users blacklist (idempotent). Gated exactly
 * like the wipe actions (requireAdmin + `__can_wipe_accounts` + 2FA) so the
 * popup can run it under its single shared 2FA code.
 *
 * Returns `{ success: true, inserted }` where `inserted` is 1 on a new row or
 * 0 if the user was already excluded (still a success — the desired end state
 * "user is excluded" holds either way).
 */
export async function excludeUserFromAllStats(data: {
  userId: string;
  totpCode: string;
  reason?: string;
}): Promise<
  | { success: true; inserted: 0 | 1 }
  | { success: false; error: string }
> {
  const session = await requireAdmin();
  await requireCapability(session, "__can_wipe_accounts", "wipe account data");

  const parsed = excludeSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  try {
    await require2FA(session.userId, parsed.data.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  try {
    const result = await excludeUserFromMetrics({
      userId: parsed.data.userId,
      adminUserId: session.userId,
      reason: parsed.data.reason ?? "Auto-excluded on account wipe",
    });
    return { success: true, inserted: result.inserted };
  } catch (err) {
    console.error("[excludeUserFromAllStats] failed to add to blacklist:", err);
    return {
      success: false,
      error:
        err instanceof Error
          ? err.message
          : "Could not add the user to the excluded-users list",
    };
  }
}
