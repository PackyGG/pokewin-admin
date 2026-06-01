import Link from "next/link";
import { Trophy } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  getRakebackTopClaimers,
  type RakebackTopClaimerScope,
} from "@/lib/queries/insights-rewards/rakeback/top-claimers";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { RakebackTopScopeToggle } from "./top-claimers-scope-toggle";

/**
 * Top 25 rakeback claimers. Scope toggle between "period" (default —
 * top in current window) and "lifetime" (all-time top). Each row links
 * to /users/[id].
 *
 * House-POV: rakeback paid → rose tile colour for the leaderboard
 * amount; lifetime context column stays neutral.
 */
export async function TopClaimersTab({
  period,
  scope,
}: {
  period: InsightsRewardsPeriod;
  scope: RakebackTopClaimerScope;
}) {
  const rowsRes = await safeQuery(
    () => getRakebackTopClaimers(period, scope),
    [],
    "insights-rewards-rakeback.top-claimers",
  );
  if (rowsRes.error) {
    return (
      <TileErrorFallback
        label="Rakeback — Top claimers"
        hint="The top-claimers query failed."
        size="panel"
      />
    );
  }
  const rows = rowsRes.data;
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title="No rakeback claimers to rank"
          description="No rakeback claims in scope. Try a longer window or switch to Lifetime."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <SectionHeading
          icon={Trophy}
          title={`Top 25 by rakeback — ${scope === "lifetime" ? "Lifetime" : "Period"}`}
          action={<RakebackTopScopeToggle />}
        />
        <div className="mt-3 overflow-hidden rounded-2xl border bg-card">
          <div className="max-h-[36rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border/40">
                  <th className="w-[3rem] px-3 py-2 text-right">#</th>
                  <th className="px-3 py-2 text-left sm:px-5">User</th>
                  <th className="px-3 py-2 text-right">
                    {scope === "lifetime" ? "Lifetime rakeback" : "Period rakeback"}
                  </th>
                  <th className="px-3 py-2 text-right">Claims</th>
                  <th className="px-3 py-2 text-right">Avg / claim</th>
                  <th className="px-3 py-2 text-right">Lifetime $</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.userId}
                    className="border-t border-border/40 hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {i + 1}
                    </td>
                    <td className="px-3 py-2 sm:px-5">
                      <Link
                        href={`/users/${r.userId}`}
                        className="hover:underline"
                      >
                        {r.username ?? r.userId.slice(0, 10)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(r.totalRakeback)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(r.claimCount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCurrency(r.avgPerClaim)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(r.lifetimeRakeback)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
