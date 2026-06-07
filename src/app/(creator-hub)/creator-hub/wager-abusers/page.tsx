import { Suspense } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  Users,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { FadeIn } from "@/components/fade-in";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/utils/format";
import { ABUSER_HUB_TAGS, getUsersWithTags } from "@/lib/queries/user-tags";

export const metadata = { title: "Wager / Fraud Abusers · Creator Hub" };

const HUB_WAGER_ABUSERS_PATH = "/creator-hub/wager-abusers";
const LIMIT = 50;

/**
 * Creator Hub → Wager Abusers.
 *
 * Lists packy.gg users tagged `wager_abuser` or `fraud_abuser` in the admin DB.
 * Tags are applied on `/users/[id]` by admins (or roles with
 * `__can_manage_user_tags`).
 *
 * ACCESS: `canAccessCreatorHub` — same gate as other Hub pages.
 */
export default async function WagerAbusersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const params = await searchParams;
  const offset = Math.max(0, Number(params.offset ?? "0")) || 0;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="pink"
          title="Wager / Fraud Abusers"
          subtitle="Users flagged for wager abuse or fraud — tag them on their profile in Admin"
        />
      </PageHero>

      <Suspense key={offset} fallback={<ListSkeleton />}>
        <ListSection offset={offset} />
      </Suspense>
    </div>
  );
}

async function ListSection({ offset }: { offset: number }) {
  const { items, total } = await getUsersWithTags(ABUSER_HUB_TAGS, {
    limit: LIMIT,
    offset,
  });

  return (
    <FadeIn>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:max-w-xs">
        <KpiTile
          label="Tagged users"
          value={String(total)}
          sub="wager / fraud flags"
          icon={Users}
          accent="pink"
        />
      </div>

      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Flagged accounts</span>
          <span className="text-xs text-muted-foreground">
            Showing {items.length} of {total}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
            <ShieldAlert className="size-6" />
            <span className="text-sm">No abusers tagged yet.</span>
            <span className="max-w-sm text-center text-xs">
              Open a user in Admin → Users, then add &quot;Wager Abuser&quot; or
              &quot;Fraud Abuser&quot; from their profile header.
            </span>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Tag</th>
                  <th className="pb-2 pr-4 font-medium">Username</th>
                  <th className="pb-2 pr-4 font-medium">Email</th>
                  <th className="pb-2 pr-4 font-medium">Tagged by</th>
                  <th className="pb-2 font-medium">Tagged at</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((row) => (
                  <tr key={`${row.userId}-${row.tag}`} className="align-middle">
                    <td className="py-3 pr-4 capitalize text-xs font-medium text-rose-600 dark:text-rose-400">
                      {row.tag === "fraud_abuser" ? "Fraud" : "Wager"}
                    </td>
                    <td className="py-3 pr-4">
                      <Link
                        href={`/users/${row.userId}`}
                        className="font-semibold hover:underline"
                      >
                        {row.username ?? row.userId}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.email ?? "—"}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.setByAdminUsername ?? "—"}
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {formatDateTime(row.taggedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <PaginationFooter
            offset={offset}
            limit={LIMIT}
            total={total}
            shown={items.length}
          />
        )}
      </div>
    </FadeIn>
  );
}

function PaginationFooter({
  offset,
  limit,
  total,
  shown,
}: {
  offset: number;
  limit: number;
  total: number;
  shown: number;
}) {
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + shown;
  const hasPrev = offset > 0;
  const hasNext = pageEnd < total;

  const linkFor = (nextOffset: number) => {
    const params = new URLSearchParams();
    if (nextOffset > 0) params.set("offset", String(nextOffset));
    const qs = params.toString();
    return qs
      ? `${HUB_WAGER_ABUSERS_PATH}?${qs}`
      : HUB_WAGER_ABUSERS_PATH;
  };

  return (
    <div className="mt-4 flex items-center justify-between border-t pt-3">
      <span className="text-xs text-muted-foreground">
        {pageStart}–{pageEnd} of {total}
      </span>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link
            href={linkFor(Math.max(0, offset - limit))}
            className="inline-flex h-8 items-center gap-1 rounded-md border bg-background px-3 text-xs font-semibold hover:bg-muted"
          >
            <ChevronLeft className="size-3.5" />
            Previous
          </Link>
        ) : (
          <span className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-md border px-3 text-xs font-semibold text-muted-foreground/40">
            <ChevronLeft className="size-3.5" />
            Previous
          </span>
        )}
        {hasNext ? (
          <Link
            href={linkFor(offset + limit)}
            className="inline-flex h-8 items-center gap-1 rounded-md border bg-background px-3 text-xs font-semibold hover:bg-muted"
          >
            Next
            <ChevronRight className="size-3.5" />
          </Link>
        ) : (
          <span className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-md border px-3 text-xs font-semibold text-muted-foreground/40">
            Next
            <ChevronRight className="size-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-[88px] max-w-xs rounded-xl" />
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-3 w-24 rounded" />
        </div>
        <div className="mt-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
