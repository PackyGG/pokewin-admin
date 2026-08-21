import {
  Activity,
  ArrowUpCircle,
  CircleDollarSign,
  Dices,
  Grid3X3,
  Layers3,
  Package,
  Scale,
  Swords,
  TrendingUp,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { cn } from "@/lib/utils";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getGamesOverview,
  type GameModeOverviewRow,
} from "@/lib/queries/analytics-games-overview";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { AnalyticsPeriod } from "./types";

const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  today: "Today (UTC)",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "Last 365 days",
};

const MODE_META: Record<
  GameModeOverviewRow["key"],
  { icon: typeof Package; bar: string; iconClass: string; dot: string }
> = {
  packs: {
    icon: Package,
    bar: "bg-blue-500",
    iconClass: "bg-blue-500/10 text-blue-500",
    dot: "bg-blue-500",
  },
  battles: {
    icon: Swords,
    bar: "bg-rose-500",
    iconClass: "bg-rose-500/10 text-rose-500",
    dot: "bg-rose-500",
  },
  upgrader: {
    icon: ArrowUpCircle,
    bar: "bg-emerald-500",
    iconClass: "bg-emerald-500/10 text-emerald-500",
    dot: "bg-emerald-500",
  },
  "double-down": {
    icon: Dices,
    bar: "bg-amber-500",
    iconClass: "bg-amber-500/10 text-amber-500",
    dot: "bg-amber-500",
  },
  keno: {
    icon: Grid3X3,
    bar: "bg-purple-500",
    iconClass: "bg-purple-500/10 text-purple-500",
    dot: "bg-purple-500",
  },
};

