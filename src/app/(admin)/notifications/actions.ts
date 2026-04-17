"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  NOTIFICATION_EVENTS,
  getNotificationConfig,
  saveNotificationConfig,
  type NotificationEvent,
} from "@/lib/queries/notifications";
import { escapeMarkdownV2, sendTelegram } from "@/lib/telegram";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
//
// Bot tokens follow the `<bot_id>:<hash>` Telegram format. We don't lock
// the regex too tightly because Telegram may evolve the hash portion — we
// just need to reject anything obviously junk (empty strings, newlines,
// tokens longer than 256 chars). Chat ids can be negative (groups), so
// we accept any trimmed 1-32 char string.

// `null` on either field is the "clear" sentinel; `undefined` is "leave
// the existing value alone" — this lets the UI toggle `enabled` on a
// previously-configured row without sending the raw token back to the
// server.
const saveInputSchema = z.object({
  eventType: z.enum(NOTIFICATION_EVENTS as readonly [
    NotificationEvent,
    ...NotificationEvent[],
  ]),
  enabled: z.boolean(),
  botToken: z
    .string()
    .trim()
    .min(1, "Bot token can't be empty")
    .max(256, "Bot token is too long")
    .refine(
      (t) => !/\s/.test(t),
      "Bot token must not contain whitespace",
    )
    .nullable()
    .optional(),
  chatId: z
    .string()
    .trim()
    .min(1, "Chat id can't be empty")
    .max(64, "Chat id is too long")
    .regex(/^-?\d+$/, "Chat id must be a number (can be negative for groups)")
    .nullable()
    .optional(),
});

export type SaveNotificationInput = z.infer<typeof saveInputSchema>;

// ---------------------------------------------------------------------------
// saveNotificationConfigAction
// ---------------------------------------------------------------------------

export async function saveNotificationConfigAction(
  input: SaveNotificationInput,
): Promise<void> {
  const session = await requirePageAccess("/notifications");
  await requireCapability(
    session,
    "__can_manage_notifications",
    "manage notifications",
  );

  const parsed = saveInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const data = parsed.data;

  // Guard: can't enable a row that has no credentials. Without this the
  // cron would skip it silently, which is confusing for the operator —
  // better to fail fast.
  if (data.enabled) {
    const existing = await getNotificationConfig(data.eventType);
    const effectiveToken =
      data.botToken !== undefined ? data.botToken : existing?.botToken ?? null;
    const effectiveChatId =
      data.chatId !== undefined ? data.chatId : existing?.chatId ?? null;
    if (!effectiveToken || !effectiveChatId) {
      throw new Error(
        "Bot token and chat id are required before enabling notifications.",
      );
    }
  }

  await saveNotificationConfig({
    eventType: data.eventType,
    enabled: data.enabled,
    botToken: data.botToken,
    chatId: data.chatId,
    updatedBy: session.userId,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "notifications_config_saved",
    metadata: {
      event_type: data.eventType,
      enabled: data.enabled,
      // Secrets are NEVER written to the audit log. We only record whether
      // they were updated on this save.
      token_updated: data.botToken !== undefined,
      chat_id_updated: data.chatId !== undefined,
    },
  });

  revalidatePath("/notifications");
}

// ---------------------------------------------------------------------------
// testNotificationAction — fire a one-off message using the saved creds.
// ---------------------------------------------------------------------------

const eventTypeSchema = z.enum(NOTIFICATION_EVENTS as readonly [
  NotificationEvent,
  ...NotificationEvent[],
]);

export type TestNotificationResult = {
  ok: boolean;
  error?: string;
};

export async function testNotificationAction(
  eventType: NotificationEvent,
): Promise<TestNotificationResult> {
  const session = await requirePageAccess("/notifications");
  await requireCapability(
    session,
    "__can_manage_notifications",
    "manage notifications",
  );

  const parsed = eventTypeSchema.safeParse(eventType);
  if (!parsed.success) {
    return { ok: false, error: "Invalid event type" };
  }

  const config = await getNotificationConfig(parsed.data);
  if (!config) {
    return {
      ok: false,
      error: "Configuration not found. Run the migration first.",
    };
  }
  if (!config.botToken?.trim() || !config.chatId?.trim()) {
    return {
      ok: false,
      error: "Bot token and chat id must be saved before testing.",
    };
  }

  const labels: Record<NotificationEvent, string> = {
    deposit: "deposits",
    withdrawal: "withdrawals",
    signup: "signups",
  };
  const labelSafe = escapeMarkdownV2(labels[parsed.data]);
  const text = [
    "\u2705 *Pokewin notifications test*",
    `Channel: ${labelSafe}`,
    `Sent by: \`${escapeMarkdownV2(session.userId)}\``,
    "_If you can read this, the integration is working\\._",
  ].join("\n");

  const result = await sendTelegram(config.botToken, config.chatId, text);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "notifications_test_sent",
    metadata: {
      event_type: parsed.data,
      success: result.ok,
      // Error is stored for diagnostics but never includes the secret
      // (sendTelegram only surfaces Telegram's own error description).
      error: result.ok ? undefined : result.error,
    },
  });

  return result;
}
