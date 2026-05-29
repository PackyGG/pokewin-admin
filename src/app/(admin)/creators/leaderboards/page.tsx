import Link from "next/link";
import { Trophy, Plus, ArrowUp, ArrowDown } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { getDb } from "@/lib/db";
import {
    affiliateLeaderboardsApi,
    type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { LeaderboardsTable } from "./_components/leaderboards-table";
import { CreateDialog } from "./_components/create-dialog";
import { getLeaderboardSponsorshipMap } from "../_queries/leaderboard-sponsorship";

export const metadata = { title: "Affiliate Leaderboards" };

const STATUS_TABS = [
    { value: "all", label: "All" },
    { value: "pending", label: "Pending" },
    { value: "approved", label: "Approved" },
    { value: "rejected", label: "Rejected" },
] as const;

type StatusTab = (typeof STATUS_TABS)[number]["value"];

const DEFAULT_PER_PAGE = 50;
const PER_PAGE_OPTIONS = [25, 50, 100, 200] as const;

// The backend list API can't sort, so we walk the whole filtered set and
// sort + paginate here. The backend REJECTS a page size above 100, so we
// must page through in chunks of BACKEND_PAGE_SIZE (same pattern as
// _queries/list-creators-by-tab.ts) up to FETCH_CAP rows. Creator
// leaderboards are a small bounded list; 500 is well above any realistic
// count. result.total still reflects the true backend count.
const BACKEND_PAGE_SIZE = 100;
const FETCH_CAP = 500;

const SORTABLE = ["start_asc", "start_desc", "end_asc", "end_desc"] as const;
type SortValue = (typeof SORTABLE)[number];

function sortLeaderboards(
    rows: LeaderboardAdminRow[],
    sort: SortValue | undefined,
): LeaderboardAdminRow[] {
    if (!sort) return rows;
    const [field, dir] = sort.split("_") as ["start" | "end", "asc" | "desc"];
    const key = field === "start" ? "start_date" : "end_date";
    return [...rows].sort((a, b) => {
        const av = new Date(a[key]).getTime();
        const bv = new Date(b[key]).getTime();
        if (Number.isNaN(av) || Number.isNaN(bv)) return 0;
        return dir === "asc" ? av - bv : bv - av;
    });
}

function buildQueryString(params: Record<string, string | number | undefined | null>): string {
    const entries = Object.entries(params).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
    );
    if (entries.length === 0) return "";
    return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

export default async function AffiliateLeaderboardsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    await requirePageAccess("/creators/leaderboards");
    const params = await searchParams;
    const tab: StatusTab = STATUS_TABS.some((t) => t.value === params.status)
        ? (params.status as StatusTab)
        : "all";
    const creatorUserId = params.creator_user_id?.trim() || undefined;
    const includeCancelled = params.include_cancelled === "1";
    const offset = Number(params.offset) || 0;
    const sort: SortValue | undefined = (SORTABLE as readonly string[]).includes(
        params.sort ?? "",
    )
        ? (params.sort as SortValue)
        : undefined;
    const perPage = (PER_PAGE_OPTIONS as readonly number[]).includes(
        Number(params.perPage),
    )
        ? Number(params.perPage)
        : DEFAULT_PER_PAGE;

    // Walk the whole filtered set in pages of BACKEND_PAGE_SIZE (the
    // backend rejects a larger limit), then sort + paginate in-page — the
    // list API has no sort param. First page also gives us the true total.
    const listFilter = {
        status: tab === "all" ? undefined : tab,
        creator_user_id: creatorUserId,
        // Only forward the flag when truthy — the backend's safe-boolean
        // schema accepts 'true'/'false'/'1'/'0' but never auto-derives a
        // default beyond hidden=false, so leaving it off is equivalent.
        include_cancelled: includeCancelled ? true : undefined,
    };
    const firstPage = await affiliateLeaderboardsApi.list({
        ...listFilter,
        limit: BACKEND_PAGE_SIZE,
        offset: 0,
    });
    const total = firstPage.total;
    const allRows = [...firstPage.leaderboards];
    const pagesNeeded = Math.min(
        Math.ceil(FETCH_CAP / BACKEND_PAGE_SIZE),
        Math.ceil(total / BACKEND_PAGE_SIZE),
    );
    const rest: Promise<typeof firstPage>[] = [];
    for (let p = 1; p < pagesNeeded; p++) {
        rest.push(
            affiliateLeaderboardsApi.list({
                ...listFilter,
                limit: BACKEND_PAGE_SIZE,
                offset: p * BACKEND_PAGE_SIZE,
            }),
        );
    }
    for (const page of await Promise.all(rest)) {
        allRows.push(...page.leaderboards);
    }

    const sortedRows = sortLeaderboards(allRows, sort);
    const rows = sortedRows.slice(offset, offset + perPage);

    // Hydrate creator usernames from local Prisma DB so admins see who owns each row.
    const creatorIds = [...new Set(rows.map((r) => r.creator_user_id))];
    const db = await getDb();
    const creators = creatorIds.length > 0
        ? await db.user.findMany({
              where: { id: { in: creatorIds } },
              select: { id: true, username: true, email: true },
          })
        : [];
    const creatorMap = new Map(creators.map((c) => [c.id, c]));

    // Admin-side sponsored % per leaderboard (admin DB). Best-effort —
    // a failure just renders every row at the 100% default.
    const sponsorshipMap = await getLeaderboardSponsorshipMap(
        rows.map((r) => r.id),
    ).catch((e) => {
        console.error(
            "[leaderboards] sponsorship fetch failed (rows show 100%):",
            e,
        );
        return new Map<string, number>();
    });

    const hasNext = offset + perPage < sortedRows.length;
    const hasPrev = offset > 0;

    // Sort-chip state: which field is active + the direction a click should
    // move to next (first click → desc / latest-first, click again → asc).
    const isStart = sort === "start_asc" || sort === "start_desc";
    const isEnd = sort === "end_asc" || sort === "end_desc";
    const nextStart: SortValue = sort === "start_desc" ? "start_asc" : "start_desc";
    const nextEnd: SortValue = sort === "end_desc" ? "end_asc" : "end_desc";

    // Persistent query params carried across every link/filter; each link
    // overrides only what it changes. offset is intentionally omitted from
    // the base so changing a filter / sort / page-size resets to page 1.
    const baseParams = {
        status: tab === "all" ? undefined : tab,
        creator_user_id: creatorUserId,
        include_cancelled: includeCancelled ? "1" : undefined,
        sort,
        perPage: perPage !== DEFAULT_PER_PAGE ? perPage : undefined,
    };
    const hrefWith = (
        extra: Record<string, string | number | undefined | null> = {},
    ) => `/creators/leaderboards${buildQueryString({ ...baseParams, ...extra })}`;

    const chipClass = (active: boolean) =>
        cn(
            "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
            active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
        );

    return (
        <div className="space-y-6">
            <PageHero>
                <PageHeroIdentity
                    icon={Trophy}
                    title="Affiliate Leaderboards"
                    subtitle="Create on behalf of any creator (site-funded), or manage existing entries."
                    action={
                        <CreateDialog
                            trigger={
                                <Button>
                                    <Plus className="size-4 mr-1" /> Create a creator leaderboard
                                </Button>
                            }
                        />
                    }
                />
            </PageHero>

            <div className="space-y-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex gap-1 rounded-lg bg-muted p-1">
                        {STATUS_TABS.map((s) => (
                            <Link
                                key={s.value}
                                href={hrefWith({
                                    status: s.value === "all" ? undefined : s.value,
                                })}
                                className={cn(
                                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                                    tab === s.value
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {s.label}
                            </Link>
                        ))}
                    </div>

                    <div className="flex items-center gap-3 flex-wrap">
                        {/* Sort by start / end date. The backend list API can't
                            sort, so this drives the in-page sort over the full
                            fetched set. First click on a field sorts descending
                            (latest first); click the active field again to flip
                            to ascending. "Default" clears back to backend order. */}
                        <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
                            <span className="px-1.5 text-xs font-medium text-muted-foreground">
                                Sort
                            </span>
                            <Link href={hrefWith({ sort: undefined })} className={chipClass(!sort)}>
                                Default
                            </Link>
                            <Link href={hrefWith({ sort: nextStart })} className={chipClass(isStart)}>
                                Start date
                                {sort === "start_asc" && <ArrowUp className="size-3" />}
                                {sort === "start_desc" && <ArrowDown className="size-3" />}
                            </Link>
                            <Link href={hrefWith({ sort: nextEnd })} className={chipClass(isEnd)}>
                                End date
                                {sort === "end_asc" && <ArrowUp className="size-3" />}
                                {sort === "end_desc" && <ArrowDown className="size-3" />}
                            </Link>
                        </div>

                        {/* Cancelled rows stay in the DB for refund/audit trail —
                            toggle surfaces them when reviewing cancellations. */}
                        <Link
                            href={hrefWith({
                                include_cancelled: includeCancelled ? undefined : "1",
                            })}
                            className={cn(
                                "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                                includeCancelled
                                    ? "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                            )}
                        >
                            {includeCancelled ? "✓ Showing cancelled" : "Show cancelled"}
                        </Link>

                        <form className="flex items-center gap-2" action="/creators/leaderboards" method="get">
                            {tab !== "all" && <input type="hidden" name="status" value={tab} />}
                            {includeCancelled && (
                                <input type="hidden" name="include_cancelled" value="1" />
                            )}
                            {sort && <input type="hidden" name="sort" value={sort} />}
                            {perPage !== DEFAULT_PER_PAGE && (
                                <input type="hidden" name="perPage" value={perPage} />
                            )}
                            <Input
                                name="creator_user_id"
                                defaultValue={creatorUserId ?? ""}
                                placeholder="Filter by creator user id..."
                                className="w-64"
                            />
                        </form>
                    </div>
                </div>

                <FadeIn>
                    <LeaderboardsTable
                        rows={rows}
                        creatorMap={creatorMap}
                        sponsorshipMap={sponsorshipMap}
                    />
                </FadeIn>

                <div className="flex items-center justify-between gap-4 flex-wrap text-sm text-muted-foreground">
                    <div className="flex items-center gap-3 flex-wrap">
                        <span>
                            Showing {rows.length} of {total} {total === 1 ? "row" : "rows"}
                        </span>
                        {/* Rows-per-page selector. Changing it resets to page 1
                            (offset is omitted from hrefWith's base params). */}
                        <div className="flex items-center gap-1">
                            <span className="text-xs">Show</span>
                            <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
                                {PER_PAGE_OPTIONS.map((n) => (
                                    <Link
                                        key={n}
                                        href={hrefWith({
                                            perPage: n !== DEFAULT_PER_PAGE ? n : undefined,
                                        })}
                                        className={cn(
                                            "rounded-md px-2 py-0.5 text-xs font-medium tabular-nums transition-colors",
                                            perPage === n
                                                ? "bg-background text-foreground shadow-sm"
                                                : "text-muted-foreground hover:text-foreground",
                                        )}
                                    >
                                        {n}
                                    </Link>
                                ))}
                            </div>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        {hasPrev && (
                            <Link
                                href={hrefWith({ offset: Math.max(0, offset - perPage) })}
                                className="rounded-md border px-3 py-1 hover:bg-muted"
                            >
                                ← Previous
                            </Link>
                        )}
                        {hasNext && (
                            <Link
                                href={hrefWith({ offset: offset + perPage })}
                                className="rounded-md border px-3 py-1 hover:bg-muted"
                            >
                                Next →
                            </Link>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
