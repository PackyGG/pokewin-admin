"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatPanelChat } from "./chat-panel-chat";
import { ChatPanelMutes } from "./chat-panel-mutes";

type Tab = "chat" | "mutes";

/**
 * Sheet inner UI: sticky header with the Chat/Mutes tab switcher and a
 * scrollable body that renders the active tab. Both tabs are mounted so
 * the chat poll state survives a tab switch, but data fetching is gated
 * on the parent `open` flag from ChatPanel.
 */
export function ChatPanelContent({ role }: { role: string }) {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab((v as Tab) ?? "chat")}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <h2 className="text-base font-semibold">Chat &amp; Mutes</h2>
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="mutes">Mutes</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
        <ChatPanelChat role={role} />
      </TabsContent>
      <TabsContent value="mutes" className="flex min-h-0 flex-1 flex-col">
        <ChatPanelMutes role={role} />
      </TabsContent>
    </Tabs>
  );
}
