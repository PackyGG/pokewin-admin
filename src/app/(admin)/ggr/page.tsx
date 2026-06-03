import { Suspense } from "react";
import Link from "next/link";
import {
  TrendingUp,
  TrendingDown,
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins,
  Users,
  Gift,
  Repeat,
  Percent,
  Activity,
  Equal,
  Minus,
  Package,
  Swords,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  StatPanel,
  PanelRow,
  SectionHeading,
} from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import {
  getGgrPageData,
  getGgrTopContributors,
  ggrWindowToMetricWindow,
  type GgrLedgerTypeRow,
  type GgrTopContributorRow,
} from "@/lib/queries/ggr";
import { describeLedgerType } from "@/lib/queries/_wager-payout-descriptions";
import { ExportButton } from "@/components/export-button";

import { GgrWindowSwitch } from "./ggr-window-switch";
import { GgrWindowProvider, GgrBodyPending } from "./ggr-window-shell";

export const metadata = { title: "GGR Breakdown" };

// The /ggr page exposes the rolling 24h / 3d / 7d windows plus the
// `all` (Lifetime) bucket from the canonical `DashboardPeriod` set.
// `all` maps through `ggrWindowToMetricWindow("all")` to an unbounded
// (server-side capped) lookback. Anything else on `?window=` normalises
// to the default.
type GgrWindow = Extract<DashboardPeriod, "24h" | "3d" | "7d" | "all">;
const SUPPORTED_WINDOWS = ["24h", "3d", "7d", "all"] as const satisfies readonly GgrWindow[];
const DEFAULT_GGR_WINDOW: GgrWindow = "24h";

function parseGgrWindow(value: string | undefined): GgrWindow {
  if (!value) return DEFAULT_GGR_WINDOW;
  return (SUPPORTED_WINDOWS as readonly string[]).includes(value)
    ? (value as GgrWindow)
    : DEFAULT_GGR_WINDOW;
}

/** Render an empirical 0..1 ratio as a percent, or "n/a" below sample. */
function formatRatioPct(ratio: number | null): string {
  if (ratio === null) return "n/a";
  return `${(ratio * 100).toFixed(2)}%`;
}

/**
 * `/ggr` — full GGR breakdown page. Sits in the Overview sidebar group
 * as the deep-dive companion to the headline GGR card on /dashboard.
 *
 * Rebuilt on the canonical `@/lib/metrics` layer (the page's own data
 * layer lives in `@/lib/queries/ggr`). The breakdown is organised into
 * the THREE canonical groups the metric partition defines:
 *
 *   1. Gaming payouts — the payout side of GGR (inventory pack/battle
 *      wins + battle_refund + upgrader payout), shown against the wager
 *      side so GGR = wager − gamingPayout is visible.
 *   2. Neutral conversions — card_sale / voucher_redeemed / exchanges.
 *      Disposals of value the user already owns; NOT house cost, NOT
 *      losses — clearly labelled as such and excluded from GGR/NGR.
 *   3. Reward giveback — deposit_bonus / rakeback / race prizes / rain /
 *      etc. House-funded incentive spend that reduces NGR (not GGR).
 *
 * GGR/NGR are upgrader-INCLUSIVE (from `upgrader_games`), matching the
 * game-economics figure on /insights/games. Because the breakdown reads
 * the central type SETS, the imminent voucher reclassification
 * (voucher_redeemed → neutral, battle_excess_to_voucher → gaming)
 * propagates here automatically.
 *
 * Window state lives in `?window=` so the URL is shareable. Default is
 * `24h`. The body is wrapped in Suspense so flipping windows shows a
 * skeleton instead of freezing on stale numbers.
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
    <GgrWindowProvider defaultWindow={DEFAULT_GGR_WINDOW}>
      <div className="space-y-6">
        <PageHero>
          <PageHeroIdentity
            icon={TrendingUp}
            accent="cyan"
            title="GGR Breakdown"
            subtitle="Gaming margin decomposed into its canonical groups — gaming payouts, neutral conversions, and reward giveback. Upgrader included; all creator play excluded on both sides (same scope as Daily P&L)."
            action={
              <>
                <GgrWindowSwitch />
                <ExportButton page="ggr" params={{ window: ggrWindow }} />
              </>
            }
          />
        </PageHero>

        {/* The body is wrapped in `GgrBodyPending` so a window switch dims
            the figures + shows a delay-gated overlay spinner (driven by the
            shared `useTransition` pending flag) — the switch never looks
            frozen. The Suspense key includes the window so the first load of
            a window shows the shape-matched skeleton instead of leaving
            stale numbers up while the next window's data resolves. */}
        <GgrBodyPending>
          <Suspense
            key={ggrWindow}
            fallback={
              <div className="space-y-6">
                <div className="space-y-3">
                  <KpiStripSkeleton count={6} />
                  <KpiStripSkeleton count={3} />
                </div>
                <div className="space-y-3">
                  <SectionHeadingSkeleton titleWidth={180} />
                  <LedgerTypeGridSkeleton count={3} />
                </div>
                {/* NGR panel skeleton — a single wide card. */}
                <div className="space-y-3">
                  <SectionHeadingSkeleton titleWidth={200} />
                  <NgrPanelSkeleton />
                </div>
                <div className="space-y-3">
                  <SectionHeadingSkeleton titleWidth={200} />
                  <LedgerTypeGridSkeleton count={4} />
                </div>
                <div className="space-y-3">
                  <SectionHeadingSkeleton titleWidth={180} />
                  <LedgerTypeGridSkeleton count={6} />
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
        </GgrBodyPending>
      </div>
    </GgrWindowProvider>
  );
}

