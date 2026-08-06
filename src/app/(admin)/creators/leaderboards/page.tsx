import { Suspense } from "react";
import Link from "next/link";
import {
    Plus,
    ArrowUp,
    ArrowDown,
    Coins,
    Layers,
    Handshake,
    Percent,
    Activity,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { inArray } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { user } from "@/lib/db-schema/main/schema";
import {
    affiliateLeaderboardsApi,
    type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getAdminDisplayTimeZone } from "@/lib/timezone/server";
import {
    KpiStripSkeleton,
    TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

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

    // Shell = hero + create button + static controls (status tabs, sort chips,
    // cancelled toggle, creator filter) — all derived from searchParams alone,
    // so they paint instantly. The KPI strip + table + pagination all depend
    // on the backend walk (paged to FETCH_CAP) + creator hydration + KPI
    // aggregation, which stream in ONE async child (so the walk runs once, not
    // twice). Boundary is keyed on the full filter set so a filter/sort/page
    // change re-streams the child.
    const bodyKey = `${tab}|${creatorUserId ?? ""}|${includeCancelled ? 1 : 0}|${sort ?? ""}|${perPage}|${offset}`;

    return (
        <div className="space-y-6">
            <PageHero>
                <PageHeroIdentity
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
                    <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
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
                        <div className="flex items-center gap-1 rounded-lg border bg-muted/50 p-1">
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
                                className="w-full sm:flex-1 sm:min-w-[200px] sm:max-w-xs"
                            />
                        </form>
                    </div>
                </div>

                <Suspense key={bodyKey} fallback={<LeaderboardsBodySkeleton />}>
                    <LeaderboardsBody
                        tab={tab}
                        creatorUserId={creatorUserId}
                        includeCancelled={includeCancelled}
                        offset={offset}
                        sort={sort}
                        perPage={perPage}
                        hrefWith={hrefWith}
                    />
                </Suspense>
            </div>
        </div>
    );
}

/**
 * Streamed body: the whole backend walk (paged to FETCH_CAP) + creator
 * hydration + sponsorship map + KPI aggregation + the sorted/paginated
 * slice. All of it runs off the request's dynamic scope behind the page's
 * <Suspense> so the hero + controls paint instantly. Kept in ONE child on
 * purpose — the KPI strip and table share the SAME `allRows` walk, so this
 * runs the walk once instead of twice.
 *
 * `hrefWith` is a plain server→server closure prop (both this and the page
 * are Server Components) — no RSC function-prop boundary is crossed.
 */
async function LeaderboardsBody({
    tab,
    creatorUserId,
    includeCancelled,
    offset,
    sort,
    perPage,
    hrefWith,
}: {
    tab: StatusTab;
    creatorUserId: string | undefined;
    includeCancelled: boolean;
    offset: number;
    sort: SortValue | undefined;
    perPage: number;
    hrefWith: (
        extra?: Record<string, string | number | undefined | null>,
    ) => string;
}) {
    const timezone = await getAdminDisplayTimeZone();

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

    // Hydrate creator usernames from MAIN so admins see who owns each row.
    const creatorIds = [...new Set(rows.map((r) => r.creator_user_id))];
    const db = await getReadDrizzleDb();
    const creators = creatorIds.length > 0
        ? await db
              .select({ id: user.id, username: user.username, email: user.email })
              .from(user)
              .where(inArray(user.id, creatorIds))
        : [];
    const creatorMap = new Map(creators.map((c) => [c.id, c]));

    // Admin-side sponsored % (= the house's prize-pool share) per
    // leaderboard (admin DB). Best-effort — a failure renders every row
    // at the 100% default. Fetched over the WHOLE active-tab set
    // (allRows, already bounded by FETCH_CAP) — not just the visible
    // page — so the KPI strip below can weight house cost across every
    // row in the tab in a single query. The table only reads its own
    // page's ids out of the map.
    const sponsorshipMap = await getLeaderboardSponsorshipMap(
        allRows.map((r) => r.id),
    ).catch((e) => {
        console.error(
            "[leaderboards] sponsorship fetch failed (rows show 100%):",
            e,
        );
        return new Map<string, number>();
    });

    // KPI strip — computed over the active status-tab's full fetched set
    // (allRows), net of refunds, weighted by each row's house share %
    // (the admin-side "sponsored %"; absent → 100%). Mirrors the exact
    // committed-cost formula of getLeaderboardCostTotal / the /creators
    // Leaderboard Cost tile, just scoped to the rows already on screen.
    //
    // House-POV: prize money the house pays out to users is a house cost
    // → rose. The creator-funded off-site remainder isn't our spend →
    // blue/neutral. Active/Upcoming counts are operational → emerald/blue.
    //
    // NOTE: committed (pool − refund), NOT claimed. The list API / row
    // shape exposes no claimed-prize amount (prizes are manually claimed;
    // `paid_manually` is only a boolean), so a realized/claimed figure
    // would need a backend endpoint we don't have. This matches the
    // existing Leaderboard Cost tile.
    let kpiHouseCost = 0; // Σ (pool − refund) × house%
    let kpiPools = 0; // Σ (pool − refund) — full committed pools
    let kpiActive = 0;
    let kpiUpcoming = 0;
    for (const lb of allRows) {
        const pool = Number(lb.total_prize_usd) || 0;
        const refund = Number(lb.refund_amount_usd) || 0;
        const net = pool - refund;
        const pct = Math.min(
            100,
            Math.max(0, sponsorshipMap.get(lb.id) ?? 100),
        );
        kpiHouseCost += net * (pct / 100);
        kpiPools += net;
        if (lb.time_status === "active") kpiActive += 1;
        else if (lb.time_status === "upcoming") kpiUpcoming += 1;
    }
    // Creator-funded off-site = committed pools − the house's share.
    const kpiCreatorFunded = kpiPools - kpiHouseCost;
    // Blended "% we pay" — prize-weighted, i.e. house cost / pools. This
    // is the headline house-share %, not a naive mean of the per-row %s.
    const kpiAvgHouseShare = kpiPools > 0 ? (kpiHouseCost / kpiPools) * 100 : 0;

    const hasNext = offset + perPage < sortedRows.length;
    const hasPrev = offset > 0;

    return (
        <>
            {/* KPI strip — house cost + pools + the headline house-share
                %, over the active status-tab's full fetched set. House-POV:
                house spend is rose; the creator-funded off-site remainder
                is blue/neutral; live operational counts are emerald/blue. */}
            <FadeIn>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    <KpiTile
                        label="House Cost"
                        value={formatCurrency(kpiHouseCost)}
                        sub="Σ (pool − refund) × house share"
                        icon={Coins}
                        accent="rose"
                    />
                    <KpiTile
                        label="Total Prize Pools"
                        value={formatCurrency(kpiPools)}
                        sub="Committed pools, net of refunds"
                        icon={Layers}
                        accent="rose"
                    />
                    <KpiTile
                        label="Creator-Funded Off-Site"
                        value={formatCurrency(kpiCreatorFunded)}
                        sub="Pools − house cost"
                        icon={Handshake}
                        accent="blue"
                    />
                    <KpiTile
                        label="Avg House Share"
                        value={`${kpiAvgHouseShare.toFixed(1)}%`}
                        sub="Prize-weighted — the % we pay"
                        icon={Percent}
                        accent="rose"
                    />
                    <KpiTile
                        label="Active / Upcoming"
                        value={`${formatNumber(kpiActive)} / ${formatNumber(kpiUpcoming)}`}
                        sub={`${formatNumber(allRows.length)} in ${tab === "all" ? "all tabs" : `“${tab}”`}`}
                        icon={Activity}
                        accent="emerald"
                    />
                </div>
            </FadeIn>

            <FadeIn>
                <LeaderboardsTable
                    rows={rows}
                    creatorMap={creatorMap}
                    sponsorshipMap={sponsorshipMap}
                    timezone={timezone}
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
                        <div className="flex items-center gap-1 rounded-lg border bg-muted/50 p-1">
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
        </>
    );
}

/**
 * Fallback for the streamed body — KPI strip (5 tiles) + the 10-column
 * table + a pagination row, matching the real layout so the shell doesn't
 * jump when the data streams in. Mirrors the route's loading.tsx below the
 * controls row.
 */
function LeaderboardsBodySkeleton() {
    return (
        <>
            <KpiStripSkeleton count={5} />
            <TableSkeleton rows={10} columns={10} />
            <div className="flex items-center justify-between text-sm">
                <Skeleton className="h-4 w-32" />
                <div className="flex gap-2">
                    <Skeleton className="h-7 w-24 rounded-md" />
                    <Skeleton className="h-7 w-24 rounded-md" />
                </div>
            </div>
        </>
    );
}
