import { getSettings } from "@/lib/queries/settings";
import { requirePageAccess } from "@/lib/dal";
import { SettingsContent } from "./settings-content";
import { MaintenanceModeCard } from "./maintenance-mode-card";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requirePageAccess("/settings");
  const data = await getSettings();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <MaintenanceModeCard
        initialEnabled={data.maintenance.enabled}
        initialMessage={data.maintenance.message}
      />
      <SettingsContent data={data} />
    </div>
  );
}
