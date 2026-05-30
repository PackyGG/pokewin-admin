"use client";

import * as React from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatPanelContent } from "@/components/chat-panel/chat-panel-content";

/**
 * Persistent docked Chat & Mutes widget on the right edge of the admin
 * shell, mirroring the `<LiveMoneyChat />` pattern. Takes the BOTTOM
 * half of the right rail — the LiveMoneyChat widget sits in the top
 * half. Both share the right edge from `top-20` (under the admin
 * header) to `bottom-6`, split at the viewport midpoint with a small
 * gap between them.
 *
 * Replaces the previous Sheet-based ChatPanel that lived behind a
 * floating action button in the corner. Both widgets are now always
 * visible (with independent collapse/expand state), per the same UX
 * pattern the live-money feed uses — admins watch both feeds while
 * they work on whatever page they're on.
 *
 * Collapse state persists across reloads via localStorage and travels
 * across admin pages, so an admin who minimized chat on one page
 * returns to a minimized chat on another.
 *
 * The inner Chat / Mutes tabs come from the same `<ChatPanelContent />`
 * the old Sheet used — no logic changes there, just a different
 * container.
 */

const PANEL_WIDTH_PX = 320;
const STORAGE_KEY = "docked-chat:open";

export function DockedChat({ role }: { role: string }) {
  // Default open. localStorage overrides on mount so a previously
  // minimized panel doesn't flash open during hydration.
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "0") setOpen(false);
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  // Collapsed: thin vertical tab anchored just below the (top-half)
  // LiveMoneyChat collapsed-tab slot. The vertical "Chat" label
  // mirrors the live-money tab's "Live" label so the two stack
  // cleanly when both are minimized.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open chat & mutes panel"
        title="Open chat & mutes panel"
        style={{ top: "calc(50vh + 0.25rem)" }}
        className={cn(
          "fixed right-0 z-30 flex flex-col items-center gap-2 rounded-l-lg border border-r-0 bg-card/95 px-2 py-3 shadow-md backdrop-blur",
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
      style={{
        width: PANEL_WIDTH_PX,
        // Bottom HALF of the right edge. `top` is the viewport midpoint
        // plus a small gap, mirroring the live-money widget's `bottom`.
        top: "calc(50vh + 0.25rem)",
      }}
      className={cn(
        "fixed right-0 bottom-6 z-30 flex flex-col overflow-hidden rounded-l-2xl border border-r-0 bg-card/95 shadow-xl backdrop-blur",
      )}
    >
      {/* Header — title + minimize chevron. Mirrors LiveMoneyChat's
          header styling so the two stacked panels read as a unit. */}
      <div className="flex items-center justify-between gap-2 border-b bg-gradient-to-r from-blue-500/5 via-card to-purple-500/5 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/10">
            <MessagesSquare className="size-3.5 text-blue-500" />
          </div>
          <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Chat &amp; Mutes
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Minimize chat & mutes panel"
          title="Minimize"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>

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
