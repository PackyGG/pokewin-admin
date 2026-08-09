import { FadeIn } from "@/components/fade-in";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePageAccess } from "@/lib/dal";
import { getDiscordModerationSettings } from "@/lib/discord-moderation-settings";

import { DiscordModerationCard } from "./discord-moderation-card";

export const metadata = { title: "Discord Moderation" };

export default async function DiscordModerationPage() {
  await requirePageAccess("/system/discord-moderation");
  const settings = await getDiscordModerationSettings();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <FadeIn>
        <DiscordModerationCard initial={settings} />
      </FadeIn>
    </div>
  );
}
