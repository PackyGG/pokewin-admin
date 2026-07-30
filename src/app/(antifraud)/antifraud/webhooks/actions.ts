"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { queueDiscordChannelCreation } from "@/lib/discord-notifications/channel-operations";
import {
  createDiscordNotificationEvent,
  deleteDiscordNotificationRoute,
  replaceDiscordNotificationChannelRoutes,
  setDiscordNotificationRouteEnabled,
  upsertDiscordNotificationRoute,
} from "@/lib/discord-notifications/config";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

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

const channelRoutesSchema = z.object({
  channelId: snowflakeSchema,
  eventKeys: z
    .array(eventKeySchema)
    .max(500)
    .refine(
      (keys) => new Set(keys).size === keys.length,
      "Choose each event only once",
    ),
});

const routeIdSchema = z.string().uuid("Invalid routing rule");
const createChannelSchema = z.object({
  parentId: snowflakeSchema,
  name: z.string().trim().min(1).max(100),
});

export async function createDiscordChannelAction(
  input: unknown,
): Promise<{ requestId: string; name: string }> {
  const session = await requireAntifraudManager();
  const parsed = createChannelSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const queued = await queueDiscordChannelCreation({
    parentId: parsed.data.parentId,
    name: parsed.data.name,
    actorId: session.userId,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "discord_notification_channel_creation_queued",
    metadata: {
      requestId: queued.id,
      parentId: parsed.data.parentId,
      channelName: queued.name,
    },
  });
  revalidatePath("/antifraud/webhooks");
  return { requestId: queued.id, name: queued.name };
}

export async function createCustomEventAction(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
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
  revalidatePath("/antifraud/webhooks");
}

export async function upsertRouteAction(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
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
  revalidatePath("/antifraud/webhooks");
}

export async function replaceChannelRoutesAction(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = channelRoutesSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await replaceDiscordNotificationChannelRoutes({
    ...parsed.data,
    actorId: session.userId,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "discord_notification_channel_routes_replaced",
    metadata: {
      channelId: parsed.data.channelId,
      eventKeys: parsed.data.eventKeys,
      eventCount: parsed.data.eventKeys.length,
    },
  });
  revalidatePath("/antifraud/webhooks");
}

export async function setRouteEnabledAction(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
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
  revalidatePath("/antifraud/webhooks");
}

export async function deleteRouteAction(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = z.object({ id: routeIdSchema }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await deleteDiscordNotificationRoute(parsed.data);
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "discord_notification_route_deleted",
    metadata: parsed.data,
  });
  revalidatePath("/antifraud/webhooks");
}