// ─── Body ────────────────────────────────────────────────────────────

/**
 * Streaming body — fetches the canonical page payload and the top-10
 * contributor list for the active window in parallel, then renders the
 * KPI strip + the three breakdown groups + the contributor table.
 */
async function GgrBody({
  ggrWindow,
  periodLabel,
}: {
  ggrWindow: GgrWindow;
  periodLabel: string;
}) {
  const metricWindow = ggrWindowToMetricWindow(ggrWindow);
  const [data, contributors] = await Promise.all([
    getGgrPageData(metricWindow),
    getGgrTopContributors(metricWindow, 10),
  ]);

  return (
    <FadeIn className="space-y-6">
      <div className="space-y-3">
        <KpiStrip data={data} periodLabel={periodLabel} />
        {/* Per-category wager split — sits directly below the headline
            strip. Volume metric (not P&L) → neutral/blue accents. The
            three reconcile with the headline Wager tile by construction
            (packs + battles + upgrader = total gaming wager). */}
        <CategoryWagerStrip data={data} periodLabel={periodLabel} />
      </div>

      {/* ── Group 1 — Gaming payouts (the GGR engine) ───────────────── */}
      <section className="space-y-3">
        <SectionHeading
          icon={Coins}
          title={`Gaming payouts · ${periodLabel}`}
        />
        <GamingGroup data={data} />
      </section>

      {/* ── Group 2 — Neutral conversions (not house cost) ──────────── */}
      <section className="space-y-3">
        <SectionHeading
          icon={Repeat}
          title={`Neutral conversions · ${periodLabel}`}
        />
        <NeutralGroup rows={data.neutral.rows} total={data.neutral.total} />
      </section>

      {/* ── Group 3 — Reward giveback (reduces NGR) ─────────────────── */}
      <section className="space-y-3">
        <SectionHeading
          icon={Gift}
          title={`Reward giveback · ${periodLabel}`}
        />
        <RewardGroup data={data} />
      </section>

      {/* ── Net Gaming Revenue (NGR) — the bottom line ──────────────── */}
      {/* Pulled out of the headline strip into its own clearly-separated
          panel so the GGR → (minus reward giveback) → NGR flow reads
          explicitly, instead of NGR being a thin tile lost in the strip. */}
      <section className="space-y-3">
        <SectionHeading
          icon={Coins}
          title={`Net Gaming Revenue · ${periodLabel}`}
        />
        <NgrPanel data={data} periodLabel={periodLabel} />
      </section>

      {/* ── Top contributors ────────────────────────────────────────── */}
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

/**
 * 6-tile headline strip. Wager (purple — identity/flow tint), Gaming
 * payout (rose — money out), GGR + NGR (house-POV: positive emerald,
 * negative rose), House edge (blue — informational), Bets (amber).
 */
function KpiStrip({
  data,
  periodLabel,
}: {
  data: Awaited<ReturnType<typeof getGgrPageData>>;
  periodLabel: string;
}) {
  const { headline } = data;
  const ggrUp = headline.ggr >= 0;
  const ngrUp = headline.ngr >= 0;
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <KpiTile
        label="Wager"
        value={formatCurrency(headline.wager)}
        sub={`Pack + battle + upgrader · ${periodLabel}`}
        icon={ArrowDownToLine}
        accent="purple"
      />
      <KpiTile
        label="Gaming Payout"
        value={formatCurrency(headline.gamingPayout)}
        sub="Cards + battle refund + upgrader"
        icon={ArrowUpFromLine}
        accent="rose"
      />
      <KpiTile
        label="GGR (Wager − Payout)"
        value={`${ggrUp ? "+" : "−"}${formatCurrency(Math.abs(headline.ggr))}`}
        sub={ggrUp ? "House profit" : "House loss"}
        icon={ggrUp ? TrendingUp : TrendingDown}
        accent={ggrUp ? "emerald" : "rose"}
      />
      <KpiTile
        label="NGR (GGR − Rewards)"
        value={`${ngrUp ? "+" : "−"}${formatCurrency(Math.abs(headline.ngr))}`}
        sub="Net of reward giveback"
        icon={Coins}
        accent={ngrUp ? "emerald" : "rose"}
      />
      <KpiTile
        label="House Edge"
        value={formatRatioPct(headline.houseEdge)}
        sub="GGR ÷ wager"
        icon={Percent}
        accent="blue"
      />
      <KpiTile
        label="Bets"
        value={formatNumber(headline.bets)}
        sub="Settled gaming plays"
        icon={Activity}
        accent="amber"
      />
    </div>
  );
}

// ─── Per-category wager strip ────────────────────────────────────────

/**
 * Second strip of 3 tiles directly under the headline — the per-category
 * gaming WAGER (Packs / Battles / Upgrader) for the active window. Same
 * `KpiTile` component and sizing as the headline strip.
 *
 * Wager is a VOLUME metric, not P&L, so these use neutral/informational
 * accents (purple / cyan / blue — the page's flow/identity tints), never
 * emerald/rose, so they never read as house profit/loss. The three sum to
 * the headline Wager tile by construction (packs + battles + upgrader =
 * total gaming wager). Upgrader degrades to $0 when `upgrader_games` is
 * absent on the connected DB.
 */
function CategoryWagerStrip({
  data,
  periodLabel,
}: {
  data: Awaited<ReturnType<typeof getGgrPageData>>;
  periodLabel: string;
}) {
  const { packs, battles, upgrader } = data.categoryWager;
  const playSub = (count: number) => `${formatNumber(count)} plays · ${periodLabel}`;
  return (
    <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
      <KpiTile
        label="Packs wager"
        value={formatCurrency(packs.wager)}
        sub={playSub(packs.count)}
        icon={Package}
        accent="purple"
      />
      <KpiTile
        label="Battles wager"
        value={formatCurrency(battles.wager)}
        sub={playSub(battles.count)}
        icon={Swords}
        accent="cyan"
      />
      <KpiTile
        label="Upgrader wager"
        value={data.upgraderAvailable ? formatCurrency(upgrader.wager) : "—"}
        sub={
          data.upgraderAvailable
            ? playSub(upgrader.count)
            : "Unavailable on this database"
        }
        icon={TrendingUp}
        accent="blue"
      />
    </div>
  );
}

// ─── Group 1 — Gaming payouts ────────────────────────────────────────

/**
 * The GGR engine, shown as the identity wager − payout = GGR.
 *
 * Wager is the house take from staking (emerald — house gain). Each
 * payout leg is money returned to the user on the games (rose — house
 * cost). The resulting GGR is house-POV (emerald up / rose down).
 */
function GamingGroup({
  data,
}: {
  data: Awaited<ReturnType<typeof getGgrPageData>>;
}) {
  const { gaming } = data;
  const ggrUp = gaming.ggr >= 0;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {/* Wager — house collected from staking → emerald */}
      <GamingCell
        label="Game wagers"
        sub="Pack + battle + upgrader, borrow-corrected"
        value={formatCurrency(gaming.wager)}
        valueColor="text-emerald-600 dark:text-emerald-400"
        accentBg="bg-emerald-500/5"
        iconBg="bg-emerald-500/15"
        icon={<Coins className="size-4 text-emerald-500" />}
      />

      {/* Payout legs — money out → rose */}
      <div className="rounded-xl border bg-rose-500/5 p-4 sm:rounded-2xl sm:p-5">
        <div className="flex items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-rose-500/15">
            <Minus className="size-4 text-rose-500" />
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Game payouts
          </p>
        </div>
        <p className="mt-2 truncate text-lg font-bold tabular-nums text-rose-600 dark:text-rose-400">
          −{formatCurrency(gaming.payoutTotal)}
        </p>
        <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {gaming.legs.map((leg) => (
            <div
              key={leg.label}
              className="flex items-center justify-between gap-3 text-[11px] tabular-nums text-muted-foreground"
            >
              <span className="min-w-0 truncate">{leg.label}</span>
              <span className="shrink-0">{formatCurrency(leg.total)}</span>
            </div>
          ))}
          {!data.upgraderAvailable && (
            <p className="pt-1 text-[10px] italic text-muted-foreground/60">
              Upgrader unavailable on this database.
            </p>
          )}
        </div>
      </div>

      {/* GGR — house-POV result */}
      <GamingCell
        label="Gross Gaming Revenue"
        sub={ggrUp ? "House profit on games" : "House loss on games"}
        value={`${ggrUp ? "+" : "−"}${formatCurrency(Math.abs(gaming.ggr))}`}
        valueColor={
          ggrUp
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400"
        }
        accentBg={ggrUp ? "bg-emerald-500/5" : "bg-rose-500/5"}
        iconBg={ggrUp ? "bg-emerald-500/15" : "bg-rose-500/15"}
        icon={
          ggrUp ? (
            <Equal className="size-4 text-emerald-500" />
          ) : (
            <Equal className="size-4 text-rose-500" />
          )
        }
      />
    </div>
  );
}

