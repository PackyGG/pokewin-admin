import { Suspense } from "react";
import Link from "next/link";
import {
  TrendingUp,
  TrendingDown,
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins,
  Users,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import {
  getGgrBreakdown,
  getGgrTopContributors,
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
  type GgrBreakdownRow,
  type GgrTopContributorRow,
} from "@/lib/queries/dashboard";
import { describeLedgerType } from "@/lib/queries/_wager-payout-descriptions";

import { GgrWindowSwitch } from "./ggr-window-switch";

export const metadata = { title: "GGR Breakdown" };

// The /ggr page only exposes the rolling 24h / 3d / 7d windows from the
// canonical `DashboardPeriod` set — admins who need a longer view drop
// into the dashboard's full period selector. Anything else on
// `?window=` normalises to the default.
type GgrWindow = Extract<DashboardPeriod, "24h" | "3d" | "7d">;
const SUPPORTED_WINDOWS = ["24h", "3d", "7d"] as const satisfies readonly GgrWindow[];
const DEFAULT_GGR_WINDOW: GgrWindow = "24h";

function parseGgrWindow(value: string | undefined): GgrWindow {
  if (!value) return DEFAULT_GGR_WINDOW;
  return (SUPPORTED_WINDOWS as readonly string[]).includes(value)
    ? (value as GgrWindow)
    : DEFAULT_GGR_WINDOW;
}

/**
 * `/ggr` — full GGR breakdown page. Sits in the Overview sidebar group
 * as the deep-dive companion to the headline GGR card on /dashboard.
 *
 * The dashboard's GgrStatCard shipped a popover breakdown in
 * 2a21491 + 90d8f09 — this page is the long-form version of that
 * popover: every wager and payout ledger type rendered as a per-type
 * card with its own explanation, plus a per-period top-contributors
 * section. Reuses the cached `getGgrBreakdown` + `getGgrTopContributors`
 * query helpers so the page stays consistent with the headline GGR
 * number (same window, same filter, same numerics).
 *
 * Window state lives in `?window=` so the URL is shareable and reload
 * survives the active tab — same pattern as `/creators?tab=`. Default
 * is `24h` (matches `DEFAULT_DASHBOARD_PERIOD`).
 *
 * The body is wrapped in Suspense so flipping windows shows a skeleton
 * instead of freezing on stale numbers — the cached query (60s TTL)
 * keeps the swap fast for the common cases.
 */
export default async function GgrPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/ggr");
  const sp = await searchParams;
  const ggrWindow = parseGgrWindow(sp.window);
  const periodLabel = DASHBOARD_PERIOD_LABELS[ggrWindow];

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={TrendingUp}
          accent="cyan"
          title="GGR Breakdown"
          subtitle="Every wager and payout component driving Gross Gaming Revenue."
          action={<GgrWindowSwitch />}
        />
      </PageHero>

      {/* Suspense key includes the window so a tab swap shows the
          skeleton again instead of leaving stale numbers up while the
          next window's data resolves. */}
      <Suspense
        key={ggrWindow}
        fallback={
          <div className="space-y-6">
            <KpiStripSkeleton count={4} />
            <div className="space-y-3">
              <SectionHeadingSkeleton titleWidth={180} />
              <LedgerTypeGridSkeleton count={5} />
            </div>
            <div className="space-y-3">
              <SectionHeadingSkeleton titleWidth={180} />
              <LedgerTypeGridSkeleton count={9} />
            </div>
            <div className="space-y-3">
              <SectionHeadingSkeleton titleWidth={220} />
              <TableSkeleton rows={10} columns={5} />
            </div>
          </div>
        }
      >
        <GgrBody ggrWindow={ggrWindow} periodLabel={periodLabel} />
      </Suspense>
    </div>
  );
}

// ─── Body ────────────────────────────────────────────────────────────

/**
 * Streaming body — fetches the per-type breakdown and the top-10
 * contributor list for the active window in parallel and renders the
 * KPI strip + per-type cards + contributor table.
 *
 * Top contributors are fetched eagerly here (unlike the dashboard
 * popover, where the per-user GROUP BY is hidden behind a click)
 * because this page IS the GGR deep-dive — admins land here to see the
 * top movers, so deferring them to a second click would be hostile.
 * The cached `getGgrBreakdown` is reused for the KPI numbers; the
 * top-contributors call is uncached at the query layer but the page
 * itself is server-rendered behind Suspense, so the per-page repeat
 * cost is bounded by how often admins hit /ggr.
 */
