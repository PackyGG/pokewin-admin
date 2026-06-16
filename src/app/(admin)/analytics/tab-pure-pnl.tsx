import { getPackBattlePurePnl } from "@/lib/queries/pnl";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { PackBattlePurePnl } from "@/components/pack-battle-pure-pnl";
import { comparePurePnl } from "@/lib/clickhouse/compare/pure-pnl";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getPackBattlePurePnlFromClickHouse } from "@/lib/clickhouse/queries/analytics/pure-pnl";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

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
    () =>
      resolveAdminRead<Awaited<ReturnType<typeof getPackBattlePurePnl>>>(
        "pure_pnl",
        {
          pg: () => getPackBattlePurePnl(),
          ch: async () =>
            getPackBattlePurePnlFromClickHouse(await getExcludedUserIds()),
        },
      ),
    null,
    "analytics.purePnl",
    REWARD_QUERY_TIMEOUT_MS,
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
  // Fire-and-forget ClickHouse comparison (no-op unless the `pure_pnl` surface
  // is in comparison mode). Never affects the served Postgres payload.
  void comparePurePnl(data);
  return (
    <div className="space-y-6">
      <FadeIn>
        <PackBattlePurePnl data={data} />
      </FadeIn>
    </div>
  );
}
