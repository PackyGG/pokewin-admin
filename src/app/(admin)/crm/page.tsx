import { Suspense } from "react";
import Link from "next/link";
import {
  Users,
  UserPlus,
  Wallet,
  TrendingUp,
  PieChart,
  Crown,
  BellRing,
  Trophy,
  Activity,
  Coins,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { safeQueryOrNull, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getCrmSnapshot,
  type CrmSegmentRow,
  type CrmPlayerRow,
  type LifecycleKey,
} from "@/lib/queries/crm";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  type AccentColor,
} from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export const metadata = { title: "Player CRM" };

// Categorical accents (counts, not money — House-POV money rule applies
// only to the GGR / deposit figures, which are coloured separately).
const LIFECYCLE_ACCENT: Record<LifecycleKey, AccentColor> = {
  active: "emerald",
  at_risk: "amber",
  dormant: "orange",
  churned: "rose",
};
const VIP_ACCENT: Record<string, AccentColor> = {
  diamond: "cyan",
  platinum: "purple",
  gold: "amber",
  silver: "blue",
  bronze: "orange",
};

// House-POV: positive GGR = house win = emerald; negative = rose.
function ggrClass(v: number): string {
  return v >= 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

function SegmentBar({
  row,
  total,
  accent,
}: {
  row: CrmSegmentRow;
  total: number;
  accent: AccentColor;
}) {
  const pct = total > 0 ? Math.round((row.users / total) * 100) : 0;
  const barColor: Record<AccentColor, string> = {
    blue: "bg-blue-500",
    emerald: "bg-emerald-500",
    rose: "bg-rose-500",
    cyan: "bg-cyan-500",
    amber: "bg-amber-500",
    purple: "bg-purple-500",
    orange: "bg-orange-500",
    pink: "bg-pink-500",
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate font-medium">{row.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatNumber(row.users)} · {pct}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", barColor[accent])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
          {formatCurrency(row.deposits)} deposits
        </span>
        <span className={cn("tabular-nums", ggrClass(row.ggr))}>
          {formatCurrency(row.ggr)} GGR
        </span>
      </div>
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
        <p className="truncate text-sm font-medium">{p.username ?? "—"}</p>
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

export default async function CrmPage() {
  await requirePageAccess("/crm");

  // Paint the hero shell instantly; the heavy 365-day per-customer aggregate
  // streams in behind its own Suspense boundary, so first paint no longer
  // blocks on the multi-table segmentation query (Index-or-ClickHouse rule:
  // the read itself resolves via `resolveAdminRead("crm_snapshot")`).
  return (
    <div className="space-y-5">
      <PageHero>
        <PageHeroIdentity
          icon={PieChart}
          accent="purple"
          title="Player CRM"
          subtitle="Lifecycle, value tiers & win-back targets — real customers, last 365 days (borrow-corrected, House POV)"
        />
      </PageHero>

      <Suspense
        fallback={
          <>
            <KpiStripSkeleton count={6} />
            <ChartRowSkeleton count={2} height={260} />
            <ChartRowSkeleton count={2} height={260} />
          </>
        }
      >
        <CrmBody />
      </Suspense>
    </div>
  );
}

async function CrmBody() {
  const { data: snap, error } = await safeQueryOrNull(
    () => getCrmSnapshot(),
    "crm.snapshot",
    REWARD_QUERY_TIMEOUT_MS,
  );

  return (
    <>
      {!snap ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          {error
            ? "Segmentation is taking too long to compute — refresh to retry."
            : "No customer activity in the window yet."}
        </div>
      ) : (
        <>
          {/* KPI strip */}
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

          {/* Lifecycle + VIP tiers */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="space-y-4 rounded-2xl border bg-card p-4 sm:p-5">
              <SectionHeading icon={Activity} title="Lifecycle segments" />
              <div className="space-y-4">
                {snap.lifecycle.map((row) => (
                  <SegmentBar
                    key={row.key}
                    row={row}
                    total={snap.totalCustomers}
                    accent={LIFECYCLE_ACCENT[row.key as LifecycleKey]}
                  />
                ))}
              </div>
            </section>

            <section className="space-y-4 rounded-2xl border bg-card p-4 sm:p-5">
              <SectionHeading icon={Crown} title="VIP value tiers" />
              <div className="space-y-4">
                {snap.vipTiers.map((row) => (
                  <SegmentBar
                    key={row.key}
                    row={row}
                    total={snap.depositingCustomers}
                    accent={VIP_ACCENT[row.key] ?? "blue"}
                  />
                ))}
              </div>
            </section>
          </div>

          {/* Dormant whales + top value */}
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
              <SectionHeading icon={Trophy} title="Top value players" />
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
        </>
      )}
    </>
  );
}
