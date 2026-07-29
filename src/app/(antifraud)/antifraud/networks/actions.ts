"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createNetworkCase,
  requestAccountNetworkRescan,
  revealNetworkIp,
} from "@/lib/antifraud/network-api";
import { requireCapability } from "@/lib/require-capability";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

export async function rescanAccountNetwork(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = z.object({
    userId: z.string().trim().min(1).max(100),
  }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  await requestAccountNetworkRescan({
    userId: parsed.data.userId,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_network_rescan_requested",
    targetUserId: parsed.data.userId,
  });
  // revalidatePath does not support query strings — revalidate the bare path.
  revalidatePath("/antifraud/networks");
}

export async function openAccountNetworkCase(input: unknown): Promise<string> {
  const session = await requireAntifraudAccess();
  const parsed = z.object({
    snapshotId: z.string().uuid(),
    reason: z.string().trim().min(3).max(1_000),
    idempotencyKey: z.string().uuid(),
  }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const caseId = await createNetworkCase({
    ...parsed.data,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_network_case_opened",
    metadata: {
      caseId,
      snapshotId: parsed.data.snapshotId,
      reason: parsed.data.reason,
    },
  });
  revalidatePath("/antifraud/reviews");
  return caseId;
}

export async function revealAccountNetworkIp(input: unknown): Promise<string> {
  const session = await requireAntifraudAccess();
  await requireCapability(
    session,
    "__can_reveal_antifraud_pii",
    "reveal exact antifraud IP addresses",
  );
  const parsed = z.object({
    snapshotId: z.string().uuid(),
    nodeKey: z.string().min(1).max(100),
  }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const value = await revealNetworkIp(parsed.data);
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_network_ip_revealed",
    metadata: {
      snapshotId: parsed.data.snapshotId,
      nodeKey: parsed.data.nodeKey,
    },
  });
  return value;
}