async function GgrBody({
  ggrWindow,
  periodLabel,
}: {
  ggrWindow: GgrWindow;
  periodLabel: string;
}) {
  const [breakdown, contributors] = await Promise.all([
    getGgrBreakdown(ggrWindow),
    getGgrTopContributors(ggrWindow, 10),
  ]);

  // Hide zero-total rows on each side so quiet windows (e.g. last 24h
  // with no upgrader plays or no race prizes) don't render dead cards.
  // The headline KPI strip still reflects the full math.
  const wagers = breakdown.wagers.filter((r) => r.total > 0);
  const payouts = breakdown.payouts.filter((r) => r.total > 0);

  return (
    <FadeIn className="space-y-6">
      {/* Hero KPI strip — 4 tiles. Wagers (neutral identity tint),
          Payouts (rose — money out), GGR (house-POV: positive emerald,
          negative rose), and a duplicate "Net for house" tile for
          emphasis on positive windows. */}
      <KpiStrip
        wagersTotal={breakdown.wagersTotal}
        payoutsTotal={breakdown.payoutsTotal}
        ggr={breakdown.ggr}
        periodLabel={periodLabel}
      />

      {/* Wagers — every wager-side ledger type. Cards rendered in DESC
          order by total (the SQL already orders that way). Each card
          shows the type label, hero $ amount, and the canonical
          description. */}
      <section className="space-y-3">
        <SectionHeading
          icon={ArrowDownToLine}
          title={`Wagers · ${periodLabel}`}
        />
        {wagers.length === 0 ? (
          <EmptySection label="No wager activity in this window." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {wagers.map((row) => (
              <LedgerTypeCard
                key={row.type}
                row={row}
                side="wager"
                bucketTotal={breakdown.wagersTotal}
              />
            ))}
          </div>
        )}
      </section>

      {/* Payouts — every payout-side ledger type. Rose tint (money out
          → house loss). */}
      <section className="space-y-3">
        <SectionHeading
          icon={ArrowUpFromLine}
          title={`Payouts · ${periodLabel}`}
        />
        {payouts.length === 0 ? (
          <EmptySection label="No payout activity in this window." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {payouts.map((row) => (
              <LedgerTypeCard
                key={row.type}
                row={row}
                side="payout"
                bucketTotal={breakdown.payoutsTotal}
              />
            ))}
          </div>
        )}
      </section>

      {/* Top 10 contributors for the active window — net is signed from
          the house POV, so the column color flips per row. */}
      <section className="space-y-3">
        <SectionHeading
          icon={Users}
          title={`Top 10 contributors · ${periodLabel}`}
        />
        <TopContributorsTable rows={contributors} />
      </section>
    </FadeIn>
  );
}

// ─── KPI strip ───────────────────────────────────────────────────────

function KpiStrip({
  wagersTotal,
  payoutsTotal,
  ggr,
  periodLabel,
}: {
  wagersTotal: number;
  payoutsTotal: number;
  ggr: number;
  periodLabel: string;
}) {
  const ggrIsHouseProfit = ggr >= 0;
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      <KpiTile
        label="Total Wagers"
        value={formatCurrency(wagersTotal)}
        sub={periodLabel}
        icon={ArrowDownToLine}
        accent="purple"
      />
      <KpiTile
        label="Total Payouts"
        value={formatCurrency(payoutsTotal)}
        sub={periodLabel}
        icon={ArrowUpFromLine}
        // Payouts always shrink GGR — rose tint regardless of magnitude
        // so the card reads house-POV consistently.
        accent="rose"
      />
      <KpiTile
        label="GGR (Wagers − Payouts)"
        value={`${ggrIsHouseProfit ? "+" : "−"}${formatCurrency(Math.abs(ggr))}`}
        sub={periodLabel}
        icon={ggrIsHouseProfit ? TrendingUp : TrendingDown}
        // House-POV: positive GGR → emerald, negative GGR → rose.
        accent={ggrIsHouseProfit ? "emerald" : "rose"}
      />
      <KpiTile
        label="Net for House"
        // Net for the house is the same number as GGR with the same
        // sign convention — surfacing it twice so the "what does this
        // mean for us" line is unmissable when admins scan the strip.
        value={`${ggrIsHouseProfit ? "+" : "−"}${formatCurrency(Math.abs(ggr))}`}
        sub={ggrIsHouseProfit ? "House profit" : "House loss"}
        icon={Coins}
        accent={ggrIsHouseProfit ? "emerald" : "rose"}
      />
    </div>
  );
}

// ─── Per-type card ───────────────────────────────────────────────────

/**
 * Card for one ledger type — hero number on top, label + side badge,
 * canonical description, and a small footer with the type's raw name
 * and percentage of its bucket total.
 *
 * Side colouring follows the dashboard popover:
 *   • wager  — neutral identity tint (foreground)
 *   • payout — rose (money out)
 * Per CLAUDE.md the headline GGR is already coloured house-POV up in
 * the KPI strip; the per-type cards are flow tiles, not P&L tiles, so
 * we tint by side rather than by sign.
 */
