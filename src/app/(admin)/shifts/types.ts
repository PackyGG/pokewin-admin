/**
 * Shared types + constants for the shifts planner. Lives in a pure-
 * types file so client components can import without pulling the
 * server-only admin DB client across the RSC boundary.
 */

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
 * Combine a week-start Monday + day-of-week offset + HH:mm time string
 * into a concrete UTC instant. Used when the admin picks times via
 * `<input type="time">`: the picker returns "HH:mm" in the admin's
 * local zone, which we need to combine with the chosen date to produce
 * a Date. Here we treat the HH:mm as UTC-native so the server stores
 * an unambiguous instant; client-side conversion flips it back to the
 * viewer's zone for display.
 */
export function combineUtcInstant(
  weekStart: Date,
  dayOfWeek: number,
  hhmm: string,
): Date {
  const [hh, mm] = hhmm.split(":").map((n) => parseInt(n, 10));
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() + dayOfWeek);
  d.setUTCHours(Number.isFinite(hh) ? hh : 0, Number.isFinite(mm) ? mm : 0, 0, 0);
  return d;
}

/**
 * Extract "HH:mm" in the given IANA timezone from a UTC Date. Used by
 * the editor to pre-populate `<input type="time">` with the admin's
 * existing shift times rendered in their own zone.
 */
export function toZonedHhMm(instant: Date | string, tz: string): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    // Fallback to UTC if the tz string is bad.
    return d.toISOString().slice(11, 16);
  }
}

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
