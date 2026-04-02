import { requirePageAccess } from "@/lib/dal";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators";
import { LevelConfigCard } from "./level-config-card";

export default async function CreatorSettingsPage() {
  await requirePageAccess("/creators/settings");

  const configs = await getAffiliateLevelConfigs();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Creator Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure affiliate level tiers and commission rates.
        </p>
      </div>

      {configs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No level configurations found. Seed the database with initial level configs.
        </p>
      ) : (
        <LevelConfigCard configs={configs} />
      )}
    </div>
  );
}
