"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { DURATION, EASE_STANDARD, EASE_OUT, prefersReducedMotion } from "@/components/ux";

/**
 * Thin animated bar at the very top of the viewport that flashes on
 * every route change. Gives admins a visible "the page is loading"
 * cue so slow navigations don't feel like dead clicks.
 *
 * Implementation detail: we can't know *exactly* when the server
 * started rendering (Next.js doesn't expose a client-side
 * navigation-start event in the App Router). We instead detect
 * pathname / searchParams changes, which fire the moment the new
 * route commits. Pairing that with a 0 -> 100% easing animation and
 * fade-out gives the classic nprogress feel without any deps.
 *
 * Timing + easing are sourced from the centralized motion system
 * (`@/components/ux`) so the bar feels coherent with every other
 * transition in the app. The width sweep uses the standard
 * linear-sweep ease; the fade-out uses the signature ease-out curve.
 *
 * Reduced-motion: users with `prefers-reduced-motion: reduce` should
 * not see a sweeping bar tween across the screen. We still surface a
 * brief commit cue (the bar appears at full width and fades) but drop
 * the width animation entirely — a quiet flash instead of a sweep.
 *
 * Z-index is above every card / dialog (100) so it's always visible.
 */
export function TopProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  // Read once on mount — the media query result is stable for the
  // session and re-reading it on every navigation would be wasteful.
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    setReduced(prefersReducedMotion());
  }, []);

  useEffect(() => {
    setVisible(true);

    if (reduced) {
      // Reduced motion: no sweep. Show the bar at full width as a quiet
      // commit cue, then fade it out — no width tween across the page.
      // Held a touch longer so it's clearly registered before fading.
      setProgress(100);
      const toHide = setTimeout(() => setVisible(false), 700);
      return () => clearTimeout(toHide);
    }

    setProgress(0);
    // Animation sequence: snap to a visible 40% immediately so the sweep
    // is obviously in motion, ease toward 90% (simulates "loading"), snap
    // to 100%, then fade out. Timings are stretched vs. the original so a
    // fast navigation still leaves the bar on screen long enough to read
    // instead of flashing away before the eye catches it.
    const frame = requestAnimationFrame(() => setProgress(40));
    const toEase = setTimeout(() => setProgress(90), 180);
    const toDone = setTimeout(() => setProgress(100), 520);
    const toHide = setTimeout(() => setVisible(false), 760);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(toEase);
      clearTimeout(toDone);
      clearTimeout(toHide);
    };
  }, [pathname, searchParams, reduced]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[100] h-[3px] overflow-visible"
      style={{
        width: `${progress}%`,
        opacity: visible ? 1 : 0,
        transition: reduced
          ? `opacity ${DURATION.base}ms ${EASE_OUT}`
          : `width ${DURATION.slow}ms ${EASE_STANDARD}, opacity ${DURATION.base}ms ${EASE_OUT}`,
      }}
    >
      {/* Flat matte bar — solid primary fill, NO gradient, NO glow, NO comet
          highlight. Owner asked to remove even more shine (2026-07-12), so the
          bar is now just a clean colored line with a rounded right cap. */}
      <div className="h-full w-full rounded-r-full bg-primary" />
    </div>
  );
}
