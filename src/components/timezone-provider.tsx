"use client";

import * as React from "react";
import {
  formatDate,
  formatDateTime,
  formatMonthYear,
  formatRelative,
  formatWithPattern,
} from "@/lib/utils/format";
import {
  getBrowserTimeZone,
  getEffectiveTimeZone,
} from "@/lib/timezone/core";
import { tzCookieWriteString } from "@/lib/timezone/cookie";

// ---------------------------------------------------------------------------
// TimezoneProvider
// ---------------------------------------------------------------------------
//
// Renders a React context carrying the admin's preferred IANA timezone and
// preferred date-fns format pattern. Pages + components consume via the
// `useTimezone` / `useFormatDate{,Time}` / `useFormatRelative` hooks —
// see src/lib/utils/format.ts (rendering) + src/lib/timezone/core.ts
// (the underlying pure Intl engine) for the helpers behind them.
//
// Zone resolution precedence — IDENTICAL to the server
// (`getServerTimeZone` in src/lib/timezone/server.ts) so SSR and the first
// client paint compute the same zone from the same two inputs:
//
//   explicit DB preference  →  admin_tz cookie  →  "UTC"
//
// Hydration: the layout passes BOTH the explicit preference
// (`initialTimezone`) AND the cookie value (`cookieTimezone`, read
// server-side from `admin_tz`). The browser-fallback state is SEEDED from
// the cookie (NOT hardcoded "UTC"), so when a cookie exists the first
// client render matches SSR exactly → no flash. The post-mount effect then
// detects the live browser zone; if it differs from the cookie it (a)
// updates state and (b) re-writes the cookie so the NEXT request's SSR is
// already correct. A first-ever visit (no cookie) accepts one benign
// first-paint correction; every later navigation is flash-free.
// ---------------------------------------------------------------------------

type TimezoneContextValue = {
  /** IANA tz — always concrete (pref → cookie → browser → "UTC"). */
  timezone: string;
  /** Whether the admin has an explicit preference (vs auto-detect). */
  explicit: boolean;
  /** Preferred date-fns format pattern (or undefined for the default). */
  dateFormat: string | undefined;
  /**
   * Swap the active timezone at runtime without a round-trip. Used by the
   * profile editor so the rest of the UI re-renders immediately after
   * the "Save" button writes the preference server-side.
   */
  setTimezone: (tz: string | null) => void;
  /** Swap the active date-format at runtime. */
  setDateFormat: (pattern: string | undefined) => void;
};

const TimezoneContext = React.createContext<TimezoneContextValue | null>(null);

export function TimezoneProvider({
  initialTimezone,
  cookieTimezone,
  initialDateFormat,
  children,
}: {
  /** Null means "admin hasn't picked one — use cookie/browser". */
  initialTimezone: string | null;
  /**
   * The browser-detected zone from the `admin_tz` cookie (read server-side
   * in the layout). `null` on a first-ever visit before the cookie is
   * written. Seeds the fallback so SSR and first client paint agree.
   */
  cookieTimezone?: string | null;
  initialDateFormat: string | undefined;
  children: React.ReactNode;
}) {
  // Two pieces of zone state so the provider can distinguish "explicit
  // pref" from "auto-detected" (the profile UI surfaces a "Detect from
  // browser" option). The fallback is SEEDED from the cookie so the
  // initial render — server AND client — uses the same value with no flash.
  const [explicitTimezone, setExplicitTimezone] = React.useState<string | null>(
    initialTimezone,
  );
  const [browserTimezone, setBrowserTimezone] = React.useState<string>(
    cookieTimezone ?? "UTC",
  );
  const [dateFormat, setDateFormat] = React.useState<string | undefined>(
    initialDateFormat,
  );

  React.useEffect(() => {
    // Detect the live browser zone (client-only; getBrowserTimeZone guards
    // window). If it diverges from what SSR used (the cookie), adopt it AND
    // persist it so the next request server-renders the right zone.
    const detected = getBrowserTimeZone();
    if (detected && detected !== (cookieTimezone ?? "UTC")) {
      setBrowserTimezone(detected);
    }
    if (detected && detected !== cookieTimezone) {
      try {
        document.cookie = tzCookieWriteString(detected);
      } catch {
        // document.cookie can throw in locked-down embeds — non-fatal;
        // the in-memory state above still corrects this session.
      }
    }
    // Intentionally run once on mount. cookieTimezone is a server-provided
    // constant for the life of the provider; re-running on its identity is
    // unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = React.useMemo<TimezoneContextValue>(() => {
    return {
      // Same precedence as the server: explicit pref → detected/cookie →
      // "UTC". getEffectiveTimeZone validates each candidate.
      timezone: getEffectiveTimeZone(explicitTimezone, browserTimezone),
      explicit: explicitTimezone !== null,
      dateFormat,
      setTimezone: (tz) => setExplicitTimezone(tz),
      setDateFormat,
    };
  }, [explicitTimezone, browserTimezone, dateFormat]);

  return (
    <TimezoneContext.Provider value={value}>{children}</TimezoneContext.Provider>
  );
}

