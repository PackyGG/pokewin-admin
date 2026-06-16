import Link from "next/link";
import {
  Trophy,
  DollarSign,
  Dice5,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Globe,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import {
  getTopDepositors,
  getTopWagerers,
  getTopLosers,
  getTopWinners,
  getTopCreatorsByVolume,
  getTopCountries,
  type LeaderboardPeriod,
} from "@/lib/queries/analytics-top";
import {
  compareTopDepositors,
  compareTopWagerers,
  compareTopLosers,
  compareTopWinners,
  compareTopCreators,
  compareTopCountries,
} from "@/lib/clickhouse/compare/analytics-top";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import {
  getTopDepositorsFromClickHouse,
  getTopWagerersFromClickHouse,
  getTopLosersFromClickHouse,
  getTopWinnersFromClickHouse,
  getTopCreatorsByVolumeFromClickHouse,
  getTopCountriesFromClickHouse,
} from "@/lib/clickhouse/queries/analytics/top";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import type { AnalyticsPeriod } from "./types";

type SubTab =
  | "depositors"
  | "wagerers"
  | "losers"
  | "winners"
  | "creators"
  | "countries";

function parseSubTab(value: string | undefined): SubTab {
  switch (value) {
    case "depositors":
    case "wagerers":
    case "losers":
    case "winners":
    case "creators":
    case "countries":
      return value;
    default:
      return "depositors";
  }
}

/**
 * Top-performers leaderboards. Uses a sub-tab pattern inside the main
 * analytics tab so the admin can drill into each leaderboard without
 * blowing their URL state. Sub-tab is persisted via `?topTab=…`.
 *
 * The hero period filter drives a leaderboard period (7d / 30d / all)
 * but "today" and "90d" fall back to 30d for leaderboards — top-N
 * rankings aren't meaningful on tiny or huge windows.
 */
export async function TopPerformersTab({
  period: heroPeriod,
  subTab,
}: {
  period: AnalyticsPeriod;
  subTab: string | undefined;
}) {
  const active = parseSubTab(subTab);
  const leaderboardPeriod: LeaderboardPeriod =
    heroPeriod === "7d"
      ? "7d"
      : heroPeriod === "all"
        ? "all"
        : "30d";

  // Only the ACTIVE board's query runs — inactive boards stay null,
  // mirroring the conditional JSX below (same one-query-per-render
  // behavior as before). Each query is wrapped in safeQuery so a
  // failed leaderboard scan degrades its card to a panel fallback
  // instead of throwing past the tab boundary.
  const [depositors, wagerers, losers, winners, creators, countries] =
    await Promise.all([
      active === "depositors"
        ? safeQuery(
            () =>
              resolveAdminRead<Awaited<ReturnType<typeof getTopDepositors>>>(
                "analytics_top",
                {
                  pg: () => getTopDepositors(leaderboardPeriod),
                  ch: async () =>
                    getTopDepositorsFromClickHouse(
                      leaderboardPeriod,
                      await getExcludedUserIds(),
                    ),
                },
              ),
            null,
            "analytics.top.depositors",
            REWARD_QUERY_TIMEOUT_MS,
          )
        : null,
      active === "wagerers"
        ? safeQuery(
            () =>
              resolveAdminRead<Awaited<ReturnType<typeof getTopWagerers>>>(
                "analytics_top",
                {
                  pg: () => getTopWagerers(leaderboardPeriod),
                  ch: async () =>
                    getTopWagerersFromClickHouse(
                      leaderboardPeriod,
                      await getExcludedUserIds(),
                    ),
                },
              ),
            null,
            "analytics.top.wagerers",
            REWARD_QUERY_TIMEOUT_MS,
          )
        : null,
      active === "losers"
        ? safeQuery(
            () =>
              resolveAdminRead<Awaited<ReturnType<typeof getTopLosers>>>(
                "analytics_top",
                {
                  pg: () => getTopLosers(leaderboardPeriod),
                  ch: async () =>
                    getTopLosersFromClickHouse(
                      leaderboardPeriod,
                      await getExcludedUserIds(),
                    ),
                },
              ),
            null,
            "analytics.top.losers",
            REWARD_QUERY_TIMEOUT_MS,
          )
        : null,
      active === "winners"
        ? safeQuery(
            () =>
              resolveAdminRead<Awaited<ReturnType<typeof getTopWinners>>>(
                "analytics_top",
                {
                  pg: () => getTopWinners(leaderboardPeriod),
                  ch: async () =>
                    getTopWinnersFromClickHouse(
                      leaderboardPeriod,
                      await getExcludedUserIds(),
                    ),
                },
              ),
            null,
            "analytics.top.winners",
            REWARD_QUERY_TIMEOUT_MS,
          )
        : null,
      active === "creators"
        ? safeQuery(
            () =>
              resolveAdminRead<Awaited<ReturnType<typeof getTopCreatorsByVolume>>>(
                "analytics_top",
                {
                  pg: () => getTopCreatorsByVolume(leaderboardPeriod),
                  ch: () => getTopCreatorsByVolumeFromClickHouse(leaderboardPeriod),
                },
              ),
            null,
            "analytics.top.creators",
            REWARD_QUERY_TIMEOUT_MS,
          )
        : null,
      active === "countries"
        ? safeQuery(
            () =>
              resolveAdminRead<Awaited<ReturnType<typeof getTopCountries>>>(
                "analytics_top",
                {
                  pg: () => getTopCountries(leaderboardPeriod),
                  ch: async () =>
                    getTopCountriesFromClickHouse(
                      leaderboardPeriod,
                      await getExcludedUserIds(),
                    ),
                },
              ),
            null,
            "analytics.top.countries",
            REWARD_QUERY_TIMEOUT_MS,
          )
        : null,
    ]);

  // Comparison-mode ClickHouse twin (fire-and-forget). No-op unless the
  // `analytics_top` surface is in `comparison` mode. Diffs only the active
  // board against its served Postgres rows; never awaited, swallows its own
  // errors, and never affects the rendered payload.
  if (active === "depositors" && depositors?.data) {
    void compareTopDepositors(leaderboardPeriod, depositors.data);
  } else if (active === "wagerers" && wagerers?.data) {
    void compareTopWagerers(leaderboardPeriod, wagerers.data);
  } else if (active === "losers" && losers?.data) {
    void compareTopLosers(leaderboardPeriod, losers.data);
  } else if (active === "winners" && winners?.data) {
    void compareTopWinners(leaderboardPeriod, winners.data);
  } else if (active === "creators" && creators?.data) {
    void compareTopCreators(leaderboardPeriod, creators.data);
  } else if (active === "countries" && countries?.data) {
    void compareTopCountries(leaderboardPeriod, countries.data);
  }

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Trophy className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Top performers</h3>
            <p className="text-muted-foreground">
              Top 20 in each category. House P&amp;L = canonical gaming
              margin (borrow-corrected wager − cards kept − battle refunds,
              upgrader from its own table; card conversions neutral).
              Winners = users who took money off the house. Losers = users
              we made money from. Clickable rows go to the user / creator
              detail.
            </p>
          </div>
        </div>

        <TopSubTabs active={active} />

        {active === "depositors" && (
          <LeaderCard
            title="Top depositors"
            subtitle="Largest completed deposits in the period"
            icon={DollarSign}
          >
            {!depositors || depositors.error || !depositors.data ? (
              <TileErrorFallback
                label="Top depositors"
                hint="The leaderboard query failed — refresh to retry."
                size="panel"
              />
            ) : (
              <UserLeaderTable
                rows={depositors.data}
                metricLabel="Deposited"
                tone="neutral"
              />
            )}
          </LeaderCard>
        )}

        {active === "wagerers" && (
          <LeaderCard
            title="Top wagerers"
            subtitle="Largest borrow-corrected wager (pack + battle + upgrader)"
            icon={Dice5}
          >
            {!wagerers || wagerers.error || !wagerers.data ? (
              <TileErrorFallback
                label="Top wagerers"
                hint="The leaderboard query failed — refresh to retry."
                size="panel"
              />
            ) : (
              <UserLeaderTable
                rows={wagerers.data}
                metricLabel="Wagered"
                tone="neutral"
              />
            )}
          </LeaderCard>
        )}

        {active === "losers" && (
          <LeaderCard
            title="Top losers (house revenue)"
            subtitle="Users we made the most gaming revenue from — positive house P&L"
            icon={TrendingUp}
          >
            {!losers || losers.error || !losers.data ? (
              <TileErrorFallback
                label="Top losers"
                hint="The leaderboard query failed — refresh to retry."
                size="panel"
              />
            ) : (
              <UserLeaderTable
                rows={losers.data}
                metricLabel="House P&L"
                tone="emerald"
              />
            )}
          </LeaderCard>
        )}

        {active === "winners" && (
          <LeaderCard
            title="Top winners (taking us)"
            subtitle="Users who took the most money off the house — negative house P&L"
            icon={TrendingDown}
          >
            {!winners || winners.error || !winners.data ? (
              <TileErrorFallback
                label="Top winners"
                hint="The leaderboard query failed — refresh to retry."
                size="panel"
              />
            ) : (
              <UserLeaderTable
                rows={winners.data}
                metricLabel="User net"
                tone="rose"
              />
            )}
          </LeaderCard>
        )}

        {active === "creators" && (
          <LeaderCard
            title="Top creators by volume"
            subtitle="Wager volume driven by referred users + commission paid"
            icon={UserPlus}
          >
            {!creators || creators.error || !creators.data ? (
              <TileErrorFallback
                label="Top creators"
                hint="The leaderboard query failed — refresh to retry."
                size="panel"
              />
            ) : (
              <CreatorLeaderTable rows={creators.data} />
            )}
          </LeaderCard>
        )}

        {active === "countries" && (
          <LeaderCard
            title="Top countries by revenue"
            subtitle="GGR aggregated per country (wagers − payouts)"
            icon={Globe}
          >
            {!countries || countries.error || !countries.data ? (
              <TileErrorFallback
                label="Top countries"
                hint="The leaderboard query failed — refresh to retry."
                size="panel"
              />
            ) : (
              <CountryLeaderTable rows={countries.data} />
            )}
          </LeaderCard>
        )}
      </div>
    </FadeIn>
  );
}

