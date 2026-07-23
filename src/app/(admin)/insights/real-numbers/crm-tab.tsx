import Link from "next/link";
import {
  Users,
  UserPlus,
  Wallet,
  TrendingUp,
  BellRing,
  Trophy,
  Activity,
  Coins,
  Gauge,
} from "lucide-react";
import {
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import {
  getCrmSnapshot,
  type CrmSegmentRow,
  type CrmPlayerRow,
  type LifecycleKey,
} from "@/lib/queries/crm";
import {
  SectionHeading,
  KpiTile,
  type AccentColor,
} from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Player CRM — lifecycle segmentation, player-level bands, dormant-whale
 * win-back targets and top depositors.
 *
 * REBUILT 2026-07-23. The previous version's second panel was "VIP value
 * tiers": Diamond / Platinum / Gold / Silver / Bronze over gross-deposit
 * brackets. No such tier system exists in the product — the names were
 * invented here, so the block read as a real player status while actually
 * being "how much have they deposited" wearing a costume. It also silently
 * dropped every non-depositing customer, so its rows never summed to the
 * customer count next to them. It is replaced by bands over the REAL
 * `user_statistics.level` (XP-driven, 0–84 on prod), where every customer
 * lands in exactly one band.
 *
 * Read path: `getCrmSnapshot()` (resolveAdminRead("crm_snapshot"), real
 * customers only, borrow-corrected, last 365 days, House POV). Streamed behind
 * its own `<Suspense>` boundary on the analytics page.
 */

// Lifecycle is genuinely CATEGORICAL (four named states an operator acts on
// differently), so it keeps per-state colour. Level bands are an ORDINAL
// ladder — colouring them would imply five unrelated categories, so they read
// as one accent and let the bar length carry the comparison.
const LIFECYCLE_ACCENT: Record<LifecycleKey, AccentColor> = {
  active: "emerald",
  at_risk: "amber",
  dormant: "orange",
  churned: "rose",
};

const BAR_COLOR: Record<AccentColor, string> = {
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-500",
  amber: "bg-amber-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  pink: "bg-pink-500",
};

// House-POV: positive GGR = house win = emerald; negative = rose.
function ggrClass(v: number): string {
  return v >= 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

/**
 * One segment as an aligned data row rather than a stack of loose text.
 *
 * The old layout put deposits and GGR on their own line under each bar in
 * 11px, so nothing lined up between rows and the eye couldn't compare two
 * segments without reading every number. Fixed columns fix that: the share bar
 * sits under the label, money is right-aligned in its own column, and the
 * numbers stack vertically across rows.
 */
function SegmentRow({
  row,
  total,
  accent,
}: {
  row: CrmSegmentRow;
  total: number;
  accent: AccentColor;
}) {
  const pct = total > 0 ? Math.round((row.users / total) * 100) : 0;
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 py-2">
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{row.label}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatNumber(row.users)}
            <span className="ml-1 opacity-60">{pct}%</span>
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", BAR_COLOR[accent])}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="text-right leading-tight">
        <div className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
          {formatCurrency(row.deposits)}
        </div>
        <div className={cn("text-[11px] tabular-nums", ggrClass(row.ggr))}>
          {formatCurrency(row.ggr)}
        </div>
      </div>
    </div>
  );
}

/** Column key so the two money columns are labelled once, not per row. */
function SegmentHeader() {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-4 border-b pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      <span>Segment · players</span>
      <span className="text-right">Deposits / GGR</span>
    </div>
  );
}

