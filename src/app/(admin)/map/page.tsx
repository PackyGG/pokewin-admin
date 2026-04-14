import { Globe, Users, MapPinOff } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getUsersByCountry, type Period } from "@/lib/queries/map";
import { formatNumber } from "@/lib/utils/format";
import { StatCard } from "../dashboard/stat-card";
import { PeriodFilter } from "./period-filter";
import { WorldMap } from "./world-map";

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

  const data = await getUsersByCountry(period);
  const topCountry = data.byCountry[0];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-page-title">Map</h1>
        <PeriodFilter />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Total Users"
          value={formatNumber(data.totalUsers)}
          subtitle={`${data.byCountry.length} countries`}
          icon={Users}
          color="blue"
        />
        <StatCard
          title="Top Country"
          value={topCountry?.country ?? topCountry?.country_code ?? "—"}
          subtitle={
            topCountry
              ? `${formatNumber(topCountry.user_count)} users`
              : "No data"
          }
          icon={Globe}
          color="green"
        />
        <StatCard
          title="Without Location"
          value={formatNumber(data.withoutLocation)}
          subtitle="Users with no country data"
          icon={MapPinOff}
          color="orange"
        />
      </div>

      <WorldMap data={data.byCountry} />
    </div>
  );
}
