import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import {
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { getClaims, getProgramsWithStats } from "@/lib/creator-vip/queries";

import { CreatorVipContent } from "../../../(admin)/creator-rewards/content";

export const metadata = { title: "Creator Rewards · Creator Hub" };

/**
 * Creator Hub → Creator Rewards.
 *
 * The Hub surface for the same wager-milestone reward programs + manual
 * claim-review queue as `/creator-rewards`. ONE data layer, ONE UI: it reuses
 * `getProgramsWithStats` / `getClaims` and the exact `CreatorVipContent`
 * client component the admin page renders, so the two surfaces cannot drift.
 * The server actions the content fires are the admin ones — no duplicate
 * mutation path — and they now revalidate BOTH paths.
 *
 * ── ACCESS (deliberately the admin page's gate, not just the Hub's) ────────
 * `requireCreatorHubPageAccess()` **and** `requirePageAccess("/creator-rewards")`.
 *
 * The Hub is reachable by non-admin roles via the per-role ADMIN-DB toggle,
 * and `creator`-role users hold real dashboard sessions. Gating this page on
 * Hub membership ALONE would show a creator the full claim queue (every
 * creator's pending payouts) on a page whose every button then throws — the
 * mutations in `creator-rewards/actions.ts` are `requireAdmin()` precisely so
 * a creator can't approve payouts against their own program. So the view gate
 * here matches the admin page exactly; the Hub check is additive, never a
 * loosening. The `requireAdmin()` write gate is untouched.
 *
 * Shell-first: both reads stream behind one Suspense boundary (loading.tsx
 * mirrors the skeleton), each degraded independently.
 */
export default async function CreatorHubRewardsPage() {
  await requireCreatorHubPageAccess();
  await requirePageAccess("/creator-rewards");

  return (
    <div className="space-y-6">
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
      "creator-hub.rewards.programs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQueryOrNull(
      () => getClaims({ limit: 200 }),
      "creator-hub.rewards.claims",
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
