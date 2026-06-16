"use client";

import * as React from "react";
import { useRailWidget } from "@/components/right-rail-context";

// Mirror the dock widths from live-money-chat.tsx — keep in sync.
const PANEL_WIDTH_PX = 320; // an open panel
const COLLAPSED_TAB_WIDTH_PX = 56; // the collapsed edge tab

/**
 * Publishes the right rail's currently-occupied width to the
 * `--rail-occupied` CSS variable so the admin scroll container
 * (`[data-admin-scroll]`) can reserve exactly that much right-side space
 * at lg+ (see globals.css). When any docked widget is open the rail is a
 * full 320px panel; when they're all collapsed only their 56px edge tabs
 * remain. Reading the live rail state means the reserved gap shrinks back
 * to the tab width the moment the admin minimizes the panels — no wasted
 * 320px band, and content never hides under an open dock.
 *
 * Renders nothing; must live inside <RightRailProvider>.
 */
export function RailWidthSync() {
  const { allOpen, mounted } = useRailWidget("live");
  const anyOpen =
    (mounted.live && allOpen.live) ||
    (mounted.recent && allOpen.recent) ||
    (mounted.alerts && allOpen.alerts) ||
    (mounted.chat && allOpen.chat);
  const width = anyOpen ? PANEL_WIDTH_PX : COLLAPSED_TAB_WIDTH_PX;

  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--rail-occupied", `${width}px`);
    return () => {
      root.style.removeProperty("--rail-occupied");
    };
  }, [width]);

  return null;
}
