"use client";

import * as React from "react";
import {
  formatDate,
  formatDateTime,
  formatMonthYear,
  formatRelative,
  formatWithPattern,
} from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// TimezoneProvider
// ---------------------------------------------------------------------------
//
// Renders a React context carrying the admin's preferred IANA timezone and
// preferred date-fns format pattern. Pages + components consume via the
// `useTimezone` / `useFormatDate{,Time}` / `useFormatRelative` hooks —
// see src/lib/utils/format.ts for the underlying pure helpers.
//
// The initial timezone comes from the server (preferences row → null if
// the admin hasn't set one yet). When null, the provider falls back to
// the browser's detected zone on mount. `useTimezone()` always returns
// a concrete string so consumers never need their own fallbacks.
// ---------------------------------------------------------------------------

type TimezoneContextValue = {
  /** IANA tz — always concrete (browser fallback applied). */
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

/**
 * Detect the browser's IANA zone. Wrapped in try/catch because very old
 * engines may not implement Intl.DateTimeFormat().resolvedOptions() — we
 * fall back to UTC rather than crashing the layout.
 */
function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function TimezoneProvider({
  initialTimezone,
  initialDateFormat,
  children,
}: {
  /** Null means "admin hasn't picked one — use browser". */
  initialTimezone: string | null;
  initialDateFormat: string | undefined;
  children: React.ReactNode;
}) {
  // Two pieces of state so the provider can distinguish "explicit pref"
  // from "auto-detected" when the profile UI wants to show the "Detect
  // from browser" option. Initial render uses the server value; a
  // post-mount effect fills in the browser fallback when the admin
  // hasn't chosen one yet (can't run on the server).
  const [explicitTimezone, setExplicitTimezone] = React.useState<string | null>(
    initialTimezone,
  );
  const [browserTimezone, setBrowserTimezone] = React.useState<string>("UTC");
  const [dateFormat, setDateFormat] = React.useState<string | undefined>(
    initialDateFormat,
  );

  React.useEffect(() => {
    setBrowserTimezone(detectBrowserTimezone());
  }, []);

  const value = React.useMemo<TimezoneContextValue>(() => {
    return {
      timezone: explicitTimezone ?? browserTimezone,
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
export function useTimezone(): string {
  const ctx = React.useContext(TimezoneContext);
  if (ctx) return ctx.timezone;
  // Fallback: no provider mounted (login screen, storybook, etc.).
  // Server render returns "UTC" so the markup is deterministic; client
  // render upgrades to the browser's detected zone.
  return typeof window === "undefined" ? "UTC" : detectBrowserTimezone();
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

export function useFormatDate(): (d: Date | string | number) => string {
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

export function useFormatMonthYear(): (d: Date | string | number) => string {
  const tz = useTimezone();
  return React.useCallback((d) => formatMonthYear(d, tz), [tz]);
}

/**
 * Relative strings ("2 hours ago") don't change by viewer timezone —
 * the hook just returns the pure formatter, but providing a hook keeps
 * the API shape consistent so consumers can swap between absolute and
 * relative modes without touching imports.
 */
export function useFormatRelative(): (d: Date | string | number) => string {
  return React.useCallback((d) => formatRelative(d), []);
}
