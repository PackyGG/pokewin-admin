import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins,
  TrendingUp,
  Users,
} from "lucide-react";
import { getInsightsHubWager } from "@/lib/queries/insights-analytics/hub-wager";
import { getCostBreakdownLifetimeCached } from "@/lib/queries/insights-analytics/cost-breakdown";
import { getTotalUserCount } from "@/lib/queries/dashboard";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Admin-only "house at a glance" pills for the top bar — LIFETIME wager,
 * deposit, withdrawal, total users, and gaming margin (GGR), shown to the
 * RIGHT of the sidebar toggle + breadcrumbs. Pill order: Wager · Deposits ·
 * Withdrawals · Users · GGR (Users sits immediately to the LEFT of GGR).
 *
 * DATA (the owner-trusted lifetime stack — the SAME reads the /insights pages
 * use, so the pills equal the /insights lifetime overview BY CONSTRUCTION):
 *   • Wager ← `getInsightsHubWager` — the SAME cached helper behind the
 *     /insights hub headline Wager tile (lifetime, 365d-capped; borrow-net
 *     real amounts, creator sessions excluded, sponsored battles + upgrader
 *     included).
 *   • GGR / Deposits / Withdrawals ← `getCostBreakdownLifetimeCached` — the
 *     ONE shared lifetime cost-breakdown cache the /insights hub AND
 *     /insights/real-numbers also read (same `getCostBreakdown("all", …, 365)`
 *     assembly). GGR = `.ggr`; Deposits = the `residual:deposit` bridge row;
 *     Withdrawals = `.cardWithdrawals`.
 *   • Users ← `getTotalUserCount` — reuses the dashboard's indexed,
 *     5-min-cached `cachedUserCounts` (COUNT(*) FROM "user", staff + blacklist
 *     excluded), so the pill equals the dashboard's old "Total Users" box BY
 *     CONSTRUCTION and dedupes against the dashboard's own read. Neutral count
 *     → BLUE (House-POV colours are money-only). This figure replaces the
 *     Total Users tile that used to live on /dashboard.
 *
 * WHY SHARED CACHE: the pills used to flash "—" on a cold load because the
 * topbar's lifetime read had its OWN `unstable_cache` key, separate from the
 * /insights pages. Opening /insights (which the owner does constantly) never
 * warmed the pills, so the heavy assembly re-ran inside the 15s budget and
 * degraded. Now both call the SAME `getCostBreakdownLifetimeCached` key
 * (revalidate 900s), so rendering /insights or /insights/real-numbers warms the
 * exact entry the pills read — they reliably show the numbers.
 *
 * PERF: both helpers are 365d-capped + `unstable_cache`d, so the lifetime read
 * is bounded (never an unbounded full-history scan) and a hit is cheap.
 *
 * RESILIENCE: the wager pill + the cost-breakdown pills run on SEPARATE
 * `safeQuery` legs (each 15s-bounded), and the layout renders this inside its
 * own `<Suspense>` boundary. So a slow/cold cost-breakdown read degrades only
 * its three pills to "—" while the lighter wager pill (its own smaller cache)
 * still renders — and neither ever blocks the page shell / breadcrumbs. A
 * timed-out read keeps running server-side and warms the cache for the next
 * render; failures are never cached.
 */

/** Loud window label — every pill tooltip names the window + the shared source. */
const WINDOW_SOURCE = "Lifetime — same source as /insights";

