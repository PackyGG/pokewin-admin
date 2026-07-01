"use client";

import * as React from "react";

// Mirror the dock widths from live-money-chat.tsx — keep in sync.
// The collapsed edge tab is the ONLY width the page layout reserves. An
// open panel (320px) floats OVER the content as an overlay (fixed, z-30);
// it never widens the reserved gutter, so opening/closing a dock does not
// reflow the page — see below.
const COLLAPSED_TAB_WIDTH_PX = 56; // the collapsed edge tab

/**
 * Publishes the right rail's reserved width to the `--rail-occupied` CSS
 * variable so the admin scroll container (`[data-admin-scroll]`) reserves
 * exactly that much right-side space at lg+ (see globals.css).
 *
 * The reserved width is CONSTANT — it always equals the collapsed edge-tab
 * width (56px). The always-present tabs sit flush in that reserved gutter,
 * so there is no empty white column. When the admin expands a dock the
 * 320px panel is `position: fixed; right: 0` and simply OVERLAYS the page
 * on top of the content (z-30) — it does NOT grow the reserved gutter.
 * Keeping this value fixed is what stops opening/closing a panel from
 * shifting the page layout sideways (the old behavior toggled the gutter
 * between 56px and 320px on every open, reflowing all content).
 *
 * Static now, but kept as a component (rather than a hard-coded CSS var)
 * so the reserved width stays colocated with the dock width constants and
 * can react to future per-viewport tab sizing without touching globals.css.
 *
 * Renders nothing; must live inside <RightRailProvider>.
 */
export function RailWidthSync() {
  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--rail-occupied", `${COLLAPSED_TAB_WIDTH_PX}px`);
    return () => {
      root.style.removeProperty("--rail-occupied");
    };
  }, []);

  return null;
}
