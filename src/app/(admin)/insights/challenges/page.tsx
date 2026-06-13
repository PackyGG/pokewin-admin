import { Suspense } from "react";
import { Trophy } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  parseChallengesPeriod,
  type ChallengesPeriod,
} from "@/lib/queries/insights-challenges";
import { ChallengesPeriodFilter } from "./_components/period-filter";
import { ChallengesContent } from "./_components/challenges-content";
import { ChallengesContentSkeleton } from "./_components/content-skeleton";

export const metadata = { title: "Challenges Insights" };

/**
 * /insights/challenges — challenges analytics (the /challenges page is
 * CRUD-only; this is the analytics surface that sits on top of it).
 *
 * Shows:
 *   - Overview KPIs: total / active challenges, total prize cost (sum of
 *     `challenge_prize` ledger rows = house cost), total claims, avg claims
 *     per challenge, overall completion rate (Σ claimed / Σ max).
 *   - A period-scoped daily prize-cost area chart (customer-scoped ledger
 *     aggregate; 24h / 7d / 30d / all, active-window-only).
 *   - A current-state per-challenge table (name, type, status, prize,
 *     claims / max + completion %, created), sortable by cost or claims.
 *
 * House-POV (strict): a challenge prize is money paid TO users → a house
 * cost → rose. Counts / rates are neutral blue / cyan.
 *
 * Active-timeframe-only: only the selected window's series is fetched.
 * The `<Suspense key={period}>` boundary re-renders the skeleton on a
 * period flip instead of stalling on stale numbers.
 */
export default async function ChallengesInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/challenges");
  const params = await searchParams;
  const period: ChallengesPeriod = parseChallengesPeriod(params.period);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Trophy}
            accent="rose"
            title="Challenges Insights"
            subtitle="Challenge prize cost, claims, and completion analytics — house-POV cost view."
          />
          <ChallengesPeriodFilter />
        </div>
      </PageHero>

      <Suspense key={period} fallback={<ChallengesContentSkeleton />}>
        <ChallengesContent period={period} />
      </Suspense>
    </div>
  );
}
