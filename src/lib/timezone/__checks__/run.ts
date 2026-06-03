/**
 * run.ts — self-checking assertions for the PURE timezone core layer.
 *
 * Same harness convention as `src/lib/metrics/__checks__/run.ts`: the repo
 * has no unit-test framework (only Playwright e2e under `e2e/`, which
 * `playwright.config.ts` scopes to `e2e/tests` — this file is NOT picked up
 * by it). Per the task, instead of adding a framework we pin the engine
 * with plain `assert`-style checks runnable on demand:
 *
 *   npx tsx src/lib/timezone/__checks__/run.ts
 *
 * Exit code 0 = all checks passed; non-zero = a check failed (the message
 * names the failing case). It imports ONLY the pure, isomorphic core module
 * (`../core`) via a RELATIVE path — never `../server` (which pulls
 * `server-only` + `next/headers` and cannot run outside a request) and
 * never the `@/` alias (so the script runs under plain `tsx` with no
 * tsconfig-path loader, exactly like the metrics harness).
 *
 * Zones covered (the 6 required + half-hour + half-hour-DST oracles):
 *   UTC, Europe/Berlin, America/New_York, America/Los_Angeles,
 *   Asia/Tokyo, Australia/Sydney (+ Asia/Kolkata, America/St_Johns spot
 *   checks for half-hour offsets).
 *
 * DST oracles are the REAL 2026 transitions, verified against the runtime's
 * IANA database before pinning:
 *   - US spring-forward 2026-03-08, fall-back 2026-11-01
 *   - EU spring-forward 2026-03-29 01:00Z, fall-back 2026-10-25 01:00Z
 *   - AU (Sydney) fall-back 2026-04-05 16:00Z, spring-forward 2026-10-04 16:00Z
 */

import {
  isValidTimeZone,
  getEffectiveTimeZone,
  getBrowserTimeZone,
  toZonedWallClock,
  toUtcIso,
  fromUtcIso,
  zonedWallClockToUtc,
  getLocalDayBounds,
  getLocalRangeBounds,
  getLocalDayString,
  formatDate,
  formatDateTime,
  formatTime,
  formatDateTimeWithZone,
  formatClockInZone,
  toZonedHhMm,
  getTimeZoneLabel,
} from "../core";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

/**
 * The offset (in whole minutes, tz − UTC) at a given instant, computed
 * independently from `zonedWallClockToUtc` so it is a genuine oracle:
 * read the zone's wall clock for the instant, subtract the instant.
 */
function offsetMinutes(tz: string, iso: string): number {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const L: Record<string, number> = {};
  for (const x of p) if (x.type !== "literal") L[x.type] = Number(x.value);
  let h = L.hour;
  if (h === 24) h = 0;
  const asUtc = Date.UTC(L.year, L.month - 1, L.day, h, L.minute, L.second);
  return (asUtc - d.getTime()) / 60000;
}