const SUB_TABS: { value: SubTab; label: string }[] = [
  { value: "depositors", label: "Depositors" },
  { value: "wagerers", label: "Wagerers" },
  { value: "losers", label: "Losers" },
  { value: "winners", label: "Winners" },
  { value: "creators", label: "Creators" },
  { value: "countries", label: "Countries" },
];

function TopSubTabs({ active }: { active: SubTab }) {
  // 6 sub-tabs; on phones these wrap to two rows for tap-target
  // friendliness instead of scrolling under fades like the main
  // analytics tab nav. Sub-tab rows are short enough that wrapping
  // works visually, unlike the 9-chip parent nav.
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
      {SUB_TABS.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=top&topTab=${value}`}
          replace
          prefetch={false}
          className={cn(
            "shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            active === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

function LeaderCard({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-4 text-primary" />
          {title}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function UserLeaderTable({
  rows,
  metricLabel,
  tone,
}: {
  rows: Awaited<ReturnType<typeof getTopDepositors>>;
  metricLabel: string;
  tone: "neutral" | "emerald" | "rose";
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No data for the selected window"
        description="No users qualify for this leaderboard yet. Try a longer period."
        compact
      />
    );
  }
  const toneClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  return (
    <>
      {/* Mobile card list (<md) */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r, i) => (
          <div
            key={r.userId}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/40"
          >
            <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
              #{i + 1}
            </span>
            <Link
              href={`/users/${r.userId}`}
              className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
            >
              {r.username ?? r.userId.slice(0, 8)}
            </Link>
            <span
              className={cn(
                "shrink-0 text-sm font-medium tabular-nums",
                toneClass,
              )}
            >
              {formatCurrency(r.amount)}
            </span>
          </div>
        ))}
      </div>

      {/* Desktop table (>=md) */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">Rank</TableHead>
              <TableHead>User</TableHead>
              <TableHead className="text-right">{metricLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.userId}>
                <TableCell className="tabular-nums text-muted-foreground">
                  #{i + 1}
                </TableCell>
                <TableCell className="font-medium">
                  <Link href={`/users/${r.userId}`} className="hover:underline">
                    {r.username ?? r.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell className={cn("text-right tabular-nums", toneClass)}>
                  {formatCurrency(r.amount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function CreatorLeaderTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getTopCreatorsByVolume>>;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={UserPlus}
        title="No creators active"
        description="No creators drove referred-user volume in the selected window. Try a longer period."
        compact
      />
    );
  }
  return (
    <>
      {/* Mobile card list (<md) */}
      <div className="space-y-2 md:hidden">
        {rows.map((r, i) => (
          <div
            key={r.userId}
            className="rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40"
          >
            <div className="flex items-center gap-3">
              <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
                #{i + 1}
              </span>
              <Link
                href={`/creators/${r.userId}`}
                className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
              >
                {r.username ?? r.userId.slice(0, 8)}
                {r.code && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {r.code}
                  </span>
                )}
              </Link>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Volume</span>
                <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.wagerVolume)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Commission</span>
                <span className="tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.commission)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table (>=md) */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">Rank</TableHead>
              <TableHead>Creator</TableHead>
              <TableHead className="text-right">Wager Volume</TableHead>
              <TableHead className="text-right">Commission Paid</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.userId}>
                <TableCell className="tabular-nums text-muted-foreground">
                  #{i + 1}
                </TableCell>
                <TableCell className="font-medium">
                  <Link
                    href={`/creators/${r.userId}`}
                    className="hover:underline"
                  >
                    {r.username ?? r.userId.slice(0, 8)}
                  </Link>
                  {r.code && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.code}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.wagerVolume)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.commission)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function CountryLeaderTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getTopCountries>>;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title="No country data"
        description="No GGR could be attributed to a country in the selected window. Try a longer period."
        compact
      />
    );
  }
  return (
    <>
      {/* Mobile card list (<md) */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r, i) => (
          <div
            key={`${r.countryCode ?? r.country}-${i}`}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
              #{i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {r.countryCode && (
                  <span className="mr-2 text-xs font-normal text-muted-foreground">
                    {r.countryCode}
                  </span>
                )}
                {r.country}
              </div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {formatNumber(r.users)} users
              </div>
            </div>
            <span
              className={cn(
                "shrink-0 text-sm font-medium tabular-nums",
                r.ggr >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {formatCurrency(r.ggr)}
            </span>
          </div>
        ))}
      </div>

      {/* Desktop table (>=md) */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">Rank</TableHead>
              <TableHead>Country</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">GGR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${r.countryCode ?? r.country}-${i}`}>
                <TableCell className="tabular-nums text-muted-foreground">
                  #{i + 1}
                </TableCell>
                <TableCell className="font-medium">
                  {r.countryCode && (
                    <span className="mr-2 text-xs text-muted-foreground">
                      {r.countryCode}
                    </span>
                  )}
                  {r.country}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.users)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    r.ggr >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {formatCurrency(r.ggr)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
