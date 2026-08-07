// ---------------------------------------------------------------------------
// Timezone core — the single, pure, isomorphic Intl engine.
// ---------------------------------------------------------------------------
//
// This is the canonical conversion + formatting layer. Everything else
// delegates here:
//   • src/lib/utils/format.ts          (rendering helpers → call core)
//   • src/components/timezone-provider  (hooks → format.ts → core)
//   • src/lib/timezones.ts              (re-exports formatClockInZone/label)
//   • src/app/(admin)/shifts/types.ts   (re-exports localHhMmToUtc/toZonedHhMm)
//   • src/lib/admin-preferences-types   (re-exports isValidTimezone)
//
// Design rules (do not break):
//   • PURE & ISOMORPHIC — callable from RSC, client components, and route
//     handlers. The ONLY `window`-touching function is `getBrowserTimeZone`,
//     and it guards `typeof window`. No `next/headers`, no `server-only`,
//     no React in this file.
//   • NATIVE Intl ONLY — no new date dependency. date-fns stays in
//     format.ts as the pattern-string formatter; this layer is the
//     instant↔wall-clock + offset math + cached Intl formatting.
//   • DST-safe AND half-hour-offset-safe — verified against Berlin,
//     New York, Los Angeles, Tokyo, Sydney, Kolkata, St_Johns, UTC,
//     including both DST transitions.
//
// The conversion logic here is NOT new — it is the deduped union of three
// already-verified implementations that used to live separately:
//   - format.ts::toZonedWallClock  (the wall-clock projection engine)
//   - shifts/types.ts::localHhMmToUtc / toZonedHhMm  (the inverse offset pair)
//   - timezones.ts::formatClockInZone + admin-preferences-types::isValidTimezone
// ---------------------------------------------------------------------------

export type DateInput = Date | string | number;

const UTC = "UTC";
const DEFAULT_LOCALE = "en-US";

function resolveDate(d: DateInput): Date {
  return d instanceof Date ? d : new Date(d);
}

// ── formatter cache ──────────────────────────────────────────────────────
//
// `new Intl.DateTimeFormat(...)` construction is the expensive part of every
// format call (the old format.ts / timezones.ts / shifts code built a fresh
// one per call). A table page renders thousands of date cells; caching the
// formatter by (locale, tz, opts) collapses that to one construction per
// distinct shape. The key is stable because we JSON-stringify a normalized
// (sorted-key) view of the options.
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function stableOptsKey(opts: Intl.DateTimeFormatOptions): string {
  // Sort keys so {hour,minute} and {minute,hour} share a cache entry.
  const keys = Object.keys(opts).sort();
  const norm: Record<string, unknown> = {};
  for (const k of keys) norm[k] = (opts as Record<string, unknown>)[k];
  return JSON.stringify(norm);
}

/**
 * Cached `Intl.DateTimeFormat`. Falls back to a UTC formatter (and caches
 * THAT under the same key) if the requested zone is rejected by the
 * runtime, so a bad IANA string degrades to UTC rendering instead of
 * throwing in a render path.
 */