export async function TopbarHouseStats() {
  // Two independent legs so a cold/slow cost-breakdown read degrades only its
  // three pills (deposits / withdrawals / GGR) to "—" without taking down the
  // lighter, separately-cached wager pill.
  const [
    { data: wager, error: wagerError },
    { data: cb, error: cbError },
    { data: totalUsers, error: usersError },
  ] = await Promise.all([
    safeQuery(
      () => getInsightsHubWager(),
      0,
      "topbar.houseStats.wager",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getCostBreakdownLifetimeCached(),
      null,
      "topbar.houseStats.costBreakdown",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    // Total users — its OWN leg (reuses the dashboard's indexed, 5-min-cached
    // `cachedUserCounts`), so a slow/cold user-count read degrades only its
    // own pill without touching wager or the cost-breakdown pills.
    safeQuery(
      () => getTotalUserCount(),
      0,
      "topbar.houseStats.totalUsers",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  // Project the three figures out of the full shared CostBreakdown. A residual
  // bridge row with a zero total is omitted from `lines`, so a missing deposit
  // row truthfully means $0 deposited in-window.
  const data = {
    wager: wager ?? 0,
    deposits: cb?.lines.find((l) => l.key === "residual:deposit")?.amount ?? 0,
    withdrawals: cb?.cardWithdrawals ?? 0,
    ggr: cb?.ggr ?? 0,
  };

  // Per-leg failure: the wager pill degrades only on a wager-read failure; the
  // three cost-breakdown pills degrade only on a cost-breakdown failure. So one
  // cold/slow read never blanks the other's pills.
  const wagerFailed = wagerError !== null;
  const cbFailed = cbError !== null;
  const usersFailed = usersError !== null;
  const ggrPositive = data.ggr >= 0;
  const totalUsersCount = totalUsers ?? 0;

  return (
    <div className="hidden items-center gap-1.5 md:flex">
      <HouseStatPill
        className="hidden md:inline-flex"
        tone="emerald"
        icon={<Coins className="size-3.5 shrink-0" aria-hidden />}
        label="Wager"
        value={wagerFailed ? "—" : formatCompactUsd(data.wager)}
        title={`${WINDOW_SOURCE} · customer wager (borrow-net, creator sessions excluded, incl. upgrader) · ${
          wagerFailed ? "unavailable" : usd(data.wager)
        }`}
      />
      <HouseStatPill
        className="hidden md:inline-flex"
        tone="emerald"
        icon={<ArrowDownToLine className="size-3.5 shrink-0" aria-hidden />}
        label="Deposits"
        value={cbFailed ? "—" : formatCompactUsd(data.deposits)}
        title={`${WINDOW_SOURCE} · deposits (cash in) · ${
          cbFailed ? "unavailable" : usd(data.deposits)
        }`}
      />
      <HouseStatPill
        className="hidden lg:inline-flex"
        tone="rose"
        icon={<ArrowUpFromLine className="size-3.5 shrink-0" aria-hidden />}
        label="Withdrawals"
        value={cbFailed ? "—" : formatCompactUsd(data.withdrawals)}
        title={`${WINDOW_SOURCE} · card withdrawals (completed/shipped) · ${
          cbFailed ? "unavailable" : usd(data.withdrawals)
        }`}
      />
      {/* Total users — neutral count, so BLUE (House-POV colours are for
          money only; a headcount is neither a house win nor loss). Sits
          immediately to the LEFT of the GGR pill. */}
      <HouseStatPill
        className="hidden lg:inline-flex"
        tone="blue"
        icon={<Users className="size-3.5 shrink-0" aria-hidden />}
        label="Users"
        value={usersFailed ? "—" : formatNumber(totalUsersCount)}
        title={`Lifetime total users (real users, staff excluded — same source as the dashboard Total Users box) · ${
          usersFailed ? "unavailable" : formatNumber(totalUsersCount)
        }`}
      />
      <HouseStatPill
        className="hidden xl:inline-flex"
        tone={ggrPositive ? "emerald" : "rose"}
        icon={<TrendingUp className="size-3.5 shrink-0" aria-hidden />}
        label="GGR"
        value={cbFailed ? "—" : formatCompactUsd(data.ggr)}
        title={`${WINDOW_SOURCE} · gaming margin (GGR) · ${
          cbFailed ? "unavailable" : usd(data.ggr)
        }`}
      />
    </div>
  );
}

const TONE_CLASSES: Record<"emerald" | "rose" | "blue", string> = {
  emerald:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  rose: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400",
  blue: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
};

function HouseStatPill({
  tone,
  icon,
  label,
  value,
  title,
  className,
}: {
  tone: "emerald" | "rose" | "blue";
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
