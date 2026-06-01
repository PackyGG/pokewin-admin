import { BarChart3, Layers, Trophy, Users } from "lucide-react";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { AFFILIATE_LEVEL_COLORS } from "@/lib/constants";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getAffiliateTierDistribution } from "@/lib/queries/insights-rewards/affiliate/tier-distribution";
import { TierDistributionChart } from "./tier-distribution-chart";

/**
 * Tier Distribution — how many affiliates sit at each level (1–8).
 *
 * A tier is COMPUTED from the affiliate's lifetime referred wager
 * (`affiliate_accounts.total_wager_volume_usd`) against the
 * `affiliate_level_configs` threshold ladder — there is no stored level
 * column in prod (see the query helper's header for the full evidence).
 *
 * House-POV: the affiliate count is a neutral population metric (blue);
 * commission paid is money the house gives affiliates → rose. The
 * referred wager a tier generated is house-positive (we take the rake)
 * → emerald.
 */
export async function AffiliateTierDistributionTab() {
  const { data, error } = await safeQuery(
    () => getAffiliateTierDistribution(),
    null,
    "insights-rewards-affiliate.tier-distribution",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Tier Distribution"
        hint="The tier-distribution query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const { rows, totalAffiliates } = data;

  if (totalAffiliates === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Layers}
          title="No affiliates yet"
          description="No affiliate_accounts rows for non-staff users."
          compact
        />
      </div>
    );
  }

  // Most-populated tier (highest count; ties resolve to the lower level).
  const mostPopulated = rows.reduce((best, r) =>
    r.affiliateCount > best.affiliateCount ? r : best,
  );
  // Highest tier that has at least one affiliate.
  const highestPopulated = [...rows]
    .reverse()
    .find((r) => r.affiliateCount > 0);
  const totalCommissionPaid = rows.reduce(
    (a, r) => a + r.totalCommissionPaid,
    0,
  );

  const chartData = rows.map((r) => ({
    label: `L${r.level}`,
    affiliateCount: r.affiliateCount,
  }));

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Total affiliates"
            value={formatNumber(totalAffiliates)}
            sub="Non-staff, blacklist-excluded"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Most populated tier"
            value={`Level ${mostPopulated.level}`}
            sub={`${formatNumber(mostPopulated.affiliateCount)} affiliates · ${mostPopulated.sharePct.toFixed(1)}%`}
            icon={Layers}
            accent="blue"
          />
          <KpiTile
            label="Highest active tier"
            value={highestPopulated ? `Level ${highestPopulated.level}` : "—"}
            sub={
              highestPopulated
                ? `${formatNumber(highestPopulated.affiliateCount)} affiliate${highestPopulated.affiliateCount === 1 ? "" : "s"}`
                : "No affiliates"
            }
            icon={Trophy}
            accent="blue"
          />
          <KpiTile
            label="Commission paid"
            value={formatCurrency(totalCommissionPaid)}
            sub="Lifetime, all tiers"
            icon={BarChart3}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={BarChart3} title="Affiliates per tier" />
          <div className="rounded-2xl border bg-card p-3 sm:p-4">
            <TierDistributionChart data={chartData} />
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Layers} title="Tier breakdown" />
          <p className="text-xs text-muted-foreground">
            Tier is computed from each affiliate&apos;s lifetime referred
            wager (`affiliate_accounts.total_wager_volume_usd`) against the
            `affiliate_level_configs` threshold ladder — there is no stored
            level column in prod. Commission paid is settled lifetime
            payout (house cost → rose); referred wager is the cohort wager
            those affiliates generated (house-positive → emerald).
          </p>
          <div className="rounded-2xl border bg-card p-1.5 sm:p-2">
            {/* Mobile cards */}
            <div className="space-y-1.5 md:hidden">
              {rows.map((r) => (
                <div
                  key={r.level}
                  className="space-y-1.5 rounded-lg border bg-card px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge
                      variant="outline"
                      className={AFFILIATE_LEVEL_COLORS[r.level] ?? ""}
                    >
                      Level {r.level} — {r.label}
                    </Badge>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatNumber(r.affiliateCount)}
                      <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                        ({r.sharePct.toFixed(1)}%)
                      </span>
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                    <div className="text-muted-foreground">
                      Commission:{" "}
                      <span className="text-foreground">
                        {(r.commissionRate * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Threshold:{" "}
                      <span className="text-foreground">
                        {formatCurrency(r.threshold)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Referred wager:{" "}
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.totalReferredWager)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Paid:{" "}
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.totalCommissionPaid)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tier</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                    <TableHead className="text-right">Wager threshold</TableHead>
                    <TableHead className="text-right">Affiliates</TableHead>
                    <TableHead className="text-right">% of all</TableHead>
                    <TableHead className="text-right">Referred wager</TableHead>
                    <TableHead className="text-right">Commission paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.level}>
                      <TableCell className="font-medium">
                        <Badge
                          variant="outline"
                          className={AFFILIATE_LEVEL_COLORS[r.level] ?? ""}
                        >
                          Level {r.level} — {r.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {(r.commissionRate * 100).toFixed(0)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(r.threshold)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">
                        {formatNumber(r.affiliateCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.sharePct.toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.totalReferredWager)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.totalCommissionPaid)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
