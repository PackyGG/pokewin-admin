/**
 * Cross-subdomain theme persistence.
 *
 * next-themes stores the chosen theme in `localStorage`, which is scoped to a
 * single ORIGIN. The dashboard is served from several hostnames off the same
 * deployment (`packydash.com`, `packs.`, `fraud.`, `marketing.`), so a theme
 * picked on one host was invisible to the others — each subdomain silently kept
 * its own theme and the apps looked like they used different palettes (the
 * Creator Hub on `marketing.` sitting on `dark` while the apex ran `grailed`,
 * which reads as "marketing is darker").
 *
 * Fix: mirror the theme into a COOKIE scoped to the registrable domain
 * (`.packydash.com`), which every subdomain shares.
 *
 *   • {@link ThemeCookieSync} writes the cookie whenever the theme changes.
 *   • The inline seed script in the root layout copies the cookie into
 *     next-themes' `localStorage` key BEFORE next-themes' own pre-hydration
 *     script runs, so a cross-host visit paints the right theme with no flash
 *     and no extra render.
 *
 * Last change anywhere wins, on every host. Edge-safe / dependency-free.
 */

import { ROOT_DOMAIN } from "@/lib/app-hosts";

/** next-themes `storageKey` — must stay in sync with `src/app/layout.tsx`. */
export const THEME_STORAGE_KEY = "pokewin-theme-v2";

/** Domain-wide cookie mirroring {@link THEME_STORAGE_KEY}. */
export const THEME_COOKIE_NAME = "pokewin-theme";

/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Every theme next-themes may hand us, including "system". The seed script
 * validates against this list so a hand-edited cookie can't inject a class.
 */
export const THEME_COOKIE_VALUES = [
  "light",
  "dark",
  "grailed",
  "grailed-light",
  "system",
] as const;

/**
 * Cookie `Domain` for the current host: the registrable domain when we're on a
 * dashboard hostname (so every subdomain shares it), and NO domain attribute
 * anywhere else (`*.vercel.app` previews, `localhost`), where a domain-wide
 * cookie is either rejected or pointless.
 */
export function themeCookieDomain(hostname: string): string | null {
  const host = hostname.toLowerCase();
  return host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`)
    ? `.${ROOT_DOMAIN}`
    : null;
}

/**
 * Inline script that runs before next-themes' pre-hydration script: if the
 * shared cookie disagrees with this origin's `localStorage` (i.e. the theme was
 * last changed on a sibling subdomain), the cookie wins and is copied over, so
 * next-themes reads the up-to-date value on its very first pass.
 *
 * Kept tiny and fully defensive — any throw here would block first paint.
 */
export const THEME_COOKIE_SEED_SCRIPT = `(function(){try{
var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE_NAME}=([^;]*)/);
if(!m)return;
var t=decodeURIComponent(m[1]);
if(${JSON.stringify(THEME_COOKIE_VALUES)}.indexOf(t)===-1)return;
if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})!==t)localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)},t);
}catch(e){}})();`;
