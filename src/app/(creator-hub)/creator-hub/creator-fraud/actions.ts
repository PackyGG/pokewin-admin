"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  requestCreatorFraudRescan,
  type CreatorWindow,
} from "@/lib/antifraud/network-api";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";

export async function rescanCreatorFraud(input: unknown): Promise<void> {
  const session = await requireCreatorHubAccess();
  const parsed = z.object({
    creatorId: z.string().trim().min(1).max(100),
    window: z.enum(["7d", "30d", "90d", "lifetime"]),
  }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  await requestCreatorFraudRescan({
    creatorId: parsed.data.creatorId,
    window: parsed.data.window as CreatorWindow,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_creator_rescan_requested",
    targetUserId: parsed.data.creatorId,
    metadata: { window: parsed.data.window },
  });
  // revalidatePath does not support query strings — revalidate the bare path.
  revalidatePath(`/creator-hub/creator-fraud/${parsed.data.creatorId}`);
}
