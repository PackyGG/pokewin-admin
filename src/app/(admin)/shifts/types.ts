/**
 * Shared types + constants for the shifts planner. Lives in a pure-
 * types file so client components can import without pulling the
 * server-only admin DB client across the RSC boundary.
 */

import { zonedWallClockToUtc } from "@/lib/timezone/core";

export type Worker = {
  id: string;
  username: string;
  displayUsername: string | null;
  role: string;
};

export type Shift = {
  id: string;
  weekStart: string; // ISO string, Monday 00:00 UTC
  dayOfWeek: number; // 0=Mon … 6=Sun
  shiftSlot: number; // 0, 1, 2
  startAt: string; // ISO
  endAt: string; // ISO
  notes: string | null;
  assignedIds: string[]; // admin_user ids
};

/** Number of concurrent shifts per day. Fixed to 3 per the spec. */
export const SHIFTS_PER_DAY = 3 as const;

/** Day names in ISO order (Monday first). */
export const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const DAY_SHORT = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

export const SLOT_LABELS = ["Shift 1", "Shift 2", "Shift 3"] as const;

// ─── Week helpers (pure) ───────────────────────────────────────────

/**
 * Return Monday 00:00 UTC of the ISO week containing `date`. We normalize
 * to UTC so the planner is timezone-independent on the server — clients
 * then render individual instants in their own preference zone.
 */
export function getWeekStart(date: Date | string | number): Date {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  // Work in UTC: getUTCDay returns 0 (Sun) … 6 (Sat). We want Monday = 0.
  const utcDay = d.getUTCDay();
  const diff = utcDay === 0 ? -6 : 1 - utcDay;
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff),
  );
  return monday;
}

/** ISO date string (YYYY-MM-DD) used as a query param. */
export function weekStartToParam(weekStart: Date): string {
  return weekStart.toISOString().slice(0, 10);
}

/** Inverse of weekStartToParam — returns Monday 00:00 UTC. */
export function parseWeekStartParam(param: string | null | undefined): Date {
  if (!param || !/^\d{4}-\d{2}-\d{2}$/.test(param)) {
    return getWeekStart(new Date());
  }
  const [y, m, d] = param.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Shift week boundaries by N weeks. Positive = forward in time. */
export function shiftWeek(weekStart: Date, weeks: number): Date {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d;
}

/**
 * Combine a week-start Monday + day-of-week + HH:mm (in the admin's
 * local timezone `tz`) into the correct UTC instant for storage.
 *
 * We want: when an admin in Berlin types "14:00", the DB stores the
 * instant that corresponds to 14:00 Berlin wall-clock on that date —
 * i.e. 12:00 UTC in summer, 13:00 UTC in winter. An admin in Kolkata
 * typing "14:00" on the same date gets 08:30 UTC (IST is UTC+5:30,
 * half-hour offset). Every viewer then renders the stored UTC instant
 * back to their own zone for display.
 *
 * The DST + half-hour-offset-safe offset algorithm this used to inline
 * now lives in the shared layer as `core.zonedWallClockToUtc` (the SAME
 * 3-step algorithm, verified against Berlin/Kolkata/New_York/St_Johns/UTC).
 * This wrapper just derives the Y/M/D from the week-start + day-of-week
 * and forwards to it — the duplicated Intl block is gone.
 */
export function localHhMmToUtc(
  weekStart: Date,
  dayOfWeek: number,
  hhmm: string,
  tz: string,
): Date {
  const [hh, mm] = hhmm.split(":").map((n) => parseInt(n, 10));
  const safeHh = Number.isFinite(hh) ? hh : 0;
  const safeMm = Number.isFinite(mm) ? mm : 0;
  // weekStart is Monday 00:00 UTC; adding dayOfWeek as a UTC date offset
  // (with normalization) yields the target calendar day. We then treat
  // (Y,M,D,hh,mm) as LOCAL wall-clock in `tz`.
  const target = new Date(
    Date.UTC(
      weekStart.getUTCFullYear(),
      weekStart.getUTCMonth(),
      weekStart.getUTCDate() + dayOfWeek,
    ),
  );
  return zonedWallClockToUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    safeHh,
    safeMm,
    tz,
  );
}

/**
 * Extract "HH:mm" in the given IANA timezone from a UTC Date. Used by
 * the editor to pre-populate `<input type="time">` with the admin's
 * existing shift times rendered in their own zone. Re-exported from the
 * shared core engine (formerly a local Intl block).
 */
export { toZonedHhMm } from "@/lib/timezone/core";

/** Human-friendly week label "Apr 20 – Apr 26, 2026". */
export function formatWeekRange(weekStart: Date): string {
  const end = new Date(weekStart);
  end.setUTCDate(end.getUTCDate() + 6);
  const fmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const yearFmt = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    timeZone: "UTC",
  });
  const sameYear = weekStart.getUTCFullYear() === end.getUTCFullYear();
  if (sameYear) {
    return `${fmt.format(weekStart)} – ${fmt.format(end)}, ${yearFmt.format(end)}`;
  }
  return `${fmt.format(weekStart)}, ${yearFmt.format(weekStart)} – ${fmt.format(end)}, ${yearFmt.format(end)}`;
}
