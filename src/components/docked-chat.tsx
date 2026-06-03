"use client";

import * as React from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatPanelContent } from "@/components/chat-panel/chat-panel-content";
import {
  railSlotStyle,
  useRailWidget,
} from "@/components/right-rail-context";
import { useMounted } from "@/hooks/use-mounted";

/**
 * Persistent docked Chat & Mutes widget on the right edge of the admin
 * shell — bottom slot of the right rail. The other two widgets (Live
 * money feed at the top, Recent activity in the middle) reflow when
 * this one is collapsed; the at-most-2-open rule (enforced inside
 * RightRailProvider) auto-collapses the oldest-opened panel when the
 * user expands a third.
 *
 * Replaces the previous Sheet-based ChatPanel that lived behind a
 * floating action button. All three widgets are always visible (with
 * independent collapse/expand state). State persists via localStorage
 * through the shared context.
 */

const PANEL_WIDTH_PX = 320;

export function DockedChat({ role }: { role: string }) {
  const { open, setOpen, allOpen, mounted } = useRailWidget("chat");
  // `false` on the server render AND the first client paint, `true` after mount.
  // The docked chat defaults to OPEN (DEFAULT_OPEN.chat), so its body is part of
  // the SSR markup. That body — <ChatPanelContent>'s base-ui <Tabs> (Chat/Mutes
  // triggers + the active tabpanel) and the search <Input> — derives its element
  // `id`s from React `useId()` through base-ui's composite-list internals, and
  // the SSR pass and the first client render allocate DIFFERENT `useId` values
  // for those nodes. The id/aria attributes therefore disagree on hydration,
  // which React reports as a recoverable hydration mismatch — minified React
  // error #418 (args[]=HTML) in production — and it fires on EVERY admin page
  // because the chat dock lives in the always-rendered shell (admin role).
  // base-ui's <Menu> (the header profile dropdown) does NOT hit this, so it's
  // specific to the Tabs/Field composite components painting at first load.
  //
  // Fix: keep the SSR-shaped open <aside> (chrome + a deterministic placeholder
  // body) byte-identical between the server and the first client paint, and only
  // mount the interactive ChatPanelContent AFTER hydration. The Tabs/Input then
  // mount fresh on the client and never hydrate against the server HTML, so no
  // id can diverge. The panel already bootstraps its messages in an effect
  // (shows a skeleton first), so deferring its mount by one tick is invisible.
  const mountedAfterHydration = useMounted();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open chat & mutes panel"
        title="Open chat & mutes panel"
        style={railSlotStyle("chat", allOpen, mounted)}
        className={cn(
          "fixed right-0 z-30 flex flex-col items-center justify-center gap-2 rounded-l-lg border border-r-0 bg-card/95 px-2 shadow-md backdrop-blur",
          "hover:bg-card transition-colors",
        )}
      >
        <MessagesSquare className="size-4 text-blue-500" />
        <span
          className="font-mono text-[10px] font-semibold uppercase leading-none tracking-wider text-muted-foreground"
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
      style={{ width: PANEL_WIDTH_PX, ...railSlotStyle("chat", allOpen, mounted) }}
      className={cn(
        // Bottom slot of the right rail. The `top` / `bottom` anchors
        // come from `railSlotStyle` and depend on the open/collapsed
        // state of the two widgets above (live + recent activity).
        // `z-30` sits above normal content but below modals (z-50).
        "fixed right-0 z-30 flex flex-col overflow-hidden rounded-l-2xl border border-r-0 bg-card/95 shadow-xl backdrop-blur",
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
          (so the inner scrolling list doesn't push the panel out).

          Mounted only AFTER hydration (see `mountedAfterHydration` above):
          on the server + first client paint we render a deterministic
          placeholder so the markup matches byte-for-byte; the base-ui
          Tabs/Input then mount fresh on the client without hydrating, so
          their `useId`-derived ids can't diverge (the #418 source). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {mountedAfterHydration ? (
          <ChatPanelContent role={role} />
        ) : (
          <div
            className="flex-1"
            aria-hidden
            // Matches the server markup exactly (an empty flex body) so the
            // first client paint is identical to SSR. The real panel swaps in
            // one tick later; it shows its own loading skeleton while it
            // bootstraps, so there is no visible flash.
          />
        )}
      </div>
    </aside>
  );
}
