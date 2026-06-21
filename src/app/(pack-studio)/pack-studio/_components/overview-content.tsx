import type * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Gauge,
  Layers,
  Percent,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";

import {
  KpiTile,
  PanelRow,
  SectionHeading,
  StatPanel,
  type AccentColor,
} from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getPackStudioOverview,
  type ComplianceAlert,
} from "../_queries/overview";
import {
  DEFAULT_EDGE_CEILING,
  DEFAULT_EDGE_FLOOR,
} from "../_lib/risk-config";
import { TierDistributionChart } from "./tier-distribution-chart";

/** Format a 0..1 edge fraction as a percent string (e.g. 0.1099 → "10.99%"). */
function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

// The edge target is no longer flat: each pack targets its OWN point on a curve
// — floor 10.99% (no pack targets below it) up to a 11.50% safety cap, the
// premium rising with the pack's house risk (max-win $ exposure + price). A pack
// is flagged "below target" when its edge falls under that floor.
const EDGE_FLOOR_LABEL = pct(DEFAULT_EDGE_FLOOR);
const EDGE_BAND_LABEL = `${pct(DEFAULT_EDGE_FLOOR)}–${pct(DEFAULT_EDGE_CEILING)}`;

/**
 * One compliance-alert group rendered as a clickable card linking to the Pack
 * Doctor with the matching querystring. `query` must be the exact param string
 * the Doctor page consumes in `paramsToFilters` (e.g. `belowTarget=1`,
 * `overCap=1`, `zeroNearMiss=1`, `tier=T5`) — NOT a `?filter=` value, which the
 * Doctor page does not parse. House-POV note: a margin leak (packs under the
 * edge floor) or a pack over the win cap is BAD for us, so those alert cards are
 * tinted rose. Near-miss / over-tier are play-feel / risk signals (not money)
 * → amber.
 */
