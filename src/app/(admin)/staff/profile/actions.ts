"use server";

import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { staff_notification_channels, staff_notification_prefs, staff_profiles } from "@/lib/db-schema/admin/schema";
import { requireStaffAccess } from "@/lib/staff/access";
import {
  isChannelConfigured,
  sendOnChannel,
  type ChannelKind,
} from "@/lib/staff/channels";
import {
  STAFF_NOTIFICATION_KINDS,
  isStaffNotificationKind,
} from "@/lib/staff/notifications";

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
  const session = await requireStaffAccess();
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { displayName, title, bio, accent } = parsed.data;

  await adminDrizzle.insert(staff_profiles).values({
      admin_user_id: session.userId,
      display_name: displayName ? displayName : null,
      title: title ? title : null,
      bio: bio ? bio : null,
      accent,
    }).onConflictDoUpdate({
      target: staff_profiles.admin_user_id,
      set: {
      display_name: displayName ? displayName : null,
      title: title ? title : null,
      bio: bio ? bio : null,
      accent,
      },
  });

  revalidatePath("/staff/profile");
  revalidatePath("/staff/points");
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
  const session = await requireStaffAccess();
  const parsed = prefSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { kind, inApp, discord, telegram } = parsed.data;
  if (!isStaffNotificationKind(kind)) throw new Error("Unknown notification");

  await adminDrizzle.insert(staff_notification_prefs).values({
      admin_user_id: session.userId,
      kind,
      in_app: inApp,
      discord,
      telegram,
    }).onConflictDoUpdate({
      target: [staff_notification_prefs.admin_user_id, staff_notification_prefs.kind],
      set: { in_app: inApp, discord, telegram },
  });

  revalidatePath("/staff/profile");
}

/** Reset one event kind back to its shipped default (deletes the override). */
export async function resetNotificationPref(input: unknown): Promise<void> {
  const session = await requireStaffAccess();
  const parsed = z.object({ kind: z.string() }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  if (!isStaffNotificationKind(parsed.data.kind)) {
    throw new Error("Unknown notification");
  }

  await adminDrizzle.delete(staff_notification_prefs)
    .where(and(eq(staff_notification_prefs.admin_user_id, session.userId),
      eq(staff_notification_prefs.kind, parsed.data.kind)))
    .catch(() => {
      // No override existed — already at the default.
    });

  revalidatePath("/staff/profile");
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
  const session = await requireStaffAccess();
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

  await adminDrizzle.insert(staff_notification_channels).values({
      admin_user_id: session.userId,
      channel,
      target,
      verification_code: code,
      verification_sent_at: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [staff_notification_channels.admin_user_id, staff_notification_channels.channel],
      set: {
      target,
      // Changing the target invalidates any previous verification — the new id
      // has to prove itself on its own.
      verified_at: null,
      verification_code: code,
      verification_sent_at: new Date().toISOString(),
      verify_attempts: 0,
      last_error: null,
      },
  });

  const result = await sendOnChannel(channel as ChannelKind, {
    target,
    title: "Packy Staff — verify this channel",
    body: `Your code is ${code}. Enter it in the workspace to switch these notifications on.`,
  });

  if (!result.ok) {
    await adminDrizzle.update(staff_notification_channels)
      .set({ last_error: result.error.slice(0, 200) })
      .where(and(eq(staff_notification_channels.admin_user_id, session.userId),
        eq(staff_notification_channels.channel, channel)))
      .catch(() => {});
    revalidatePath("/staff/profile");
    return { sent: false, message: result.error };
  }

  revalidatePath("/staff/profile");
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
  const session = await requireStaffAccess();
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { channel, code } = parsed.data;

  const [row] = await adminDrizzle.select().from(staff_notification_channels)
    .where(and(eq(staff_notification_channels.admin_user_id, session.userId),
      eq(staff_notification_channels.channel, channel))).limit(1);
  if (!row) throw new Error("Set the channel up first");
  if (row.verified_at) return; // already done

  if (row.verify_attempts >= MAX_VERIFY_ATTEMPTS) {
    throw new Error("Too many wrong codes — send yourself a new one.");
  }
  if (
    !row.verification_code ||
    !row.verification_sent_at ||
    Date.now() - new Date(row.verification_sent_at).getTime() > CODE_TTL_MS
  ) {
    throw new Error("That code expired — send yourself a new one.");
  }

  if (row.verification_code !== code) {
    await adminDrizzle.update(staff_notification_channels)
      .set({ verify_attempts: sql`${staff_notification_channels.verify_attempts} + 1` })
      .where(eq(staff_notification_channels.id, row.id));
    throw new Error("That code doesn't match");
  }

  await adminDrizzle.update(staff_notification_channels).set({
      verified_at: new Date().toISOString(),
      verification_code: null,
      verify_attempts: 0,
      enabled: true,
      last_error: null,
    }).where(eq(staff_notification_channels.id, row.id));

  revalidatePath("/staff/profile");
}

export async function toggleNotificationChannel(
  input: unknown,
): Promise<void> {
  const session = await requireStaffAccess();
  const parsed = z
    .object({ channel: z.enum(CHANNELS), enabled: z.boolean() })
    .safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await adminDrizzle.update(staff_notification_channels)
    .set({ enabled: parsed.data.enabled })
    .where(and(eq(staff_notification_channels.admin_user_id, session.userId),
      eq(staff_notification_channels.channel, parsed.data.channel)));

  revalidatePath("/staff/profile");
}

export async function removeNotificationChannel(
  input: unknown,
): Promise<void> {
  const session = await requireStaffAccess();
  const parsed = z.object({ channel: z.enum(CHANNELS) }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await adminDrizzle.delete(staff_notification_channels)
    .where(and(eq(staff_notification_channels.admin_user_id, session.userId),
      eq(staff_notification_channels.channel, parsed.data.channel)));

  revalidatePath("/staff/profile");
}

/** Send yourself a test ping on a verified channel. */
export async function sendTestPing(input: unknown): Promise<void> {
  const session = await requireStaffAccess();
  const parsed = z.object({ channel: z.enum(CHANNELS) }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { channel } = parsed.data;

  const [row] = await adminDrizzle.select({
    target: staff_notification_channels.target,
    verified_at: staff_notification_channels.verified_at,
  }).from(staff_notification_channels)
    .where(and(eq(staff_notification_channels.admin_user_id, session.userId),
      eq(staff_notification_channels.channel, channel))).limit(1);
  if (!row) throw new Error("Set the channel up first");
  if (!row.verified_at) throw new Error("Verify the channel first");

  const result = await sendOnChannel(channel as ChannelKind, {
    target: row.target,
    title: "Packy Staff — test ping",
    body: "This is what a notification looks like. Nothing is wrong.",
    href: "/staff",
  });

  await adminDrizzle.update(staff_notification_channels)
    .set(result.ok
      ? { last_sent_at: new Date().toISOString(), last_error: null }
      : { last_error: result.error.slice(0, 200) })
    .where(and(eq(staff_notification_channels.admin_user_id, session.userId),
      eq(staff_notification_channels.channel, channel)))
    .catch(() => {});

  if (!result.ok) throw new Error(result.error);

  revalidatePath("/staff/profile");
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
  await requireStaffAccess();
  return Object.entries(STAFF_NOTIFICATION_KINDS).map(([kind, spec]) => ({
    kind,
    label: spec.label,
    description: spec.description,
    defaults: { ...spec.defaults },
  }));
}