function percentage(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function signedCurrency(value: number): string {
  return `${value >= 0 ? "+" : "−"}${formatCurrency(Math.abs(value))}`;
}

export async function GamesOverview({
  period,
}: {
  period: AnalyticsPeriod;
}) {
  const { data, error, kind } = await safeQuery(
    () => getGamesOverview(period),
    null,
    "analytics.games.overview",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error || !data) {
    return (
      <TileErrorFallback
        label="Games overview"
        hint="The game-mode aggregate failed — refresh to retry."
        kind={kind ?? undefined}
        size="panel"
      />
    );
  }

  const attributedWager = data.modes.reduce(
    (sum, mode) => sum + mode.wager,
    0,
  );
  const measuredHold = percentage(data.ggr, data.totalWager);
  const organicShare = percentage(data.organicWager, data.totalWager);
  const topMode = attributedWager > 0 ? data.modes[0] : null;
  const topTwoWager = data.modes
    .slice(0, 2)
    .reduce((sum, mode) => sum + mode.wager, 0);
  const strongestGgrMode =
    attributedWager > 0
      ? data.modes.reduce<GameModeOverviewRow | null>(
          (best, mode) => (!best || mode.ggr > best.ggr ? mode : best),
          null,
        )
      : null;

  const tiles = [
    {
      label: "Total wager",
      value: formatCurrency(data.totalWager),
      sub: `${formatNumber(data.bets)} wager events`,
      icon: CircleDollarSign,
      tone: "text-blue-500",
      accent: "border-l-blue-500/70",
    },
    {
      label: "Gaming payout",
      value: formatCurrency(data.gamingPayout),
      sub: `${percentage(data.gamingPayout, data.totalWager).toFixed(1)}% measured RTP`,
      icon: Activity,
      tone: "text-rose-500",
      accent: "border-l-rose-500/70",
    },
    {
      label: "Gross gaming revenue",
      value: signedCurrency(data.ggr),
      sub: `${measuredHold.toFixed(1)}% measured hold`,
      icon: TrendingUp,
      tone: data.ggr >= 0 ? "text-emerald-500" : "text-rose-500",
      accent:
        data.ggr >= 0 ? "border-l-emerald-500/70" : "border-l-rose-500/70",
    },
    {
      label: "Organic wager",
      value: formatCurrency(data.organicWager),
      sub: `${organicShare.toFixed(1)}% without creator referral`,
      icon: Scale,
      tone: "text-purple-500",
      accent: "border-l-purple-500/70",
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <SectionHeading icon={Activity} title="Games overview" />
        <p className="text-xs text-muted-foreground">{PERIOD_LABELS[period]}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {tiles.map(({ label, value, sub, icon: Icon, tone, accent }) => (
          <div
            key={label}
            className={cn(
              "rounded-xl border border-l-2 bg-card p-3 shadow-sm sm:p-4",
              accent,
            )}
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="grid size-7 place-items-center rounded-md bg-muted/70">
                <Icon className={cn("size-3.5", tone)} aria-hidden />
              </span>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] sm:text-[11px]">
                {label}
              </p>
            </div>
            <p
              className={cn(
                "mt-2 text-xl font-bold tabular-nums sm:text-2xl",
                tone,
              )}
            >
              {value}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground sm:text-xs">
              {sub}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
        <section className="rounded-xl border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h3 className="font-semibold">Performance by game mode</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Wager, payouts, and house result in one view
              </p>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatCurrency(attributedWager)} attributed
            </span>
          </div>

          <div className="mt-5 space-y-3">
            {data.modes.map((mode, index) => {
              const meta = MODE_META[mode.key];
              const Icon = meta.icon;
              const share = percentage(mode.wager, attributedWager);
              const average = mode.events > 0 ? mode.wager / mode.events : 0;
              const rtp = percentage(mode.payout, mode.wager);

              return (
                <div
                  key={mode.key}
                  className="rounded-xl border bg-background/50 p-3 transition-colors hover:bg-muted/25 sm:p-4"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "relative grid size-10 shrink-0 place-items-center rounded-lg",
                        meta.iconClass,
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                      <span className="absolute -left-1.5 -top-1.5 grid size-4 place-items-center rounded-full border bg-card text-[9px] font-bold text-muted-foreground">
                        {index + 1}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {mode.label}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {mode.description}
                          </p>
                        </div>
                        <div className="grid shrink-0 grid-cols-2 gap-4 text-right">
                          <div>
                            <p className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                              Wager
                            </p>
                            <p className="mt-0.5 text-sm font-semibold tabular-nums">
                              {formatCurrency(mode.wager)}
                            </p>
                          </div>
                          <div>
                            <p className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                              GGR
                            </p>
                            <p
                              className={cn(
                                "mt-0.5 text-sm font-bold tabular-nums",
                                mode.ggr >= 0
                                  ? "text-emerald-500"
                                  : "text-rose-500",
                              )}
                            >
                              {signedCurrency(mode.ggr)}
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn("h-full rounded-full", meta.bar)}
                            style={{
                              width: `${Math.max(0, Math.min(100, share))}%`,
                            }}
                          />
                        </div>
                        <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
                          {share.toFixed(1)}%
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-3 text-[11px] sm:grid-cols-4">
                        <div>
                          <p className="text-muted-foreground">Events</p>
                          <p className="font-medium tabular-nums">
                            {formatNumber(mode.events)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Avg wager</p>
                          <p className="font-medium tabular-nums">
                            {formatCurrency(average)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Paid out</p>
                          <p className="font-medium tabular-nums">
                            {formatCurrency(mode.payout)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">RTP / hold</p>
                          <p className="font-semibold tabular-nums">
                            {rtp.toFixed(1)}% /{" "}
                            <span
                              className={cn(
                                mode.ggr >= 0
                                  ? "text-emerald-500"
                                  : "text-rose-500",
                              )}
                            >
                              {percentage(mode.ggr, mode.wager).toFixed(1)}%
                            </span>
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-lg bg-blue-500/10 text-blue-500">
                <Layers3 className="size-4" aria-hidden />
              </span>
              <div>
                <h3 className="font-semibold">Mode mix</h3>
                <p className="text-[11px] text-muted-foreground">
                  Share of attributed wager
                </p>
              </div>
            </div>

            <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-muted">
              {data.modes.map((mode) => (
                <div
                  key={mode.key}
                  className={MODE_META[mode.key].bar}
                  style={{
                    width: `${percentage(mode.wager, attributedWager)}%`,
                  }}
                  title={`${mode.label}: ${percentage(mode.wager, attributedWager).toFixed(1)}%`}
                />
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              {data.modes.map((mode) => (
                <div
                  key={mode.key}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        MODE_META[mode.key].dot,
                      )}
                    />
                    <span className="truncate">{mode.label}</span>
                  </span>
                  <span className="tabular-nums">
                    {percentage(mode.wager, attributedWager).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
            <h3 className="font-semibold">Quick read</h3>
            <dl className="mt-4 space-y-4">
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Leading mode
                </dt>
                <dd className="mt-1 text-sm font-semibold">
                  {topMode?.label ?? "No wagers"}
                  {topMode ? (
                    <span className="ml-1 font-normal text-muted-foreground">
                      · {percentage(topMode.wager, attributedWager).toFixed(1)}%
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Highest GGR
                </dt>
                <dd className="mt-1 text-sm font-semibold">
                  {strongestGgrMode?.label ?? "No wagers"}
                  {strongestGgrMode ? (
                    <span
                      className={cn(
                        "ml-1 font-normal tabular-nums",
                        strongestGgrMode.ggr >= 0
                          ? "text-emerald-500"
                          : "text-rose-500",
                      )}
                    >
                      · {signedCurrency(strongestGgrMode.ggr)}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Top-two concentration
                </dt>
                <dd className="mt-1 text-sm font-semibold tabular-nums">
                  {percentage(topTwoWager, attributedWager).toFixed(1)}%
                  <span className="ml-1 font-normal text-muted-foreground">
                    of mode wager
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Average wager event
                </dt>
                <dd className="mt-1 text-sm font-semibold tabular-nums">
                  {formatCurrency(
                    data.bets > 0 ? data.totalWager / data.bets : 0,
                  )}
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}
