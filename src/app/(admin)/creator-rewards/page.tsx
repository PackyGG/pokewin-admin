import { Suspense } from "react";
import { AlertTriangle, Gift } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { getClaims, getProgramsWithStats } from "@/lib/creator-vip/queries";

import { CreatorVipContent } from "./content";

export const metadata = { title: "Creator Rewards" };

/**
 * /creator-rewards — creator VIP wager-reward programs + the manual claim
 * review queue that pays them out.
 *
 * Promoted out of the /rewards tab hub to its own page: it is an operational
 * queue that staff work through, not a config surface like the tabs it used to
 * sit beside, and burying a review queue one tab deep hides work that needs
 * doing.
 *
 * Shell-first: the hero paints immediately and both reads stream in behind
 * their own Suspense boundary (see loading.tsx for the matching skeleton).
 */
export default async function CreatorRewardsPage() {
  await requirePageAccess("/creator-rewards");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Gift}
          accent="purple"
          title="Creator Rewards"
          subtitle="Wager-milestone programs per creator — and the claim requests waiting on review."
        />
      </PageHero>

      <Suspense fallback={<BodySkeleton />}>
        <Body />
      </Suspense>
    </div>
  );
}

function BodySkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-9 w-56 animate-pulse rounded-lg bg-muted" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-2xl border bg-muted/30"
        />
      ))}
    </div>
  );
}

function LoadNotice({ what }: { what: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        Couldn&apos;t load {what} — the list below may be incomplete. Refresh to
        try again.
      </span>
    </div>
  );
}

async function Body() {
  // Independent reads, degraded independently: a failing claims query must not
  // blank the programs table (and vice versa). `null` is the failure sentinel —
  // distinct from a successful read that genuinely found nothing.
  const [programs, claims] = await Promise.all([
    safeQueryOrNull(
      () => getProgramsWithStats(),
      "creator-vip.programs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQueryOrNull(
      () => getClaims({ limit: 200 }),
      "creator-vip.claims",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  return (
    <FadeIn>
      <div className="space-y-4">
        {programs.data === null && <LoadNotice what="the programs" />}
        {claims.data === null && <LoadNotice what="the claim requests" />}
        <CreatorVipContent
          programs={programs.data ?? []}
          claims={claims.data ?? []}
        />
      </div>
    </FadeIn>
  );
}
