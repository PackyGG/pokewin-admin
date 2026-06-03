import { format, formatDistanceToNow, formatDistanceToNowStrict } from "date-fns";
import {
  toZonedWallClock,
  type DateInput,
} from "@/lib/timezone/core";

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
// These helpers are the PUBLIC RENDERING FACE. Their signatures are frozen
// (an optional trailing `timezone` IANA string) so the ~30 call sites and
// the provider's hooks (useFormatDate{,Time}, useFormatMonthYear) keep
// working with ZERO churn.
//
// The zone PROJECTION now delegates to `src/lib/timezone/core.ts`
// (`toZonedWallClock`) — there is no longer a duplicated Intl block here.
// date-fns stays as the PATTERN-STRING formatter (so `formatWithPattern`
// and the `dateFormat` presets — "MMM d, yyyy" / "dd/MM/yyyy" /
// "yyyy-MM-dd" — render identically to before). `core.toZonedWallClock`
// returns a Date whose UTC fields mirror the target-zone wall clock;
// date-fns' `format` reads LOCAL fields, so when this process runs in any
// zone the result is the target zone's wall clock. When `timezone` is
// omitted, we pass the instant straight to date-fns (runtime-local
// rendering), preserving the original no-arg behaviour exactly.
//
// Rationale for keeping date-fns here (vs core's Intl renderers): the
// presets are date-fns pattern strings the profile UI persists; matching
// them through Intl field options would risk subtle format drift
// (separators, abbreviations). The Intl renderers in core.ts
// (formatDate/formatDateTime/formatTime) exist for NEW callers; the
// established surface keeps its exact date-fns output.
// ---------------------------------------------------------------------------

function resolveDate(d: DateInput): Date {
  return d instanceof Date ? d : new Date(d);
}

/** Project an instant into the wall clock of `timezone` (or pass through). */
function project(d: Date, timezone?: string | null): Date {
  return timezone ? toZonedWallClock(d, timezone) : d;
}

export function formatDate(date: DateInput, timezone?: string | null): string {
  return format(project(resolveDate(date), timezone), "MMM d, yyyy");
}

export function formatDateTime(
  date: DateInput,
  timezone?: string | null,
): string {
  return format(project(resolveDate(date), timezone), "MMM d, yyyy HH:mm");
}

export function formatMonthYear(
  date: DateInput,
  timezone?: string | null,
): string {
  return format(project(resolveDate(date), timezone), "MMM yyyy");
}

/**
 * Relative-time labels ("2 hours ago") don't depend on the viewer's
 * timezone — the delta between two instants is zone-independent. The
 * `timezone` arg is accepted for API parity with the sibling helpers
 * (callers can pass `useTimezone()` blindly) but is ignored here.
 */
export function formatRelative(
  date: DateInput,
  _timezone?: string | null,
): string {
  void _timezone;
  return formatDistanceToNow(resolveDate(date), { addSuffix: true });
}

/**
 * Strict variant of `formatRelative` — drops the fuzzy "about" prefix
 * and rounds to the nearest single unit ("13 hours ago" instead of
 * "about 13 hours ago"). Use where precision matters and the imprecise
 * wording reads like a bug (e.g. changelog timestamps a few hours old).
 *
 * `timezone` is accepted for API parity with the other helpers; relative
 * deltas are zone-independent so the argument is ignored.
 */
export function formatRelativeStrict(
  date: DateInput,
  _timezone?: string | null,
): string {
  void _timezone;
  return formatDistanceToNowStrict(resolveDate(date), { addSuffix: true });
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
  date: DateInput,
  pattern: string,
  timezone?: string | null,
): string {
  return format(project(resolveDate(date), timezone), pattern);
}
