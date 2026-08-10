import { FadeIn } from "@/components/fade-in";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePageAccess } from "@/lib/dal";
import { getDiscordModerationSettings } from "@/lib/discord-moderation-settings";
import { COMMUNITY_XP_GUILD_ID } from "@/lib/discord-community-ranks";
import {
  getCommunityXpDashboard,
  listCommunityLevelRoles,
} from "@/lib/discord-community-xp";

import { DiscordWorkspace } from "./discord-workspace";

export const metadata = { title: "Discord" };

export default async function DiscordModerationPage() {
  await requirePageAccess("/system/discord-moderation");
  const [settings, roles, xpDashboard] = await Promise.all([
    getDiscordModerationSettings(),
    listCommunityLevelRoles(COMMUNITY_XP_GUILD_ID),
    getCommunityXpDashboard(),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <FadeIn>
        <DiscordWorkspace
          initialModeration={settings}
          initialRoles={roles}
          initialXpDashboard={xpDashboard}
        />
      </FadeIn>
    </div>
  );
}
