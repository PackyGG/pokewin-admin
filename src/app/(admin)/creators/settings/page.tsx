import { Suspense } from "react";

import { requirePageAccess } from "@/lib/dal";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators";
import { getSiteConfigValues } from "@/lib/queries/site-config";
import { LevelConfigCard } from "./level-config-card";
import { AffiliateExpirationCard } from "./affiliate-expiration-card";
import { AffiliateClaimsWagerRequirementCard } from "./affiliate-claims-wager-requirement-card";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import {
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { getWagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";

export const metadata = { title: "Creator Settings" };

export default async function CreatorSettingsPage() {
  await requirePageAccess("/creators/settings");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      {/* Shell-first: the hero paints immediately and the three reads (two
          admin/main DB, one backend HTTP) resolve behind this boundary. The
          fallback reuses the exact shapes from this route's loading.tsx so a
          cold navigation and a client-side nav look identical. */}
      <Suspense
        fallback={
          <div className="space-y-6">
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-96 rounded-2xl" />
          </div>
        }
      >
        <CreatorSettingsBody />
      </Suspense>
    </div>
  );
}

async function CreatorSettingsBody() {
  // All three reads are independent, so they run in ONE wave instead of the
  // old two-wave waterfall (Promise.all → then a separate await). The backend
  // leg is the one that used to have no timeout at all on this path; it is now
  // bounded and still degrades to `null` (the previous try/catch behaviour) so
  // the card renders its "unavailable" state instead of failing the page.
  const [configs, siteConfig, wagerDefaults] = await Promise.all([
    getAffiliateLevelConfigs(),
    getSiteConfigValues(["affiliate_cut_expiration_days"]),
    safeQueryOrNull(
      () => getWagerRequirementDefaults(),
      "creators.settings.wagerDefaults",
      REWARD_QUERY_TIMEOUT_MS,
    ),
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

  const affiliateClaimsWagerRequirementBps =
    wagerDefaults.data?.affiliate_wager_requirement_bps ?? null;

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
