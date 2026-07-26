"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  sessionIsAdmin,
  sessionIsOwner,
  verifySession,
} from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  listStaffNotificationRecipients,
  notifyStaff,
} from "@/lib/staff/notifications";

const inputSchema = z.object({
  audience: z.enum(["selected", "role", "all"]),
  recipientIds: z.array(z.string().uuid()).max(200).default([]),
  role: z.string().trim().min(1).max(40).optional(),
  title: z.string().trim().min(3).max(100),
  body: z.string().trim().max(1_000).optional(),
  href: z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) => value === "" || (value.startsWith("/") && !value.startsWith("//")),
      "Link must be an internal path beginning with /",
    )
    .optional(),
  externalChannels: z.boolean().default(true),
});

export type SendStaffNotificationResult = {
  targeted: number;
  inboxRows: number;
};

export async function sendStaffNotificationAction(
  input: unknown,
): Promise<SendStaffNotificationResult> {
  const session = await verifySession();
  if (!sessionIsAdmin(session) && !sessionIsOwner(session)) {
    throw new Error("Admin access is required to send staff notifications");
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const active = await listStaffNotificationRecipients();
  const activeById = new Map(active.map((recipient) => [recipient.id, recipient]));

  let recipients: string[];
  if (parsed.data.audience === "all") {
    recipients = active.map((recipient) => recipient.id);
  } else if (parsed.data.audience === "role") {
    if (!parsed.data.role) throw new Error("Pick a role");
    recipients = active
      .filter((recipient) => recipient.roles.includes(parsed.data.role!))
      .map((recipient) => recipient.id);
  } else {
    recipients = [
      ...new Set(
        parsed.data.recipientIds.filter((id) => activeById.has(id)),
      ),
    ];
  }

  if (recipients.length === 0) {
    throw new Error("No active staff accounts match this audience");
  }

  const inboxRows = await notifyStaff({
    recipients,
    kind: "announcement",
    title: parsed.data.title,
    body: parsed.data.body || null,
    href: parsed.data.href || null,
    inAppOnly: !parsed.data.externalChannels,
    metadata: {
      source: "system_staff_notifications",
      sentByAdminUserId: session.userId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "staff_notification_sent",
    metadata: {
      audience: parsed.data.audience,
      role: parsed.data.role ?? null,
      recipientIds: recipients,
      recipientCount: recipients.length,
      inboxRows,
      title: parsed.data.title,
      body: parsed.data.body || null,
      href: parsed.data.href || null,
      externalChannels: parsed.data.externalChannels,
    },
  });

  revalidatePath("/system/staff-notifications");
  revalidatePath("/antifraud/notifications");

  return { targeted: recipients.length, inboxRows };
}
