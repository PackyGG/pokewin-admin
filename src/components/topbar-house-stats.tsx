import { ArrowDownToLine, ArrowUpFromLine, Coins, TrendingUp } from "lucide-react";
import { getLifetimeHouseTotals } from "@/lib/queries/dashboard";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCompactUsd } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Admin-only "house at a glance" pills for the top bar — all-time wager,
 * deposit, withdrawal, and gaming margin (GGR), shown to the RIGHT of the
 * sidebar toggle + breadcrumbs.
 *
 * DATA: a single accessor (`getLifetimeHouseTotals`) backed by a dedicated
 * 30-min (`unstable_cache`, `revalidate: 1800`) cache. The top bar renders
 * on every admin page, so the read MUST stay cheap: it is ONE indexed
 * aggregate, capped at one run per 30 minutes across all admins. Because
 * `unstable_cache` is a shared server cache, a reload / new request inside
 * the window serves the cached value with no DB hit — the data loads once
 * on entry and only refetches every 30 minutes. See `getLifetimeHouseTotals`
 * for the booking model + sources.
 *
 * RESILIENCE: wrapped in `safeQuery`, and the layout renders this inside
 * its own `<Suspense>` boundary, so a slow or failed read degrades to "—"
 * pills (and never blocks the page shell / breadcrumbs).
 *
 * HOUSE-POV colours (per CLAUDE.md — every figure is from the house's
 * perspective, NEVER the user's):
 *   • Organic Wager — user risking their money, the house takes it →
 *                   emerald. ORGANIC only: excludes wager from users who
 *                   joined under a creator code (creator-marketed play), so
 *                   it reads as "real, non-creator-driven" volume. The GGR
 *                   pill still uses the FULL wager (see getLifetimeHouseTotals).
 *   • Deposit     — capital into the house                       → emerald
 *   • Withdrawal  — money leaving the house (card_withdrawal_requests,
 *                   status completed/shipped — the authoritative
 *                   site-wide "money out" total)                 → rose
 *   • GGR         — house gaming margin; positive = house up     → emerald,
 *                   negative = house down                        → rose
 *
 * LAYOUT: the pills are sized to FIT the existing `h-14` header (compact
 * `py-1`, `text-tiny`) and never grow it. They collapse progressively on
 * narrow viewports (wager+deposit appear from `md`, withdrawal from `lg`,
 * GGR from `xl`) so they never overflow the bar on small screens; the
 * title + toggle always keep priority.
 */
export async function TopbarHouseStats() {
  const { data, error } = await safeQuery(
    () => getLifetimeHouseTotals(),
    { wager: 0, deposits: 0, withdrawals: 0, ggr: 0 },
    "topbar.houseStats",
  );

  // On a failed/timed-out read, show muted "—" placeholders rather than
  // misleading zeros, matching the formatCurrency "no value" convention.
  const failed = error !== null;
  const ggrPositive = data.ggr >= 0;

  return (
    <div className="hidden items-center gap-1.5 md:flex">
      <HouseStatPill
        className="hidden md:inline-flex"
        tone="emerald"
        icon={<Coins className="size-3.5 shrink-0" aria-hidden />}
        label="Organic Wager"
        value={failed ? "—" : formatCompactUsd(data.wager)}
        title={`All-time organic wager (excludes users who joined under a creator code) · ${
          failed ? "unavailable" : usd(data.wager)
        }`}
      />
      <HouseStatPill
        className="hidden md:inline-flex"
        tone="emerald"
        icon={<ArrowDownToLine className="size-3.5 shrink-0" aria-hidden />}
        label="Deposits"
        value={failed ? "—" : formatCompactUsd(data.deposits)}
        title={`All-time deposits · ${failed ? "unavailable" : usd(data.deposits)}`}
      />
      <HouseStatPill
        className="hidden lg:inline-flex"
        tone="rose"
        icon={<ArrowUpFromLine className="size-3.5 shrink-0" aria-hidden />}
        label="Withdrawals"
        value={failed ? "—" : formatCompactUsd(data.withdrawals)}
        title={`All-time withdrawals · ${failed ? "unavailable" : usd(data.withdrawals)}`}
      />
      <HouseStatPill
        className="hidden xl:inline-flex"
        tone={ggrPositive ? "emerald" : "rose"}
        icon={<TrendingUp className="size-3.5 shrink-0" aria-hidden />}
        label="GGR"
        value={failed ? "—" : formatCompactUsd(data.ggr)}
        title={`All-time gaming margin (GGR) · ${
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
        // Compact pill tuned to sit inside the h-14 bar without growing it.
        // Explicit text-[10px] (not the `.text-tiny` helper) because that
        // helper bundles `text-muted-foreground`, which would override the
        // tone colour the coloured icon inherits from this span.
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium",
        TONE_CLASSES[tone],
        className,
      )}
      title={title}
    >
      {icon}
      {/* Label hidden until there is room (xl) so the pill stays small on
          mid widths — the value + icon + tooltip already identify it. */}
      <span className="hidden text-muted-foreground xl:inline">{label}</span>
      <span className="tabular-nums font-semibold text-foreground">{value}</span>
    </span>
  );
}

/** Full-precision USD for the pill tooltip (the pill shows the compact form). */
function usd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

/**
 * Suspense fallback — four neutral skeleton pills at the same dimensions as
 * the real ones so the header doesn't reflow when the stats stream in.
 */
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
