import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_users,
  staff_notification_channels,
  staff_notification_prefs,
  staff_notifications,
} from "@/lib/db-schema/admin/schema";
import { sendOnChannel, type ChannelKind } from "./channels";
import {
  isPostgresError,
  postgresErrorMessages,
} from "@/lib/postgres-errors";

/**
 * The staff notification system.
 *
 * Every notification ALWAYS lands in the in-app inbox (`staff_notifications`,
 * the header bell). On top of that it can be pushed to the staff member's own
 * verified Discord / Telegram channel — Discord by default, Telegram opt-in.
 *
 * Two rules the whole module is built around:
 *
 *  1. NOTIFYING MUST NEVER BREAK THE ACTION THAT CAUSED IT. Publishing a quiz
 *     or resolving a review is the real work; a dead webhook, an unmigrated
 *     table or a rate-limited bot must degrade to "no ping", never to a failed
 *     mutation. Every entry point here resolves, never rejects.
 *
 *  2. A CHANNEL IS INERT UNTIL VERIFIED. External delivery only ever goes to a
 *     row with `verified_at` set and `enabled = true`, so a typo'd Discord id
 *     can't quietly ping a colleague forever.
 */

// ─── Kinds ────────────────────────────────────────────────────────────────

/**
 * Every event a staff member can be notified about, with its per-channel
 * DEFAULT. A staff member's `staff_notification_prefs` row overrides these;
 * a MISSING row means "use the default", so a newly added kind is opt-OUT
 * rather than silently off for everyone who never touched their settings.
 */
export const STAFF_NOTIFICATION_KINDS = {
  quiz_published: {
    label: "New quiz available",
    description: "A quiz you can take has been published.",
    defaults: { inApp: true, discord: true, telegram: false },
  },
  quiz_result: {
    label: "Quiz result",
    description: "Your score and the points you earned.",
    defaults: { inApp: true, discord: false, telegram: false },
  },
  points_awarded: {
    label: "Points awarded",
    description: "An owner or admin adjusted your points.",
    defaults: { inApp: true, discord: true, telegram: false },
  },
  level_up: {
    label: "Level up",
    description: "You reached a new staff level.",
    defaults: { inApp: true, discord: true, telegram: false },
  },
  review_assigned: {
    label: "Case assigned to you",
    description: "An account review was put in your queue.",
    defaults: { inApp: true, discord: true, telegram: true },
  },
  review_resolved: {
    label: "Case resolved",
    description: "A case you opened or worked was closed.",
    defaults: { inApp: true, discord: false, telegram: false },
  },
  fraud_alert: {
    label: "Fraud alert",
    description: "A high-severity signal arrived from the fraud backend.",
    defaults: { inApp: true, discord: true, telegram: true },
  },
  announcement: {
    label: "Announcement",
    description: "A message from the owners to the staff team.",
    defaults: { inApp: true, discord: true, telegram: false },
  },
} as const;

export type StaffNotificationKind = keyof typeof STAFF_NOTIFICATION_KINDS;

export const STAFF_NOTIFICATION_KIND_LIST = Object.keys(
  STAFF_NOTIFICATION_KINDS,
) as StaffNotificationKind[];

export function isStaffNotificationKind(
  value: string,
): value is StaffNotificationKind {
  return Object.prototype.hasOwnProperty.call(STAFF_NOTIFICATION_KINDS, value);
}

// ─── Resilience ───────────────────────────────────────────────────────────

/**
 * True for "this table/column doesn't exist here yet". The antifraud tables are
 * provisioned by reviewed Admin SQL, so a deploy can briefly run ahead of the
 * SQL — every read degrades to empty and every write to a no-op rather than
 * 500ing a page that merely renders a bell.
 */
export function isMissingRelationError(err: unknown): boolean {
  if (isPostgresError(err, "42P01", "42703")) return true;
  const message = postgresErrorMessages(err);
  return (
    /does not exist/i.test(message) ||
    /UndefinedTable/i.test(message) ||
    /relation .* does not exist/i.test(message)
  );
}

// ─── Reads (the header bell) ──────────────────────────────────────────────

export type StaffNotificationRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  readAt: Date | null;
  createdAt: Date;
};

/** The bell's dropdown list — newest first, hard-capped. */
export type StaffNotificationRecipient = {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  role: string;
  roles: string[];
  verifiedChannels: number;
};

/**
 * Active dashboard accounts available to the custom staff composer.
 *
 * This intentionally reads `admin_users`, not `staff_profiles`: the inbox is
 * global dashboard infrastructure, so a colleague does not have to visit the
 * Anti-Fraud workspace before an admin can notify them.
 */
export async function listStaffNotificationRecipients(): Promise<
  StaffNotificationRecipient[]