function AlertGroup({
  accent,
  icon: Icon,
  title,
  items,
  query,
  describe,
}: {
  accent: AccentColor;
  icon: React.ElementType;
  title: string;
  items: ComplianceAlert[];
  query: string;
  describe: (a: ComplianceAlert) => string;
}) {
  if (items.length === 0) return null;
  const tint =
    accent === "rose"
      ? "border-rose-500/20 bg-rose-500/[0.04] hover:bg-rose-500/[0.08]"
      : "border-amber-500/20 bg-amber-500/[0.04] hover:bg-amber-500/[0.08]";
  const iconTint = accent === "rose" ? "text-rose-500" : "text-amber-500";

  return (
    <Link
      href={`/pack-studio/doctor?${query}`}
      className={`group block rounded-xl border p-4 transition-colors ${tint}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={`size-4 shrink-0 ${iconTint}`} aria-hidden />
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="shrink-0 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {formatNumber(items.length)}
          </span>
        </div>
        <ArrowUpRight
          className="size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
          aria-hidden
        />
      </div>
      <ul className="mt-2 space-y-1">
        {items.slice(0, 3).map((a) => (
          <li
            key={a.packId}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <span className="min-w-0 truncate text-muted-foreground">
              {a.name}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {describe(a)}
            </span>
          </li>
        ))}
        {items.length > 3 && (
          <li className="text-[11px] text-muted-foreground">
            +{formatNumber(items.length - 3)} more · view in Pack Doctor
          </li>
        )}
      </ul>
    </Link>
  );
}

/**
 * Async server child for the Pack-Studio overview. Awaits the cached overview
 * read and renders the KPI strip, ramp panel, compliance alerts, and the tier
 * histogram. Rendered behind a <Suspense> boundary so the page shell paints
 * immediately.
 */
export async function PackStudioOverviewContent() {
  const data = await getPackStudioOverview();

  const tierData = (["T1", "T2", "T3", "T4", "T5"] as const).map((tier) => ({
    tier,
    count: data.tierDistribution[tier] ?? 0,
  }));

  const totalAlerts =
    data.alerts.belowTargetEdge.length +
    data.alerts.overMaxWinCap.length +
    data.alerts.zeroNearMiss.length +
    data.alerts.overTier.length;

  if (!data.hasSnapshot) {
    return (
      <div className="rounded-xl border border-dashed bg-muted/20 p-8 text-center">
        <Gauge className="mx-auto size-6 text-muted-foreground" aria-hidden />
        <p className="mt-2 text-sm font-medium">No risk snapshot yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Once the risk snapshot job runs, edge, tier, and compliance KPIs will
          appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── KPI strip ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeading icon={Gauge} title="Risk & compliance at a glance" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile
            label="Avg edge"
            value={pct(data.avgEdge)}
            sub={`Target curve ${EDGE_BAND_LABEL}`}
            icon={Percent}
            accent="blue"
          />
          {/* A pack below the 10.99% edge floor is a margin leak = BAD for the
              house → rose. The target is a per-pack curve, but the floor is the
              one line no pack may fall under. */}
          <KpiTile
            label={`Below ${EDGE_FLOOR_LABEL} floor`}
            value={formatNumber(data.countBelowTarget)}
            sub="Margin leak"
            icon={TrendingUp}
            accent="rose"
          />
          {/* Over the max-win cap = oversized payout exposure = BAD → rose. */}
          <KpiTile
            label="Over win cap"
            value={formatNumber(data.countOverCap)}
            sub={`Cap ${formatCurrency(data.ramp.maxWinCap)}`}
            icon={ShieldAlert}
            accent="rose"
          />
          <KpiTile
            label="Near-miss coverage"
            value={pct(data.nearMissCoverage)}
            sub="Packs with play feel"
            icon={Sparkles}
            accent="amber"
          />
          <KpiTile
            label="Active packs"
            value={formatNumber(data.activeTotal)}
            sub="Scored cash packs"
            icon={Layers}
            accent="purple"
          />
          {/* Open compliance alerts across all four groups — any open alert is
              an unresolved risk = BAD for the house → rose when > 0, else
              neutral blue (nothing outstanding). */}
          <KpiTile
            label="Open alerts"
            value={formatNumber(totalAlerts)}
            sub="Compliance flags"
            icon={AlertTriangle}
            accent={totalAlerts > 0 ? "rose" : "blue"}
          />
        </div>
      </section>

      {/* ── Ramp + tier histogram ──────────────────────────────── */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <SectionHeading icon={Gauge} title="Ramp phase" />
          <StatPanel title="Reserve-backed ramp" icon={Gauge} accent="purple">
            <PanelRow
              label="Reserves (R)"
              value={
                data.ramp.reserves === null
                  ? "—"
                  : formatCurrency(data.ramp.reserves)
              }
            />
            <PanelRow label="Current phase" value={data.ramp.phase ?? "—"} />
            <PanelRow
              label="Max single-win cap"
              value={formatCurrency(data.ramp.maxWinCap)}
            />
            <PanelRow
              label="Packs over cap"
              value={formatNumber(data.countOverCap)}
              valueClassName={
                data.countOverCap > 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-emerald-600 dark:text-emerald-400"
              }
            />
          </StatPanel>
        </div>

        <div className="space-y-3">
          <SectionHeading
            icon={BarChart3}
            title="Volatility tier distribution"
          />
          <div className="surface-sheen surface-raise relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:rounded-2xl sm:p-5">
            <TierDistributionChart data={tierData} />
          </div>
        </div>
      </section>

      {/* ── Compliance alerts ──────────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeading
          icon={AlertTriangle}
          title="Compliance alerts"
          action={
            totalAlerts > 0 ? (
              <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium tabular-nums text-rose-600 dark:text-rose-400">
                {formatNumber(totalAlerts)} open
              </span>
            ) : undefined
          }
        />
        {totalAlerts === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
            <CheckCircle2 className="size-5 text-emerald-500" aria-hidden />
            <div>
              <p className="text-sm font-medium">All packs compliant</p>
              <p className="text-xs text-muted-foreground">
                No packs below the {EDGE_FLOOR_LABEL} floor, over cap, zero
                near-miss, or over tier.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <AlertGroup
              accent="rose"
              icon={TrendingUp}
              title={`Packs below ${EDGE_FLOOR_LABEL} floor`}
              items={data.alerts.belowTargetEdge}
              query="belowTarget=1"
              describe={(a) => pct(a.edge)}
            />
            <AlertGroup
              accent="rose"
              icon={ShieldAlert}
              title="Over max-win cap"
              items={data.alerts.overMaxWinCap}
              query="overCap=1"
              describe={(a) => formatCurrency(a.maxWin)}
            />
            <AlertGroup
              accent="amber"
              icon={Sparkles}
              title="Zero near-miss"
              items={data.alerts.zeroNearMiss}
              query="zeroNearMiss=1"
              describe={(a) => pct(a.nearMiss)}
            />
            <AlertGroup
              accent="amber"
              icon={Target}
              title="Over tier (T5)"
              items={data.alerts.overTier}
              query="tier=T5"
              describe={(a) => a.tier}
            />
          </div>
        )}
      </section>
    </div>
  );
}
