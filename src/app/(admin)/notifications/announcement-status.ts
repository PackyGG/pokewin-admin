import { STATUS_COLORS } from "@/lib/constants";
import type { Announcement } from "@/lib/backend-api/announcements";

export function announcementStatus(
  announcement: Pick<Announcement, "revoked_at" | "starts_at" | "ends_at">,
  now = Date.now(),
): {
  label: string;
  className: string;
} {
  if (announcement.revoked_at) {
    return {
      label: "Revoked",
      className: STATUS_COLORS.failed,
    };
  }

  const starts = new Date(announcement.starts_at).getTime();
  const ends = announcement.ends_at
    ? new Date(announcement.ends_at).getTime()
    : null;
  if (starts > now) {
    return {
      label: "Scheduled",
      className: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    };
  }
  if (ends != null && ends <= now) {
    return {
      label: "Ended",
      className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    };
  }
  return {
    label: "Active",
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  };
}
