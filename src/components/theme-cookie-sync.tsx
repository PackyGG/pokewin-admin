"use client";

import * as React from "react";
import { useTheme } from "next-themes";

import {
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_NAME,
  themeCookieDomain,
} from "@/lib/theme-cookie";

/**
 * Mirrors the active next-themes value into a domain-wide cookie so every
 * dashboard hostname (apex + `packs.` / `fraud.` / `marketing.`) shares one
 * theme. See `src/lib/theme-cookie.ts` for the full mechanic — this is the
 * WRITE half; the read half is the inline seed script in the root layout.
 *
 * Renders nothing. Writes the raw `theme` (which may be "system"), NOT
 * `resolvedTheme`, so a "System" choice stays "System" on the other hosts
 * instead of freezing into whatever it resolved to here.
 */
export function ThemeCookieSync() {
  const { theme } = useTheme();

  React.useEffect(() => {
    if (!theme) return;
    const domain = themeCookieDomain(window.location.hostname);
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      `${THEME_COOKIE_NAME}=${encodeURIComponent(theme)}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax` +
      (domain ? `; Domain=${domain}` : "") +
      secure;
  }, [theme]);

  return null;
}
