/**
 * URL-driven tabs for /notifications.
 *
 * `announcements` is the broadcast list (one row read by everyone).
 * `direct` is the per-user composer (one row per recipient, own payload).
 *
 * The tab lives in the URL so the server mounts ONLY the active tab's
 * segment — the announcements backend GET never fires while the composer is
 * open (Active-Tab-Only).
 */
export const NOTIFICATION_TABS = ["announcements", "direct"] as const;
export type NotificationTab = (typeof NOTIFICATION_TABS)[number];

export function parseNotificationTab(value: string | undefined): NotificationTab {
  return (NOTIFICATION_TABS as readonly string[]).includes(value ?? "")
    ? (value as NotificationTab)
    : "announcements";
}
