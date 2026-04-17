import { Suspense } from "react";
import Link from "next/link";
import { Trophy } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  getRaceLeaderboard,
  getRacePrizeTiers,
  getRaceClaims,
} from "@/lib/queries/races";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { PeriodPicker } from "./period-picker";
import { RaceTiersTable } from "./race-tiers-table";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Leaderboards" };

// Leaderboards is the single entry point for everything race-related now
// that /rewards/races is gone:
//   - Standings: current wager standings per period (daily/weekly)
//   - Prize Tiers: admin-editable prize amounts per position and period type
//   - History:    historical claims (who won what, when)
const TABS = [
  { value: "standings", label: "Standings" },
  { value: "tiers", label: "Prize Tiers" },
  { value: "history", label: "History" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

function getDefaultPeriodStart(raceType: string): string {
  const now = new Date();
  if (raceType === "weekly") {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    now.setDate(now.getDate() - diff);
  }
  return now.toISOString().slice(0, 10);
}

export default async function LeaderboardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/leaderboards");
  const params = await searchParams;
  const tab: TabValue = (
    TABS.find((t) => t.value === params.tab) ?? TABS[0]
  ).value;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Trophy className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Leaderboards</h1>
            <p className="text-sm text-muted-foreground">
              Wager standings, prize tiers, and historical race claims.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-4">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 w-fit">
          {TABS.map((t) => (
            <Link
              key={t.value}
              href={`/rewards/leaderboards?tab=${t.value}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {tab === "standings" && <StandingsTab params={params} />}
        {tab === "tiers" && <TiersTab />}
        {tab === "history" && <HistoryTab params={params} />}
      </div>
    </div>
  );
}

async function StandingsTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const raceType = params.raceType || "all";
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const search = params.search;

  const effectivePeriod =
    raceType === "all"
      ? undefined
      : params.periodStart || getDefaultPeriodStart(raceType);
  const result = await getRaceLeaderboard({
    raceType,
    periodStart: effectivePeriod,
    search,
    page,
    perPage,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {["all", "daily", "weekly"].map((type) => (
            <Link
              key={type}
              href={`/rewards/leaderboards?tab=standings&raceType=${type}${
                type !== "all" && effectivePeriod
                  ? `&periodStart=${effectivePeriod}`
                  : ""
              }`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                raceType === type
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {type}
            </Link>
          ))}
        </div>
        {raceType !== "all" && effectivePeriod && (
          <PeriodPicker raceType={raceType} periodStart={effectivePeriod} />
        )}
      </div>
      <Suspense>
        <DataTableToolbar searchPlaceholder="Search by username, email, or ID..." />
      </Suspense>
      <FadeIn>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Position</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Wagered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Badge variant="outline">#{e.position}</Badge>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/users/${e.userId}`}
                      className="hover:underline"
                    >
                      {e.username ?? e.userId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>{formatCurrency(e.wageredUsd)}</TableCell>
                </TableRow>
              ))}
              {result.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No leaderboard data.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </FadeIn>
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}

async function TiersTab() {
  const tiers = await getRacePrizeTiers();
  return (
    <FadeIn>
      <RaceTiersTable tiers={tiers} />
    </FadeIn>
  );
}

async function HistoryTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const raceType = params.raceType;
  const claims = await getRaceClaims({ page, perPage, raceType });

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
        {["all", "daily", "weekly"].map((type) => (
          <Link
            key={type}
            href={`/rewards/leaderboards?tab=history&raceType=${type}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
              (raceType || "all") === type
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {type}
          </Link>
        ))}
      </div>
      <FadeIn>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Prize</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Claimed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {claims.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link
                      href={`/users/${c.userId}`}
                      className="hover:underline"
                    >
                      {c.username ?? c.userId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {c.raceType}
                    </Badge>
                  </TableCell>
                  <TableCell>#{c.position}</TableCell>
                  <TableCell>{formatCurrency(c.prizeAmountUsd)}</TableCell>
                  <TableCell>{formatDateTime(c.racePeriodStart)}</TableCell>
                  <TableCell>{formatDateTime(c.claimedAt)}</TableCell>
                </TableRow>
              ))}
              {claims.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No claims found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </FadeIn>
      <DataTablePagination
        page={claims.page}
        totalPages={claims.totalPages}
        total={claims.total}
        perPage={claims.perPage}
      />
    </div>
  );
}
