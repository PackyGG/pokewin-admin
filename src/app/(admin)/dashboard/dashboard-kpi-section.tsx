"use client";

import { useCallback, useState, useTransition } from "react";
import {
  Percent,
  Coins,
  BadgeDollarSign,
  HandCoins,
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
 * that do NOT change with the today/24h toggle (FTDs 24h, Depositors, Avg
 * RTP, Avg P&L 7d). Computed once on the server from the eager "today" stats
 * and rendered without a toggle (an honest UI — no toggle on a box whose
 * number can't move).
 *
 * NOTE: the lifetime Total Users figure now lives in the admin top-bar pill
 * (to the LEFT of the GGR pill), and the Avg Deposit + Deposits/Hour tiles
 * were removed. `usersTotal/usersToday/usersWeek`, `avgDeposit`, and
 * `depositsPerHour24h/depositsPerHour7d` are therefore no longer rendered
 * here, but remain on the type because the server page still computes them
 * (e.g. `usersTotal` drives the Depositors "% of users" footer).
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
  /** Rolling 7d total realized house P&L. */
  totalPnl7d: number;
  /** totalPnl7d ÷ 7 — average per day in the window. */
  avgDailyPnl7d: number;
  /** Lifetime realized house P&L (balance-sheet snapshot). */
  totalPnlLifetime: number;
};

const PANEL_TINT = {
  cyan: "bg-cyan-500/10",
  purple: "bg-purple-500/10",
  emerald: "bg-emerald-500/10",
  pink: "bg-pink-500/10",
  blue: "bg-blue-500/10",
  amber: "bg-amber-500/10",
  rose: "bg-rose-500/10",
} as const;

type PanelTint = keyof typeof PANEL_TINT;

const ICON_TINT: Record<PanelTint, string> = {
  cyan: "text-cyan-400",
  purple: "text-purple-400",
  emerald: "text-emerald-400",
  pink: "text-pink-400",
  blue: "text-blue-400",
  amber: "text-amber-400",
  rose: "text-rose-400",
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
  // Long-form description for assistive tech — the visible chip
  // ("today" / "24h") is too terse to stand alone, especially in
  // a strip where multiple toggles share the page.
  const longLabel: Record<DashboardKpiWindow, string> = {
    today: "Today",
    "24h": "Last 24h",
  };
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
            aria-label={
              isActive
                ? `Showing ${longLabel[w]}`
                : `Switch to ${longLabel[w]}`
            }
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
 *
 * The shell stretches to fill its equal-height grid cell (`h-full` +
 * flex-col), and the optional {@link footer} (breakdown chip row /
 * subtitle) is pushed to the BOTTOM via `mt-auto`. That keeps every box's
 * chip row bottom-aligned at the same y across the strip regardless of how
 * much hero content sits above it — so Deposits/Withdrawals (short hero)
 * line up with the taller Wager box instead of floating up toward the
 * number. Alignment lives here in the shared shell, not per-box.
 */
function KpiPanel({
  title,
  titleAdornment,
  headerRight,
  icon: Icon,
  tint,
  children,
  footer,
}: {
  title: string;
  /** Rendered inline after the title (e.g. the GGR Info popover trigger). */
  titleAdornment?: React.ReactNode;
  /** Rendered at the right of the header (window toggle or static label). */
  headerRight?: React.ReactNode;
  icon?: LucideIcon;
  tint: PanelTint;
  /** Hero value block — sits at the top of the content area. */
  children: React.ReactNode;
  /**
   * Optional bottom block (breakdown chip row or subtitle). Pinned to the
   * bottom of the card via `mt-auto` so it aligns across every box.
   */
  footer?: React.ReactNode;
}) {
  return (
    <Card className={cn("h-full", PANEL_TINT[tint])}>
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
      <CardContent className="flex flex-1 flex-col">
        {/* Hero block stays at the top; its own space-y keeps the original
            internal spacing without applying a margin to the pinned footer
            (which would override mt-auto via the space-y selector). */}
        <div className="space-y-3">{children}</div>
        {footer && <div className="mt-auto pt-3">{footer}</div>}
      </CardContent>
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
      {/* Label bumped 10px → 11px so the eye can grip "Total" vs
          "Organic" without zoom. Value stays at text-lg/text-xl, hint
          bumped 10px → 11px to match. */}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <div className="truncate text-lg font-bold tabular-nums text-foreground sm:text-xl">
        <AnimatedNumber value={value} format="currency" />
      </div>
      {hint && (
        <p className="text-[11px] leading-tight text-muted-foreground truncate">
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
      {/* Label bumped 10px → 11px and value bumped text-xs → text-[13px]
          so each breakdown chip reads cleanly at a glance — at 10px/12px
          the chip text was a smudge next to the hero number above it. */}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className={cn("text-[13px] font-semibold tabular-nums truncate", valueColor)}>
        <AnimatedNumber value={value} format={format} />
      </p>
    </div>
  );
}

/**
 * bps → trimmed percent string. 45 → "0.45%", 7.5 → "0.075%", 50 → "0.5%".
 * Up to 3 decimals, trailing zeros stripped. Used by the Crypto Fee box's
 * "avg ~0.45% / ~0.075%" subtitle.
 */
function formatBpsPct(bps: number): string {
  const pct = bps / 100;
  const s = pct.toFixed(3).replace(/\.?0+$/, "");
  return `${s}%`;
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
 * merged box], Deposits/Withdrawals [merged into one single tile]) with a
 * per-box today/24h toggle, plus the window-independent snapshot boxes (FTDs
 * 24h, Depositors, Avg RTP, Avg P&L 7d) reskinned onto the same panel design.
 * (Total Users moved to the top-bar pill; Avg Deposit + Deposits/Hour tiles
 * were removed.)
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
/**
 * Crypto-fee box payload. Mirrors the {@link CryptoFeeCounter} query return
 * (serializable primitives only — no function props cross the RSC boundary).
 * `available: false` renders the muted slot. The total is the monotonic
 * high-water estimate counted since `sinceLabel`; it's always positive.
 */
export type CryptoFeeKpi = {
  available: boolean;
  totalFeeUsd: number;
  depositFeeUsd: number;
  withdrawalFeeUsd: number;
  depositBps: number;
  withdrawalBps: number;
  sinceLabel: string;
};

export function DashboardKpiSection({
  today,
  snapshot,
  cryptoFee,
}: {
  today: KpiWindowPayload;
  snapshot: KpiSnapshotValues;
  cryptoFee: CryptoFeeKpi;
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
      {/* Period-bound boxes — each with a today/24h toggle. FOUR boxes now:
          GGR, Deposits/Withdrawals (merged into one single tile), Wager
          (Total + Organic merged), and the Crypto Fee counter (anchored
          monotonic estimate — NOT period-bound, carries a static "since"
          label instead of a toggle). Mobile-first: one column at <sm so the
          hero value + toggle never crush; 2-up at sm; 4 across at xl where
          there's width for all four without crushing. */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
        {/* GGR — industry definition (`wager − payouts`): what we won from
            the games today (packs, battles, upgrader), pre-rewards,
            pre-promo. Cyan identity; Info popover surfaces the per-leg
            breakdown + lazy top-contributors + a secondary "Cash P&L"
            (deposits − withdrawals) reference, scoped to the box's active
            window. House-POV: positive → house gain → emerald; negative →
            house loss → rose (handled by SignedHero). */}
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
                  cashGgr={p.cashGgr}
                  deposits={p.deposits}
                  withdrawals={p.withdrawals}
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
              {/* Subtitle/tooltip — restates the industry GGR definition so
                  the headline number is unambiguous next to the popover's
                  secondary Cash P&L figure. */}
              <p className="text-tiny text-muted-foreground leading-snug">
                gross gaming margin (wager − payouts on packs, battles,
                upgrader, double down). Pre-rewards, pre-promo.
              </p>
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
              footer={
                /* Packs / Battles / Upgrader split of the TOTAL wager.
                   Negative inline margin only at sm+ where the panel has
                   the room for it; at <sm (320–375px) keep it at 0 so the
                   chips don't get clipped at the right edge of the card. */
                <div className="grid grid-cols-3 gap-1.5 sm:-mx-0.5">
                  <PanelChip label="Packs" value={p.wagerBreakdown.packs} />
                  <PanelChip label="Battles" value={p.wagerBreakdown.battles} />
                  <PanelChip label="Upgrader" value={p.wagerBreakdown.upgrader} />
                </div>
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
            </KpiPanel>
          );
        })()}

        {/* Cash flow — MERGED box (Deposits + Withdrawals) held to a SINGLE
            tile footprint. Two stacked halves inside one KpiPanel: Deposits
            (emerald, House-POV: fresh cash in = house gain = green) on top,
            Withdrawals (rose, House-POV: money out = house loss = red)
            below. One shared today/24h toggle drives BOTH figures (both read
            the same window payload). Neutral "blue" tint on the shell so the
            box itself doesn't bias one leg's color over the other — the
            per-leg color lives on the values/counts inside. */}
        {(() => {
          const p = payloadFor("cashflow");
          const mode = modeFor("cashflow");
          return (
            <KpiPanel
              title="Deposits / Withdrawals"
              tint="blue"
              headerRight={
                <WindowToggle
                  active={mode}
                  loading={loading}
                  onPick={(w) => pick("cashflow", w)}
                />
              }
            >
              {/* Two compact halves stacked to fit one single-size tile.
                  Each half: uppercase label + emerald/rose count chip on the
                  header row, hero $ value below. A hairline divider keeps the
                  two legs visually distinct without a second card. */}
              <div className="space-y-2.5">
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                      Deposits
                    </p>
                    <p className="text-[11px] font-medium tabular-nums text-muted-foreground shrink-0">
                      {formatNumber(p.depositCount)} tx
                    </p>
                  </div>
                  <div className="truncate text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400 sm:text-xl">
                    <AnimatedNumber value={p.deposits} format="currency" />
                  </div>
                </div>
                <div className="border-t border-border/50" />
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                      Withdrawals
                    </p>
                    <p className="text-[11px] font-medium tabular-nums text-muted-foreground shrink-0">
                      {formatNumber(p.withdrawalCount)} tx
                    </p>
                  </div>
                  <div className="truncate text-lg font-bold tabular-nums text-rose-600 dark:text-rose-400 sm:text-xl">
                    <AnimatedNumber value={p.withdrawals} format="currency" />
                  </div>
                </div>
              </div>
            </KpiPanel>
          );
        })()}

        {/* Crypto Fee — house profit from the hidden crypto exchange-rate fee,
            an ANCHORED + MONOTONIC estimate counted since the seed anchor (so
            it starts near $0 and only counts up). Emerald identity (House-POV:
            a dollar we make = green). Always positive. Not period-bound, so it
            carries a static "est · since …" label instead of a today/24h
            toggle. When unavailable (admin counter row missing) the muted
            slot renders so the row still holds five cells. */}
        {cryptoFee.available ? (
          <KpiPanel
            title="Crypto Fee"
            tint="emerald"
            icon={Coins}
            headerRight={
              <StaticWindowLabel label={`est · ${cryptoFee.sinceLabel}`} />
            }
            footer={
              <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-1.5 sm:-mx-0.5">
                  <PanelChip
                    label="Deposits"
                    value={cryptoFee.depositFeeUsd}
                    tone="emerald"
                  />
                  <PanelChip
                    label="Withdrawals"
                    value={cryptoFee.withdrawalFeeUsd}
                    tone="emerald"
                  />
                </div>
                {/* Bumped 10px → 11px so the bps caption is readable
                    next to the chip values it explains. */}
                <p className="text-[11px] leading-snug text-muted-foreground">
                  avg ~{formatBpsPct(cryptoFee.depositBps)} deposits · ~
                  {formatBpsPct(cryptoFee.withdrawalBps)} withdrawals
                </p>
              </div>
            }
          >
            {/* Always-positive house profit → emerald hero (count-up). */}
            <div className="text-stat-value truncate text-emerald-600 dark:text-emerald-300">
              <AnimatedNumber value={cryptoFee.totalFeeUsd} format="currency" />
            </div>
          </KpiPanel>
        ) : (
          <KpiPanel
            title="Crypto Fee"
            tint="emerald"
            icon={Coins}
            headerRight={<StaticWindowLabel label="est" />}
          >
            <div className="text-stat-value truncate text-muted-foreground/70">
              —
            </div>
            <p className="text-tiny text-muted-foreground">
              Crypto fee data not available.
            </p>
          </KpiPanel>
        )}
      </div>

      {/* Snapshot boxes — lifetime / fixed-window figures that do NOT vary
          by the today/24h selection, so they carry a static window label
          (not a toggle). Reskinned onto the same panel design. */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-8">
        <KpiPanel
          title="FTDs"
          tint="amber"
          icon={HandCoins}
          headerRight={<StaticWindowLabel label="24h" />}
          footer={
            <p className="text-stat-label">
              {formatCurrency(snapshot.ftdTotal24h)} total ·{" "}
              {formatCurrency(snapshot.ftdAvg24h)} avg
            </p>
          }
        >
          <PlainHero value={snapshot.ftds24h} format="number" />
        </KpiPanel>

        <KpiPanel
          title="Depositors"
          tint="purple"
          icon={BadgeDollarSign}
          headerRight={<StaticWindowLabel label="lifetime" />}
          footer={
            <p className="text-stat-label">
              {snapshot.depositorsPctOfUsers != null
                ? `${snapshot.depositorsPctOfUsers.toFixed(1)}% of users have funded`
                : "Unique players who funded at least once"}
            </p>
          }
        >
          <PlainHero value={snapshot.uniqueDepositors} format="number" />
        </KpiPanel>

        <KpiPanel
          title="Avg RTP"
          tint="pink"
          icon={Percent}
          headerRight={<StaticWindowLabel label="lifetime" />}
        >
          <PlainHero value={snapshot.avgRtp} format="percent" />
        </KpiPanel>

        {(() => {
          const isProfit = snapshot.avgDailyPnl7d >= 0;
          return (
            <KpiPanel
              title="Avg P&L"
              tint={isProfit ? "emerald" : "rose"}
              icon={isProfit ? TrendingUp : TrendingDown}
              headerRight={<StaticWindowLabel label="7d" />}
              footer={
                <p className="text-stat-label">
                  per day · {formatCurrency(snapshot.totalPnl7d)} rolling 7d
                </p>
              }
            >
              <SignedHero value={snapshot.avgDailyPnl7d} />
            </KpiPanel>
          );
        })()}

        {(() => {
          const isProfit = snapshot.totalPnlLifetime >= 0;
          return (
            <KpiPanel
              title="Total P&L"
              tint={isProfit ? "emerald" : "rose"}
              icon={isProfit ? TrendingUp : TrendingDown}
              headerRight={<StaticWindowLabel label="lifetime" />}
              footer={
                <p className="text-stat-label">
                  Balance-sheet snapshot · incl. unclaimed rakeback
                </p>
              }
            >
              <SignedHero value={snapshot.totalPnlLifetime} />
            </KpiPanel>
          );
        })()}
      </div>
    </div>
  );
}
