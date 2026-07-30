import { Suspense } from "react";
import { Ban, Clock, UsersRound } from "lucide-react";

import { FormCardSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { listAntifraudBannedUsers } from "@/lib/antifraud/profiles-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatRelative } from "@/lib/utils/format";
import { ListSearchForm } from "../_components/list-search-form";
import { BannedUsersList } from "./banned-users-list";

export const metadata = { title: "Banned Users · Antifraud" };
type SearchParams = Promise<{ page?: string; search?: string }>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const result = await listAntifraudBannedUsers({
    page: Math.max(1, Number(params.page) || 1),
    search: params.search,
  });
  const newestBan = result.data.find((user) => user.bannedAt)?.bannedAt ?? null;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Banned accounts" value={String(result.pagination.total)} icon={Ban} accent="rose" />
        <KpiTile
          label="Newest ban"
          value={newestBan ? formatRelative(newestBan) : "—"}
          icon={Clock}
          accent="orange"
        />
        <KpiTile label="Pages" value={String(result.pagination.pages)} icon={UsersRound} accent="blue" />
      </div>
      <div className="rounded-xl border border-border/60 bg-card p-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Search
        </p>
        <ListSearchForm
          action="/antifraud/banned-users"
          placeholder="User ID, username or email prefix"
          ariaLabel="Search banned users"
          defaultValue={params.search ?? ""}
          submitLabel="Search"
          className="flex-col gap-2 sm:flex-row"
          inputClassName="sm:max-w-sm"
        />
      </div>
      {(!result.configured || result.error) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {!result.configured
            ? "The Antifraud monitor API is not configured."
            : "Banned users could not be loaded. No empty state is being assumed."}
        </div>
      )}
      {result.configured && !result.error && (
        <BannedUsersList
          key={`${params.search ?? ""}:${result.pagination.page}`}
          initialUsers={result.data}
          initialPage={result.pagination.page}
          totalPages={result.pagination.pages}
          total={result.pagination.total}
          search={params.search}
        />
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

export default async function BannedUsersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAntifraudPageAccess();
  return (
    <div className="space-y-4">
      <PageHero><PageHeroIdentity /></PageHero>
      <Suspense fallback={<Fallback />}><Content searchParams={searchParams} /></Suspense>
    </div>
  );
}
