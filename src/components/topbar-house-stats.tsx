import { ArrowDownToLine, ArrowUpFromLine, Coins, TrendingUp } from "lucide-react";
import { getInsightsHubWager } from "@/lib/queries/insights-analytics/hub-wager";
import { getCostBreakdownTopbarLifetime } from "@/lib/queries/insights-analytics/cost-breakdown";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { formatCompactUsd } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Admin-only "house at a glance" pills for the top bar — LIFETIME wager,
 * deposit, withdrawal, and gaming margin (GGR), shown to the RIGHT of the
 * sidebar toggle + breadcrumbs.
 *
 * DATA (the owner-trusted lifetime stack — same sources as the /insights hub):
 *   • Wager ← `getInsightsHubWager` — the SAME cached helper behind the
 *     /insights hub headline Wager tile (lifetime, 365d-capped; borrow-net
 *     real amounts, creator sessions excluded, sponsored battles + upgrader
 *     included).
 *   • GGR / Deposits / Withdrawals ← `getCostBreakdownTopbarLifetime` — a
 *     cached projection of the IDENTICAL `getCostBreakdown("all", …, 365)`
 *     assembly the /insights hub headline margin tiles render.
 * So the pills equal the /insights lifetime overview BY CONSTRUCTION (shared
 * helpers, same call shapes), on a 5-min `unstable_cache` that shares the
 * hub's cached read so they stay cheap on every admin page.
 *
 * PERF: both helpers are 365d-capped + `unstable_cache`d (300s), so the
 * lifetime read is bounded (never an unbounded full-history scan) and reuses
 * the hub's cache on hits.
 *
 * RESILIENCE: wrapped in `safeQuery` (15s bound), and the layout renders
 * this inside its own `<Suspense>` boundary, so a slow or failed read
 * degrades to "—" pills (and never blocks the page shell / breadcrumbs).
 * A timed-out read keeps running server-side and warms the cache for the
 * next render; failures are never cached.
 */

/** Loud window label — every pill tooltip names the window + the shared source. */
const WINDOW_SOURCE = "Lifetime — same source as /insights";

export async function TopbarHouseStats() {
  const { data, error } = await safeQuery(
    async () => {
      const [wager, cb] = await Promise.all([
        getInsightsHubWager(),
        getCostBreakdownTopbarLifetime(),
      ]);
      return {
        wager,
        deposits: cb.deposits,
        withdrawals: cb.withdrawals,
        ggr: cb.ggr,
      };
    },
    { wager: 0, deposits: 0, withdrawals: 0, ggr: 0 },
    "topbar.houseStats",
    REWARD_QUERY_TIMEOUT_MS,
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
        title={`${WINDOW_SOURCE} · customer wager (borrow-net, creator sessions excluded, incl. upgrader) · ${
          failed ? "unavailable" : usd(data.wager)
        }`}
      />
      <HouseStatPill
        className="hidden md:inline-flex"
        tone="emerald"
        icon={<ArrowDownToLine className="size-3.5 shrink-0" aria-hidden />}
        label="Deposits"
        value={failed ? "—" : formatCompactUsd(data.deposits)}
        title={`${WINDOW_SOURCE} · deposits (cash in) · ${
          failed ? "unavailable" : usd(data.deposits)
        }`}
      />
      <HouseStatPill
        className="hidden lg:inline-flex"
        tone="rose"
        icon={<ArrowUpFromLine className="size-3.5 shrink-0" aria-hidden />}
        label="Withdrawals"
        value={failed ? "—" : formatCompactUsd(data.withdrawals)}
        title={`${WINDOW_SOURCE} · card withdrawals (completed/shipped) · ${
          failed ? "unavailable" : usd(data.withdrawals)
        }`}
      />
      <HouseStatPill
        className="hidden xl:inline-flex"
        tone={ggrPositive ? "emerald" : "rose"}
        icon={<TrendingUp className="size-3.5 shrink-0" aria-hidden />}
        label="GGR"
        value={failed ? "—" : formatCompactUsd(data.ggr)}
        title={`${WINDOW_SOURCE} · gaming margin (GGR) · ${
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