function PlayerRow({ p }: { p: CrmPlayerRow }) {
  const fallback = (p.username ?? "?").slice(0, 2).toUpperCase();
  const accent = LIFECYCLE_ACCENT[p.lifecycle];
  const recencyTint: Record<AccentColor, string> = {
    blue: "text-blue-600 dark:text-blue-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
    rose: "text-rose-600 dark:text-rose-400",
    cyan: "text-cyan-600 dark:text-cyan-400",
    amber: "text-amber-600 dark:text-amber-400",
    purple: "text-purple-600 dark:text-purple-400",
    orange: "text-orange-600 dark:text-orange-400",
    pink: "text-pink-600 dark:text-pink-400",
  };
  return (
    <Link
      href={`/users/${p.userId}`}
      className="flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 transition-colors hover:border-border hover:bg-accent/50"
    >
      <Avatar className="size-8 shrink-0">
        {p.image ? <AvatarImage src={p.image} alt={p.username ?? ""} /> : null}
        <AvatarFallback className="text-[11px]">{fallback}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">{p.username ?? "—"}</span>
          {/* Real level, straight from user_statistics — the same number the
              player sees, so support can reference it in a conversation. */}
          <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
            L{p.level}
          </span>
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {formatNumber(p.plays)} plays ·{" "}
          <span className={recencyTint[accent]}>{p.recencyDays}d ago</span>
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
          {formatCurrency(p.deposits)}
        </p>
        <p className={cn("text-[11px] tabular-nums", ggrClass(p.ggr))}>
          {formatCurrency(p.ggr)} GGR
        </p>
      </div>
    </Link>
  );
}

export async function CrmTab() {
  const { data: snap, error } = await safeQueryOrNull(
    () => getCrmSnapshot(),
    "crm.snapshot",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (!snap) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
        {error
          ? "Segmentation is taking too long to compute — refresh to retry."
          : "No customer activity in the window yet."}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="Customers"
          value={formatNumber(snap.totalCustomers)}
          sub={`${formatNumber(snap.depositingCustomers)} depositing`}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="New (30d)"
          value={formatNumber(snap.newCustomers)}
          sub="signed up ≤30d ago"
          icon={UserPlus}
          accent="cyan"
        />
        <KpiTile
          label="Deposits"
          value={formatCurrency(snap.totalDeposits)}
          sub="gross cash in"
          icon={Wallet}
          accent="emerald"
        />
        <KpiTile
          label="Net Deposits"
          value={formatCurrency(snap.totalNetDeposits)}
          sub="deposits − withdrawals"
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Gaming GGR"
          value={formatCurrency(snap.totalGgr)}
          sub="wager − payout"
          icon={Activity}
          accent={snap.totalGgr >= 0 ? "emerald" : "rose"}
        />
        <KpiTile
          label="Avg / Depositor"
          value={formatCurrency(snap.avgDepositPerCustomer)}
          sub="deposits per payer"
          icon={Coins}
          accent="purple"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="space-y-2 rounded-2xl border bg-card p-4 sm:p-5">
          <SectionHeading icon={Activity} title="Lifecycle" />
          <p className="text-[11px] text-muted-foreground">
            Days since the player last moved money — deposit, wager or payout.
          </p>
          <SegmentHeader />
          <div className="divide-y">
            {snap.lifecycle.map((row) => (
              <SegmentRow
                key={row.key}
                row={row}
                total={snap.totalCustomers}
                accent={LIFECYCLE_ACCENT[row.key as LifecycleKey]}
              />
            ))}
          </div>
        </section>

        <section className="space-y-2 rounded-2xl border bg-card p-4 sm:p-5">
          <SectionHeading icon={Gauge} title="Player level" />
          <p className="text-[11px] text-muted-foreground">
            The player&apos;s real XP level. Every customer is in exactly one
            band, so these add up to the customer count.
          </p>
          <SegmentHeader />
          <div className="divide-y">
            {snap.levelBands.map((row) => (
              <SegmentRow
                key={row.key}
                row={row}
                total={snap.totalCustomers}
                accent="blue"
              />
            ))}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-2xl border bg-card p-4 sm:p-5">
          <SectionHeading
            icon={BellRing}
            title={
              <span className="flex items-center gap-2">
                Dormant whales
                <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                  win-back
                </span>
              </span>
            }
          />
          <p className="text-[11px] text-muted-foreground">
            Deposited ≥ {formatCurrency(1000)} but no activity in 30+ days.
          </p>
          {snap.dormantWhales.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No dormant whales — every high-value player is still active.
            </p>
          ) : (
            <div className="space-y-0.5">
              {snap.dormantWhales.map((p) => (
                <PlayerRow key={p.userId} p={p} />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-2xl border bg-card p-4 sm:p-5">
          <SectionHeading icon={Trophy} title="Top depositors" />
          <p className="text-[11px] text-muted-foreground">
            Highest gross deposits in the window.
          </p>
          <div className="space-y-0.5">
            {snap.topValue.map((p) => (
              <PlayerRow key={p.userId} p={p} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