> {
  try {
    const [users, channels] = await Promise.all([
      adminDrizzle
        .select({
          id: admin_users.id,
          username: admin_users.username,
          display_name: admin_users.display_username,
          email: admin_users.email,
          role: admin_users.role,
          roles: admin_users.roles,
        })
        .from(admin_users)
        .where(eq(admin_users.is_active, true))
        .orderBy(asc(admin_users.username)),
      adminDrizzle
        .select({
          admin_user_id: staff_notification_channels.admin_user_id,
        })
        .from(staff_notification_channels)
        .where(
          and(
            eq(staff_notification_channels.enabled, true),
            isNotNull(staff_notification_channels.verified_at),
          ),
        ),
    ]);

    const channelCount = new Map<string, number>();
    for (const channel of channels) {
      channelCount.set(
        channel.admin_user_id,
        (channelCount.get(channel.admin_user_id) ?? 0) + 1,
      );
    }

    return users.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      email: user.email,
      role: user.role,
      roles: user.roles.length > 0 ? user.roles : [user.role],
      verifiedChannels: channelCount.get(user.id) ?? 0,
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[staff-notifications] recipient list failed:", err);
    }
    return [];
  }
}

export async function listStaffNotifications(
  adminUserId: string,
  limit = 12,
): Promise<StaffNotificationRow[]> {
  try {
    const rows = await adminDrizzle.select().from(staff_notifications)
      .where(and(
        eq(staff_notifications.admin_user_id, adminUserId),
        sql`(
          ${staff_notifications.kind} IS DISTINCT FROM 'fraud_alert'
          OR ${staff_notifications.metadata}->>'kind'
            IS DISTINCT FROM 'daily_reward_granted'
        )`,
      ))
      .orderBy(desc(staff_notifications.created_at))
      .limit(Math.min(Math.max(limit, 1), 50));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      readAt: row.read_at ? new Date(row.read_at) : null,
      createdAt: new Date(row.created_at),
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listStaffNotifications failed:", err);
    }
    return [];
  }
}

/** The bell's unread badge. Served by the partial unread index. */
export async function countUnreadStaffNotifications(
  adminUserId: string,
): Promise<number> {
  try {
    const [row] = await adminDrizzle.select({ value: count() })
      .from(staff_notifications).where(and(
        eq(staff_notifications.admin_user_id, adminUserId),
        isNull(staff_notifications.read_at),
        sql`(
          ${staff_notifications.kind} IS DISTINCT FROM 'fraud_alert'
          OR ${staff_notifications.metadata}->>'kind'
            IS DISTINCT FROM 'daily_reward_granted'
        )`,
      ));
    return row?.value ?? 0;
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] countUnreadStaffNotifications failed:", err);
    }
    return 0;
  }
}

/**
 * Mark one notification read. Scoped to the OWNER of the row — the id comes
 * from the client, so the `admin_user_id` in the where-clause is what stops one
 * staff member marking another's inbox.
 */
export async function markStaffNotificationRead(
  adminUserId: string,
  notificationId: string,
): Promise<void> {
  try {
    await adminDrizzle.update(staff_notifications)
      .set({ read_at: new Date().toISOString() })
      .where(and(eq(staff_notifications.id, notificationId),
        eq(staff_notifications.admin_user_id, adminUserId),
        isNull(staff_notifications.read_at)));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] markStaffNotificationRead failed:", err);
    }
  }
}

export async function markAllStaffNotificationsRead(
  adminUserId: string,
): Promise<void> {
  try {
    await adminDrizzle.update(staff_notifications)
      .set({ read_at: new Date().toISOString() })
      .where(and(eq(staff_notifications.admin_user_id, adminUserId),
        isNull(staff_notifications.read_at)));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] markAllStaffNotificationsRead failed:", err);
    }
  }
}

// ─── Writes (fan-out) ─────────────────────────────────────────────────────

export type NotifyStaffInput = {
  /** admin_user ids. Duplicates are collapsed; empty is a no-op. */
  recipients: readonly string[];
  kind: StaffNotificationKind;
  title: string;
  body?: string | null;
  /** In-app deep link, e.g. "/staff/quizzes/<id>". */
  href?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Skip external channels entirely (in-app only). Used for high-volume or
   * low-value events where a Discord ping would be noise.
   */
  inAppOnly?: boolean;
};

const DISABLED_AUTOMATED_STAFF_SIGNAL_KINDS = new Set([
  "daily_reward_granted",
]);

export function isDisabledAutomatedStaffNotification(
  input: Pick<NotifyStaffInput, "kind" | "metadata">,
): boolean {
  return (
    input.kind === "fraud_alert" &&
    typeof input.metadata?.kind === "string" &&
    DISABLED_AUTOMATED_STAFF_SIGNAL_KINDS.has(input.metadata.kind)
  );
}

type ChannelRow = {
  admin_user_id: string;
  channel: string;
  target: string;
};

type PrefRow = {
  admin_user_id: string;
  kind: string;
  in_app: boolean;
  discord: boolean;
  telegram: boolean;
};

/**
 * Deliver one event to a set of staff members.
 *
 * Resolves to the number of in-app rows written. Never throws — see the module
 * header. External sends are awaited (bounded by the 5s per-send timeout in
 * `channels.ts`) so a caller that immediately redirects doesn't cut them off
 * mid-flight, but every failure is swallowed into `last_error` on the channel
 * row instead of propagating.
 */
