import { Settings } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators";
import { getSiteConfigValues } from "@/lib/queries/site-config";
import { LevelConfigCard } from "./level-config-card";
import { AffiliateExpirationCard } from "./affiliate-expiration-card";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Creator Settings" };

export default async function CreatorSettingsPage() {
  await requirePageAccess("/creators/settings");

  const [configs, siteConfig] = await Promise.all([
    getAffiliateLevelConfigs(),
    getSiteConfigValues(["affiliate_cut_expiration_days"]),
  ]);

  const expirationRaw = siteConfig["affiliate_cut_expiration_days"];
  const expirationDays =
    expirationRaw && expirationRaw.trim() !== "" ? Number(expirationRaw) : null;
  const initialDays =
    expirationDays !== null &&
    Number.isFinite(expirationDays) &&
    expirationDays > 0
      ? expirationDays
      : null;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Settings className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">
              Creator Settings
            </h1>
            <p className="text-sm text-muted-foreground">
              Configure affiliate level tiers, commission rates, and global
              affiliate policies.
            </p>
          </div>
        </div>
      </PageHero>

      <FadeIn className="space-y-6">
        <AffiliateExpirationCard initialDays={initialDays} />

        {configs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No level configurations found. Seed the database with initial level
            configs.
          </p>
        ) : (
          <LevelConfigCard configs={configs} />
        )}
      </FadeIn>
    </div>
  );
}
