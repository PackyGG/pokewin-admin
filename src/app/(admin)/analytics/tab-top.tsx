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
import { FadeIn } from "@/components/fade-in";
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
              Top 20 in each category. Winners = users who took money off
              the house (house P&amp;L negative). Losers = users we made
              money from. Clickable rows go to the user / creator detail.
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
            <UserLeaderTable
              rows={await getTopDepositors(leaderboardPeriod)}
              metricLabel="Deposited"
              tone="neutral"
            />
          </LeaderCard>
        )}

        {active === "wagerers" && (
          <LeaderCard
            title="Top wagerers"
            subtitle="Largest wager volume (pack + battle)"
            icon={Dice5}
          >
            <UserLeaderTable
              rows={await getTopWagerers(leaderboardPeriod)}
              metricLabel="Wagered"
              tone="neutral"
            />
          </LeaderCard>
        )}

        {active === "losers" && (
          <LeaderCard
            title="Top losers (house revenue)"
            subtitle="Users we made the most gaming revenue from — positive house P&L"
            icon={TrendingUp}
          >
            <UserLeaderTable
              rows={await getTopLosers(leaderboardPeriod)}
              metricLabel="House P&L"
              tone="emerald"
            />
          </LeaderCard>
        )}

        {active === "winners" && (
          <LeaderCard
            title="Top winners (taking us)"
            subtitle="Users who took the most money off the house — negative house P&L"
            icon={TrendingDown}
          >
            <UserLeaderTable
              rows={await getTopWinners(leaderboardPeriod)}
              metricLabel="User net"
              tone="rose"
            />
          </LeaderCard>
        )}

        {active === "creators" && (
          <LeaderCard
            title="Top creators by volume"
            subtitle="Wager volume driven by referred users + commission paid"
            icon={UserPlus}
          >
            <CreatorLeaderTable
              rows={await getTopCreatorsByVolume(leaderboardPeriod)}
            />
          </LeaderCard>
        )}

        {active === "countries" && (
          <LeaderCard
            title="Top countries by revenue"
            subtitle="GGR aggregated per country (wagers − payouts)"
            icon={Globe}
          >
            <CountryLeaderTable
              rows={await getTopCountries(leaderboardPeriod)}
            />
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
  return (
    <div className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/40 p-1">
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
      <p className="py-8 text-center text-sm text-muted-foreground">
        No data for the selected window.
      </p>
    );
  }
  const toneClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  return (
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
  );
}

function CreatorLeaderTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getTopCreatorsByVolume>>;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No creators active in the selected window.
      </p>
    );
  }
  return (
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
  );
}

function CountryLeaderTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getTopCountries>>;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No country data for the selected window.
      </p>
    );
  }
  return (
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
  );
}
