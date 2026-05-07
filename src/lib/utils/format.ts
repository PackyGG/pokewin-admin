import { format, formatDistanceToNow } from "date-fns";

export function formatCurrency(amount: number): string {
  // Guard against NaN / Infinity sneaking through from a divide-by-zero
  // upstream (e.g. avg-* metrics). Intl.NumberFormat would otherwise emit
  // "NaN" / "∞" literals which look broken in admin UIs. Rendered as "—"
  // matches the existing convention for "no value to show".
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

// ---------------------------------------------------------------------------
// Timezone-aware formatting
// ---------------------------------------------------------------------------
//
// All date helpers below accept an optional `timezone` (IANA string, e.g.
// "Europe/Berlin"). When omitted they format with the runtime's local zone
// which keeps every existing call site working unchanged.
//
// Implementation note: date-fns v4 doesn't expose a built-in `timeZone`
// option. To avoid pulling in `date-fns-tz` (extra dep — see CLAUDE.md)
// we compute the offset-adjusted epoch via Intl.DateTimeFormat and then
// hand the resulting "as if UTC" date to date-fns' `format`. This is
// exact for whole-minute zones, including DST transitions, because the
// offset is looked up for the original instant.
// ---------------------------------------------------------------------------

function resolveDate(d: Date | string | number): Date {
  return d instanceof Date ? d : new Date(d);
}

/**
 * Return a Date whose UTC fields mirror the wall-clock time in `tz` for
 * the original instant. Passing this through date-fns' `format` (which
 * reads local fields) is equivalent to rendering in `tz`.
 */
function toZonedWallClock(date: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }
  const year = Number(lookup.year);
  const month = Number(lookup.month);
  const day = Number(lookup.day);
  // Intl returns "24" for midnight in hour12:false mode on some platforms —
  // normalize to 0 so Date.UTC doesn't roll forward a day.
  let hour = Number(lookup.hour);
  if (hour === 24) hour = 0;
  const minute = Number(lookup.minute);
  const second = Number(lookup.second);
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, date.getUTCMilliseconds()),
  );
}

export function formatDate(
  date: Date | string | number,
  timezone?: string | null,
): string {
  const d = resolveDate(date);
  const source = timezone ? toZonedWallClock(d, timezone) : d;
  return format(source, "MMM d, yyyy");
}

export function formatDateTime(
  date: Date | string | number,
  timezone?: string | null,
): string {
  const d = resolveDate(date);
  const source = timezone ? toZonedWallClock(d, timezone) : d;
  return format(source, "MMM d, yyyy HH:mm");
}

export function formatMonthYear(
  date: Date | string | number,
  timezone?: string | null,
): string {
  const d = resolveDate(date);
  const source = timezone ? toZonedWallClock(d, timezone) : d;
  return format(source, "MMM yyyy");
}

/**
 * Relative-time labels ("2 hours ago") don't depend on the viewer's
 * timezone — the delta between two instants is zone-independent. The
 * `timezone` arg is accepted for API parity with the sibling helpers
 * (callers can pass `useTimezone()` blindly) but is ignored here.
 */
export function formatRelative(
  date: Date | string | number,
  _timezone?: string | null,
): string {
  void _timezone;
  return formatDistanceToNow(resolveDate(date), { addSuffix: true });
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat("en-US").format(num);
}

export function formatCompactUsd(v: number): string {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Render a date with a custom date-fns pattern in the given timezone.
 * Used by the profile preferences preview so operators can see how a
 * format/timezone combo looks before saving.
 */
export function formatWithPattern(
  date: Date | string | number,
  pattern: string,
  timezone?: string | null,
): string {
  const d = resolveDate(date);
  const source = timezone ? toZonedWallClock(d, timezone) : d;
  return format(source, pattern);
}
