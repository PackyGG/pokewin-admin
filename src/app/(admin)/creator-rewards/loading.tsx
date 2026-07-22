import { Gift } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";

/**
 * Route-level skeleton. Renders the SAME hero the page does so navigating in
 * paints the real header immediately and only the queue below swaps in — no
 * layout jump between this and the loaded page.
 */
export default function Loading() {
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

      <div className="space-y-4">
        <div className="h-9 w-56 animate-pulse rounded-lg bg-muted" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-2xl border bg-muted/30"
          />
        ))}
      </div>
    </div>
  );
}
