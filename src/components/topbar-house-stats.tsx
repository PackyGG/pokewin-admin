import { ArrowDownToLine, ArrowUpFromLine, Coins, TrendingUp } from "lucide-react";
import { getTopbarHouseKpis, TOPBAR_HOUSE_PERIOD } from "@/lib/queries/house-kpis";
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCompactUsd } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Admin-only "house at a glance" pills for the top bar — rolling 30d wager,
 * deposit, withdrawal, and gaming margin (GGR), shown to the RIGHT of the
 * sidebar toggle + breadcrumbs.
 *
 * DATA: `getTopbarHouseKpis` → `getCanonicalMoneyKpis` (same sources as
 * Analytics Insights overview + dashboard period KPIs). Cached 5 min via
 * `unstable_cache` so the pills stay cheap on every admin page.
 *
 * RESILIENCE: wrapped in `safeQuery`, and the layout renders this inside
 * its own `<Suspense>` boundary, so a slow or failed read degrades to "—"
 * pills (and never blocks the page shell / breadcrumbs).
 */
export async function TopbarHouseStats() {
  const periodLabel = DASHBOARD_PERIOD_LABELS[TOPBAR_HOUSE_PERIOD];
  const { data, error } = await safeQuery(
    () => getTopbarHouseKpis(),
    {
      wager: 0,
      deposits: 0,
      withdrawals: 0,
      ggr: 0,
      wagerOrganic: 0,
      wagerCreatorCoded: 0,
      depositCount: 0,
      upgraderOrganic: 0,
      organicCustomerStake: 0,
    },
    "topbar.houseStats",
  );

  const failed = error !== null;
  const ggrPositive = data.ggr >= 0;

  return (
    <div className="hidden items-center gap-1.5 md:flex">
      <HouseStatPill
        className="hidden md:inline-flex"
        tone="emerald"
        icon={<Coins className="size-3.5 shrink-0" aria-hidden />}
        label="Wager"
        value={failed ? "—" : formatCompactUsd(data.wager)}
        title={`${periodLabel} customer wager (ex creator on-stream) · ${
          failed ? "unavailable" : usd(data.wager)
        }`}
      />
      <HouseStatPill
        className="hidden md:inline-flex"
        tone="emerald"
        icon={<ArrowDownToLine className="size-3.5 shrink-0" aria-hidden />}
        label="Deposits"
        value={failed ? "—" : formatCompactUsd(data.deposits)}
        title={`${periodLabel} deposits · ${failed ? "unavailable" : usd(data.deposits)}`}
      />
      <HouseStatPill
        className="hidden lg:inline-flex"
        tone="rose"
        icon={<ArrowUpFromLine className="size-3.5 shrink-0" aria-hidden />}
        label="Withdrawals"
        value={failed ? "—" : formatCompactUsd(data.withdrawals)}
        title={`${periodLabel} card withdrawals (completed/shipped) · ${
          failed ? "unavailable" : usd(data.withdrawals)
        }`}
      />
      <HouseStatPill
        className="hidden xl:inline-flex"
        tone={ggrPositive ? "emerald" : "rose"}
        icon={<TrendingUp className="size-3.5 shrink-0" aria-hidden />}
        label="GGR"
        value={failed ? "—" : formatCompactUsd(data.ggr)}
        title={`${periodLabel} gaming margin (GGR) · ${
          failed ? "unavailable" : usd(data.ggr)
        }`}
      />
    </div>
  );
}

const TONE_CLASSES: Record<"emerald" | "rose", string> = {
  emerald:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  rose: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

function HouseStatPill({
  tone,
  icon,
  label,
  value,
  title,
  className,
}: {
  tone: "emerald" | "rose";
  icon: React.ReactNode;
  label: string;
  value: string;
  title: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium",
        TONE_CLASSES[tone],
        className,
      )}
      title={title}
    >
      {icon}
      <span className="hidden text-muted-foreground xl:inline">{label}</span>
      <span className="tabular-nums font-semibold text-foreground">{value}</span>
    </span>
  );
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

export function TopbarHouseStatsSkeleton() {
  return (
    <div className="hidden items-center gap-1.5 md:flex" aria-hidden>
      <SkeletonPill className="hidden md:inline-flex" />
      <SkeletonPill className="hidden md:inline-flex" />
      <SkeletonPill className="hidden lg:inline-flex" />
      <SkeletonPill className="hidden xl:inline-flex" />
    </div>
  );
}

function SkeletonPill({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "h-[26px] w-16 animate-pulse rounded-full border border-border/60 bg-muted/40",
        className,
      )}
    />
  );
}