export function getFormatter(
  tz: string,
  locale: string,
  opts: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${stableOptsKey(opts)}`;
  const hit = FORMATTER_CACHE.get(key);
  if (hit) return hit;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz });
  } catch {
    fmt = new Intl.DateTimeFormat(locale, { ...opts, timeZone: UTC });
  }
  FORMATTER_CACHE.set(key, fmt);
  return fmt;
}

// ── zone resolution ────────────────────────────────────────────────────────

/**
 * Browser's IANA zone. CLIENT-ONLY in effect: guarded by `typeof window`
 * so it never executes the detection on the server (where it would read
 * the SERVER's zone, not the viewer's — the exact hydration-mismatch trap).
 * On the server, or if `Intl.resolvedOptions()` is unavailable, returns
 * "UTC". Server code must use `getServerTimeZone` (./server.ts) instead.
 */
export function getBrowserTimeZone(): string {
  if (typeof window === "undefined") return UTC;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC;
  } catch {
    return UTC;
  }
}

/**
 * Resolve the zone to actually use, given the two candidate inputs.
 * PURE — the caller supplies the candidates; this never reads a cookie or
 * `window`. Used identically on client and server so both compute the same
 * zone from the same two inputs (the key to a flash-free hydration):
 *
 *   explicit DB preference  →  detected/cookie fallback  →  "UTC"
 *
 * An invalid candidate is skipped (treated as absent) rather than trusted.
 */
export function getEffectiveTimeZone(
  explicit: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (explicit && isValidTimeZone(explicit)) return explicit;
  if (fallback && isValidTimeZone(fallback)) return fallback;
  return UTC;
}

/**
 * IANA validity check via Intl (re-homed from admin-preferences-types).
 * Bounded length guard first (cheap reject for junk / huge strings) then
 * the runtime acceptance test. Available in both Node and the browser.
 */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat(DEFAULT_LOCALE, { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// ── the wall-clock projection (engine that powers date-fns rendering) ──────
//
// Returns a Date whose UTC fields MIRROR the wall-clock time in `tz` for the
// original instant. Handing the result to a UTC-reading formatter (or
// date-fns' `format`, which reads LOCAL fields) renders "as if in `tz`".
// This is `format.ts::toZonedWallClock`, moved here and made the shared
// primitive. The `hour === 24 → 0` normalization is the verified midnight
// fix for engines that emit "24" in hour12:false mode.
function zonedFieldLookup(
  date: Date,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const fmt = getFormatter(tz, DEFAULT_LOCALE, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const lookup: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = Number(p.value);
  }
  let hour = lookup.hour ?? 0;
  if (hour === 24) hour = 0;
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour,
    minute: lookup.minute ?? 0,
    second: lookup.second ?? 0,
  };
}

/**
 * Date whose UTC fields mirror `tz` wall-clock for the instant. The bridge
 * between an instant and date-fns pattern rendering (format.ts passes the
 * result to `format`, which reads local fields).
 */
export function toZonedWallClock(date: DateInput, tz: string): Date {
  const d = resolveDate(date);
  const f = zonedFieldLookup(d, tz);
  return new Date(
    Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, d.getUTCMilliseconds()),
  );
}

// ── rendering helpers (format.ts delegates to these) ───────────────────────

type FmtOpts = { tz?: string | null; locale?: string };

function fmtZone(opts?: FmtOpts): string {
  const tz = opts?.tz;
  return tz && isValidTimeZone(tz) ? tz : UTC;
}

/** "Jun 3, 2026 14:00" in `tz` (defaults to UTC when tz omitted/invalid). */
export function formatDateTime(date: DateInput, opts?: FmtOpts): string {
  const fmt = getFormatter(fmtZone(opts), opts?.locale ?? DEFAULT_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(resolveDate(date));
}

/** "Jun 3, 2026" in `tz`. */
export function formatDate(date: DateInput, opts?: FmtOpts): string {
  const fmt = getFormatter(fmtZone(opts), opts?.locale ?? DEFAULT_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return fmt.format(resolveDate(date));
}

/** "14:00" (24h) in `tz`. */
export function formatTime(date: DateInput, opts?: FmtOpts): string {
  const fmt = getFormatter(fmtZone(opts), opts?.locale ?? "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(resolveDate(date));
}

/**
 * Absolute timestamp WITH an explicit zone abbreviation, e.g.
 * "Jun 3, 2026, 14:00 PDT". For "hard business gate" surfaces (audit,
 * vault unlock, voucher/promo expiry, payout windows) where the zone must
 * be unambiguous on the face of the value. `tz` defaults to UTC → "...UTC".
 */
export function formatDateTimeWithZone(date: DateInput, opts?: FmtOpts): string {
  const fmt = getFormatter(fmtZone(opts), opts?.locale ?? DEFAULT_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return fmt.format(resolveDate(date));
}

// ── instant ↔ wall-clock conversion ────────────────────────────────────────

/** Date|ISO|epoch → canonical UTC ISO string (the storage form). */
export function toUtcIso(date: DateInput): string {
  return resolveDate(date).toISOString();
}

/** UTC ISO → Date instant. Pairs with `toUtcIso` for round-trips. */
export function fromUtcIso(iso: string): Date {
  return new Date(iso);
}

/**
 * Local wall-clock components in `tz` → the UTC instant they denote.
 * Generalizes `shifts/types.ts::localHhMmToUtc`. DST + half-hour-offset
 * safe via the verified 3-step offset algorithm:
 *
 *   1. Treat the components as if they were UTC → a naive instant.
 *   2. Read that naive instant's wall-clock in `tz`; the delta (read as
 *      UTC) is the zone's offset at that moment.
 *   3. The real UTC is naive − offset.
 *
 * `month` is 1-based (January = 1) to match human/SQL conventions and the
 * `getLocalDayBounds` caller below.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  // Step 1 — naive: pretend the local components are UTC.
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  // Step 2 — read the tz wall clock at that naive instant.
  let offsetMs = 0;
  try {
    const f = zonedFieldLookup(naive, tz);
    const tzWallAsUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    offsetMs = tzWallAsUtc - naive.getTime();
  } catch {
    offsetMs = 0; // unknown tz → UTC-native interpretation
  }
  // Step 3 — the real UTC instant.
  return new Date(naive.getTime() - offsetMs);
}

// ── local-day boundaries (the off-by-one / DST fix primitive) ──────────────

/**
 * [start, end) UTC instants bracketing the LOCAL calendar day that `date`
 * falls in, for zone `tz`. This is THE primitive that makes a server-side
 * "Today" align with the admin's local day instead of the UTC day.
 *
 * Built on `zonedWallClockToUtc(…, 00:00)` for local midnight, plus one
 * local-day increment (NOT +24h — that would drift across a DST boundary;
 * incrementing the local day component and re-resolving the offset is
 * exact). `end` is the start of the NEXT local day (half-open interval),
 * so `created_at >= start AND created_at < end` selects exactly the day.
 */
export function getLocalDayBounds(date: DateInput, tz: string): { start: Date; end: Date } {
  const d = resolveDate(date);
  // Local calendar Y/M/D for this instant.
  const f = zonedFieldLookup(d, tz);
  const start = zonedWallClockToUtc(f.year, f.month, f.day, 0, 0, tz);
  // Next local day: bump the DAY component then re-resolve (offset may
  // differ across the boundary on DST days). Date.UTC normalizes overflow
  // (e.g. day 32 → next month), so we read the bumped components back.
  const nextNaive = new Date(Date.UTC(f.year, f.month - 1, f.day + 1, 0, 0, 0, 0));
  const end = zonedWallClockToUtc(
    nextNaive.getUTCFullYear(),
    nextNaive.getUTCMonth() + 1,
    nextNaive.getUTCDate(),
    0,
    0,
    tz,
  );
  return { start, end };
}

/**
 * [start, end) bracketing the last `days` LOCAL calendar days ending with
 * (and including) the local day `date` falls in. e.g. `days = 7` → start =
 * local midnight 6 days before today, end = local midnight tomorrow. Snaps
 * both edges to local midnight so 7d/30d windows align to local days
 * (not rolling instants). For "Today" pass `days = 1` (equals
 * getLocalDayBounds).
 */
export function getLocalRangeBounds(
  date: DateInput,
  tz: string,
  days: number,
): { start: Date; end: Date } {
  const today = getLocalDayBounds(date, tz);
  if (days <= 1) return today;
  const f = zonedFieldLookup(resolveDate(date), tz);
  const back = new Date(Date.UTC(f.year, f.month - 1, f.day - (days - 1), 0, 0, 0, 0));
  const start = zonedWallClockToUtc(
    back.getUTCFullYear(),
    back.getUTCMonth() + 1,
    back.getUTCDate(),
    0,
    0,
    tz,
  );
  return { start, end: today.end };
}

/**
 * "YYYY-MM-DD" of the LOCAL calendar day for an instant in `tz`. The honest
 * bucket key for cache keys and daily-group serialization — replaces the
 * `new Date(d).toISOString().slice(0,10)` UTC-day reinterpretation that
 * causes the daily-bucket off-by-one when the DB already grouped by local
 * day. `en-CA` yields ISO `YYYY-MM-DD` directly.
 */
export function getLocalDayString(date: DateInput, tz: string): string {
  const fmt = getFormatter(tz && isValidTimeZone(tz) ? tz : UTC, "en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(resolveDate(date));
}

// ── labels ──────────────────────────────────────────────────────────────────

/**
 * IANA zone → human label. Tries the curated city map first ("Berlin
 * (Europe/Berlin)"); if the zone isn't curated, falls back to a live Intl
 * long-offset render ("UTC+02:00") appended to the raw id. The curated
 * map is injected by `timezones.ts` (which owns the city list) to avoid a
 * circular import — `core.ts` stays dependency-free.
 */
let curatedLabelLookup: ((tz: string) => string | null) | null = null;

/** Registered once by timezones.ts at module load. */
export function registerCuratedLabels(fn: (tz: string) => string | null): void {
  curatedLabelLookup = fn;
}

export function getTimeZoneLabel(tz: string, locale: string = DEFAULT_LOCALE): string {
  const curated = curatedLabelLookup?.(tz);
  if (curated) return curated;
  if (tz === UTC) return "UTC (Coordinated Universal Time)";
  // A genuinely invalid zone returns the raw id rather than a misleading
  // "(GMT)" suffix — getFormatter degrades bad zones to a UTC formatter, so
  // we must reject up front instead of relying on the catch below.
  if (!isValidTimeZone(tz)) return tz;
  // Live offset for non-curated zones.
  try {
    const fmt = getFormatter(tz, locale, {
      timeZoneName: "longOffset",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(new Date());
    const off = parts.find((p) => p.type === "timeZoneName")?.value;
    return off ? `${tz} (${off})` : tz;
  } catch {
    return tz;
  }
}

/**
 * Short "HH:mm" clock in `tz` (re-homed from timezones.ts::formatClockInZone).
 * Returns "—" on a bad zone, matching the prior contract.
 */
export function formatClockInZone(date: DateInput, tz: string): string {
  try {
    return formatTime(date, { tz });
  } catch {
    return "—";
  }
}

/**
 * "HH:mm" in `tz` from a UTC instant (re-homed from shifts::toZonedHhMm).
 * Falls back to the instant's UTC HH:mm on a bad zone, matching prior
 * behaviour (shift editor pre-population).
 */
export function toZonedHhMm(instant: DateInput, tz: string): string {
  const d = resolveDate(instant);
  if (!isValidTimeZone(tz)) return d.toISOString().slice(11, 16);
  return formatTime(d, { tz });
}
