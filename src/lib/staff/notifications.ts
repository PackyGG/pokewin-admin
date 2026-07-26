import "server-only";

import { adminDb } from "@/lib/admin-db";
import { sendOnChannel, type ChannelKind } from "./channels";

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
 * provisioned by `prisma db execute`, so a deploy can briefly run ahead of the
 * SQL — every read degrades to empty and every write to a no-op rather than
 * 500ing a page that merely renders a bell.
 */
export function isMissingRelationError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "P2021" || code === "P2022") return true;
  if (!(err instanceof Error)) return false;
  return (
    /does not exist/i.test(err.message) ||
    /UndefinedTable/i.test(err.message) ||
    /relation .* does not exist/i.test(err.message)
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
export async function listStaffNotifications(
  adminUserId: string,
  limit = 12,
): Promise<StaffNotificationRow[]> {
  try {
    const rows = await adminDb.staff_notifications.findMany({
      where: { admin_user_id: adminUserId },
      orderBy: { created_at: "desc" },
      take: Math.min(Math.max(limit, 1), 50),
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        href: true,
        read_at: true,
        created_at: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      readAt: row.read_at,
      createdAt: row.created_at,
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
    return await adminDb.staff_notifications.count({
      where: { admin_user_id: adminUserId, read_at: null },
    });
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
    await adminDb.staff_notifications.updateMany({
      where: { id: notificationId, admin_user_id: adminUserId, read_at: null },
      data: { read_at: new Date() },
    });
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
    await adminDb.staff_notifications.updateMany({
      where: { admin_user_id: adminUserId, read_at: null },
      data: { read_at: new Date() },
    });
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
  const recipients = [...new Set(input.recipients.filter(Boolean))];
  if (recipients.length === 0) return 0;

  const spec = STAFF_NOTIFICATION_KINDS[input.kind];
  const defaults = spec.defaults;

  // Per-recipient preference overrides for THIS kind (missing row = default).
  let prefs: PrefRow[] = [];
  try {
    prefs = await adminDb.staff_notification_prefs.findMany({
      where: { admin_user_id: { in: recipients }, kind: input.kind },
      select: {
        admin_user_id: true,
        kind: true,
        in_app: true,
        discord: true,
        telegram: true,
      },
    });
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
      const result = await adminDb.staff_notifications.createMany({
        data: inAppRecipients.map((adminUserId) => ({
          admin_user_id: adminUserId,
          kind: input.kind,
          title: input.title,
          body: input.body ?? null,
          href: input.href ?? null,
          metadata: (input.metadata ?? undefined) as never,
        })),
      });
      written = result.count;
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
    channels = await adminDb.staff_notification_channels.findMany({
      where: {
        admin_user_id: { in: recipients },
        enabled: true,
        verified_at: { not: null },
      },
      select: { admin_user_id: true, channel: true, target: true },
    });
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
        await adminDb.staff_notification_channels.updateMany({
          where: {
            admin_user_id: row.admin_user_id,
            channel: row.channel,
          },
          data: result.ok
            ? { last_sent_at: new Date(), last_error: null }
            : { last_error: result.error.slice(0, 200) },
        });
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
 * The recipient set for a broadcast: every staff member who has entered the
 * workspace (i.e. has a `staff_profiles` row) and is still an active admin
 * user. Optionally narrowed to holders of specific roles — used by a quiz with
 * a role audience.
 *
 * Deliberately NOT "every admin_user": someone who has never opened the
 * workspace has no staff profile, and pinging them about a quiz they can't see
 * would be noise.
 */
export async function staffBroadcastRecipients(
  roles?: readonly string[],
): Promise<string[]> {
  try {
    const profiles = await adminDb.staff_profiles.findMany({
      select: { admin_user_id: true },
    });
    const ids = profiles.map((p) => p.admin_user_id);
    if (ids.length === 0) return [];

    const users = await adminDb.admin_users.findMany({
      where: { id: { in: ids }, is_active: true },
      select: { id: true, role: true, roles: true },
    });

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
