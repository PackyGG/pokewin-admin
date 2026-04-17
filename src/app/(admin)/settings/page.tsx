import { Settings as SettingsIcon } from "lucide-react";
import { getSettings } from "@/lib/queries/settings";
import { requirePageAccess } from "@/lib/dal";
import { SettingsContent } from "./settings-content";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requirePageAccess("/settings");
  const data = await getSettings();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <SettingsIcon className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Platform-wide configuration — rakeback, rewards, restrictions,
              and maintenance.
            </p>
          </div>
        </div>
      </PageHero>

      <FadeIn>
        <SettingsContent data={data} />
      </FadeIn>
    </div>
  );
}
