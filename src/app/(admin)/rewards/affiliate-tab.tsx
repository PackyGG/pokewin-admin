import { Suspense } from "react";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators";
import { getSiteConfigValues } from "@/lib/queries/site-config";
import { LevelConfigCard } from "../creators/settings/level-config-card";
import { AffiliateExpirationCard } from "../creators/settings/affiliate-expiration-card";
import { AffiliateClaimsWagerRequirementCard } from "../creators/settings/affiliate-claims-wager-requirement-card";
import { FadeIn } from "@/components/fade-in";
import { getWagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";

/**
 * Affiliate tab of the merged /rewards page — affiliate tier / commission
 * config. Reuses the components from /creators/settings, which is KEPT as a
 * live route + permission key because its server actions
 * (affiliate-claims-wager-requirement-actions, creators/actions,
 * security/wager-requirement-actions) still gate/revalidate on
 * "/creators/settings". Only the standalone Rewards nav entry was removed.
 *
 * The reads run behind this tab's own Suspense (active-tab-only) — the hub
 * shell paints immediately and this content streams in.
 */
export function AffiliateTab() {
  return (
    <Suspense
      key="affiliate"
      fallback={
        <div className="space-y-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-2xl border bg-muted/30"
            />
          ))}
        </div>
      }
    >
      <AffiliateBody />
    </Suspense>
  );
}

async function AffiliateBody() {
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
  );
}
