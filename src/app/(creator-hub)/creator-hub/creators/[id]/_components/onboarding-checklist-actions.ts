"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";

import {
  MANUAL_TOGGLE_FIELDS,
  type ManualToggleField,
} from "./onboarding-checklist-shared";

/**
 * Per-creator Onboarding Checklist — manager actions for the MANUAL items.
 *
 * Gate: every mutation runs `requireCreatorHubAccess` — the SAME access rule
 * the rest of the Creator-Hub `creators/[id]` tab actions use
 * (`creator-tab-actions.ts`). Re-verifies the session and reads the live
 * role/active flag from the ADMIN DB — the client identity is never trusted.
 *
 * Writes: ADMIN DB ONLY (`creator_onboarding_checklist`). MAIN/prod game DB is
 * never touched here. Each mutation is audit-logged via `createAdminAuditEvent`
 * and revalidates the creator detail route (and the legacy /creators route, in
 * step with the other Hub actions during cut-over).
 *
 * Resilience: the table is upserted on `target_user_id` (one row per creator),
 * so a creator with no row yet gets one on first manual action. `updated_by`
 * is stamped with the acting admin for traceability.
 */

const userIdSchema = z.string().trim().min(1, "Missing creator id").max(128);

const toggleFieldSchema = z.enum(MANUAL_TOGGLE_FIELDS);

// Giveaway URL: optional, but when present must be a real http(s) URL and
// bounded. An empty string clears the stored URL.
const giveawayUrlSchema = z
  .string()
  .trim()
  .max(2048, "URL is too long")
  .refine(
    (v) => v === "" || /^https?:\/\/\S+$/i.test(v),
    "Enter a valid http(s) URL",
  );

// Prepaid coin ticker — short free text (e.g. "USDT", "BTC", "ETH").
const coinSchema = z.string().trim().max(32, "Coin label is too long");

// TX explorer link — same URL rule as the giveaway URL.
const txUrlSchema = z
  .string()
  .trim()
  .max(2048, "TX link is too long")
  .refine(
    (v) => v === "" || /^https?:\/\/\S+$/i.test(v),
    "Enter a valid explorer URL",
  );

type ActionResult = { success: true } | { success: false; error: string };

/** Refresh both the Hub detail route and the legacy admin detail route. */
function revalidateCreator(userId: string) {
  revalidatePath(`/creator-hub/creators/${userId}`);
  revalidatePath(`/creators/${userId}`);
}

/** Map a toggle field to its DB column + matching `*_at` timestamp column. */
function toggleColumns(field: ManualToggleField): {
  boolCol: "twitter_giveaway_done" | "streaming_assets_provided" | "lb_funds_collected";
  atCol: "lb_funds_collected_at" | null;
} {
  switch (field) {
    case "twitter_giveaway":
      return { boolCol: "twitter_giveaway_done", atCol: null };
    case "streaming_assets":
      return { boolCol: "streaming_assets_provided", atCol: null };
    case "lb_funds_collected":
      return { boolCol: "lb_funds_collected", atCol: "lb_funds_collected_at" };
  }
}

/**
 * Toggle one manual boolean item (twitter giveaway / streaming assets /
 * leaderboard funds collected). Upserts the per-creator row.
 */
export async function setChecklistToggle(
  targetUserId: string,
  field: string,
  value: boolean,
): Promise<ActionResult> {
  let adminUserId: string;
  try {
    const session = await requireCreatorHubAccess();
    adminUserId = session.userId;
  } catch {
    // Auth miss → toast via caller catch.
    return { success: false, error: "Not authorized." };
  }

  const idParsed = userIdSchema.safeParse(targetUserId);
  if (!idParsed.success) {
    return { success: false, error: idParsed.error.issues[0].message };
  }
  const fieldParsed = toggleFieldSchema.safeParse(field);
  if (!fieldParsed.success) {
    return { success: false, error: "Unknown checklist item." };
  }

  const userId = idParsed.data;
  const { boolCol, atCol } = toggleColumns(fieldParsed.data);

  // Build the column patch. The `*_at` timestamp (only lb_funds_collected has
  // one) is stamped when turning on, cleared when turning off.
  const data: Record<string, unknown> = {
    [boolCol]: value,
    updated_by: adminUserId,
  };
  if (atCol) data[atCol] = value ? new Date() : null;

  try {
    await adminDb.creator_onboarding_checklist.upsert({
      where: { target_user_id: userId },
      create: { target_user_id: userId, ...data },
      update: data,
      select: { id: true },
    });
  } catch {
    return {
      success: false,
      error: "Could not save — the onboarding table may be unavailable.",
    };
  }

  await createAdminAuditEvent({
    adminUserId,
    eventType: "creator_onboarding_item_toggled",
    targetUserId: userId,
    metadata: { field: fieldParsed.data, value, via: "creator_hub_checklist" },
  });

  revalidateCreator(userId);
  return { success: true };
}

