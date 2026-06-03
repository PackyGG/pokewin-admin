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
      setProgress(100);
      const toHide = setTimeout(() => setVisible(false), 550);
      return () => clearTimeout(toHide);
    }

    setProgress(0);
    // Animation sequence: snap to 30% immediately so users see motion,
    // then ease toward 90% (simulates "loading"), snap to 100% on a
    // short delay, fade out cleanly.
    const frame = requestAnimationFrame(() => setProgress(30));
    const toEase = setTimeout(() => setProgress(85), 120);
    const toDone = setTimeout(() => setProgress(100), 350);
    const toHide = setTimeout(() => setVisible(false), 550);

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
      className="pointer-events-none fixed left-0 top-0 z-[100] h-[2px] bg-primary shadow-[0_0_8px_var(--color-primary)]"
      style={{
        width: `${progress}%`,
        opacity: visible ? 1 : 0,
        transition: reduced
          ? `opacity ${DURATION.base}ms ${EASE_OUT}`
          : `width ${DURATION.base}ms ${EASE_STANDARD}, opacity ${DURATION.base}ms ${EASE_OUT}`,
      }}
    />
  );
}
