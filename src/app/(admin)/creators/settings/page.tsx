import { Settings } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators";
import { getSiteConfigValues } from "@/lib/queries/site-config";
import { LevelConfigCard } from "./level-config-card";
import { AffiliateExpirationCard } from "./affiliate-expiration-card";
import { AffiliateClaimsWagerRequirementCard } from "./affiliate-claims-wager-requirement-card";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { getWagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";

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

  let affiliateClaimsWagerRequirementBps: number | null = null;
  try {
    const wagerDefaults = await getWagerRequirementDefaults();
    affiliateClaimsWagerRequirementBps =
      wagerDefaults.affiliate_wager_requirement_bps;
  } catch {
    affiliateClaimsWagerRequirementBps = null;
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Settings}
          title="Creator Settings"
          subtitle="Configure affiliate level tiers, commission rates, and global affiliate policies."
        />
      </PageHero>

      <FadeIn className="space-y-6">
        <AffiliateExpirationCard initialDays={initialDays} />

        <AffiliateClaimsWagerRequirementCard
          initialBps={affiliateClaimsWagerRequirementBps}
        />

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
