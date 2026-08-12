import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators";
import { getSiteConfigValues } from "@/lib/queries/site-config";
import { LevelConfigCard } from "../creators/settings/level-config-card";
import { AffiliateExpirationCard } from "../creators/settings/affiliate-expiration-card";
import { AffiliateClaimsWagerRequirementCard } from "../creators/settings/affiliate-claims-wager-requirement-card";
import { FadeIn } from "@/components/fade-in";
import { getWagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";

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

/**
 * Inline "couldn't load" band — mirrors the amber notice the sibling tabs
 * render when a safeQuery-wrapped read fails, so a slow / failing affiliate
 * config read degrades to a per-tab notice instead of throwing to the /rewards
 * route error boundary (which blanks the WHOLE hub).
 */
function AffiliateLoadErrorBand() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
    >
      <AlertTriangle
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-500"
      />
      <p className="text-xs text-amber-700 dark:text-amber-300">
        Couldn&apos;t load affiliate config — the query timed out or failed.
        This is a{" "}
        <span className="font-medium">request error, not zero results</span>.
        Refresh to retry.
      </p>
    </div>
  );
}

async function AffiliateBody() {
  // safeQuery so a slow / failing affiliate-config read degrades to an inline
  // band instead of throwing up the /rewards route boundary (which blanks the
  // WHOLE hub). Fallbacks: empty level-config list + empty site-config map.
  const [
    { data: configs, error: configsError },
    { data: siteConfig, error: siteConfigError },
    { data: wagerDefaults },
  ] = await Promise.all([
    safeQuery(
      () => getAffiliateLevelConfigs(),
      [] as Awaited<ReturnType<typeof getAffiliateLevelConfigs>>,
      "affiliate.levelConfigs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getSiteConfigValues(["affiliate_cut_expiration_days"]),
      {} as Awaited<ReturnType<typeof getSiteConfigValues>>,
      "affiliate.siteConfig",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    // The wager-requirement default is a backend HTTP read. It used to be
    // awaited AFTER the two reads above had resolved, so the tab paid for two
    // round trips end to end; nothing here depends on the other two, so it
    // joins the same batch. Its failure still degrades to `null` (the card
    // renders its own unset state) rather than taking the tab down.
    safeQuery(
      () => getWagerRequirementDefaults(),
      null as Awaited<ReturnType<typeof getWagerRequirementDefaults>> | null,
      "affiliate.wagerRequirementDefaults",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  if (configsError !== null || siteConfigError !== null) {
    return <AffiliateLoadErrorBand />;
  }

  const expirationRaw = siteConfig["affiliate_cut_expiration_days"];
  const expirationDays =
    expirationRaw && expirationRaw.trim() !== "" ? Number(expirationRaw) : null;
  const initialDays =
    expirationDays !== null &&
    Number.isFinite(expirationDays) &&
    expirationDays > 0
      ? expirationDays
      : null;

  const affiliateClaimsWagerRequirementBps: number | null =
    wagerDefaults?.affiliate_wager_requirement_bps ?? null;

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
