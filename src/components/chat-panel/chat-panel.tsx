"use client";

import { useState } from "react";
import { MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ChatPanelContent } from "./chat-panel-content";

/**
 * Slide-out chat & mutes panel, mounted once in the admin shell.
 *
 * The panel replaces the standalone /chat page. Chat and Mutes live in a
 * two-tab switcher at the top of the Sheet. Data fetching for each tab is
 * lazy — only the active tab runs its server action.
 *
 * The trigger is a floating action button in the bottom-right corner —
 * persistent and reachable from every admin page without competing with
 * the top bar.
 */
export function ChatPanel({ role }: { role: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        onClick={() => setOpen(true)}
        aria-label="Open chat and mutes panel"
        title="Chat & mutes"
        className="fixed right-6 bottom-6 z-40 size-14 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/30 ring-1 ring-white/10 transition-all hover:scale-105 hover:shadow-xl hover:shadow-blue-500/40 focus-visible:ring-2 focus-visible:ring-blue-400 [&_svg]:size-6"
      >
        <MessagesSquare />
      </Button>
      <SheetContent
        side="right"
        className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-md lg:max-w-2xl"
      >
        {/* Title + description are required by base-ui Dialog for a11y; we
            visually hide them because the custom header below owns the UI. */}
        <SheetTitle className="sr-only">Chat & Mutes</SheetTitle>
        <SheetDescription className="sr-only">
          Live chat feed, moderation actions, and the mute list.
        </SheetDescription>
        {/* Render content only while open so pollers / fetches don't run in
            the background when the panel is closed. */}
        {open && <ChatPanelContent role={role} />}
      </SheetContent>
    </Sheet>
  );
}
