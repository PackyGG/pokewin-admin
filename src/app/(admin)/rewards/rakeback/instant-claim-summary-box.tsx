import Link from "next/link";
import { AlertTriangle, Percent, Users, Zap } from "lucide-react";
import { KpiTile } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  INSTANT_CLAIM_PERIODS,
  instantClaimPeriodLabel,
  type InstantClaimPeriod,
  type InstantClaimUsage,
} from "@/lib/queries/rakeback-instant-claim";

function pct01(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function buildClaimsPeriodHref(
  period: InstantClaimPeriod,
  type?: string,
): string {
  const params = new URLSearchParams({ tab: "claims", icPeriod: period });
  if (type && type !== "all") params.set("type", type);
  return `/rewards/rakeback?${params.toString()}`;
}

/**
 * Compact instant-claim KPI strip for the Claims tab — house fee saved,
 * distinct users, and instant share of claims.
 */
export function InstantClaimSummaryBox({
  usage,
  period,
  claimType,
}: {
  usage: InstantClaimUsage;
  period: InstantClaimPeriod;
  claimType?: string;
}) {
  if (!usage.supported) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-4 shrink-0 mt-0.5" />
        <p>
          Instant-claim stats are unavailable on this environment until the{" "}
          <code>last_preclaim_at</code> column ships on the game database.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border bg-muted/15 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-amber-500" />
          <p className="text-sm font-semibold">Instant claim impact</p>
          <span className="text-xs text-muted-foreground">
            · {instantClaimPeriodLabel(period)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
          {INSTANT_CLAIM_PERIODS.map((p) => (
            <Link
              key={p}
              href={buildClaimsPeriodHref(p, claimType)}
              scroll={false}
              className={cn(
                "inline-flex items-center rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                period === p
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {instantClaimPeriodLabel(p)}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Fee saved (house)"
          value={formatCurrency(usage.instantSavedUsd)}
          sub={`from ${formatNumber(usage.instantCount)} instant claim${usage.instantCount === 1 ? "" : "s"}`}
          icon={Zap}
          accent="emerald"
        />
        <KpiTile
          label="Users on instant"
          value={formatNumber(usage.instantUniqueUsers)}
          sub={`${formatNumber(usage.instantCount)} instant claim${usage.instantCount === 1 ? "" : "s"} total`}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Instant share"
          value={pct01(usage.instantShareByCount)}
          sub={`${formatNumber(usage.instantCount)} of ${formatNumber(usage.totalClaimCount)} claims`}
          icon={Percent}
          accent="amber"
        />
      </div>
    </div>
  );
}
