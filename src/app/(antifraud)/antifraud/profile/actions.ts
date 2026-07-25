"use server";

import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import {
  isChannelConfigured,
  sendOnChannel,
  type ChannelKind,
} from "@/lib/antifraud/channels";
import {
  STAFF_NOTIFICATION_KINDS,
  isStaffNotificationKind,
} from "@/lib/antifraud/notifications";

/**
 * The staff member's own profile + notification settings.
 *
 * EVERY action here writes ONLY the caller's own rows — the admin id always
 * comes from the verified session, never from the client. There is no path in
 * this file that can touch another staff member's profile or channels.
 *
 * The avatar is deliberately NOT handled here: it lives on `admin_users` and is
 * written by the EXISTING `uploadAvatar` / `updateProfile` actions that the
 * whole dashboard already uses, so a staff member has one face everywhere
 * rather than two that can disagree.
 */

const ACCENTS = [
  "blue",
  "emerald",
  "rose",
  "cyan",
  "amber",
  "purple",
  "orange",
  "pink",
] as const;

const profileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .max(48, "Keep the name under 48 characters")
    .optional()
    .or(z.literal("")),
  title: z
    .string()
    .trim()
    .max(48, "Keep the title under 48 characters")
    .optional()
    .or(z.literal("")),
  bio: z
    .string()
    .trim()
    .max(300, "Keep the bio under 300 characters")
    .optional()
    .or(z.literal("")),
  accent: z.enum(ACCENTS),
});

/** Update the staff-facing half of your profile (name, title, bio, accent). */
export async function updateStaffProfile(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { displayName, title, bio, accent } = parsed.data;

  await adminDb.staff_profiles.upsert({
    where: { admin_user_id: session.userId },
    update: {
      display_name: displayName ? displayName : null,
      title: title ? title : null,
      bio: bio ? bio : null,
      accent,
    },
    create: {
      admin_user_id: session.userId,
      display_name: displayName ? displayName : null,
      title: title ? title : null,
      bio: bio ? bio : null,
      accent,
    },
  });

  revalidatePath("/antifraud/profile");
  revalidatePath("/antifraud/staff");
}

// ─── Notification preferences ─────────────────────────────────────────

const prefSchema = z.object({
  kind: z.string(),
  inApp: z.boolean(),
  discord: z.boolean(),
  telegram: z.boolean(),
});

/**
 * Set your delivery preference for ONE event kind. A row is only written when
 * you actually change something — the absence of a row means "use the default",
 * which is what makes a newly added event kind opt-OUT rather than silently off.
 */
export async function setNotificationPref(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = prefSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { kind, inApp, discord, telegram } = parsed.data;
  if (!isStaffNotificationKind(kind)) throw new Error("Unknown notification");

  await adminDb.staff_notification_prefs.upsert({
    where: {
      admin_user_id_kind: { admin_user_id: session.userId, kind },
    },
    update: { in_app: inApp, discord, telegram },
    create: {
      admin_user_id: session.userId,
      kind,
      in_app: inApp,
      discord,
      telegram,
    },
  });

  revalidatePath("/antifraud/profile");
}

/** Reset one event kind back to its shipped default (deletes the override). */
export async function resetNotificationPref(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = z.object({ kind: z.string() }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  if (!isStaffNotificationKind(parsed.data.kind)) {
    throw new Error("Unknown notification");
  }

  await adminDb.staff_notification_prefs
    .delete({
      where: {
        admin_user_id_kind: {
          admin_user_id: session.userId,
          kind: parsed.data.kind,
        },
      },
    })
    .catch(() => {
      // No override existed — already at the default.
    });

  revalidatePath("/antifraud/profile");
}

// ─── Channels ─────────────────────────────────────────────────────────

const CHANNELS = ["discord", "telegram"] as const;

const channelSchema = z.object({
  channel: z.enum(CHANNELS),
  target: z
    .string()
    .trim()
    .min(2, "Enter your id")
    .max(32, "That id is too long"),
});

/** Six digits, cryptographically random — this is an ownership proof. */
function newVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Save (or replace) a notification channel and send it a verification code.
 *
 * The channel is stored UNVERIFIED and stays inert until the code comes back.
 * That is the whole point: a mistyped Discord id would otherwise quietly ping a
 * stranger — or a colleague — forever, and nobody would notice.
 */
export async function saveNotificationChannel(
  input: unknown,
): Promise<{ sent: boolean; message: string }> {
  const session = await requireAntifraudAccess();
  const parsed = channelSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { channel, target } = parsed.data;

  if (channel === "discord" && !/^\d{15,25}$/.test(target)) {
    throw new Error(
      "That doesn't look like a Discord user id. Turn on Developer Mode, right-click your name and Copy User ID.",
    );
  }
  if (channel === "telegram" && !/^-?\d{1,20}$/.test(target)) {
    throw new Error(
      "A Telegram chat id is numeric. Message the bot and it will tell you yours.",
    );
  }

  if (!isChannelConfigured(channel as ChannelKind)) {
    throw new Error(
      channel === "discord"
        ? "Discord notifications aren't configured on this deployment yet."
        : "Telegram notifications aren't configured on this deployment yet.",
    );
  }

  const code = newVerificationCode();

  await adminDb.staff_notification_channels.upsert({
    where: {
      admin_user_id_channel: {
        admin_user_id: session.userId,
        channel,
      },
    },
    update: {
      target,
      // Changing the target invalidates any previous verification — the new id
      // has to prove itself on its own.
      verified_at: null,
      verification_code: code,
      verification_sent_at: new Date(),
      verify_attempts: 0,
      last_error: null,
    },
    create: {
      admin_user_id: session.userId,
      channel,
      target,
      verification_code: code,
      verification_sent_at: new Date(),
    },
  });

  const result = await sendOnChannel(channel as ChannelKind, {
    target,
    title: "Packy Antifraud — verify this channel",
    body: `Your code is ${code}. Enter it in the workspace to switch these notifications on.`,
  });

  if (!result.ok) {
    await adminDb.staff_notification_channels
      .updateMany({
        where: { admin_user_id: session.userId, channel },
        data: { last_error: result.error.slice(0, 200) },
      })
      .catch(() => {});
    revalidatePath("/antifraud/profile");
    return { sent: false, message: result.error };
  }

  revalidatePath("/antifraud/profile");
  return {
    sent: true,
    message: "Code sent — check the channel and enter it here.",
  };
}

const verifySchema = z.object({
  channel: z.enum(CHANNELS),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "The code is six digits"),
});

