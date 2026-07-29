import { Suspense } from "react";
import { requireAdmin } from "@/lib/dal";
import { getCountryRestrictions } from "@/lib/queries/geo-blocking";
import { getFiatConfig } from "@/lib/queries/fiat";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { GeoBlockingContent } from "./geo-blocking-content";

export const metadata = { title: "Geo Blocking" };

/**
 * /system/geo-blocking — per-country deposit / withdrawal restrictions
 * (formerly the "Country Restrictions" section of the removed /settings
 * page). Admin-only config surface; the gate matches the old /settings page
 * (requireAdmin) and the underlying server actions enforce requireAdmin +
 * the per-action capabilities independently.
 *
 * Shell-first Suspense streaming (2026-07-12, owner report: "when i click
 * blocked it takes really long to load"): a read-only prod `EXPLAIN ANALYZE`
 * confirmed `getCountryRestrictions()` itself is trivially fast (250 rows,
 * sub-millisecond execution — PK seq scan is optimal at that size, no
 * missing index). The real fix per CLAUDE.md's Shell-first Suspense-Streaming
 * rule is that the PREVIOUS version awaited the read directly in the page
 * body, blocking First Paint on a request-time DB round-trip. `requireAdmin`
 * stays a top-level await (auth gate, not the heavy read, and already
 * `cache()`-memoized per request) while the restrictions read moves into
 * `GeoBlockingBody` behind its own `<Suspense>` so the hero shell paints
 * instantly. `getCountryRestrictions` is also now `unstable_cache`-wrapped
 * (see `src/lib/queries/geo-blocking.ts`) so a repeat navigation is an
 * instant cache hit that doesn't touch the shared MAIN-DB pool at all.
 */
export default async function GeoBlockingPage() {
  await requireAdmin();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense
        fallback={
          <div className="space-y-4">
            <SectionHeadingSkeleton titleWidth={120} />
            <KpiStripSkeleton count={6} />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-9 w-full sm:max-w-xs" />
              <Skeleton className="h-9 w-[170px]" />
              <Skeleton className="h-9 w-[230px]" />
            </div>
            <TableSkeleton rows={10} columns={3} />
          </div>
        }
      >
        <GeoBlockingBody />
      </Suspense>
    </div>
  );
}

async function GeoBlockingBody() {
  const [restrictionsResult, configResult] = await Promise.all([
    safeQuery(
      () => getCountryRestrictions(),
      null,
      "geo-blocking.restrictions",
    ),
    safeQuery(() => getFiatConfig(), [], "geo-blocking.fiat-config"),
  ]);
  const {
    data: countryRestrictions,
    error,
    kind,
  } = restrictionsResult;

  if (error || !countryRestrictions) {
    return (
      <TileErrorFallback
        label="Geo Blocking"
        hint="The country restrictions query failed — refresh to retry."
        kind={kind ?? "error"}
        size="panel"
      />
    );
  }

  const fiatLockRow = configResult.data.find(
    (row) => row.key === "locked_deposits_fiat",
  );
  let siteLockedMethods: string[] | null = null;
  if (!configResult.error && fiatLockRow) {
    try {
      const parsed: unknown = JSON.parse(fiatLockRow.value);
      if (Array.isArray(parsed)) {
        siteLockedMethods = parsed.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      siteLockedMethods = null;
    }
  }

  return (
    <FadeIn>
      <GeoBlockingContent
        countryRestrictions={countryRestrictions}
        siteLockedMethods={siteLockedMethods}
      />
    </FadeIn>
  );
}
