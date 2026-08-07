import { z } from "zod";

// Robust parsing for human-entered USD money strings.
//
// Why this exists: a money input parsed with `parseFloat` silently
// truncates malformed thousands input — `parseFloat("17.878.54")` stops
// at the second dot and returns `17.878`, which then rounds to $17.88 on
// a Decimal(20,2) column. An admin who meant $17,878.54 records $17.88.
// That is a serious, silent four-figure money bug.
//
// This parser NEVER silently produces a wrong number. It accepts only
// unambiguous US-formatted amounts and rejects anything malformed with a
// clear message, so the caller can surface a validation error instead of
// writing a wrong ledger row.
//
// Accepted (signed optional, leading `$`/spaces tolerated):
//   "17878.54"        → 17878.54
//   "17,878.54"       → 17878.54   (US thousands grouping stripped)
//   "1,000.00"        → 1000
//   "1000"            → 1000
//   "-50" / "+50"     → -50 / 50
//   ".5" / "0.5"      → 0.5
//
// Rejected (returned as { ok: false }):
//   "17.878.54"       multiple dots — ambiguous, never guessed
//   "17.878"          more than 2 decimal places (not a cents value)
//   "1,00"            malformed thousands grouping (group not 3 digits)
//   "17878,54"        comma used as a decimal separator (EU format)
//   "abc" / ""        non-numeric / empty
//
// The result keeps `value` exactly rounded to cents so the caller writes
// the same number the operator was shown in the live preview.

const REJECT_MESSAGE = "Enter a valid amount, e.g. 17878.54 or 17,878.54";

export type ParsedAmount =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Parse a human-entered USD string into a cents-precise number, or
 * reject it. See file header for the exact accept/reject rules.
 *
 * `value` is rounded to 2 decimal places (cents) and is safe to hand to
 * a Decimal(20,2) column without further rounding surprising the caller.
 */
export function parseUsdAmount(raw: string): ParsedAmount {
  if (typeof raw !== "string") {
    return { ok: false, error: REJECT_MESSAGE };
  }

  // Strip surrounding whitespace and a single optional leading currency
  // symbol. We do NOT strip arbitrary characters — anything unexpected
  // left in the string after this will fail the strict checks below.
  let s = raw.trim();
  if (s.length === 0) {
    return { ok: false, error: "Enter an amount" };
  }
  if (s.startsWith("$")) {
    s = s.slice(1).trim();
  }

  // Capture and remove a single leading sign.
  let sign = 1;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  s = s.trim();
  if (s.length === 0) {
    return { ok: false, error: REJECT_MESSAGE };
  }

  // A comma is only ever a US thousands separator here. Each comma must
  // sit between digit groups of exactly 3 (e.g. 1,000 / 12,345,678).
  // A comma followed by 1-2 digits ("1,00") or used as a decimal
  // ("17878,54") is malformed in US format → reject rather than guess.
  if (s.includes(",")) {
    // Split off an optional decimal part first so the comma check only
    // looks at the integer portion's grouping.
    const dotCount = (s.match(/\./g) ?? []).length;
    if (dotCount > 1) {
      // Multiple dots alongside commas — hopeless to disambiguate.
      return { ok: false, error: REJECT_MESSAGE };
    }
    const [intPart, decPartRaw] = s.split(".");
    // Integer part with commas must match strict thousands grouping:
    // a 1-3 digit lead group, then any number of ",ddd" groups.
    if (!/^\d{1,3}(,\d{3})+$/.test(intPart)) {
      return { ok: false, error: REJECT_MESSAGE };
    }
    s = intPart.replace(/,/g, "") + (decPartRaw !== undefined ? "." + decPartRaw : "");
  }

  // After comma handling there must be NO comma left and at most one dot.
  if (s.includes(",")) {
    return { ok: false, error: REJECT_MESSAGE };
  }
  const dotCount = (s.match(/\./g) ?? []).length;
  if (dotCount > 1) {
    // The classic bug input "17.878.54" lands here → rejected, never
    // silently truncated to 17.878 / 17.88.
    return { ok: false, error: REJECT_MESSAGE };
  }

  // Strict shape: optional integer digits, optional single dot, optional
  // fractional digits — but require at least one digit overall, and cap
  // the fractional part at 2 places (a USD amount can't carry sub-cent
  // precision; "17.878" with 3 decimals is rejected, not rounded).
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) {
    return { ok: false, error: REJECT_MESSAGE };
  }
  const intDigits = m[1] ?? "";
  const decDigits = m[2] ?? "";
  if (intDigits.length === 0 && decDigits.length === 0) {
    // e.g. just "." or empty after stripping.
    return { ok: false, error: REJECT_MESSAGE };
  }

  const numeric = Number(`${intDigits || "0"}.${decDigits || "0"}`);
  if (!Number.isFinite(numeric)) {
    return { ok: false, error: REJECT_MESSAGE };
  }

  // Round to cents defensively (the regex already guarantees ≤2 decimals,
  // so this is exact) and re-apply the sign. Math.round on the cents
  // integer avoids binary-float drift like 0.1 + 0.2.
  const cents = Math.round(numeric * 100) * sign;
  const value = cents / 100;

  return { ok: true, value };
}

/**
 * True when `n` is a finite number that lands exactly on a cent
 * boundary (no sub-cent precision). Used server-side to reject a client
 * number that didn't come from `parseUsdAmount` — e.g. a hand-crafted
 * `17.878` request. We never trust the client's parse; the server
 * re-validates that the amount is a clean cents value.
 */
function isCentsPrecise(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  // Scale to cents and confirm the result is (within float tolerance) an
  // integer. 1e-6 absorbs benign binary-float drift while still rejecting
  // a genuine third decimal (which scales to a .x cents value).
  const scaled = n * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * Zod schema for a server-side USD money amount that may be positive or
 * negative (e.g. a balance adjustment) but must be finite and exactly
 * cent-precise. Rejects NaN/Infinity and sub-cent precision so a
 * malformed client number can't slip a wrong value into a Decimal(20,2)
 * ledger write. Pass `{ positive: true }` for amounts that must be > 0.
 */
export function usdAmountSchema(opts?: { positive?: boolean }) {
  let schema = z
    .number()
    .refine((n) => Number.isFinite(n), { message: "Amount must be a number" })
    .refine(isCentsPrecise, {
      message: "Amount can have at most 2 decimal places",
    });
  if (opts?.positive) {
    schema = schema.refine((n) => n > 0, {
      message: "Amount must be positive",
    });
  }
  return schema;
}
