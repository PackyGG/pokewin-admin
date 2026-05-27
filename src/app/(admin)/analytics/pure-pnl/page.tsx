import { Coins } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getPackBattlePurePnl } from "@/lib/queries/pnl";
import { AutoRefresh } from "../../dashboard/auto-refresh";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { PackBattlePurePnl } from "@/components/pack-battle-pure-pnl";

export const metadata = { title: "Raw P&L" };

/**
 * Standalone admin page for the Pack & Battle Raw P&L breakdown.
 *
 * "Raw" = real-money plays only. Creators are excluded (their plays
 * are house-funded promo / stream content), and every borrow-mode
 * play is dropped (the borrowed leg never reaches the ledger amount
 * and the borrowed cards never reach inventory net of auto-resale —
 * counting them would distort margin).
 *
 * Mirrors the panel that lives inside Analytics → Overview, but as
 * its own dedicated route so admins who only need this view can
 * bookmark it and skip the full Overview tab's other panels (which
 * carry the realized snapshot, period P&L breakdown, and KPI strip).
 *
 * Data fetch is identical to the analytics tab variant — same
 * staff + blacklist + creator + borrow exclusions, same windows
 * (24h / 3d / 7d / lifetime). Cached per-request via the existing
 * getPackBattlePurePnl `withTiming` wrapper.
 */
export default async function PurePnlPage() {
  await requirePageAccess("/analytics/pure-pnl");
  const data = await getPackBattlePurePnl();

  return (
    <div className="space-y-6">
      {/* Same 5-min refresh cadence as Analytics — the underlying
          inventory + ledger numbers don't move second-to-second. */}
      <AutoRefresh intervalMs={300_000} />
      <PageHero>
        <PageHeroIdentity
          icon={Coins}
          accent="cyan"
          title="Raw P&L"
          subtitle="Real-money plays only — the stats we actually make money from. Excludes creator wagers (house-funded promo), borrow-mode plays (both wager and won inventory), and every reward surface (bonuses / rakeback / upgrader / rain / race / leaderboard prizes)."
        />
      </PageHero>

      <FadeIn>
        <PackBattlePurePnl data={data} />
      </FadeIn>
    </div>
  );
}