/**
 * Read the currently-active timezone. Always returns a concrete IANA
 * string (never null). Components outside the provider get a browser
 * fallback instead of throwing — this keeps the hook safe to call from
 * client bundles rendered by the login layout (pre-provider) etc.
 */
function useTimezone(): string {
  const ctx = React.useContext(TimezoneContext);
  if (ctx) return ctx.timezone;
  // Fallback: no provider mounted (login screen, storybook, etc.).
  // Server render returns "UTC" so the markup is deterministic; client
  // render upgrades to the browser's detected zone. getBrowserTimeZone
  // already guards `typeof window` and returns "UTC" on the server.
  return getBrowserTimeZone();
}

/**
 * Full context accessor — use this from the profile editor when you
 * need to mutate the stored timezone or check whether the current value
 * is explicit vs auto-detected.
 */
export function useTimezoneContext(): TimezoneContextValue {
  const ctx = React.useContext(TimezoneContext);
  if (!ctx) {
    throw new Error(
      "useTimezoneContext must be used inside a <TimezoneProvider>",
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Timezone-aware format hooks
//
// Each hook returns a memoized format function bound to the active zone.
// Consumers can drop them in as an additive replacement for the direct
// imports in src/lib/utils/format.ts — existing call sites that still
// import the raw helpers keep working (they get browser-local output).
// ---------------------------------------------------------------------------

function useFormatDate(): (d: Date | string | number) => string {
  const tz = useTimezone();
  const ctx = React.useContext(TimezoneContext);
  const pattern = ctx?.dateFormat;
  return React.useCallback(
    (d) => (pattern ? formatWithPattern(d, pattern, tz) : formatDate(d, tz)),
    [tz, pattern],
  );
}

export function useFormatDateTime(): (d: Date | string | number) => string {
  const tz = useTimezone();
  const ctx = React.useContext(TimezoneContext);
  const pattern = ctx?.dateFormat;
  return React.useCallback(
    (d) =>
      pattern
        ? formatWithPattern(d, `${pattern} HH:mm`, tz)
        : formatDateTime(d, tz),
    [tz, pattern],
  );
}

function useFormatMonthYear(): (d: Date | string | number) => string {
  const tz = useTimezone();
  return React.useCallback((d) => formatMonthYear(d, tz), [tz]);
}

/**
 * Relative strings ("2 hours ago") don't change by viewer timezone —
 * the hook just returns the pure formatter, but providing a hook keeps
 * the API shape consistent so consumers can swap between absolute and
 * relative modes without touching imports.
 */
function useFormatRelative(): (d: Date | string | number) => string {
  return React.useCallback((d) => formatRelative(d), []);
}
