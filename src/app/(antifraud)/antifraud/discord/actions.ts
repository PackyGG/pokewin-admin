"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { logError } from "@/lib/errors/logger";
import {
  fail,
  ok,
  type ServerActionResult,
} from "@/lib/errors/server-action-result";
import { postgresErrorCode } from "@/lib/postgres-errors";
import { require2FA } from "@/lib/require-2fa";
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
  credential: z.string().trim().min(1).max(4096),
});

const routeSchema = z.object({
  eventKey: eventKeySchema,
  channelId: snowflakeSchema,
  enabled: z.boolean(),
  credential: z.string().trim().min(1).max(4096),
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
  credential: z.string().trim().min(1).max(4096),
});

const routeIdSchema = z.string().uuid("Invalid routing rule");
const createChannelSchema = z.object({
  parentId: snowflakeSchema,
  name: z.string().trim().min(1).max(100),
  credential: z.string().trim().min(1).max(4096),
});

/**
 * Next.js replaces every thrown Server Action error with an opaque digest in
 * production, so the hand-written reasons these mutations raise ("that 2FA code
 * was already used", "the channel is no longer available") reached the operator
 * as "An error occurred in the Server Components render" and told them nothing.
 * Expected failures come back as a result instead; database faults stay generic
 * and go to the server log only.
 */
async function guarded<T>(
  area: string,
  run: () => Promise<T>,
): Promise<ServerActionResult<T>> {
  try {
    return ok(await run());
  } catch (err) {
    logError(area, "discord routing mutation failed", err);
    if (err instanceof Error && postgresErrorCode(err) === undefined) {
      return fail(err.message);
    }
    return fail("That change could not be saved — please try again.");
  }
}

export async function createDiscordChannelAction(
  input: unknown,
): Promise<ServerActionResult<{ requestId: string; name: string }>> {
  const session = await requireAntifraudManager();
  return guarded("antifraud.webhooks.createChannel", async () => {
    const parsed = createChannelSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    await require2FA(session.userId, parsed.data.credential);

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
    revalidatePath("/antifraud/discord");
    return { requestId: queued.id, name: queued.name };
  });
}

export async function createCustomEventAction(
  input: unknown,
): Promise<ServerActionResult<void>> {
  const session = await requireAntifraudManager();
  return guarded("antifraud.webhooks.createEvent", async () => {
    const parsed = createEventSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    await require2FA(session.userId, parsed.data.credential);

    await createDiscordNotificationEvent({
      key: parsed.data.key,
      label: parsed.data.label,
      description: parsed.data.description,
      category: parsed.data.category,
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
    revalidatePath("/antifraud/discord");
  });
}

export async function upsertRouteAction(
  input: unknown,
): Promise<ServerActionResult<void>> {
  const session = await requireAntifraudManager();
  return guarded("antifraud.webhooks.upsertRoute", async () => {
    const parsed = routeSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    await require2FA(session.userId, parsed.data.credential);

    await upsertDiscordNotificationRoute({
      eventKey: parsed.data.eventKey,
      channelId: parsed.data.channelId,
      enabled: parsed.data.enabled,
      actorId: session.userId,
    });
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "discord_notification_route_upserted",
      metadata: {
        eventKey: parsed.data.eventKey,
        channelId: parsed.data.channelId,
        enabled: parsed.data.enabled,
      },
    });
    revalidatePath("/antifraud/discord");
  });
}

export async function replaceChannelRoutesAction(
  input: unknown,
): Promise<ServerActionResult<void>> {
  const session = await requireAntifraudManager();
  return guarded("antifraud.webhooks.replaceChannelRoutes", async () => {
    const parsed = channelRoutesSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    await require2FA(session.userId, parsed.data.credential);

    await replaceDiscordNotificationChannelRoutes({
      channelId: parsed.data.channelId,
      eventKeys: parsed.data.eventKeys,
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
    revalidatePath("/antifraud/discord");
  });
}

export async function setRouteEnabledAction(
  input: unknown,
): Promise<ServerActionResult<void>> {
  const session = await requireAntifraudManager();
  return guarded("antifraud.webhooks.setRouteEnabled", async () => {
    const parsed = z
      .object({
        id: routeIdSchema,
        enabled: z.boolean(),
        credential: z.string().trim().min(1).max(4096),
      })
      .safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    await require2FA(session.userId, parsed.data.credential);

    await setDiscordNotificationRouteEnabled({
      id: parsed.data.id,
      enabled: parsed.data.enabled,
    });
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "discord_notification_route_toggled",
      metadata: { id: parsed.data.id, enabled: parsed.data.enabled },
    });
    revalidatePath("/antifraud/discord");
  });
}

export async function deleteRouteAction(
  input: unknown,
): Promise<ServerActionResult<void>> {
  const session = await requireAntifraudManager();
  return guarded("antifraud.webhooks.deleteRoute", async () => {
    const parsed = z.object({
      id: routeIdSchema,
      credential: z.string().trim().min(1).max(4096),
    }).safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    await require2FA(session.userId, parsed.data.credential);

    await deleteDiscordNotificationRoute({ id: parsed.data.id });
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "discord_notification_route_deleted",
      metadata: { id: parsed.data.id },
    });
    revalidatePath("/antifraud/discord");
  });
}
