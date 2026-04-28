import Link from "next/link";
import { Trophy, Plus } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { getDb } from "@/lib/db";
import {
    affiliateLeaderboardsApi,
    type ApprovalStatus,
    type TimeStatus,
} from "@/lib/backend-api/affiliate-leaderboards";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/utils/format";

import { ListRowActions } from "./_components/list-row-actions";
import { CreateDialog } from "./_components/create-dialog";

export const metadata = { title: "Affiliate Leaderboards" };

const APPROVAL_COLORS: Record<ApprovalStatus, string> = {
    pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    approved: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    rejected: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

const TIME_COLORS: Record<TimeStatus, string> = {
    upcoming: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
    active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    ended: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

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
    const offset = Number(params.offset) || 0;

    const result = await affiliateLeaderboardsApi.list({
        status: tab === "all" ? undefined : tab,
        creator_user_id: creatorUserId,
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

                    <form className="flex items-center gap-2" action="/creators/leaderboards" method="get">
                        {tab !== "all" && <input type="hidden" name="status" value={tab} />}
                        <Input
                            name="creator_user_id"
                            defaultValue={creatorUserId ?? ""}
                            placeholder="Filter by creator user id..."
                            className="w-64"
                        />
                    </form>
                </div>

                <FadeIn>
                    <div className="rounded-md border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Title</TableHead>
                                    <TableHead>Creator</TableHead>
                                    <TableHead>Approval</TableHead>
                                    <TableHead>Time</TableHead>
                                    <TableHead className="text-right">Creator $</TableHead>
                                    <TableHead className="text-right">Bonus $</TableHead>
                                    <TableHead className="text-right">Total $</TableHead>
                                    <TableHead>Starts</TableHead>
                                    <TableHead>Ends</TableHead>
                                    <TableHead className="w-[200px]" />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                                            No leaderboards found for this filter.
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    rows.map((r) => {
                                        const creator = creatorMap.get(r.creator_user_id);
                                        return (
                                            <TableRow key={r.id}>
                                                <TableCell>
                                                    <Link
                                                        href={`/creators/leaderboards/${r.id}`}
                                                        className="font-medium hover:underline"
                                                    >
                                                        {r.title}
                                                    </Link>
                                                    {r.is_sponsored && (
                                                        <Badge variant="outline" className="ml-2 text-xs">
                                                            sponsored
                                                        </Badge>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    {creator ? (
                                                        <div className="flex flex-col">
                                                            <span className="text-sm">{creator.username ?? "(no username)"}</span>
                                                            <span className="text-xs text-muted-foreground font-mono">
                                                                {r.creator_user_id.slice(0, 12)}…
                                                            </span>
                                                        </div>
                                                    ) : (
                                                        <span className="text-xs text-muted-foreground font-mono">
                                                            {r.creator_user_id}
                                                        </span>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline" className={APPROVAL_COLORS[r.approval_status]}>
                                                        {r.approval_status}
                                                    </Badge>
                                                    {r.cancelled_at && (
                                                        <Badge variant="outline" className="ml-2 bg-zinc-500/15 text-zinc-600 border-zinc-500/30">
                                                            cancelled
                                                        </Badge>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline" className={TIME_COLORS[r.time_status]}>
                                                        {r.time_status}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums">${r.creator_prize_usd}</TableCell>
                                                <TableCell className="text-right tabular-nums">${r.site_bonus_usd}</TableCell>
                                                <TableCell className="text-right tabular-nums font-semibold">${r.total_prize_usd}</TableCell>
                                                <TableCell className="text-xs">{formatDateTime(r.start_date)}</TableCell>
                                                <TableCell className="text-xs">{formatDateTime(r.end_date)}</TableCell>
                                                <TableCell>
                                                    <ListRowActions row={r} />
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })
                                )}
                            </TableBody>
                        </Table>
                    </div>
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