/** Max wrong guesses before the code is burned and has to be re-sent. */
const MAX_VERIFY_ATTEMPTS = 5;

/** Codes expire — an old ping shouldn't stay a valid proof forever. */
const CODE_TTL_MS = 30 * 60 * 1000;

export async function verifyNotificationChannel(
  input: unknown,
): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { channel, code } = parsed.data;

  const row = await adminDb.staff_notification_channels.findUnique({
    where: {
      admin_user_id_channel: { admin_user_id: session.userId, channel },
    },
  });
  if (!row) throw new Error("Set the channel up first");
  if (row.verified_at) return; // already done

  if (row.verify_attempts >= MAX_VERIFY_ATTEMPTS) {
    throw new Error("Too many wrong codes — send yourself a new one.");
  }
  if (
    !row.verification_code ||
    !row.verification_sent_at ||
    Date.now() - row.verification_sent_at.getTime() > CODE_TTL_MS
  ) {
    throw new Error("That code expired — send yourself a new one.");
  }

  if (row.verification_code !== code) {
    await adminDb.staff_notification_channels.update({
      where: { id: row.id },
      data: { verify_attempts: { increment: 1 } },
    });
    throw new Error("That code doesn't match");
  }

  await adminDb.staff_notification_channels.update({
    where: { id: row.id },
    data: {
      verified_at: new Date(),
      verification_code: null,
      verify_attempts: 0,
      enabled: true,
      last_error: null,
    },
  });

  revalidatePath("/antifraud/profile");
}

export async function toggleNotificationChannel(
  input: unknown,
): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = z
    .object({ channel: z.enum(CHANNELS), enabled: z.boolean() })
    .safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await adminDb.staff_notification_channels.updateMany({
    where: { admin_user_id: session.userId, channel: parsed.data.channel },
    data: { enabled: parsed.data.enabled },
  });

  revalidatePath("/antifraud/profile");
}

export async function removeNotificationChannel(
  input: unknown,
): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = z.object({ channel: z.enum(CHANNELS) }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await adminDb.staff_notification_channels.deleteMany({
    where: { admin_user_id: session.userId, channel: parsed.data.channel },
  });

  revalidatePath("/antifraud/profile");
}

/** Send yourself a test ping on a verified channel. */
export async function sendTestPing(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = z.object({ channel: z.enum(CHANNELS) }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { channel } = parsed.data;

  const row = await adminDb.staff_notification_channels.findUnique({
    where: {
      admin_user_id_channel: { admin_user_id: session.userId, channel },
    },
    select: { target: true, verified_at: true },
  });
  if (!row) throw new Error("Set the channel up first");
  if (!row.verified_at) throw new Error("Verify the channel first");

  const result = await sendOnChannel(channel as ChannelKind, {
    target: row.target,
    title: "Packy Antifraud — test ping",
    body: "This is what a notification looks like. Nothing is wrong.",
    href: "/antifraud",
  });

  await adminDb.staff_notification_channels
    .updateMany({
      where: { admin_user_id: session.userId, channel },
      data: result.ok
        ? { last_sent_at: new Date(), last_error: null }
        : { last_error: result.error.slice(0, 200) },
    })
    .catch(() => {});

  if (!result.ok) throw new Error(result.error);

  revalidatePath("/antifraud/profile");
}

/** Every notification kind with its label + shipped default, for the UI. */
export async function listNotificationKinds(): Promise<
  {
    kind: string;
    label: string;
    description: string;
    defaults: { inApp: boolean; discord: boolean; telegram: boolean };
  }[]
> {
  await requireAntifraudAccess();
  return Object.entries(STAFF_NOTIFICATION_KINDS).map(([kind, spec]) => ({
    kind,
    label: spec.label,
    description: spec.description,
    defaults: { ...spec.defaults },
  }));
}