function GamingCell({
  label,
  sub,
  value,
  valueColor,
  accentBg,
  iconBg,
  icon,
}: {
  label: string;
  sub: string;
  value: string;
  valueColor: string;
  accentBg: string;
  iconBg: string;
  icon: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border p-4 sm:rounded-2xl sm:p-5", accentBg)}>
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full",
            iconBg,
          )}
        >
          {icon}
        </div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      </div>
      <p className={cn("mt-2 truncate text-lg font-bold tabular-nums", valueColor)}>
        {value}
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

// ─── Group 2 — Neutral conversions ───────────────────────────────────

/**
 * Inventory↔balance / voucher↔balance conversions of value the user
 * ALREADY owns. These are net-NEUTRAL to GGR and NGR — they are NOT a
 * house cost and NOT a loss. Tinted muted/blue (informational) so they
 * never read as red giveback or green house gain.
 */
function NeutralGroup({
  rows,
  total,
}: {
  rows: GgrLedgerTypeRow[];
  total: number;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        These are user conversions, <span className="font-semibold">not house cost</span>.
        Cards sold back, vouchers redeemed, and exchanges just change the
        form value is held in — they are excluded from GGR and NGR.
        {total > 0 && (
          <span className="ml-1">
            Total moved this window: {formatCurrency(total)}.
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptySection label="No conversions in this window." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <LedgerTypeCard key={row.type} row={row} kind="neutral" bucketTotal={total} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Group 3 — Reward giveback ───────────────────────────────────────

/**
 * House-funded incentive spend (`REWARD_PAYOUT_TYPES`). The user receives
 * value the house funded → user gain = house cost → rose. Reduces NGR
 * (not GGR).
 *
 * Rain is shown at its GROSS magnitude (what users received), but only
 * the NET house slice (`max(0, rain_win − rain_tip)`) reduces NGR — the
 * footer surfaces the reconciliation so the gross rows and the NGR delta
 * don't look inconsistent.
 */
function RewardGroup({
  data,
}: {
  data: Awaited<ReturnType<typeof getGgrPageData>>;
}) {
  const { reward } = data;
  const rainNetted = reward.rainWinTotal > 0 && reward.rainTipTotal > 0;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3 text-xs text-muted-foreground">
        House-funded giveaways the user received — bonuses, rakeback, race
        prizes, rain, and affiliate payouts. These reduce{" "}
        <span className="font-semibold">NGR</span> (not GGR).{" "}
        <span className="text-rose-600 dark:text-rose-400">
          −{formatCurrency(reward.appliedToNgr)}
        </span>{" "}
        applied to NGR this window.
        {rainNetted && (
          <span className="ml-1">
            Rain shown gross ({formatCurrency(reward.rainWinTotal)}); only the
            net house slice {formatCurrency(reward.rainHouseCost)} (gross −{" "}
            {formatCurrency(reward.rainTipTotal)} tips) reduced NGR.
          </span>
        )}
      </div>
      {reward.rows.length === 0 ? (
        <EmptySection label="No reward giveback in this window." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {reward.rows.map((row) => (
            <LedgerTypeCard
              key={row.type}
              row={row}
              kind="reward"
              bucketTotal={reward.total}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Net Gaming Revenue (NGR) panel ──────────────────────────────────

/**
 * Dedicated NGR panel — the clearly-separated bottom line of the gaming
 * margin, sitting below the reward-giveback group so the flow reads:
 *
 *   GGR  − reward giveback (applied to NGR)  =  NGR
 *
 * NGR was previously only a thin tile in the headline strip; here it gets
 * its own `StatPanel` with the full GGR → minus rewards → NGR waterfall as
 * breakdown rows, plus a margin readout (NGR ÷ wager).
 *
 * House-POV colouring (strict):
 *   • GGR / NGR positive → house profit → emerald; negative → rose.
 *   • Reward giveback is house cost (user received value) → rose, −$.
 *
 * Every figure is sourced from the canonical `getGgrPageData` payload
 * (`headline.ggr`, `reward.appliedToNgr`, `reward.costExclRain`,
 * `reward.rainHouseCost`, `headline.ngr`) so the panel reconciles with the
 * headline NGR tile by construction.
 */
function NgrPanel({
  data,
  periodLabel,
}: {
  data: Awaited<ReturnType<typeof getGgrPageData>>;
  periodLabel: string;
}) {
  const { headline, reward } = data;
  const ggrUp = headline.ggr >= 0;
  const ngrUp = headline.ngr >= 0;
  // House-POV: a positive bottom line is house profit → emerald accent;
  // a negative one is a house loss → rose.
  const accent = ngrUp ? "emerald" : "rose";
  const ngrColor = ngrUp
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const ggrColor = ggrUp
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  // NGR as a share of wager — informational margin readout (blue).
  const ngrPctOfWager =
    headline.wager > 0 ? (headline.ngr / headline.wager) * 100 : null;
  // Only surface the rain split when rain actually netted (gross win and
  // tips both present), mirroring the reward group's reconciliation note.
  const rainNetted = reward.rainWinTotal > 0 && reward.rainTipTotal > 0;

  return (
    <StatPanel title="Net Gaming Revenue (NGR)" icon={Coins} accent={accent}>
      {/* Hero NGR figure + the GGR − rewards = NGR identity as a sub-line. */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className={cn("truncate text-3xl font-bold tabular-nums sm:text-4xl", ngrColor)}>
            {ngrUp ? "+" : "−"}
            {formatCurrency(Math.abs(headline.ngr))}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {ngrUp ? "House profit after giveaways" : "House loss after giveaways"}
            {" · "}
            {periodLabel}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            NGR margin
          </p>
          <p className="text-lg font-bold tabular-nums text-blue-600 dark:text-blue-400">
            {ngrPctOfWager === null ? "n/a" : `${ngrPctOfWager.toFixed(2)}%`}
          </p>
          <p className="text-[10px] text-muted-foreground">of wager</p>
        </div>
      </div>

      {/* The waterfall: GGR → minus reward giveback → NGR. */}
      <div className="mt-3 border-t border-border/60 pt-2">
        <PanelRow
          label="Gross Gaming Revenue (GGR)"
          value={`${ggrUp ? "+" : "−"}${formatCurrency(Math.abs(headline.ggr))}`}
          valueClassName={ggrColor}
        />
        {reward.costExclRain > 0 && (
          <PanelRow
            label="− Reward giveback (excl. rain)"
            value={`−${formatCurrency(reward.costExclRain)}`}
            valueClassName="text-rose-600 dark:text-rose-400"
          />
        )}
        {reward.rainHouseCost > 0 && (
          <PanelRow
            label={
              rainNetted ? "− Rain (net house slice)" : "− Rain prizes"
            }
            value={`−${formatCurrency(reward.rainHouseCost)}`}
            valueClassName="text-rose-600 dark:text-rose-400"
          />
        )}
        {reward.appliedToNgr === 0 && (
          <PanelRow
            label="− Reward giveback"
            value={formatCurrency(0)}
            valueClassName="text-muted-foreground"
          />
        )}
        <div className="mt-1 border-t border-border/60 pt-1">
          <PanelRow
            label="= Net Gaming Revenue (NGR)"
            value={`${ngrUp ? "+" : "−"}${formatCurrency(Math.abs(headline.ngr))}`}
            valueClassName={cn("font-bold", ngrColor)}
          />
        </div>
      </div>
    </StatPanel>
  );
}

// ─── Per-type card (neutral / reward) ────────────────────────────────

/**
 * Card for one ledger type — hero number, label + kind badge, canonical
 * description, and a footer with the raw type name + percentage of its
 * bucket total.
 *
 * Colouring is house-POV:
 *   • neutral — muted/blue (informational; not cost, not gain)
 *   • reward  — rose (user received house-funded value = house cost)
 */
function LedgerTypeCard({
  row,
  kind,
  bucketTotal,
}: {
  row: GgrLedgerTypeRow;
  kind: "neutral" | "reward";
  bucketTotal: number;
}) {
  const desc = describeLedgerType(row.type);
  // `row.label` overrides the type-derived label for per-row carve-outs
  // (e.g. the manual admin-voucher slice split out of `voucher_redeemed`),
  // where the raw type name alone would be ambiguous across groups.
  const label = row.label ?? desc.label;
  const pct = bucketTotal > 0 ? Math.round((row.total / bucketTotal) * 100) : 0;
  const isReward = kind === "reward";
  const valueColor = isReward
    ? "text-rose-600 dark:text-rose-400"
    : "text-blue-600 dark:text-blue-400";
  const badgeLabel = isReward ? "Giveback" : "Neutral";
  const badgeColor = isReward
    ? "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400"
    : "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400";

  return (
    <div className="surface-sheen surface-raise group relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:rounded-2xl sm:p-5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">
            {label}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
            {row.type}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            badgeColor,
          )}
        >
          {badgeLabel}
        </span>
      </div>

      <p className={cn("mt-3 truncate text-2xl font-bold tabular-nums", valueColor)}>
        {isReward ? "−" : ""}
        {formatCurrency(row.total)}
      </p>

      {desc.description ? (
        <p className="mt-2 line-clamp-3 text-xs leading-snug text-muted-foreground">
          {desc.description}
        </p>
      ) : (
        <p className="mt-2 text-xs italic leading-snug text-muted-foreground/60">
          No description on file for this ledger type.
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-2 text-[11px] tabular-nums text-muted-foreground">
        <span>
          {pct}% of {isReward ? "giveback" : "conversions"}
        </span>
        <span>{formatCurrency(row.total)}</span>
      </div>
    </div>
  );
}

// ─── Skeletons ──────────────────────────────────────────────────────

/**
 * Skeleton mirror of the per-type card grid. Reproduces the same 1 / 2 /
 * 3-column responsive grid + the card's internal layout so the swap into
 * real content doesn't jank.
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

/**
 * Skeleton mirror of the NGR panel — one wide `StatPanel`-shaped card with
 * the hero figure + margin readout row and the GGR → rewards → NGR
 * breakdown rows, so the swap into the real panel doesn't shift layout.
 */
function NgrPanelSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-4 sm:rounded-2xl sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1.5">
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-3 w-52" />
        </div>
        <div className="space-y-1.5 text-right">
          <Skeleton className="ml-auto h-3 w-20" />
          <Skeleton className="ml-auto h-5 w-16" />
        </div>
      </div>
      <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3.5 w-20" />
          </div>
        ))}
      </div>
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
 * with house-POV colouring: positive net = user lost = house profited =
 * emerald; negative = user won = house lost = rose. Upgrader is folded
 * into both legs so contributors line up with the headline.
 *
 * Each row links to /users/<id>. Users with no username (deleted /
 * pending) fall back to a truncated id.
 */
function TopContributorsTable({ rows }: { rows: GgrTopContributorRow[] }) {
  if (rows.length === 0) {
    return <EmptySection label="No contributing activity in this window." />;
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
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
