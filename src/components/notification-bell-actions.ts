"use server";

import { verifySession } from "@/lib/dal";
import {
  countUnreadStaffNotifications,
  listStaffNotifications,
  markAllStaffNotificationsRead,
  markStaffNotificationRead,
} from "@/lib/antifraud/notifications";

/**
 * Server actions behind the header notification bell.
 *
 * EVERY action re-verifies the session and derives the admin id from it — the
 * client never passes a user id, so one staff member can never read or mutate
 * another's inbox. (`markStaffNotificationRead` additionally scopes its
 * where-clause by owner, so even a guessed notification id is inert.)
 *
 * The bell is rendered in the shared `AdminHeader`, which means it appears in
 * the main admin shell, the Creator Hub, Pack Studio and the Antifraud
 * workspace alike. For an admin who has never entered the staff system this
 * simply resolves to zero notifications.
 */

export type BellNotification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  /** ISO string — Dates don't survive the RSC boundary cleanly in this shape. */
  createdAt: string;
};

export type BellSnapshot = {
  unread: number;
  items: BellNotification[];
};

/** The dropdown's data: unread count + the newest notifications. */
export async function fetchBellNotifications(): Promise<BellSnapshot> {
  const session = await verifySession();
  const [unread, rows] = await Promise.all([
    countUnreadStaffNotifications(session.userId),
    listStaffNotifications(session.userId, 12),
  ]);
  return {
    unread,
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Cheap poll target — just the badge number. */
export async function fetchBellUnreadCount(): Promise<number> {
  const session = await verifySession();
  return countUnreadStaffNotifications(session.userId);
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  const session = await verifySession();
  if (!notificationId) return;
  await markStaffNotificationRead(session.userId, notificationId);
}

export async function markAllNotificationsRead(): Promise<void> {
  const session = await verifySession();
  await markAllStaffNotificationsRead(session.userId);
}
