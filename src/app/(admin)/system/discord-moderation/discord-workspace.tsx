"use client";

import { Activity, ShieldCheck, TerminalSquare } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CommunityLevelRole } from "@/lib/discord-community-ranks";
import type { CommunityXpDashboard } from "@/lib/discord-community-xp";
import type { DiscordModerationSettings } from "@/lib/discord-moderation-settings";

import { DiscordCommunityXpCard } from "./discord-community-xp-card";
import { DiscordCommandsCard } from "./discord-commands-card";
import { DiscordModerationCard } from "./discord-moderation-card";

export function DiscordWorkspace({
  initialModeration,
  initialRoles,
  initialXpDashboard,
}: {
  initialModeration: DiscordModerationSettings;
  initialRoles: CommunityLevelRole[];
  initialXpDashboard: CommunityXpDashboard;
}) {
  return (
    <Tabs defaultValue="xp" className="gap-5">
      <TabsList>
        <TabsTrigger value="xp"><Activity /> XP &amp; ranks</TabsTrigger>
        <TabsTrigger value="moderation"><ShieldCheck /> Moderation</TabsTrigger>
        <TabsTrigger value="commands"><TerminalSquare /> Commands</TabsTrigger>
      </TabsList>
      <TabsContent value="xp">
        <DiscordCommunityXpCard initialRoles={initialRoles} dashboard={initialXpDashboard} />
      </TabsContent>
      <TabsContent value="moderation">
        <DiscordModerationCard initial={initialModeration} />
      </TabsContent>
      <TabsContent value="commands">
        <DiscordCommandsCard />
      </TabsContent>
    </Tabs>
  );
}
