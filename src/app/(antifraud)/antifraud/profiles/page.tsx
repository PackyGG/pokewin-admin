import { Suspense } from "react";
import Link from "next/link";
import { Search, ShieldAlert, UserRoundSearch } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormCardSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { listAntifraudProfiles } from "@/lib/antifraud/profiles-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatRelative } from "@/lib/utils/format";

export const metadata = { title: "Fraud Profiles · Antifraud" };

type SearchParams = Promise<{
  page?: string;
  search?: string;
  outcome?: string;
  blocklist?: string;
}>;

async function ProfilesContent({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const result = await listAntifraudProfiles({
    page,
    search: params.search,
    outcome: params.outcome,
    blocklist: params.blocklist,
  });
  const reviewCount = result.data.filter(
    (profile) => profile.outcome === "review_required",
  ).length;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Profiles" value={String(result.pagination.total)} icon={UserRoundSearch} accent="cyan" />
        <KpiTile label="Visible review" value={String(reviewCount)} icon={ShieldAlert} accent="rose" />
        <KpiTile label="Page" value={`${result.pagination.page}/${result.pagination.pages}`} icon={Search} accent="blue" />
      </div>
      <form className="flex flex-wrap gap-2 rounded-xl border bg-card p-3">
        <Input
          name="search"
          defaultValue={params.search}
          placeholder="User ID, username or email prefix"
          className="min-w-64 flex-1"
        />
        {params.blocklist && (
          <input type="hidden" name="blocklist" value={params.blocklist} />
        )}
        <Button type="submit" variant="outline"><Search className="size-4" />Search</Button>
      </form>
      {(!result.configured || result.error) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {!result.configured
            ? "The Antifraud monitor API is not configured."
            : "Profiles could not be loaded. No empty state is being assumed."}
        </div>
      )}
      {result.configured && !result.error && (
        <section className="overflow-hidden rounded-xl border bg-card">
          {result.data.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No profiles match these filters.
            </p>
          ) : (
            <div className="divide-y">
              {result.data.map((profile) => (
                <Link
                  key={profile.userId}
                  href={`/antifraud/profiles/${encodeURIComponent(profile.userId)}`}
                  className="grid gap-3 px-4 py-3 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{profile.username ?? profile.userId}</span>
                      <Badge variant="outline">{profile.outcome.replaceAll("_", " ")}</Badge>
                      <Badge variant="outline">{profile.completeness}</Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {profile.email ?? "Email unknown"} · {profile.countryCode ?? "Location unknown"} · assessed {formatRelative(profile.assessedAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold tabular-nums">{profile.score}</p>
                    <p className="text-[11px] text-muted-foreground">{profile.confidence}% confidence</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function Fallback() {
  return (
    <>
      <KpiStripSkeleton count={3} />
      <FormCardSkeleton rows={6} />
    </>
  );
}

export default async function ProfilesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAntifraudPageAccess();
  return (
    <div className="space-y-5">
      <PageHero><PageHeroIdentity /></PageHero>
      <Suspense fallback={<Fallback />}>
        <ProfilesContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
