import { Suspense } from "react";
import { Sparkles } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { parseXpSalesPeriod } from "@/lib/queries/insights-xp-sales";
import { XpSalesSection } from "./xp-sales-section";

export const metadata = { title: "XP Sales" };

/**
 * /xp-sales — the GLOBAL XP-sales view.
 *
 * Every `xp_purchase` ledger row is a user spending their own (withdrawable)
 * USD balance to buy XP. This page rolls those up over the active window: a
 * KPI strip (sales, revenue, buyers, avg/sale), a daily revenue trend, and a
 * recent-sales list.
 *
 * House-POV: buying XP gives up a dollar we owed the user → a house gain →
 * the revenue figure reads emerald. Customer-scoped (staff + creators dropped
 * via getMetricsScope), drift-guarded on the `xp_purchase` enum member.
 *
 * Active-timeframe-only: only the active window is fetched; switching the
 * period streams just that window via the period-keyed Suspense boundary.
 */
export default async function XpSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  await requirePageAccess("/xp-sales");

  const { period: periodParam } = await searchParams;
  const period = parseXpSalesPeriod(periodParam);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Sparkles}
          accent="emerald"
          title="XP Sales"
          subtitle="Every XP purchase across the platform — users spending their own withdrawable balance to buy XP. Revenue is shown from the house perspective (a house gain)."
        />
      </PageHero>

      {/* Period-keyed Suspense: switching the window streams just the active
          window's read (active-timeframe-only). */}
      <Suspense
        key={period}
        fallback={
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[88px] animate-pulse rounded-xl border bg-muted/30"
                />
              ))}
            </div>
            <div className="h-80 animate-pulse rounded-2xl border bg-muted/30" />
            <div className="h-64 animate-pulse rounded-2xl border bg-muted/30" />
          </div>
        }
      >
        <XpSalesSection period={period} />
      </Suspense>
    </div>
  );
}