/** Wall-clock HH:mm a `toZonedWallClock` result represents (reads UTC fields). */
function wallHhMm(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ─── 1. isValidTimeZone ────────────────────────────────────────────────────
console.log("\n[timezone checks] isValidTimeZone");
check("accepts UTC", isValidTimeZone("UTC"));
check("accepts Europe/Berlin", isValidTimeZone("Europe/Berlin"));
check("accepts America/New_York", isValidTimeZone("America/New_York"));
check("accepts America/Los_Angeles", isValidTimeZone("America/Los_Angeles"));
check("accepts Asia/Tokyo", isValidTimeZone("Asia/Tokyo"));
check("accepts Australia/Sydney", isValidTimeZone("Australia/Sydney"));
check("rejects empty string", !isValidTimeZone(""));
check("rejects junk", !isValidTimeZone("Not/AZone"));
check("rejects > 64 chars", !isValidTimeZone("A".repeat(65)));
// @ts-expect-error — runtime guard for non-string callers
check("rejects non-string", !isValidTimeZone(123));

// ─── 2. getEffectiveTimeZone precedence ─────────────────────────────────────
console.log("[timezone checks] getEffectiveTimeZone (pref → fallback → UTC)");
check("explicit valid wins", getEffectiveTimeZone("Asia/Tokyo", "Europe/Berlin") === "Asia/Tokyo");
check("falls back when explicit null", getEffectiveTimeZone(null, "Europe/Berlin") === "Europe/Berlin");
check("falls back when explicit invalid", getEffectiveTimeZone("bogus/zone", "Europe/Berlin") === "Europe/Berlin");
check("UTC when both absent", getEffectiveTimeZone(null, null) === "UTC");
check("UTC when both invalid", getEffectiveTimeZone("x/y", "a/b") === "UTC");
check("skips invalid fallback to UTC", getEffectiveTimeZone(null, "a/b") === "UTC");
// On the server (no window) browser detection returns "UTC" — the safe
// deterministic SSR default. (This harness runs in Node → no window.)
check("getBrowserTimeZone returns UTC under Node (no window)", getBrowserTimeZone() === "UTC");

// ─── 3. toZonedWallClock — DST-correct wall-clock projection ────────────────
console.log("[timezone checks] toZonedWallClock — wall clock per zone incl. DST");
// 12:00 UTC on a summer day.
const summer = "2026-06-03T12:00:00Z";
check("Berlin summer 12:00Z → 14:00 (CEST +2)", wallHhMm(toZonedWallClock(summer, "Europe/Berlin")) === "14:00");
check("NY summer 12:00Z → 08:00 (EDT -4)", wallHhMm(toZonedWallClock(summer, "America/New_York")) === "08:00");
check("LA summer 12:00Z → 05:00 (PDT -7)", wallHhMm(toZonedWallClock(summer, "America/Los_Angeles")) === "05:00");
check("Tokyo 12:00Z → 21:00 (+9)", wallHhMm(toZonedWallClock(summer, "Asia/Tokyo")) === "21:00");
check("Sydney summer(Jun=AEST) 12:00Z → 22:00 (+10)", wallHhMm(toZonedWallClock(summer, "Australia/Sydney")) === "22:00");
check("UTC 12:00Z → 12:00", wallHhMm(toZonedWallClock(summer, "UTC")) === "12:00");
check("Kolkata 12:00Z → 17:30 (+5:30 half-hour)", wallHhMm(toZonedWallClock(summer, "Asia/Kolkata")) === "17:30");
// Winter day — Berlin CET +1, NY EST -5, Sydney AEDT +11.
const winter = "2026-01-15T12:00:00Z";
check("Berlin winter 12:00Z → 13:00 (CET +1)", wallHhMm(toZonedWallClock(winter, "Europe/Berlin")) === "13:00");
check("NY winter 12:00Z → 07:00 (EST -5)", wallHhMm(toZonedWallClock(winter, "America/New_York")) === "07:00");
check("Sydney winter(Jan=AEDT) 12:00Z → 23:00 (+11)", wallHhMm(toZonedWallClock(winter, "Australia/Sydney")) === "23:00");
// Midnight normalization: an instant that is exactly local midnight must
// NOT roll forward a day (the hour===24 fix). Tokyo midnight = 15:00Z prev.
check("Tokyo local-midnight projection is 00:00 (no 24h roll)", wallHhMm(toZonedWallClock("2026-06-02T15:00:00Z", "Asia/Tokyo")) === "00:00");

// ─── 4. zonedWallClockToUtc — local wall-clock → UTC instant, incl. DST ─────
console.log("[timezone checks] zonedWallClockToUtc — local → UTC (offset oracle)");
function checkWallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number, expectIso: string) {
  const got = zonedWallClockToUtc(y, mo, d, h, mi, tz).toISOString();
  check(`${tz} ${y}-${mo}-${d} ${h}:${mi} local → ${expectIso}`, got === expectIso);
}
// Berlin 14:00 local: summer → 12:00Z, winter → 13:00Z.
checkWallToUtc("Europe/Berlin", 2026, 6, 3, 14, 0, "2026-06-03T12:00:00.000Z");
checkWallToUtc("Europe/Berlin", 2026, 1, 15, 14, 0, "2026-01-15T13:00:00.000Z");
// NY 09:00 local: summer (EDT -4) → 13:00Z, winter (EST -5) → 14:00Z.
checkWallToUtc("America/New_York", 2026, 6, 3, 9, 0, "2026-06-03T13:00:00.000Z");
checkWallToUtc("America/New_York", 2026, 1, 15, 9, 0, "2026-01-15T14:00:00.000Z");
// LA 00:00 local summer (PDT -7) → 07:00Z.
checkWallToUtc("America/Los_Angeles", 2026, 6, 3, 0, 0, "2026-06-03T07:00:00.000Z");
// Tokyo 09:00 local (+9) → 00:00Z same day.
checkWallToUtc("Asia/Tokyo", 2026, 6, 3, 9, 0, "2026-06-03T00:00:00.000Z");
// Sydney 10:00 local Jun (AEST +10) → 00:00Z.
checkWallToUtc("Australia/Sydney", 2026, 6, 3, 10, 0, "2026-06-03T00:00:00.000Z");
// Kolkata 14:00 local (+5:30) → 08:30Z (half-hour).
checkWallToUtc("Asia/Kolkata", 2026, 6, 3, 14, 0, "2026-06-03T08:30:00.000Z");
// St_Johns 12:00 local summer (NDT -2:30) → 14:30Z (half-hour + DST).
checkWallToUtc("America/St_Johns", 2026, 6, 3, 12, 0, "2026-06-03T14:30:00.000Z");
// UTC no-op.
checkWallToUtc("UTC", 2026, 6, 3, 14, 30, "2026-06-03T14:30:00.000Z");

