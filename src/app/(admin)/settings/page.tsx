import { getSettings } from "@/lib/queries/settings";
import { requirePageAccess } from "@/lib/dal";
import { SettingsContent } from "./settings-content";

export default async function SettingsPage() {
  await requirePageAccess("/settings");
  const data = await getSettings();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <SettingsContent data={data} />
    </div>
  );
}
