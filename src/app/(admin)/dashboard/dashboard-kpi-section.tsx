"use client";

import { useCallback, useState, useTransition } from "react";
import {
  Users,
  Percent,
  Coins,
  BadgeDollarSign,
  HandCoins,
  Gauge,
  TrendingUp,
  TrendingDown,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AnimatedNumber, type AnimatedNumberFormat } from "@/components/animated-number";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { GgrBreakdownPopover } from "./revenue-stat-card";
import {
  DASHBOARD_KPI_WINDOWS,
  DASHBOARD_KPI_WINDOW_LABELS,
  type DashboardKpiWindow,
} from "@/lib/queries/dashboard-period";
import { getDashboardKpiStatsAction } from "./actions";
import type { KpiWindowPayload } from "./kpi-window-data";

/**
 * Window-independent SNAPSHOT tile values — lifetime / fixed-window figures
 * that do NOT change with the today/24h toggle (Total Users, FTDs 24h,
 * Depositors, Avg Deposit, Deposits/Hour, Avg RTP). Computed once on the
 * server from the eager "today" stats and rendered without a toggle (an
 * honest UI — no toggle on a box whose number can't move).
 */
export type KpiSnapshotValues = {
  usersTotal: number;
  usersToday: number;
  usersWeek: number;
  ftds24h: number;
  ftdTotal24h: number;
  ftdAvg24h: number;
  uniqueDepositors: number;
  depositorsPctOfUsers: number | null;
  avgDeposit: number;
  depositsPerHour24h: number;
  depositsPerHour7d: number;
  avgRtp: number;
};

const PANEL_TINT = {
  cyan: "bg-cyan-500/10",
  purple: "bg-purple-500/10",
  emerald: "bg-emerald-500/10",
  pink: "bg-pink-500/10",
  blue: "bg-blue-500/10",
  amber: "bg-amber-500/10",
} as const;

type PanelTint = keyof typeof PANEL_TINT;

const ICON_TINT: Record<PanelTint, string> = {
  cyan: "text-cyan-400",
  purple: "text-purple-400",
  emerald: "text-emerald-400",
  pink: "text-pink-400",
  blue: "text-blue-400",
  amber: "text-amber-400",
};

/**
 * Per-box "today / 24h" toggle. Same look as the PnL tile's old
 * period/lifetime toggle (small pill buttons inside the card header). The
 * active button is highlighted; clicking the inactive one flips the box's
 * window. While the lazy 24h payload is loading, the 24h button shows a
 * tiny spinner so the pending state is legible without blanking the value.
 */