// ─── 5. DST transition boundaries (the hard cases) ──────────────────────────
console.log("[timezone checks] DST transition offsets (real 2026 transitions)");
// US spring-forward 2026-03-08 02:00 local (NY/LA). Before vs after.
check("NY before spring-forward (06:00Z) = -300m", offsetMinutes("America/New_York", "2026-03-08T06:00:00Z") === -300);
check("NY after spring-forward (07:00Z) = -240m", offsetMinutes("America/New_York", "2026-03-08T07:00:00Z") === -240);
check("LA before spring-forward (09:00Z) = -480m", offsetMinutes("America/Los_Angeles", "2026-03-08T09:00:00Z") === -480);
check("LA after spring-forward (11:00Z) = -420m", offsetMinutes("America/Los_Angeles", "2026-03-08T11:00:00Z") === -420);
// US fall-back 2026-11-01 02:00 local.
check("NY before fall-back (05:00Z) = -240m", offsetMinutes("America/New_York", "2026-11-01T05:00:00Z") === -240);
check("NY after fall-back (06:00Z) = -300m", offsetMinutes("America/New_York", "2026-11-01T06:00:00Z") === -300);
// EU spring-forward 2026-03-29 01:00Z (Berlin).
check("Berlin before spring-forward (00:00Z) = +60m", offsetMinutes("Europe/Berlin", "2026-03-29T00:00:00Z") === 60);
check("Berlin after spring-forward (02:00Z) = +120m", offsetMinutes("Europe/Berlin", "2026-03-29T02:00:00Z") === 120);
// EU fall-back 2026-10-25 01:00Z.
check("Berlin before fall-back (00:00Z) = +120m", offsetMinutes("Europe/Berlin", "2026-10-25T00:00:00Z") === 120);
check("Berlin after fall-back (02:00Z) = +60m", offsetMinutes("Europe/Berlin", "2026-10-25T02:00:00Z") === 60);
// AU Sydney fall-back 2026-04-05 16:00Z (AEDT +11 → AEST +10).
check("Sydney before fall-back (15:00Z) = +660m", offsetMinutes("Australia/Sydney", "2026-04-04T15:00:00Z") === 660);
check("Sydney after fall-back (17:00Z) = +600m", offsetMinutes("Australia/Sydney", "2026-04-04T17:00:00Z") === 600);
// AU Sydney spring-forward 2026-10-04 16:00Z (AEST +10 → AEDT +11).
check("Sydney before spring-forward (15:00Z) = +600m", offsetMinutes("Australia/Sydney", "2026-10-03T15:00:00Z") === 600);
check("Sydney after spring-forward (17:00Z) = +660m", offsetMinutes("Australia/Sydney", "2026-10-03T17:00:00Z") === 660);
// Tokyo never observes DST.
check("Tokyo summer = +540m", offsetMinutes("Asia/Tokyo", "2026-06-03T12:00:00Z") === 540);
check("Tokyo winter = +540m (no DST)", offsetMinutes("Asia/Tokyo", "2026-01-15T12:00:00Z") === 540);
// zonedWallClockToUtc must honor the POST-transition offset for a wall time
// after the jump: Berlin 03:00 local on spring-forward day is CEST (+2) →
// 01:00Z (02:00 local does not exist; 03:00 is the first valid CEST hour).
checkWallToUtc("Europe/Berlin", 2026, 3, 29, 3, 0, "2026-03-29T01:00:00.000Z");

