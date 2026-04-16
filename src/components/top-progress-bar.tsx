"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

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
 * Z-index is above every card / dialog (100) so it's always visible.
 */
export function TopProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(true);
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
  }, [pathname, searchParams]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[100] h-[2px] bg-primary shadow-[0_0_8px_var(--color-primary)]"
      style={{
        width: `${progress}%`,
        opacity: visible ? 1 : 0,
        transition:
          "width 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease-out",
      }}
    />
  );
}
