import Link from "next/link";
import { Trophy, Plus } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { getDb } from "@/lib/db";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { LeaderboardsTable } from "./_components/leaderboards-table";
import { CreateDialog } from "./_components/create-dialog";

export const metadata = { title: "Affiliate Leaderboards" };

const STATUS_TABS = [
    { value: "all", label: "All" },
    { value: "pending", label: "Pending" },
    { value: "approved", label: "Approved" },
    { value: "rejected", label: "Rejected" },
] as const;

type StatusTab = (typeof STATUS_TABS)[number]["value"];

const PAGE_LIMIT = 50;

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

    const result = await affiliateLeaderboardsApi.list({
        status: tab === "all" ? undefined : tab,
        creator_user_id: creatorUserId,
        // Only forward the flag when truthy — the backend's safe-boolean
        // schema accepts 'true'/'false'/'1'/'0' but never auto-derives a
        // default beyond hidden=false, so leaving it off is equivalent.
        include_cancelled: includeCancelled ? true : undefined,
        limit: PAGE_LIMIT,
        offset,
    });

    const rows = result.leaderboards;
    const total = result.total;

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

    const hasNext = offset + PAGE_LIMIT < total;
    const hasPrev = offset > 0;

    return (
        <div className="space-y-6">
            <PageHero>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                        <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
                            <Trophy className="size-5 text-primary" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold leading-tight">Affiliate Leaderboards</h1>
                            <p className="text-sm text-muted-foreground">
                                Create on behalf of any creator (site-funded), or manage existing entries.
                            </p>
                        </div>
                    </div>
                    <CreateDialog
                        trigger={
                            <Button>
                                <Plus className="size-4 mr-1" /> Create a creator leaderboard
                            </Button>
                        }
                    />
                </div>
            </PageHero>

            <div className="space-y-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex gap-1 rounded-lg bg-muted p-1">
                        {STATUS_TABS.map((s) => (
                            <Link
                                key={s.value}
                                href={`/creators/leaderboards${buildQueryString({
                                    status: s.value === "all" ? undefined : s.value,
                                    creator_user_id: creatorUserId,
                                    include_cancelled: includeCancelled ? "1" : undefined,
                                })}`}
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
                        {/* Cancelled rows stay in the DB for refund/audit trail —
                            toggle surfaces them when reviewing cancellations. */}
                        <Link
                            href={`/creators/leaderboards${buildQueryString({
                                status: tab === "all" ? undefined : tab,
                                creator_user_id: creatorUserId,
                                include_cancelled: includeCancelled ? undefined : "1",
                            })}`}
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
                    <LeaderboardsTable rows={rows} creatorMap={creatorMap} />
                </FadeIn>

                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                        Showing {rows.length} of {total} {total === 1 ? "row" : "rows"}
                    </span>
                    <div className="flex gap-2">
                        {hasPrev && (
                            <Link
                                href={`/creators/leaderboards${buildQueryString({
                                    status: tab === "all" ? undefined : tab,
                                    creator_user_id: creatorUserId,
                                    include_cancelled: includeCancelled ? "1" : undefined,
                                    offset: Math.max(0, offset - PAGE_LIMIT),
                                })}`}
                                className="rounded-md border px-3 py-1 hover:bg-muted"
                            >
                                ← Previous
                            </Link>
                        )}
                        {hasNext && (
                            <Link
                                href={`/creators/leaderboards${buildQueryString({
                                    status: tab === "all" ? undefined : tab,
                                    creator_user_id: creatorUserId,
                                    include_cancelled: includeCancelled ? "1" : undefined,
                                    offset: offset + PAGE_LIMIT,
                                })}`}
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