// ─── 6. getLocalDayBounds — the off-by-one / DST fix ────────────────────────
console.log("[timezone checks] getLocalDayBounds — local-day [start,end) in UTC");
// A Pacific admin at 23:00 local on Jun 2 (= 2026-06-03T06:00:00Z) is still
// on Jun 2 LOCALLY; UTC-day math would wrongly bucket it as Jun 3.
{
  const lateNightLA = "2026-06-03T06:00:00Z"; // 23:00 Jun 2 in LA (PDT -7)
  const b = getLocalDayBounds(lateNightLA, "America/Los_Angeles");
  // Local Jun 2 00:00 PDT = 07:00Z Jun 2; next local midnight = 07:00Z Jun 3.
  check("LA late-night bounds start = Jun 2 07:00Z", b.start.toISOString() === "2026-06-02T07:00:00.000Z");
  check("LA late-night bounds end = Jun 3 07:00Z", b.end.toISOString() === "2026-06-03T07:00:00.000Z");
  check("LA late-night instant falls within its local-day bounds", new Date(lateNightLA) >= b.start && new Date(lateNightLA) < b.end);
  // The naive UTC day would have been Jun 3 — prove we did NOT use it.
  check("LA local-day start is NOT the UTC midnight (off-by-one avoided)", b.start.toISOString() !== "2026-06-03T00:00:00.000Z");
}
// Berlin ordinary day.
{
  const b = getLocalDayBounds("2026-06-03T12:00:00Z", "Europe/Berlin");
  check("Berlin day start = Jun 3 00:00 CEST = Jun 2 22:00Z", b.start.toISOString() === "2026-06-02T22:00:00.000Z");
  check("Berlin day end = Jun 4 00:00 CEST = Jun 3 22:00Z", b.end.toISOString() === "2026-06-03T22:00:00.000Z");
}
// UTC day is the trivial identity.
{
  const b = getLocalDayBounds("2026-06-03T12:00:00Z", "UTC");
  check("UTC day start = Jun 3 00:00Z", b.start.toISOString() === "2026-06-03T00:00:00.000Z");
  check("UTC day end = Jun 4 00:00Z", b.end.toISOString() === "2026-06-04T00:00:00.000Z");
}
// DST spring-forward day in Berlin is only 23 hours long; bounds must span
// exactly that (22→23 the next day is 24h UTC minus the 1h skipped = 23h).
{
  const b = getLocalDayBounds("2026-03-29T12:00:00Z", "Europe/Berlin");
  const hours = (b.end.getTime() - b.start.getTime()) / 3_600_000;
  check("Berlin spring-forward local day spans 23h (not 24)", hours === 23);
  check("Berlin spring-forward day start = Mar 28 23:00Z (CET)", b.start.toISOString() === "2026-03-28T23:00:00.000Z");
  check("Berlin spring-forward day end = Mar 29 22:00Z (CEST)", b.end.toISOString() === "2026-03-29T22:00:00.000Z");
}
// DST fall-back day in NY is 25 hours long.
{
  const b = getLocalDayBounds("2026-11-01T12:00:00Z", "America/New_York");
  const hours = (b.end.getTime() - b.start.getTime()) / 3_600_000;
  check("NY fall-back local day spans 25h (not 24)", hours === 25);
}
// Tokyo +9: local day Jun 3 = Jun 2 15:00Z → Jun 3 15:00Z.
{
  const b = getLocalDayBounds("2026-06-03T12:00:00Z", "Asia/Tokyo");
  check("Tokyo day start = Jun 2 15:00Z", b.start.toISOString() === "2026-06-02T15:00:00.000Z");
  check("Tokyo day end = Jun 3 15:00Z", b.end.toISOString() === "2026-06-03T15:00:00.000Z");
}

