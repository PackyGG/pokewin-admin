"use client";

import * as React from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatPanelContent } from "@/components/chat-panel/chat-panel-content";
import {
  chatTabAnchor,
  chatTopCss,
  COLLAPSED_CHAT_HEIGHT_REM,
  useRightRail,
} from "@/components/right-rail-context";

/**
 * Persistent docked Chat & Mutes widget on the right edge of the admin
 * shell, mirroring the `<LiveMoneyChat />` pattern. Reads `liveOpen`
 * from the shared right-rail context to position itself:
 *
 *   • Live OPEN   → chat occupies the BOTTOM HALF of the right edge.
 *   • Live CLOSED → chat slides UP to take the full right edge below
 *                   live's collapsed tab.
 *
 * Replaces the previous Sheet-based ChatPanel that lived behind a
 * floating action button. Both widgets are always visible (with
 * independent collapse/expand state). State persists via localStorage
 * through the shared context.
 */

const PANEL_WIDTH_PX = 320;

export function DockedChat({ role }: { role: string }) {
  const { liveOpen, chatOpen: open, setChatOpen: setOpen } = useRightRail();

  // Open panel: anchors with `top:` (derived from liveOpen — slides
  // up to fill the rail when live is collapsed).
  // Collapsed tab: anchors via `chatTabAnchor()` which switches to a
  // bottom-anchor when live is open, so the live panel can expand
  // DOWN into the space the chat panel used to occupy.
  const top = chatTopCss(liveOpen);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open chat & mutes panel"
        title="Open chat & mutes panel"
        style={{
          // Pin the tab's vertical height so the live panel can
          // compute its `bottom` without measuring the tab.
          height: `${COLLAPSED_CHAT_HEIGHT_REM}rem`,
          ...chatTabAnchor(liveOpen),
        }}
        className={cn(
          "fixed right-0 z-30 flex flex-col items-center justify-center gap-2 rounded-l-lg border border-r-0 bg-card/95 px-2 shadow-md backdrop-blur",
          "hover:bg-card transition-colors",
        )}
      >
        <MessagesSquare className="size-4 text-blue-500" />
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          style={{ writingMode: "vertical-rl" }}
        >
          Chat
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Chat & mutes panel"
      style={{ width: PANEL_WIDTH_PX, top }}
      className={cn(
        // Bottom half of the right edge when live is open. Slides up
        // to take more space when live is collapsed (the `top` value
        // does the work; `bottom-6` stays put). `z-30` sits above
        // normal content but below modals (z-50).
        "fixed right-0 bottom-6 z-30 flex flex-col overflow-hidden rounded-l-2xl border border-r-0 bg-card/95 shadow-xl backdrop-blur",
      )}
    >
      {/* Header — title + minimize chevron. Whole strip is the click
          target (mirrors LiveMoneyChat) so admins don't have to hit
          the small chevron. The chevron stays as the affordance cue. */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Minimize chat & mutes panel"
        title="Minimize"
        className="flex w-full items-center justify-between gap-2 border-b bg-gradient-to-r from-blue-500/5 via-card to-purple-500/5 px-3 py-2 text-left transition-colors hover:from-blue-500/10 hover:to-purple-500/10"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/10">
            <MessagesSquare className="size-3.5 text-blue-500" />
          </div>
          <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Chat &amp; Mutes
          </h3>
        </div>
        <span
          aria-hidden
          className="pointer-events-none rounded-md p-1 text-muted-foreground"
        >
          <ChevronRight className="size-3.5" />
        </span>
      </button>

      {/* ChatPanelContent owns the Chat/Mutes tab switcher + lazy
          data fetching. Wrap in a flex container so the inner Tabs
          can stretch to fill the available height. `min-h-0` lets
          the tab content area shrink properly inside the flex parent
          (so the inner scrolling list doesn't push the panel out). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChatPanelContent role={role} />
      </div>
    </aside>
  );
}
