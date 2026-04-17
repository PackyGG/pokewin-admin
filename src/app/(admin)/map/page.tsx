import { Globe, Users, MapPinOff, Map as MapIcon } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getUsersByCountry, type Period } from "@/lib/queries/map";
import { formatNumber } from "@/lib/utils/format";
import { PeriodFilter } from "./period-filter";
import { WorldMap } from "./world-map";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

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

  const data = await getUsersByCountry(period);
  const topCountry = data.byCountry[0];

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
                Geographic distribution of users across countries.
              </p>
            </div>
          </div>
          <PeriodFilter />
        </div>
      </PageHero>

      <div className="grid gap-4 md:grid-cols-3">
        <KpiTile
          label="Total Users"
          value={formatNumber(data.totalUsers)}
          sub={`${data.byCountry.length} countries`}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Top Country"
          value={topCountry?.country ?? topCountry?.country_code ?? "—"}
          sub={
            topCountry
              ? `${formatNumber(topCountry.user_count)} users`
              : "No data"
          }
          icon={Globe}
          accent="emerald"
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
        <WorldMap data={data.byCountry} />
      </FadeIn>
    </div>
  );
}