// ─── 7. getLocalRangeBounds — N local days, snapped to local midnight ───────
console.log("[timezone checks] getLocalRangeBounds — N-day windows on local edges");
{
  const days1 = getLocalRangeBounds("2026-06-03T12:00:00Z", "America/Los_Angeles", 1);
  const day = getLocalDayBounds("2026-06-03T12:00:00Z", "America/Los_Angeles");
  check("range(1) == getLocalDayBounds", days1.start.getTime() === day.start.getTime() && days1.end.getTime() === day.end.getTime());
  const days7 = getLocalRangeBounds("2026-06-03T12:00:00Z", "America/Los_Angeles", 7);
  // 7 local days ending today: start = local midnight May 28, end = today's end.
  check("range(7) end == today end", days7.end.getTime() === day.end.getTime());
  check("range(7) start = May 28 00:00 PDT = May 28 07:00Z", days7.start.toISOString() === "2026-05-28T07:00:00.000Z");
  // The window must cover 7 local days. In LA (no DST in this window) that's
  // exactly 7*24h.
  const h = (days7.end.getTime() - days7.start.getTime()) / 3_600_000;
  check("range(7) spans 168h (no DST in window)", h === 168);
}
{
  // A 30d window that CROSSES the EU spring-forward (Mar 29) loses one hour.
  const days30 = getLocalRangeBounds("2026-04-10T12:00:00Z", "Europe/Berlin", 30);
  const h = (days30.end.getTime() - days30.start.getTime()) / 3_600_000;
  check("Berlin range(30) crossing spring-forward spans 719h (30*24 − 1)", h === 719);
}

// ─── 8. getLocalDayString — honest local bucket key ─────────────────────────
console.log("[timezone checks] getLocalDayString — local YYYY-MM-DD");
check("LA late-night → 2026-06-02 (local), not 06-03 (UTC)", getLocalDayString("2026-06-03T06:00:00Z", "America/Los_Angeles") === "2026-06-02");
check("Tokyo early-UTC → next local day", getLocalDayString("2026-06-02T16:00:00Z", "Asia/Tokyo") === "2026-06-03");
check("UTC passthrough", getLocalDayString("2026-06-03T12:00:00Z", "UTC") === "2026-06-03");
check("Berlin day string", getLocalDayString("2026-06-03T12:00:00Z", "Europe/Berlin") === "2026-06-03");

// ─── 9. Rendering helpers (Intl-backed, format.ts's NEW siblings) ───────────
console.log("[timezone checks] rendering helpers (formatDate/Time/WithZone)");
check("formatTime Berlin summer 12:00Z = 14:00", formatTime(summer, { tz: "Europe/Berlin" }) === "14:00");
check("formatTime LA summer 12:00Z = 05:00", formatTime(summer, { tz: "America/Los_Angeles" }) === "05:00");
check("formatTime defaults to UTC when tz omitted", formatTime(summer) === "12:00");
check("formatTime degrades bad tz to UTC", formatTime(summer, { tz: "bogus/zone" }) === "12:00");
// formatDate / formatDateTime carry the local calendar day across the
// date-line: an instant that is the prior local day in LA shows that day.
check("formatDate LA late-night shows Jun 2", formatDate("2026-06-03T06:00:00Z", { tz: "America/Los_Angeles" }) === "Jun 2, 2026");
check("formatDate Tokyo shows Jun 3", formatDate("2026-06-02T16:00:00Z", { tz: "Asia/Tokyo" }) === "Jun 3, 2026");
check("formatDateTime Berlin includes 14:00", formatDateTime(summer, { tz: "Europe/Berlin" }).includes("14:00"));
// with-zone variant must name the zone abbreviation.
{
  const wz = formatDateTimeWithZone(summer, { tz: "America/Los_Angeles" });
  check("formatDateTimeWithZone LA names PDT", /PDT/.test(wz));
  const wzUtc = formatDateTimeWithZone(summer);
  check("formatDateTimeWithZone defaults to UTC label", /UTC|GMT/.test(wzUtc));
}
// formatClockInZone (re-homed) keeps the "—" on a bad zone contract.
check("formatClockInZone good zone", formatClockInZone(summer, "Europe/Berlin") === "14:00");
check("formatClockInZone bad zone → 14:00 via UTC-fallback formatter", formatClockInZone(summer, "Asia/Tokyo") === "21:00");

