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
 * The trigger is a fixed-position icon button in the top-right corner so
 * it coexists with the existing admin top bar without competing for space.
 */
export function ChatPanel({ role }: { role: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Open chat and mutes panel"
        title="Chat & mutes"
        className="fixed right-4 top-3 z-40 size-9 rounded-full border border-border/60 bg-background/80 shadow-sm backdrop-blur hover:bg-accent"
      >
        <MessagesSquare className="size-4" />
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
