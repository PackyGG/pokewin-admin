import { Settings as SettingsIcon } from "lucide-react";
import { getSettings } from "@/lib/queries/settings";
import { requirePageAccess, sessionIsAdmin, verifySession } from "@/lib/dal";
import { getMainDbEnvDisplay } from "@/lib/db-env-display";
import { SettingsContent } from "./settings-content";
import { DbEnvSettingsCard } from "./db-env-settings-card";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requirePageAccess("/settings");
  const [data, session] = await Promise.all([
    getSettings(),
    verifySession(),
  ]);
  const mainDbDisplay = sessionIsAdmin(session)
    ? await getMainDbEnvDisplay()
    : null;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={SettingsIcon}
          title="Settings"
          subtitle="Platform-wide configuration — rakeback, rewards, restrictions, and maintenance."
        />
      </PageHero>

      {mainDbDisplay ? (
        <FadeIn>
          <DbEnvSettingsCard display={mainDbDisplay} />
        </FadeIn>
      ) : null}

      <FadeIn>
        <SettingsContent data={data} />
      </FadeIn>
    </div>
  );
}
