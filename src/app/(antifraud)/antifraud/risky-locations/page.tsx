import { Suspense } from "react";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import { Clock3, MapPin, RadioTower } from "lucide-react";

import { KpiStripSkeleton, FormCardSkeleton } from "@/components/loading-skeletons";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { listRiskyLocations } from "@/lib/antifraud/risky-locations-api";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { RiskyLocationsClient } from "./risky-locations-client";

countries.registerLocale(enLocale);

export const metadata = { title: "Risky Locations · Antifraud" };

async function RiskyLocationsContent() {
  const result = await listRiskyLocations();
  const active = result.data.filter((location) => location.enabled);
  const longest = active.reduce(
    (maximum, location) =>
      Math.max(maximum, location.monitorDurationMinutes),
    0,
  );
  const countryOptions = Object.entries(countries.getNames("en", { select: "official" }))
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Active locations"
          value={String(active.length)}
          icon={MapPin}
          accent="cyan"
        />
        <KpiTile
          label="Longest monitor"
          value={longest > 0 ? `${longest} min` : "—"}
          icon={Clock3}
          accent="blue"
        />
        <KpiTile
          label="Default monitor"
          value="3 min"
          icon={RadioTower}
          accent="emerald"
        />
      </div>

      {(!result.configured || result.error) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {!result.configured
            ? "The Antifraud monitor API is not configured, so risky locations cannot be managed."
            : "The live risky-location rules could not be loaded. No empty state is being assumed."}
        </div>
      )}

      {result.configured && !result.error && (
        <RiskyLocationsClient
          initialLocations={result.data}
          countries={countryOptions}
        />
      )}
    </>
  );
}

function RiskyLocationsFallback() {
  return (
    <>
      <KpiStripSkeleton count={3} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <FormCardSkeleton rows={2} />
        <FormCardSkeleton rows={3} />
      </div>
    </>
  );
}

export default async function RiskyLocationsPage() {
  await requireAntifraudManagerPage();
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={MapPin}
          accent="cyan"
          title="Risky locations"
          subtitle="Choose which signup countries need a longer live-monitor window"
        />
      </PageHero>
      <Suspense fallback={<RiskyLocationsFallback />}>
        <RiskyLocationsContent />
      </Suspense>
    </div>
  );
}
