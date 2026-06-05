"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * Resets the admin shell's scroll position to the top whenever the *route*
 * (pathname) changes — the behaviour every multi-page app expects but that
 * the App Router does NOT give you for free when the scroll lives on an inner
 * container rather than `window`.
 *
 * Why this is needed here:
 *   The admin layout scrolls inside `div.flex-1.overflow-auto` (the
 *   `[data-admin-scroll]` element), NOT the document body. Next.js's built-in
 *   scroll restoration only knows how to reset `window`, so navigating from a
 *   long page (e.g. a deep user list) to another route would leave the inner
 *   container scrolled halfway down. This restores the "new page starts at the
 *   top" expectation.
 *
 * Why it keys on PATHNAME ONLY (not search params):
 *   Param-only updates — the dashboard `?period=`, tab `?tab=`, analytics
 *   `?period=` chips — intentionally pass `{ scroll: false }` to `router.replace`
 *   so the page does NOT jump while you flip a filter in place. If this hook
 *   also reacted to `useSearchParams()` it would yank those in-place updates
 *   back to the top, undoing that behaviour. Keying on `usePathname()` alone
 *   means: real navigations reset scroll; param-only updates are left untouched.
 *
 * Reduced-motion correctness:
 *   Uses `behavior: "auto"` (instant jump), never a smooth animated scroll.
 *   An instant reset is the right call for a route change regardless of the
 *   user's motion preference — there is nothing to animate, and a smooth
 *   scroll-to-top on every navigation would itself be unwanted motion.
 *
 * Renders nothing. It is a passive effect-only island mounted once inside the
 * layout, beside the scroll container.
 */
export function ScrollToTopOnNav() {
  const pathname = usePathname();

  // Run on pathname change. We deliberately depend on `pathname` only so
  // `?period=`/`?tab=` param-only navigations (which carry `scroll: false`)
  // never trigger a reset. `useLayoutEffect`-style timing isn't needed — the
  // new route's content has already committed by the time this runs, and an
  // instant scrollTop reset has no visible intermediate frame.
  React.useEffect(() => {
    const el = document.querySelector<HTMLElement>("[data-admin-scroll]");
    if (el) {
      el.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
  }, [pathname]);

  return null;
}
