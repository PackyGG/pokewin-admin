import Link from "next/link";
import {
  Gift,
  LineChart as LineChartIcon,
  Layers,
  PackageOpen,
  Users,
  Hash,
  TrendingDown,
  Sigma,
} from "lucide-react";
import { SectionHeading, TILE_COLORS } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getRewardProgramSpend,
  REWARD_PROGRAM_LABELS,
  type RewardProgramRow,
} from "@/lib/queries/insights-rewards/program-spend";
import { getDailyPacksGiveaway } from "@/lib/queries/insights-rewards/daily-packs";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { DailyPackBreakdownRow } from "../../insights/rewards/_components/daily-pack-row";
import { fromInsightsPeriod } from "../types";
import { ProgramTrendChart } from "./program-trend-chart";
import { PROGRAM_META, MONEY_OUT } from "./program-meta";

/**
 * Rewards → Programs. One program at a time, in depth.
 *
 * The picker is plain links on `?p=`, and only the SELECTED program renders —
 * so the extra reads (currently just the daily-pack per-pack breakdown) fire
 * only when that program is open, never eagerly for all seven.
 *
 * The program list itself comes from the same cached `getRewardProgramSpend`
 * call the Overview uses, so switching between the two views costs one cache
 * hit, not a second scan.
 */
export async function RewardsProgramsView({
  period,
  selected,
}: {
  period: InsightsRewardsPeriod;
  selected: string | undefined;
}) {
  const { data: spend, error } = await safeQuery(
    () => getRewardProgramSpend(period),
    null,
    "analytics.rewards.programSpend",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error || !spend) {
    return (
      <TileErrorFallback
        label="Reward programs"
        hint="The program-spend query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const label = insightsRewardsPeriodLabel(period);

  if (spend.rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Gift}
          title={`No reward spend in ${label.toLowerCase()}`}
          description="No program paid anything out in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  // Fall back to the biggest program rather than 404-ing on a stale `?p=`.
  const active =
    spend.rows.find((r) => r.key === selected) ?? spend.rows[0];

  return (
    <div className="space-y-5">
      {/* Picker. Each chip carries its own spend so the choice is informed
          before the click, not after. */}
      <div className="flex flex-wrap gap-2">
        {spend.rows.map((row) => {
          const meta = PROGRAM_META[row.key];
          const Icon = meta.icon;
          const isActive = row.key === active.key;
          return (
            <Link
              key={row.key}
              href={`/analytics?tab=rewards&rw=programs&p=${row.key}&period=${fromInsightsPeriod(period)}`}
              replace
              scroll={false}
              prefetch={false}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                isActive
                  ? "border-foreground/20 bg-card shadow-sm"
                  : "bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon
                className={cn(
                  "size-3.5 shrink-0",
                  isActive ? TILE_COLORS[meta.accent].icon : undefined,
                )}
              />
              <span className="font-medium">{row.label}</span>
              <span className="tabular-nums text-[11px] opacity-70">
                {formatCurrency(row.total)}
              </span>
            </Link>
          );
        })}
      </div>

      <FadeIn key={active.key}>
        <ProgramDetail row={active} period={period} grandTotal={spend.grandTotal} />
      </FadeIn>
    </div>
  );
}

async function ProgramDetail({
  row,
  period,
  grandTotal,
}: {
  row: RewardProgramRow;
  period: InsightsRewardsPeriod;
  grandTotal: number;
}) {
  const meta = PROGRAM_META[row.key];
  const Icon = meta.icon;
  const label = insightsRewardsPeriodLabel(period);

  return (
    <div className="space-y-5">
      {/* Header — what this program is, in one line, so an operator who
          didn't build it still knows what they're looking at. */}
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border bg-muted/40 p-2">
            <Icon className={cn("size-5", TILE_COLORS[meta.accent].icon)} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">{row.label}</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">{row.blurb}</p>
          </div>
          <div className="hidden shrink-0 text-right sm:block">
            <p className={cn("text-2xl font-bold tabular-nums", MONEY_OUT)}>
              {formatCurrency(row.total)}
            </p>
            <p className="text-[11px] text-muted-foreground">{label}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            icon={TrendingDown}
            label="Cost"
            value={formatCurrency(row.total)}
            valueClass={MONEY_OUT}
          />
          <Stat
            icon={Sigma}
            label="Share of reward spend"
            value={`${row.share.toFixed(1)}%`}
            sub={`of ${formatCurrency(grandTotal)}`}
          />
          <Stat
            icon={Users}
            label="Players reached"
            value={formatNumber(row.claimants)}
          />
          <Stat
            icon={Hash}
            label="Payouts"
            value={formatNumber(row.count)}
          />
          <Stat
            icon={Gift}
            label="Avg per player"
            value={formatCurrency(row.avgPerClaimant)}
            sub={`${formatCurrency(row.avgPerPayout)} per payout`}
          />
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <SectionHeading
          icon={LineChartIcon}
          title={`Daily cost — ${row.label}`}
        />
        <div className="mt-3">
          <ProgramTrendChart
            data={row.dailySeries.map((p) => ({
              date: p.date,
              [row.key]: p.total,
            }))}
            programs={[row.key]}
            labels={REWARD_PROGRAM_LABELS}
            height={240}
          />
        </div>
      </div>

      {row.components.length > 1 && (
        <div className="rounded-2xl border bg-card p-4 sm:p-5">
          <SectionHeading icon={Layers} title="What makes up this figure" />
          <ul className="mt-3 space-y-2">
            {row.components.map((c) => (
              <li key={c.label} className="rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm">{c.label}</span>
                  <span
                    className={cn(
                      "shrink-0 text-sm font-semibold tabular-nums",
                      MONEY_OUT,
                    )}
                  >
                    {formatCurrency(c.total)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-rose-500/60"
                      style={{
                        width: `${row.total > 0 ? (c.total / row.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatNumber(c.count)} payout{c.count === 1 ? "" : "s"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Daily packs is the one program with a natural sub-breakdown — which
          pack handed out what. Only fetched when this program is selected. */}
      {row.key === "dailyPacks" && <DailyPacksDetail period={period} />}
    </div>
  );
}

async function DailyPacksDetail({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getDailyPacksGiveaway(period),
    null,
    "analytics.rewards.dailyPacks",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data || data.packs.length === 0) return null;

  const total = data.giveawayPayout;
  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <SectionHeading
        icon={PackageOpen}
        title="Cost by pack"
        action={
          <span className="text-xs text-muted-foreground">
            {formatNumber(data.cards)} cards handed out ·{" "}
            {formatCurrency(data.avgCostPerPack)} avg per open
          </span>
        }
      />
      <div className="mt-3 space-y-2">
        {data.packs.map((pack) => (
          <DailyPackBreakdownRow
            key={pack.packId}
            pack={pack}
            share={total > 0 ? (pack.giveawayPayout / total) * 100 : 0}
          />
        ))}
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  valueClass,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <p className="truncate text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </p>
      </div>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", valueClass)}>
        {value}
      </p>
      {sub && (
        <p className="truncate text-[11px] tabular-nums text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}