function LedgerTypeCard({
  row,
  side,
  bucketTotal,
}: {
  row: GgrBreakdownRow;
  side: "wager" | "payout";
  bucketTotal: number;
}) {
  const desc = describeLedgerType(row.type);
  const pct =
    bucketTotal > 0 ? Math.round((row.total / bucketTotal) * 100) : 0;
  const valueColor =
    side === "payout"
      ? "text-rose-600 dark:text-rose-400"
      : "text-foreground";
  const sideLabel = side === "wager" ? "Wager" : "Payout";
  const sideBadgeColor =
    side === "wager"
      ? "border-purple-500/20 bg-purple-500/10 text-purple-600 dark:text-purple-400"
      : "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400";

  return (
    <div className="surface-sheen surface-raise group relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:rounded-2xl sm:p-5">
      {/* Hairline top highlight — same lift as StatPanel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">
            {desc.label}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
            {row.type}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            sideBadgeColor,
          )}
        >
          {sideLabel}
        </span>
      </div>

      <p
        className={cn(
          "mt-3 truncate text-2xl font-bold tabular-nums",
          valueColor,
        )}
      >
        {side === "payout" ? "−" : "+"}
        {formatCurrency(row.total)}
      </p>

      {desc.description ? (
        <p className="mt-2 line-clamp-3 text-xs leading-snug text-muted-foreground">
          {desc.description}
        </p>
      ) : (
        // Defensive: an unknown ledger type would land here. Render a
        // muted placeholder so the card still has a description row.
        <p className="mt-2 text-xs italic leading-snug text-muted-foreground/60">
          No description on file for this ledger type.
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-2 text-[11px] tabular-nums text-muted-foreground">
        <span>{pct}% of {side === "wager" ? "wagers" : "payouts"}</span>
        <span>{formatCurrency(row.total)}</span>
      </div>
    </div>
  );
}

// ─── Skeletons ──────────────────────────────────────────────────────

/**
 * Skeleton mirror of the per-type card grid. Reproduces the same 1 / 2 /
 * 3-column responsive grid + the card's internal layout (label row,
 * hero number, description, footer) so the swap into real content
 * doesn't jank.
 */
function LedgerTypeGridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border bg-card p-4 sm:rounded-2xl sm:p-5"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-4 w-14 rounded-md" />
          </div>
          <Skeleton className="mt-3 h-7 w-28" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-5/6" />
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Empty section ──────────────────────────────────────────────────

function EmptySection({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-8 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

// ─── Top contributors ──────────────────────────────────────────────

/**
 * Top 10 users by ABS(net) for the active window. Net = wager − payout
 * with house-POV colouring: positive net = user lost = house profited
 * = emerald; negative = user won = house lost = rose.
 *
 * Each row links to /users/<id> so admins can drill straight in. Users
 * with no username (deleted / pending) fall back to a truncated id.
 */
function TopContributorsTable({ rows }: { rows: GgrTopContributorRow[] }) {
  if (rows.length === 0) {
    return <EmptySection label="No contributing activity in this window." />;
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* Header row */}
      <div className="grid grid-cols-[2rem_1fr_repeat(3,_minmax(0,_8rem))] gap-3 border-b border-border/60 bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>#</span>
        <span>User</span>
        <span className="text-right">Wagers</span>
        <span className="text-right">Payouts</span>
        <span className="text-right">Net (House POV)</span>
      </div>
      <ul>
        {rows.map((r, idx) => (
          <ContributorRow key={r.userId} rank={idx + 1} row={r} />
        ))}
      </ul>
    </div>
  );
}

function ContributorRow({
  rank,
  row,
}: {
  rank: number;
  row: GgrTopContributorRow;
}) {
  const isHouseProfit = row.net > 0;
  const isHouseLoss = row.net < 0;
  const username = row.username ?? `${row.userId.slice(0, 6)}…`;
  // House-POV: user lost = we won = emerald; user won = we lost = rose.
  const netColor = isHouseProfit
    ? "text-emerald-600 dark:text-emerald-400"
    : isHouseLoss
      ? "text-rose-600 dark:text-rose-400"
      : "text-muted-foreground";
  const netSign = isHouseProfit ? "+" : isHouseLoss ? "−" : "";

  return (
    <li>
      <Link
        href={`/users/${row.userId}`}
        className="grid grid-cols-[2rem_1fr_repeat(3,_minmax(0,_8rem))] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-xs transition-colors last:border-b-0 hover:bg-muted/30"
      >
        <span className="text-right text-muted-foreground tabular-nums">
          {rank}.
        </span>
        <span className="truncate font-medium">{username}</span>
        <span className="text-right tabular-nums text-muted-foreground">
          {formatCurrency(row.wagerTotal)}
        </span>
        <span className="text-right tabular-nums text-muted-foreground">
          {formatCurrency(row.payoutTotal)}
        </span>
        <span className={cn("text-right font-semibold tabular-nums", netColor)}>
          {netSign}
          {formatCurrency(Math.abs(row.net))}
        </span>
      </Link>
    </li>
  );
}

