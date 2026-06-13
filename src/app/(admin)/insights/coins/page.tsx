import { Suspense } from "react";
import { Coins } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { parseCoinsPeriod } from "@/lib/queries/insights-coins";
import { CoinsEconomySection } from "./coins-economy-section";

export const metadata = { title: "Coin & Shard Economy" };

/**
 * /insights/coins — the GLOBAL coin & shard secondary-currency economy.
 *
 * Two layers (see CoinsEconomySection):
 *   1. Supply snapshot (no period): shards + coin balance held in wallets,
 *      plus holder counts.
 *   2. Economy (active window only): the coin_transactions flow — earned vs
 *      spent, net house flow, per-type breakdown, a daily trend chart, and a
 *      sustainability read.
 *
 * The per-shards-page section (/rewards/shards) shows the same ledger as a
 * small panel; this is the global view that adds supply + the trend on top.
 *
 * Coins/shards are a SECONDARY, wager-earned currency — NOT USD. Counts &
 * balances render neutrally (cyan); the cash-adjacent flow signals follow
 * the house rule (spent = house in = emerald; earned/granted = house out =
 * rose).
 *
 * Active-timeframe-only: only the active window is fetched; switching the
 * period streams just that window via the period-keyed Suspense boundary.
 */
export default async function CoinsInsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  await requirePageAccess("/insights/coins");

  const { period: periodParam } = await searchParams;
  const period = parseCoinsPeriod(periodParam);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Coins}
          accent="cyan"
          title="Coin & Shard Economy"
          subtitle="Global view of the secondary, wager-earned currency — live wallet supply plus how coins & shards flow through games. Figures are in shards/coins, not USD."
        />
      </PageHero>

      {/* Period-keyed Suspense: switching the window streams just the active
          window's read (active-timeframe-only). The supply snapshot inside
          re-renders too, but it ignores the period. */}
      <Suspense
        key={period}
        fallback={
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[88px] animate-pulse rounded-xl border bg-muted/30"
                />
              ))}
            </div>
            <div className="h-9 w-40 animate-pulse rounded-lg bg-muted/30" />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[72px] animate-pulse rounded-xl border bg-muted/30"
                />
              ))}
            </div>
            <div className="h-80 animate-pulse rounded-2xl border bg-muted/30" />
          </div>
        }
      >
        <CoinsEconomySection period={period} />
      </Suspense>
    </div>
  );
}