export async function notifyStaff(input: NotifyStaffInput): Promise<number> {
  if (isDisabledAutomatedStaffNotification(input)) return 0;

  const recipients = [...new Set(input.recipients.filter(Boolean))];
  if (recipients.length === 0) return 0;

  const spec = STAFF_NOTIFICATION_KINDS[input.kind];
  const defaults = spec.defaults;

  // Per-recipient preference overrides for THIS kind (missing row = default).
  let prefs: PrefRow[] = [];
  try {
    prefs = await adminDrizzle.select().from(staff_notification_prefs)
      .where(and(inArray(staff_notification_prefs.admin_user_id, recipients),
        eq(staff_notification_prefs.kind, input.kind)));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] notifyStaff pref read failed:", err);
    }
  }
  const prefByUser = new Map(prefs.map((p) => [p.admin_user_id, p]));

  const wantsInApp = (userId: string) =>
    prefByUser.get(userId)?.in_app ?? defaults.inApp;
  const wantsChannel = (userId: string, channel: ChannelKind) => {
    const pref = prefByUser.get(userId);
    if (pref) return channel === "discord" ? pref.discord : pref.telegram;
    return channel === "discord" ? defaults.discord : defaults.telegram;
  };

  // ── In-app rows ────────────────────────────────────────────────────────
  const inAppRecipients = recipients.filter(wantsInApp);
  let written = 0;
  if (inAppRecipients.length > 0) {
    try {
      const result = await adminDrizzle.insert(staff_notifications).values(
        inAppRecipients.map((adminUserId) => ({
          admin_user_id: adminUserId,
          kind: input.kind,
          title: input.title,
          body: input.body ?? null,
          href: input.href ?? null,
          metadata: input.metadata,
        })),
      ).returning({ id: staff_notifications.id });
      written = result.length;
    } catch (err) {
      if (!isMissingRelationError(err)) {
        console.error("[antifraud] notifyStaff in-app write failed:", err);
      }
    }
  }

  if (input.inAppOnly) return written;

  // ── External channels ──────────────────────────────────────────────────
  // ONLY verified + enabled rows are eligible; an unverified channel is inert.
  let channels: ChannelRow[] = [];
  try {
    channels = await adminDrizzle.select({
      admin_user_id: staff_notification_channels.admin_user_id,
      channel: staff_notification_channels.channel,
      target: staff_notification_channels.target,
    }).from(staff_notification_channels).where(and(
      inArray(staff_notification_channels.admin_user_id, recipients),
      eq(staff_notification_channels.enabled, true),
      isNotNull(staff_notification_channels.verified_at),
    ));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] notifyStaff channel read failed:", err);
    }
    return written;
  }

  const eligible = channels.filter(
    (row) =>
      (row.channel === "discord" || row.channel === "telegram") &&
      wantsChannel(row.admin_user_id, row.channel),
  );
  if (eligible.length === 0) return written;

  const href = absoluteHref(input.href);

  await Promise.allSettled(
    eligible.map(async (row) => {
      const result = await sendOnChannel(row.channel as ChannelKind, {
        target: row.target,
        title: input.title,
        body: input.body,
        href,
      });
      // Record the outcome so the staff member can see WHY their pings stopped
      // arriving, without any of this being able to fail the caller.
      try {
        await adminDrizzle.update(staff_notification_channels).set(result.ok
            ? { last_sent_at: new Date().toISOString(), last_error: null }
            : { last_error: result.error.slice(0, 200) })
          .where(and(
            eq(staff_notification_channels.admin_user_id, row.admin_user_id),
            eq(staff_notification_channels.channel, row.channel),
          ));
      } catch {
        // Bookkeeping only — never escalate.
      }
    }),
  );

  return written;
}

/**
 * Turn an in-app path into a clickable absolute URL for external channels.
 * Uses the dashboard origin and falls back to the bare path when it is unset.
 */
function absoluteHref(href: string | null | undefined): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "");
  if (!base) return href;
  return base.replace(/\/+$/, "") + href;
}

/**
 * The recipient set for a broadcast: every active dashboard account,
 * regardless of whether it has opened the Staff hub. The audience
 * can be narrowed to holders of specific roles.
 */
export async function staffBroadcastRecipients(
  roles?: readonly string[],
): Promise<string[]> {
  try {
    const users = await adminDrizzle.select({
      id: admin_users.id, role: admin_users.role, roles: admin_users.roles,
    }).from(admin_users).where(eq(admin_users.is_active, true));

    if (!roles || roles.length === 0) return users.map((u) => u.id);
    const wanted = new Set(roles);
    return users
      .filter((u) => {
        const effective = u.roles.length > 0 ? u.roles : [u.role];
        return effective.some((r) => wanted.has(r));
      })
      .map((u) => u.id);
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] staffBroadcastRecipients failed:", err);
    }
    return [];
  }
}
