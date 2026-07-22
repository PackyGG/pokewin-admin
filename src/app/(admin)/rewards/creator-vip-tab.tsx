import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";

import { FadeIn } from "@/components/fade-in";
import {
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { getClaims, getProgramsWithStats } from "@/lib/creator-vip/queries";

import { CreatorVipContent } from "./creator-vip-content";

/**
 * Creator VIP tab of the /rewards hub — "wager $X under my code, get $Y"
 * programs plus the manual claim-review queue that pays them out.
 *
 * Active-tab-only: both reads sit behind this tab's own Suspense boundary, so
 * the hub shell paints immediately and a slow admin-DB read never blocks the
 * other nine tabs (CLAUDE.md).
 */
export function CreatorVipTab() {
  return (
    <Suspense
      key="creator-vip"
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
      <CreatorVipBody />
    </Suspense>
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

async function CreatorVipBody() {
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
