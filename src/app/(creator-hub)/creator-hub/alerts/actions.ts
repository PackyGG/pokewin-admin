"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";

import { adminDrizzle } from "@/lib/drizzle";
import { creator_alerts } from "@/lib/db-schema/admin/schema";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";

const alertIdSchema = z.string().uuid("Invalid alert id");

export type AlertActionResult =
  | { success: true }
  | { success: false; error: string };

function revalidateAlerts() {
  revalidateTag("creator-hub-alerts");
  revalidatePath("/creator-hub", "layout");
}

export async function markAlertRead(alertId: string): Promise<AlertActionResult> {
  let userId: string;
  try {
    const session = await requireCreatorHubAccess("Not authorized to manage alerts.");
    userId = session.userId;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  const parsed = alertIdSchema.safeParse(alertId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid id." };
  }

  try {
    await adminDrizzle
      .update(creator_alerts)
      .set({ read_at: new Date().toISOString(), read_by: userId })
      .where(eq(creator_alerts.id, parsed.data));
    revalidateAlerts();
    return { success: true };
  } catch (err) {
    console.error("[creator-alerts] markAlertRead failed:", err);
    return { success: false, error: "Failed to mark alert as read." };
  }
}

export async function dismissAlert(alertId: string): Promise<AlertActionResult> {
  let userId: string;
  try {
    const session = await requireCreatorHubAccess("Not authorized to manage alerts.");
    userId = session.userId;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  const parsed = alertIdSchema.safeParse(alertId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid id." };
  }

  try {
    await adminDrizzle
      .update(creator_alerts)
      .set({
        dismissed_at: new Date().toISOString(),
        dismissed_by: userId,
        read_at: new Date().toISOString(),
        read_by: userId,
      })
      .where(eq(creator_alerts.id, parsed.data));
    revalidateAlerts();
    return { success: true };
  } catch (err) {
    console.error("[creator-alerts] dismissAlert failed:", err);
    return { success: false, error: "Failed to dismiss alert." };
  }
}

export async function markAllAlertsRead(): Promise<AlertActionResult> {
  let userId: string;
  try {
    const session = await requireCreatorHubAccess("Not authorized to manage alerts.");
    userId = session.userId;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  try {
    await adminDrizzle
      .update(creator_alerts)
      .set({ read_at: new Date().toISOString(), read_by: userId })
      .where(
        and(
          isNull(creator_alerts.dismissed_at),
          isNull(creator_alerts.read_at),
        ),
      );
    revalidateAlerts();
    return { success: true };
  } catch (err) {
    console.error("[creator-alerts] markAllAlertsRead failed:", err);
    return { success: false, error: "Failed to mark alerts as read." };
  }
}
