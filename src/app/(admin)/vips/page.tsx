import { Suspense } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Crown,
  AlertTriangle,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { FadeIn } from "@/components/fade-in";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { getUsersWithTag } from "@/lib/queries/user-tags";

export const metadata = { title: "VIPs" };

const VIPS_PATH = "/vips";
const LIMIT = 50;
/** Small admin-DB tag lookup + a main-DB PK-IN hydration — both already
 *  indexed (see `getUsersWithTags` in `@/lib/queries/user-tags`). This
 *  bound only guards against a hung connection / pool exhaustion. */
const VIPS_LIST_TIMEOUT_MS = 15_000;

/**
 * Players → VIPs.
 *
 * Lists packy.gg users tagged `vip` in the admin DB. Tags are applied on
 * `/users/[id]` by admins (or roles with `__can_manage_user_tags`).
 *
 * Shell-first: the hero paints immediately; the tag-list fetch lives in its
 * own Suspense leg below (see `loading.tsx` for the matching skeleton
 * shell).
 */
export default async function VipsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/vips");

  const params = await searchParams;
  const offset = Math.max(0, Number(params.offset ?? "0")) || 0;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense key={offset} fallback={<VipsListSkeleton />}>
        <VipsListSection offset={offset} />
      </Suspense>
    </div>
  );
}

/**
 * House-POV PnL cell — mirrors `PnlCell` in `/users`'s
 * `src/app/(admin)/users/columns.tsx` exactly: user-perspective sign
 * (positive = user in profit = house liability → rose; negative = user
 * down → emerald), same "+"/"-" prefix via `formatCurrency`.
 */
function PnlCell({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="tabular-nums text-muted-foreground">—</span>;
  }
  const isUserProfit = value > 0;
  const isUserLoss = value < 0;
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        isUserProfit && "text-rose-400",
        isUserLoss && "text-emerald-400",
      )}
    >
      {value >= 0 ? "+" : ""}
      {formatCurrency(value)}
    </span>
  );
}

async function VipsListSection({ offset }: { offset: number }) {
  const EMPTY: Awaited<ReturnType<typeof getUsersWithTag>> = {
    items: [],
    total: 0,
  };
  const result = await safeQuery(
    () =>
      getUsersWithTag("vip", {
        limit: LIMIT,
        offset,
        includeFinancials: true,
      }),
    EMPTY,
    "vips.list",
    VIPS_LIST_TIMEOUT_MS,
  );
  const { items, total } = result.data;
  const listFailed = result.error !== null;

  return (
    <FadeIn className="space-y-6">
      <div className="space-y-3">
        <SectionHeading icon={Crown} title="VIP accounts" />

        {listFailed && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
          >
            <AlertTriangle
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-amber-500"
            />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Couldn&apos;t load the VIP list — the query timed out or
              failed. Refresh to retry.
            </p>
          </div>
        )}

        <div className="rounded-2xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">VIP users</span>
            <span className="text-xs text-muted-foreground">
              Showing {items.length} of {total}
            </span>
          </div>

          {items.length === 0 ? (
            <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
              <Crown className="size-6" />
              <span className="text-sm">No VIPs tagged yet.</span>
              <span className="max-w-sm text-center text-xs">
                Open a user in Admin → Users, then add &quot;VIP&quot; from
                their profile header.
              </span>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Username</th>
                    <th className="pb-2 pr-4 font-medium">Email</th>
                    <th className="pb-2 pr-4 font-medium">Lifetime PnL</th>
                    <th className="pb-2 pr-4 font-medium">Deposits</th>
                    <th className="pb-2 pr-4 font-medium">Withdrawals</th>
                    <th className="pb-2 pr-4 font-medium">Country</th>
                    <th className="pb-2 font-medium">Tagged at</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((row) => (
                    <tr key={row.userId} className="align-middle">
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
                      <td className="py-3 pr-4">
                        <PnlCell value={row.pnl} />
                      </td>
                      <td className="py-3 pr-4 tabular-nums">
                        {row.totalDeposited === null
                          ? "—"
                          : formatCurrency(row.totalDeposited)}
                      </td>
                      <td className="py-3 pr-4 tabular-nums">
                        {row.totalWithdrawn === null
                          ? "—"
                          : formatCurrency(row.totalWithdrawn)}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {row.country ?? row.countryCode ?? "—"}
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
    return qs ? `${VIPS_PATH}?${qs}` : VIPS_PATH;
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

function VipsListSkeleton() {
  return (
    <div className="space-y-4">
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
