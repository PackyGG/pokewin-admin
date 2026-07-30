import { Suspense } from "react";
import { Ban, Search, UsersRound } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormCardSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { listAntifraudBannedUsers } from "@/lib/antifraud/profiles-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatRelative } from "@/lib/utils/format";
import { ListPagination } from "../_components/list-page";
import { AccountBanAction } from "./account-ban-action";

export const metadata = { title: "Banned Users · Antifraud" };
type SearchParams = Promise<{ page?: string; search?: string }>;

function bannedUsersHref(page: number, search?: string): string {
  const query = new URLSearchParams();
  if (page > 1) query.set("page", String(page));
  if (search) query.set("search", search);
  const suffix = query.toString();
  return `/antifraud/banned-users${suffix ? `?${suffix}` : ""}`;
}

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const result = await listAntifraudBannedUsers({
    page: Math.max(1, Number(params.page) || 1),
    search: params.search,
  });
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Banned accounts" value={String(result.pagination.total)} icon={Ban} accent="rose" />
        <KpiTile label="Visible" value={String(result.data.length)} icon={UsersRound} accent="orange" />
        <KpiTile label="Page" value={`${result.pagination.page}/${result.pagination.pages}`} icon={Search} accent="blue" />
      </div>
      <form className="rounded-xl border border-border/60 bg-card p-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Search
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            name="search"
            defaultValue={params.search}
            placeholder="User ID, username or email prefix"
            className="sm:max-w-sm"
          />
          <Button type="submit" variant="outline"><Search className="size-4" />Search</Button>
        </div>
      </form>
      {(!result.configured || result.error) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {!result.configured
            ? "The Antifraud monitor API is not configured."
            : "Banned users could not be loaded. No empty state is being assumed."}
        </div>
      )}
      {result.configured && !result.error && (
        <>
          <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Ban className="size-4 text-rose-500" />
                Banned accounts
              </h2>
              <span className="text-[10px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
                {result.pagination.total} total
              </span>
            </div>
            {result.data.length === 0 ? (
              <div className="px-4 py-14 text-center">
                <UsersRound className="mx-auto mb-3 size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No banned accounts match this search.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {result.data.map((user) => (
                  <div
                    key={user.userId}
                    className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <HostLink
                          href={`/users/${encodeURIComponent(user.userId)}`}
                          className="truncate font-medium hover:underline"
                        >
                          {user.username ?? user.userId}
                        </HostLink>
                        <Badge variant="destructive">Banned</Badge>
                        {user.countryCode && <Badge variant="outline">{user.countryCode}</Badge>}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{user.email ?? "Email unknown"}</p>
                      <p className="text-xs">{user.banReason ?? "Historical ban reason unknown"}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {user.bannedAt ? `Banned ${formatRelative(user.bannedAt)}` : "Ban time unknown"}
                      </p>
                    </div>
                    <AccountBanAction
                      userId={user.userId}
                      account={user.username ?? user.userId}
                      action="unban"
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
          {result.pagination.pages > 1 && (
            <ListPagination
              page={result.pagination.page}
              pages={result.pagination.pages}
              total={result.pagination.total}
              unitLabel="banned accounts"
              previousHref={
                result.pagination.page > 1
                  ? bannedUsersHref(result.pagination.page - 1, params.search)
                  : undefined
              }
              nextHref={
                result.pagination.page < result.pagination.pages
                  ? bannedUsersHref(result.pagination.page + 1, params.search)
                  : undefined
              }
            />
          )}
        </>
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