// ─── 10. toUtcIso / fromUtcIso round-trips ──────────────────────────────────
console.log("[timezone checks] toUtcIso / fromUtcIso round-trips");
{
  const iso = "2026-06-03T12:34:56.789Z";
  check("fromUtcIso(toUtcIso(x)) is instant-identical", fromUtcIso(toUtcIso(iso)).getTime() === new Date(iso).getTime());
  check("toUtcIso(Date) is canonical ISO", toUtcIso(new Date(iso)) === iso);
  check("toUtcIso(epoch) round-trips", toUtcIso(new Date(iso).getTime()) === iso);
  // wall-clock → UTC → wall-clock round trip in a half-hour DST zone.
  const utc = zonedWallClockToUtc(2026, 6, 3, 12, 0, "America/St_Johns");
  check("St_Johns 12:00 local round-trips back to 12:00 via toZonedHhMm", toZonedHhMm(utc, "America/St_Johns") === "12:00");
  const utcB = zonedWallClockToUtc(2026, 1, 15, 9, 30, "America/New_York");
  check("NY 09:30 winter round-trips back to 09:30", toZonedHhMm(utcB, "America/New_York") === "09:30");
  const utcT = zonedWallClockToUtc(2026, 6, 3, 23, 45, "Asia/Tokyo");
  check("Tokyo 23:45 round-trips back to 23:45", toZonedHhMm(utcT, "Asia/Tokyo") === "23:45");
}

// ─── 11. Near-midnight edge cases ───────────────────────────────────────────
console.log("[timezone checks] near-midnight edges");
// 00:00 local in each zone must NOT roll a day in toZonedWallClock.
check("Berlin 00:00 local projection = 00:00", wallHhMm(toZonedWallClock(zonedWallClockToUtc(2026, 6, 3, 0, 0, "Europe/Berlin"), "Europe/Berlin")) === "00:00");
check("NY 00:00 local projection = 00:00", wallHhMm(toZonedWallClock(zonedWallClockToUtc(2026, 6, 3, 0, 0, "America/New_York"), "America/New_York")) === "00:00");
check("Sydney 00:00 local projection = 00:00", wallHhMm(toZonedWallClock(zonedWallClockToUtc(2026, 6, 3, 0, 0, "Australia/Sydney"), "Australia/Sydney")) === "00:00");
// 23:59 local stays on the same local day.
check("LA 23:59 local day string is same day", getLocalDayString(zonedWallClockToUtc(2026, 6, 3, 23, 59, "America/Los_Angeles"), "America/Los_Angeles") === "2026-06-03");
// One minute later (00:00 next local day) advances the local day string.
check("LA 00:00 next local day string advances", getLocalDayString(zonedWallClockToUtc(2026, 6, 4, 0, 0, "America/Los_Angeles"), "America/Los_Angeles") === "2026-06-04");

// ─── 12. Labels ─────────────────────────────────────────────────────────────
console.log("[timezone checks] getTimeZoneLabel");
// Without the curated map registered (this harness does NOT import
// timezones.ts), non-UTC zones fall back to "<id> (UTC±hh:mm)".
check("UTC label", getTimeZoneLabel("UTC").startsWith("UTC"));
check("uncurated zone gets offset suffix", /Europe\/Berlin \(GMT|Europe\/Berlin \(UTC/.test(getTimeZoneLabel("Europe/Berlin")));
check("bad zone returns the raw id", getTimeZoneLabel("bogus/zone") === "bogus/zone");

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n[timezone checks] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAILED checks:\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("[timezone checks] OK — all timezone-core assertions hold.\n");