function WindowToggle({
  active,
  loading,
  onPick,
}: {
  active: DashboardKpiWindow;
  loading: boolean;
  onPick: (next: DashboardKpiWindow) => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5">
      {DASHBOARD_KPI_WINDOWS.map((w) => {
        const isActive = w === active;
        return (
          <button
            key={w}
            type="button"
            onClick={() => onPick(w)}
            aria-pressed={isActive}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
              isActive
                ? "bg-background/70 text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={`Show ${DASHBOARD_KPI_WINDOW_LABELS[w]} figure`}
          >
            {w === "24h" && isActive && loading && (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            )}
            {DASHBOARD_KPI_WINDOW_LABELS[w]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Generic panel shell shared by every KPI box so the whole strip looks
 * like the P&L Today / Reward-Costs cards: a tinted `Card` with a header
 * (title + optional Info popover slot + a window control/label on the
 * right), a hero value, and an optional chip-grid / subtitle body.
 */
function KpiPanel({
  title,
  titleAdornment,
  headerRight,
  icon: Icon,
  tint,
  children,
}: {
  title: string;
  /** Rendered inline after the title (e.g. the GGR Info popover trigger). */
  titleAdornment?: React.ReactNode;
  /** Rendered at the right of the header (window toggle or static label). */
  headerRight?: React.ReactNode;
  icon?: LucideIcon;
  tint: PanelTint;
  children: React.ReactNode;
}) {
  return (
    <Card className={PANEL_TINT[tint]}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-card-title text-muted-foreground inline-flex min-w-0 items-center gap-1">
          <span className="truncate">{title}</span>
          {titleAdornment}
        </CardTitle>
        <div className="flex shrink-0 items-center gap-1.5">
          {headerRight}
          {Icon && <Icon className={cn("size-4 shrink-0", ICON_TINT[tint])} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

/** Hero currency value with a House-POV sign + emerald/rose color. */
function SignedHero({ value }: { value: number }) {
  const isProfit = value >= 0;
  return (
    <div className="text-stat-value truncate">
      <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
        {isProfit ? "+" : "−"}
        <AnimatedNumber value={Math.abs(value)} format="currency" />
      </span>
    </div>
  );
}

/** Plain hero value (no House-POV sign) for identity-only figures. */
function PlainHero({
  value,
  format,
}: {
  value: number;
  format: AnimatedNumberFormat;
}) {
  return (
    <div className="text-stat-value truncate tabular-nums">
      <AnimatedNumber value={value} format={format} />
    </div>
  );
}

/**
 * One of two side-by-side headline figures inside the merged Wager box
 * (Total + Organic). A small uppercase label sits above a currency value
 * sized to fit two-up in one KPI box (a notch smaller than the single
 * {@link PlainHero}). Wagers are flow-in, not a house P&L event, so the
 * value is neutral `text-foreground` (no emerald/rose) — consistent with
 * how the single Wager hero rendered before the merge.
 */
function DualHero({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <div className="truncate text-lg font-bold tabular-nums text-foreground sm:text-xl">
        <AnimatedNumber value={value} format="currency" />
      </div>
      {hint && (
        <p className="text-[10px] leading-tight text-muted-foreground truncate">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Small labelled chip used in the 2/3-col breakdown grids. */
function PanelChip({
  label,
  value,
  format = "currency",
  tone = "neutral",
}: {
  label: string;
  value: number;
  format?: AnimatedNumberFormat;
  tone?: "neutral" | "emerald" | "rose";
}) {
  const border =
    tone === "emerald"
      ? "border-emerald-500/15"
      : tone === "rose"
        ? "border-rose-500/15"
        : "border-border/60";
  const valueColor =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  return (
    <div
      className={cn("rounded-md border bg-background/40 px-2 py-1.5 min-w-0", border)}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className={cn("text-xs font-semibold tabular-nums truncate", valueColor)}>
        <AnimatedNumber value={value} format={format} />
      </p>
    </div>
  );
}

/** Static window-label chip for the snapshot boxes (no toggle). */
function StaticWindowLabel({ label }: { label: string }) {
  return (
    <span className="rounded bg-background/50 px-1.5 py-0.5 text-tiny font-medium text-muted-foreground">
      {label}
    </span>
  );
}

/**
 * Client KPI section for /dashboard.
 *
 * Renders the period-bound KPI boxes (GGR, Wager [Total + Organic in one
 * merged box], Deposits, Withdrawals) with a per-box today/24h toggle, plus
 * the window-independent snapshot boxes (Total Users, FTDs 24h, Depositors,
 * Avg Deposit, Deposits/Hour, Avg RTP) reskinned onto the same panel design.
 *
 * The "today" payload is rendered eagerly (the active default window). The
 * rolling 24h payload is fetched LAZILY (one server action) the first time
 * any box is flipped to "24h" — active-timeframe-only, the 24h aggregate
 * never runs on a cold dashboard load. The fetched payload is cached in
 * state so subsequent toggles are instant, and EVERY period-bound box that
 * is on "24h" reads from the one shared payload (no per-box re-fetch).
 *
 * Each box keeps its OWN window mode, so the admin can compare e.g. GGR
 * today against Deposits 24h side by side.
 */
export function DashboardKpiSection({
  today,
  snapshot,
}: {
  today: KpiWindowPayload;
  snapshot: KpiSnapshotValues;
}) {
  // Lazily-loaded rolling-24h payload (null until first 24h toggle).
  const [h24, setH24] = useState<KpiWindowPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();

  // Per-box active window. Default every box to "today".
  const [modes, setModes] = useState<Record<string, DashboardKpiWindow>>({});

  const ensureH24 = useCallback(() => {
    if (h24 !== null || loading) return;
    setLoading(true);
    startTransition(async () => {
      try {
        const payload = await getDashboardKpiStatsAction("24h");
        setH24(payload);
      } finally {
        // On failure h24 stays null; the box falls back to the today value
        // (see `payloadFor`) and the toggle can be retried.
        setLoading(false);
      }
    });
  }, [h24, loading]);

  const pick = useCallback(
    (boxId: string, next: DashboardKpiWindow) => {
      setModes((m) => ({ ...m, [boxId]: next }));
      if (next === "24h") ensureH24();
    },
    [ensureH24],
  );

  // Resolve the payload a box should read from: its own active window's
  // payload when available, else the eager "today" payload (so a box on
  // "24h" while the lazy fetch is in flight, or after a failed fetch, shows
  // the today figure rather than a blank — the toggle still reflects intent
  // and re-fires on the next click).
  const payloadFor = (boxId: string): KpiWindowPayload => {
    const mode = modes[boxId] ?? "today";
    if (mode === "24h" && h24) return h24;
    return today;
  };
  const modeFor = (boxId: string): DashboardKpiWindow => modes[boxId] ?? "today";

  return (
    <div className="space-y-6">
      {/* Period-bound boxes — each with a today/24h toggle. Four boxes now
          (Wager + Organic Wager merged into one): GGR, Wager, Deposits,
          Withdrawals. Mobile-first: one column at <sm so the hero value +
          toggle never crush, 2-up at sm, 4 across at lg+ (fills the row
          cleanly — no orphan slot). */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        {/* GGR — gaming margin. Cyan identity; Info popover with the
            wager/payout legs + lazy top-contributors, scoped to the box's
            active window. */}
        {(() => {
          const p = payloadFor("ggr");
          const mode = modeFor("ggr");
          const isProfit = p.ggr >= 0;
          return (
            <KpiPanel
              title="GGR"
              tint="cyan"
              titleAdornment={
                <GgrBreakdownPopover
                  breakdown={p.ggrBreakdown}
                  periodLabel={p.windowLabel}
                  contributorScope={{ kind: "kpi", value: mode }}
                />
              }
              headerRight={
                <WindowToggle
                  active={mode}
                  loading={loading}
                  onPick={(w) => pick("ggr", w)}
                />
              }
              icon={isProfit ? TrendingUp : TrendingDown}
            >
              <SignedHero value={p.ggr} />
            </KpiPanel>
          );
        })()}

        {/* Wager — MERGED box. Shows total customer wager (creator-on-stream
            sessions excluded) AND organic wager (no creator-code users) as two
            headline figures, with the Packs/Battles/Upgrader split (of the
            total) below. Purple identity; one today/24h toggle drives both
            figures + the breakdown. */}
        {(() => {
          const p = payloadFor("wager");
          const mode = modeFor("wager");
          return (
            <KpiPanel
              title="Wager"
              tint="purple"
              headerRight={
                <WindowToggle
                  active={mode}
                  loading={loading}
                  onPick={(w) => pick("wager", w)}
                />
              }
            >
              {/* Two headline figures side by side: total wager + organic
                  wager. Each labelled so neither number is ambiguous. */}
              <div className="grid grid-cols-2 gap-3">
                <DualHero label="Total" value={p.wager} />
                <DualHero
                  label="Organic"
                  value={p.wagerOrganic}
                  hint="no creator-code users"
                />
              </div>
              {/* Packs / Battles / Upgrader split of the TOTAL wager. */}
              <div className="grid grid-cols-3 gap-1.5 -mx-0.5">
                <PanelChip label="Packs" value={p.wagerBreakdown.packs} />
                <PanelChip label="Battles" value={p.wagerBreakdown.battles} />
                <PanelChip label="Upgrader" value={p.wagerBreakdown.upgrader} />
              </div>
            </KpiPanel>
          );
        })()}

        {/* Deposits — fresh cash in (house gain → emerald identity). Chip
            row carries the count + per-deposit average for the window. */}
        {(() => {
          const p = payloadFor("deposits");
          const mode = modeFor("deposits");
          const avg = p.depositCount > 0 ? p.deposits / p.depositCount : 0;
          return (
            <KpiPanel
              title="Deposits"
              tint="emerald"
              headerRight={
                <WindowToggle
                  active={mode}
                  loading={loading}
                  onPick={(w) => pick("deposits", w)}
                />
              }
            >
              <PlainHero value={p.deposits} format="currency" />
              <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
                <PanelChip
                  label="Count"
                  value={p.depositCount}
                  format="number"
                  tone="emerald"
                />
                <PanelChip label="Avg" value={avg} tone="emerald" />
              </div>
            </KpiPanel>
          );
        })()}

        {/* Withdrawals — money out. Pink identity (matches the old tile);
            chip row carries the completed/shipped request count. */}
        {(() => {
          const p = payloadFor("withdrawals");
          const mode = modeFor("withdrawals");
          return (
            <KpiPanel
              title="Withdrawals"
              tint="pink"
              headerRight={
                <WindowToggle
                  active={mode}
                  loading={loading}
                  onPick={(w) => pick("withdrawals", w)}
                />
              }
            >
              <PlainHero value={p.withdrawals} format="currency" />
              <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
                <PanelChip
                  label="Count"
                  value={p.withdrawalCount}
                  format="number"
                  tone="rose"
                />
                <PanelChip label="Total" value={p.withdrawals} tone="rose" />
              </div>
            </KpiPanel>
          );
        })()}
      </div>

      {/* Snapshot boxes — lifetime / fixed-window figures that do NOT vary
          by the today/24h selection, so they carry a static window label
          (not a toggle). Reskinned onto the same panel design. */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <KpiPanel
          title="Total Users"
          tint="blue"
          icon={Users}
          headerRight={<StaticWindowLabel label="lifetime" />}
        >
          <PlainHero value={snapshot.usersTotal} format="number" />
          <p className="text-stat-label">
            +{formatNumber(snapshot.usersToday)} today, +
            {formatNumber(snapshot.usersWeek)} this week
          </p>
        </KpiPanel>

        <KpiPanel
          title="FTDs"
          tint="amber"
          icon={HandCoins}
          headerRight={<StaticWindowLabel label="24h" />}
        >
          <PlainHero value={snapshot.ftds24h} format="number" />
          <p className="text-stat-label">
            {formatCurrency(snapshot.ftdTotal24h)} total ·{" "}
            {formatCurrency(snapshot.ftdAvg24h)} avg
          </p>
        </KpiPanel>

        <KpiPanel
          title="Depositors"
          tint="purple"
          icon={BadgeDollarSign}
          headerRight={<StaticWindowLabel label="lifetime" />}
        >
          <PlainHero value={snapshot.uniqueDepositors} format="number" />
          <p className="text-stat-label">
            {snapshot.depositorsPctOfUsers != null
              ? `${snapshot.depositorsPctOfUsers.toFixed(1)}% of users have funded`
              : "Unique players who funded at least once"}
          </p>
        </KpiPanel>

        <KpiPanel
          title="Avg Deposit"
          tint="cyan"
          icon={Coins}
          headerRight={<StaticWindowLabel label="lifetime" />}
        >
          <PlainHero value={snapshot.avgDeposit} format="currency" />
          <p className="text-stat-label">Across all users (lifetime)</p>
        </KpiPanel>

        <KpiPanel
          title="Deposits / Hour"
          tint="emerald"
          icon={Gauge}
          headerRight={<StaticWindowLabel label="24h" />}
        >
          {/* Fractional rate — render directly (not AnimatedNumber, whose
              "number" format rounds to an integer and would drop the .1). */}
          <div className="text-stat-value truncate tabular-nums">
            {snapshot.depositsPerHour24h.toFixed(1)}
          </div>
          <p className="text-stat-label">
            last 24h avg · 7d {snapshot.depositsPerHour7d.toFixed(1)}/hr
          </p>
        </KpiPanel>

        <KpiPanel
          title="Avg RTP"
          tint="pink"
          icon={Percent}
          headerRight={<StaticWindowLabel label="lifetime" />}
        >
          <PlainHero value={snapshot.avgRtp} format="percent" />
        </KpiPanel>
      </div>
    </div>
  );
}
