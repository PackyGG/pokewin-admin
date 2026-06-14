"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Wallet } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

// At-a-glance status presentation, derived purely from the existing
// `statusKey` prop — no new data threaded across the RSC boundary.
const STATUS_META: Record<
  "active" | "locked" | "banned",
  { dot: string; text: string; label: string }
> = {
  active: {
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    label: "Active",
  },
  locked: {
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    label: "Locked",
  },
  banned: {
    dot: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-400",
    label: "Banned",
  },
};

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
      {/* Condensed sticky bar — a polished mini-header echoing the hero's
          design language (subtle blue/purple corner glow, soft border,
          backdrop blur, rounded-2xl). z above the tab bar (z-20) so it layers
          cleanly on top when both are sticky. Pointer-events off while hidden
          so it never blocks clicks on the content underneath.

          The scroll show/hide mechanics are untouched: it stays
          `sticky top-0`, toggles opacity / translate / pointer-events on
          `collapsed`, and fully collapses (h-0) when hidden. Transitions are
          gated behind `motion-reduce:` for reduced-motion users. */}
      <div
        aria-hidden={!collapsed}
        className={cn(
          "sticky top-0 z-30 -mx-1 mb-2 transition-all duration-200 motion-reduce:transition-none",
          collapsed
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-1 opacity-0 h-0 overflow-hidden m-0",
        )}
      >
        {collapsed && (
          <div className="relative overflow-hidden rounded-2xl border bg-card/80 shadow-sm ring-1 ring-black/[0.02] backdrop-blur-xl dark:ring-white/[0.04]">
            {/* Hero-matched corner glows — purely decorative, behind content. */}
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 size-40 rounded-full bg-blue-500/[0.07] blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -left-16 -bottom-16 size-40 rounded-full bg-purple-500/[0.06] blur-3xl"
            />

            <div className="relative flex items-center gap-3 px-3.5 py-2">
              {/* Identity — avatar + status dot, name, status sublabel. */}
              <div className="relative shrink-0">
                <Avatar className="size-8 ring-2 ring-background shadow-sm">
                  {avatarImage && <AvatarImage src={avatarImage} alt="" />}
                  <AvatarFallback className="text-[11px] font-semibold">
                    {avatarFallback}
                  </AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                    STATUS_META[statusKey].dot,
                  )}
                  aria-label={STATUS_META[statusKey].label}
                />
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold leading-tight">
                  {displayName}
                </p>
                <p
                  className={cn(
                    "text-[11px] font-medium leading-tight",
                    STATUS_META[statusKey].text,
                  )}
                >
                  {STATUS_META[statusKey].label}
                </p>
              </div>

              {/* Balance — labelled, right-aligned. Available balance is money
                  the user holds; emerald matches the hero's balance treatment. */}
              <div className="flex shrink-0 items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1">
                <Wallet
                  aria-hidden
                  className="size-3.5 shrink-0 text-emerald-500"
                />
                <div className="text-right leading-none">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Balance
                  </p>
                  <p className="mt-0.5 text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {balanceLabel}
                  </p>
                </div>
              </div>
            </div>
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
