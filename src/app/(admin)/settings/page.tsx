import { Settings as SettingsIcon } from "lucide-react";
import { getSettings } from "@/lib/queries/settings";
import { requirePageAccess } from "@/lib/dal";
import { SettingsContent } from "./settings-content";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requirePageAccess("/settings");
  const data = await getSettings();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={SettingsIcon}
          title="Settings"
          subtitle="Platform-wide configuration — rakeback, rewards, restrictions, and maintenance."
        />
      </PageHero>

      <FadeIn>
        <SettingsContent data={data} />
      </FadeIn>
    </div>
  );
}
