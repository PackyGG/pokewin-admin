import { getPackBattlePurePnl } from "@/lib/queries/pnl";
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
  const data = await getPackBattlePurePnl();
  return (
    <div className="space-y-6">
      <FadeIn>
        <PackBattlePurePnl data={data} />
      </FadeIn>
    </div>
  );
}
