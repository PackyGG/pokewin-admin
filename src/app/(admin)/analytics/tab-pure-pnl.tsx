import { getPackBattlePurePnl } from "@/lib/queries/pnl";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { PackBattlePurePnl } from "@/components/pack-battle-pure-pnl";

/**
 * Dedicated tab for the Pack & Battle Pure P&L breakdown — same panel
 * the Overview tab also shows, but with its own page so admins can
 * deep-link / bookmark the pure-gambling-margin view without scrolling
 * past the realized-P&L and period-breakdown panels above it.
 *
 * The data fetch is independent of the Overview tab's so navigating
 * directly to ?tab=pure-pnl doesn't pay for the realized PnL +
 * windowed PnL queries the Overview needs.
 */
export async function PurePnlTab() {
  const { data, error } = await safeQuery(
    () => getPackBattlePurePnl(),
    null,
    "analytics.purePnl",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Pack & Battle raw P&L"
        hint="The pure P&L query failed — refresh to retry."
        size="panel"
      />
    );
  }
  return (
    <div className="space-y-6">
      <FadeIn>
        <PackBattlePurePnl data={data} />
      </FadeIn>
    </div>
  );
}
