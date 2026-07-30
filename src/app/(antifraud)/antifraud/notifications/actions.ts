"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  createAntifraudDashboardNotificationRule,
  deleteAntifraudDashboardNotificationRule,
  setAntifraudDashboardNotificationRuleEnabled,
} from "@/lib/antifraud/dashboard-notification-rules";
import {
  ANTIFRAUD_DASHBOARD_GROUPS,
  ANTIFRAUD_SEVERITIES,
} from "@/lib/antifraud/dashboard-notification-contract";
import {
  beginAntifraudAction,
  finishAntifraudAction,
} from "@/lib/antifraud/security-audit";
import { require2FA } from "@/lib/require-2fa";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const internalHref = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => value === "" || (value.startsWith("/") && !value.startsWith("//")),
    "Link must be an internal path beginning with /",
  );

const createSchema = z.object({
  eventKey: z.string().trim().regex(/^antifraud\.[a-z0-9._-]{2,70}$/),
  label: z.string().trim().min(2).max(100),
  minimumSeverity: z.enum(ANTIFRAUD_SEVERITIES),
  targetGroups: z
    .array(z.enum(ANTIFRAUD_DASHBOARD_GROUPS))
    .min(1)
    .max(7)
    .refine((groups) => new Set(groups).size === groups.length),
  titleTemplate: z.string().trim().min(3).max(120),
  bodyTemplate: z.string().trim().max(1000),
  hrefTemplate: internalHref,
  enabled: z.boolean(),
  credential: z.string().trim().min(1).max(4096),
  idempotencyKey: z.string().uuid(),
});

const existingSchema = z.object({
  id: z.string().uuid(),
  credential: z.string().trim().min(1).max(4096),
  idempotencyKey: z.string().uuid(),
});

async function auditedMutation<T>(input: {
  action: string;
  targetId?: string;
  credential: string;
  idempotencyKey: string;
  run: (actorId: string) => Promise<T>;
}): Promise<T> {
  const session = await requireAntifraudManager();
  await require2FA(session.userId, input.credential);
  const correlationId = await beginAntifraudAction({
    actorAdminUserId: session.userId,
    actorUsername: session.username,
    actorRoles: session.roles,
    sessionRef: `${session.userId}:${session.iat ?? 0}`,
    action: input.action,
    targetType: "dashboard_notification_rule",
    targetId: input.targetId,
    idempotencyKey: input.idempotencyKey,
    limitPerMinute: 30,
  });
  try {
    const result = await input.run(session.userId);
    await finishAntifraudAction({
      correlationId,
      actorAdminUserId: session.userId,
      actorUsername: session.username,
      actorRoles: session.roles,
      sessionRef: `${session.userId}:${session.iat ?? 0}`,
      action: input.action,
      outcome: "succeeded",
      targetType: "dashboard_notification_rule",
      targetId: input.targetId,
      idempotencyKey: input.idempotencyKey,
    });
    revalidatePath("/antifraud/notifications");
    return result;
  } catch (error) {
    await finishAntifraudAction({
      correlationId,
      actorAdminUserId: session.userId,
      actorUsername: session.username,
      actorRoles: session.roles,
      sessionRef: `${session.userId}:${session.iat ?? 0}`,
      action: input.action,
      outcome: "failed",
      targetType: "dashboard_notification_rule",
      targetId: input.targetId,
      idempotencyKey: input.idempotencyKey,
      error,
    });
    throw error;
  }
}

export async function createDashboardNotificationRuleAction(
  input: unknown,
): Promise<{ id: string }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { credential, idempotencyKey, hrefTemplate, ...rule } = parsed.data;
  const id = await auditedMutation({
    action: "antifraud.dashboard_notification_rule.create",
    credential,
    idempotencyKey,
    run: (actorId) =>
      createAntifraudDashboardNotificationRule({
        ...rule,
        hrefTemplate: hrefTemplate || null,
        actorId,
      }),
  });
  return { id };
}

export async function setDashboardNotificationRuleEnabledAction(
  input: unknown,
): Promise<void> {
  const parsed = existingSchema
    .extend({ enabled: z.boolean() })
    .safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  await auditedMutation({
    action: "antifraud.dashboard_notification_rule.toggle",
    targetId: parsed.data.id,
    credential: parsed.data.credential,
    idempotencyKey: parsed.data.idempotencyKey,
    run: (actorId) =>
      setAntifraudDashboardNotificationRuleEnabled({
        id: parsed.data.id,
        enabled: parsed.data.enabled,
        actorId,
      }),
  });
}

export async function deleteDashboardNotificationRuleAction(
  input: unknown,
): Promise<void> {
  const parsed = existingSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  await auditedMutation({
    action: "antifraud.dashboard_notification_rule.delete",
    targetId: parsed.data.id,
    credential: parsed.data.credential,
    idempotencyKey: parsed.data.idempotencyKey,
    run: () => deleteAntifraudDashboardNotificationRule(parsed.data.id),
  });
}
