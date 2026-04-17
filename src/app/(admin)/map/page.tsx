import {
  Globe,
  Users,
  MapPinOff,
  Map as MapIcon,
  TrendingUp,
  Swords,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getUsersByCountry, type Period } from "@/lib/queries/map";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  PageHero,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { PeriodFilter } from "./period-filter";
import { MetricToggle } from "./metric-toggle";
import { WorldMap } from "./world-map";
import { CountryLeaderboard } from "./country-leaderboard";
import { ContinentBreakdown } from "./continent-breakdown";
import { parseMetric } from "./utils";

export const metadata = { title: "Map" };

const VALID_PERIODS: readonly Period[] = ["today", "7d", "30d", "90d", "all"];

function parsePeriod(value: string | undefined): Period {
  if (value && (VALID_PERIODS as readonly string[]).includes(value)) {
    return value as Period;
  }
  return "30d";
}

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/map");
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const metric = parseMetric(params.metric);

  const data = await getUsersByCountry(period);
  const topCountry = data.byCountry[0];

  // Platform-wide aggregates for the KPI strip. We roll up from the
  // per-country rows (staff already excluded by the query) so the
  // numbers here and on the map always match.
  const totals = data.byCountry.reduce(
    (acc, c) => ({
      deposits: acc.deposits + c.total_deposits,
      depositCount: acc.depositCount + c.deposit_count,
      wager: acc.wager + c.total_wager,
    }),
    { deposits: 0, depositCount: 0, wager: 0 },
  );
  const multiplier = totals.deposits > 0 ? totals.wager / totals.deposits : 0;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <MapIcon className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Map</h1>
              <p className="text-sm text-muted-foreground">
                Where users live, deposit, and wager — across {data.byCountry.length}{" "}
                countr{data.byCountry.length === 1 ? "y" : "ies"}.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <MetricToggle />
            <PeriodFilter />
          </div>
        </div>
      </PageHero>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Total Users"
          value={formatNumber(data.totalUsers)}
          sub={
            topCountry
              ? `Top: ${topCountry.country ?? topCountry.country_code.toUpperCase()} · ${formatNumber(topCountry.user_count)}`
              : `${data.byCountry.length} countries`
          }
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Deposits"
          value={formatCurrency(totals.deposits)}
          sub={`${formatNumber(totals.depositCount)} transactions`}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Total Wagers"
          value={formatCurrency(totals.wager)}
          sub={
            multiplier > 0
              ? `${multiplier.toFixed(2)}× per $ deposited`
              : "No wager activity"
          }
          icon={Swords}
          accent="cyan"
        />
        <KpiTile
          label="Without Location"
          value={formatNumber(data.withoutLocation)}
          sub="Users with no country data"
          icon={MapPinOff}
          accent="orange"
        />
      </div>

      <FadeIn>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="space-y-2">
              <SectionHeading icon={Globe} title="Global distribution" />
              <WorldMap data={data.byCountry} metric={metric} />
            </div>
          </div>
          <CountryLeaderboard data={data.byCountry} metric={metric} />
        </div>
      </FadeIn>

      <FadeIn delay={120}>
        <ContinentBreakdown data={data.byCountry} metric={metric} />
      </FadeIn>
    </div>
  );
}
