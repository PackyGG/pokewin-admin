"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Scroll-collapse wrapper for the user-detail hero.
 *
 * Renders the full hero, then — once the hero scrolls out of view — reveals
 * a thin sticky top bar with just the essentials (avatar + name + balance).
 * The bar sits ABOVE the existing sticky tab bar's z-index so it never
 * fights it, and it's purely additive: the tab bar's own sticky behavior is
 * untouched.
 *
 * Detection uses a single IntersectionObserver on a zero-height sentinel
 * placed right after the hero. No scroll listener, no layout thrash. When
 * the sentinel leaves the scroll container (hero scrolled past), the
 * condensed bar fades in; scrolling back up hides it again.
 *
 * IMPORTANT: in the admin shell the page does NOT scroll the window — content
 * scrolls inside an inner `overflow-auto` container (the admin layout's
 * `[data-admin-scroll]` region). A viewport-rooted observer (`root: null`)
 * therefore never fires for this content, which is why the bar previously
 * never appeared. We resolve the nearest scrollable ancestor at mount and use
 * it as the observer `root` (falling back to the documented
 * `[data-admin-scroll]` container, then to the viewport when content genuinely
 * scrolls the window).
 *
 * Reduced-motion: the fade/slide transition is gated behind `motion-reduce:`,
 * so reduced-motion users get an instant show/hide with no animation.
 */
function findScrollParent(start: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = start?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    const oy = window.getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}
export function UserHeroSticky({
  hero,
  avatarImage,
  avatarFallback,
  displayName,
  balanceLabel,
  statusKey,
}: {
  /** The full hero, rendered as-is at the top. */
  hero: React.ReactNode;
  avatarImage: string | null;
  avatarFallback: string;
  displayName: string;
  /** Pre-formatted balance string shown in the condensed bar. */
  balanceLabel: string;
  statusKey: "active" | "locked" | "banned";
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (
      !el ||
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    // Resolve the actual scroll container: nearest scrollable ancestor →
    // the documented admin-shell scroll region → null (viewport/window).
    const root =
      findScrollParent(el) ??
      (document.querySelector("[data-admin-scroll]") as HTMLElement | null);

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Sentinel scrolled above the top of the scroll container → hero is
        // scrolled past → show the condensed bar. `top < 0` is measured in
        // viewport coords for both root: element and root: null, so the
        // comparison holds either way.
        setCollapsed(
          !entry.isIntersecting && entry.boundingClientRect.top < 0,
        );
      },
      { root, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {/* Condensed sticky bar — z above the tab bar (z-20) so it layers
          cleanly on top when both are sticky. Pointer-events off while
          hidden so it never blocks clicks on the content underneath. */}
      <div
        aria-hidden={!collapsed}
        className={cn(
          "sticky top-0 z-30 -mx-1 mb-2 rounded-xl border bg-card/90 px-3 py-2 backdrop-blur-md transition-all duration-200 motion-reduce:transition-none",
          collapsed
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-1 opacity-0 h-0 overflow-hidden border-transparent p-0 m-0",
        )}
      >
        {collapsed && (
          <div className="flex items-center gap-2.5">
            <div className="relative shrink-0">
              <Avatar className="size-7 ring-1 ring-background">
                {avatarImage && <AvatarImage src={avatarImage} alt="" />}
                <AvatarFallback className="text-[10px] font-semibold">
                  {avatarFallback}
                </AvatarFallback>
              </Avatar>
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-background",
                  statusKey === "active" && "bg-emerald-500",
                  statusKey === "locked" && "bg-amber-500",
                  statusKey === "banned" && "bg-rose-500",
                )}
              />
            </div>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-none">
              {displayName}
            </span>
            <span className="shrink-0 text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {balanceLabel}
            </span>
          </div>
        )}
      </div>

      {hero}

      {/* Zero-height sentinel: when it scrolls above the viewport the
          condensed bar appears. Sits right after the hero. */}
      <div ref={sentinelRef} aria-hidden className="h-0" />
    </>
  );
}