/**
 * Set (or clear) the Twitter giveaway URL. Pasting a URL marks the giveaway
 * item done; clearing the URL leaves the toggle state untouched (a manager can
 * still mark it done without a URL). Upserts the per-creator row.
 */
export async function setChecklistGiveawayUrl(
  targetUserId: string,
  url: string,
): Promise<ActionResult> {
  let adminUserId: string;
  try {
    const session = await requireCreatorHubAccess();
    adminUserId = session.userId;
  } catch {
    return { success: false, error: "Not authorized." };
  }

  const idParsed = userIdSchema.safeParse(targetUserId);
  if (!idParsed.success) {
    return { success: false, error: idParsed.error.issues[0].message };
  }
  const urlParsed = giveawayUrlSchema.safeParse(url);
  if (!urlParsed.success) {
    return { success: false, error: urlParsed.error.issues[0].message };
  }

  const userId = idParsed.data;
  const trimmed = urlParsed.data;
  const normalized = trimmed === "" ? null : trimmed;

  // Pasting a URL also flips the giveaway item on (the manager clearly hosted
  // it); clearing the URL does NOT auto-flip it off.
  const data: Record<string, unknown> = {
    twitter_giveaway_url: normalized,
    updated_by: adminUserId,
  };
  if (normalized) data.twitter_giveaway_done = true;

  try {
    await adminDb.creator_onboarding_checklist.upsert({
      where: { target_user_id: userId },
      create: { target_user_id: userId, ...data },
      update: data,
      select: { id: true },
    });
  } catch {
    return {
      success: false,
      error: "Could not save — the onboarding table may be unavailable.",
    };
  }

  await createAdminAuditEvent({
    adminUserId,
    eventType: "creator_onboarding_giveaway_url_set",
    targetUserId: userId,
    metadata: {
      hasUrl: normalized !== null,
      via: "creator_hub_checklist",
    },
  });

  revalidateCreator(userId);
  return { success: true };
}

/**
 * Set the leaderboard prepaid proof (which coin the creator prepaid with + the
 * explorer TX link), shown under the "Leaderboard funds collected" item. Both
 * fields are optional; empty values clear them. Upserts the per-creator row.
 */
export async function setChecklistLbPrepaidProof(
  targetUserId: string,
  coin: string,
  txUrl: string,
): Promise<ActionResult> {
  let adminUserId: string;
  try {
    const session = await requireCreatorHubAccess();
    adminUserId = session.userId;
  } catch {
    return { success: false, error: "Not authorized." };
  }

  const idParsed = userIdSchema.safeParse(targetUserId);
  if (!idParsed.success) {
    return { success: false, error: idParsed.error.issues[0].message };
  }
  const coinParsed = coinSchema.safeParse(coin);
  if (!coinParsed.success) {
    return { success: false, error: coinParsed.error.issues[0].message };
  }
  const txParsed = txUrlSchema.safeParse(txUrl);
  if (!txParsed.success) {
    return { success: false, error: txParsed.error.issues[0].message };
  }

  const userId = idParsed.data;
  const coinValue = coinParsed.data === "" ? null : coinParsed.data;
  const txValue = txParsed.data === "" ? null : txParsed.data;

  const data = {
    lb_prepaid_coin: coinValue,
    lb_prepaid_tx_url: txValue,
    updated_by: adminUserId,
  };

  try {
    await adminDb.creator_onboarding_checklist.upsert({
      where: { target_user_id: userId },
      create: { target_user_id: userId, ...data },
      update: data,
      select: { id: true },
    });
  } catch {
    return {
      success: false,
      error: "Could not save — the onboarding table may be unavailable.",
    };
  }

  await createAdminAuditEvent({
    adminUserId,
    eventType: "creator_onboarding_lb_prepaid_proof_set",
    targetUserId: userId,
    metadata: {
      hasCoin: coinValue !== null,
      hasTxUrl: txValue !== null,
      via: "creator_hub_checklist",
    },
  });

  revalidateCreator(userId);
  return { success: true };
}
