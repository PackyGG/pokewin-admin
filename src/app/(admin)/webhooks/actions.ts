"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requirePageAccess } from "@/lib/dal";
import {
  createDiscordNotificationEvent,
  deleteDiscordNotificationRoute,
  setDiscordNotificationRouteEnabled,
  upsertDiscordNotificationRoute,
} from "@/lib/discord-notifications/config";

const snowflakeSchema = z.string().regex(/^\d{15,21}$/, "Invalid Discord channel");
const eventKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use lowercase letters, numbers, dots, dashes, or underscores");

const createEventSchema = z.object({
  key: eventKeySchema,
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().min(2).max(240),
  category: z.string().trim().min(2).max(60),
});

const routeSchema = z.object({
  eventKey: eventKeySchema,
  channelId: snowflakeSchema,
  enabled: z.boolean(),
});

const routeIdSchema = z.string().uuid("Invalid routing rule");

export async function createCustomEventAction(input: unknown): Promise<void> {
  const session = await requirePageAccess("/webhooks");
  const parsed = createEventSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await createDiscordNotificationEvent({
    ...parsed.data,
    actorId: session.userId,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "discord_notification_event_created",
    metadata: {
      key: parsed.data.key,
      label: parsed.data.label,
      category: parsed.data.category,
    },
  });
  revalidatePath("/webhooks");
}

export async function upsertRouteAction(input: unknown): Promise<void> {
  const session = await requirePageAccess("/webhooks");
  const parsed = routeSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await upsertDiscordNotificationRoute({
    ...parsed.data,
    actorId: session.userId,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "discord_notification_route_upserted",
    metadata: parsed.data,
  });
  revalidatePath("/webhooks");
}

export async function setRouteEnabledAction(input: unknown): Promise<void> {
  const session = await requirePageAccess("/webhooks");
  const parsed = z
    .object({ id: routeIdSchema, enabled: z.boolean() })
    .safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await setDiscordNotificationRouteEnabled(parsed.data);
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "discord_notification_route_toggled",
    metadata: parsed.data,
  });
  revalidatePath("/webhooks");
}

export async function deleteRouteAction(input: unknown): Promise<void> {
  const session = await requirePageAccess("/webhooks");
  const parsed = z.object({ id: routeIdSchema }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await deleteDiscordNotificationRoute(parsed.data);
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "discord_notification_route_deleted",
    metadata: parsed.data,
  });
  revalidatePath("/webhooks");
}
