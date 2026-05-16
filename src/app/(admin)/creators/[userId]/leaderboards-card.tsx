import Link from "next/link";
import { Trophy, ExternalLink, Plus } from "lucide-react";

import { backendApi } from "@/lib/backend-api/client";
import { BackendApiError } from "@/lib/backend-api/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils/format";

import { CreateDialog } from "../leaderboards/_components/create-dialog";
import { CancelLeaderboardButton } from "../leaderboards/_components/cancel-leaderboard-button";
import { InlineSponsoredPercentage } from "../leaderboards/_components/inline-sponsored-percentage";
import { getLeaderboardSponsorshipMap } from "../_queries/leaderboard-sponsorship";

type ApprovalStatus = "pending" | "approved" | "rejected";
type TimeStatus = "upcoming" | "active" | "ended";

type LeaderboardRow = {
    id: string;
    title: string;
    creator_prize_usd: string;
    site_bonus_usd: string;
    total_prize_usd: string;
    is_sponsored: boolean;
    start_date: string;
    end_date: string;
    approval_status: ApprovalStatus;
    cancelled_at: string | null;
    time_status: TimeStatus;
};

type ListResponse = {
    success: boolean;
    data: {
        leaderboards: LeaderboardRow[];
        total: number;
    };
};

const APPROVAL_COLORS: Record<ApprovalStatus, string> = {
    pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    approved: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
    rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

const TIME_COLORS: Record<TimeStatus, string> = {
    upcoming: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
    active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    ended: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

const PREVIEW_LIMIT = 10;

export async function LeaderboardsCard({ userId }: { userId: string }) {
    let response: ListResponse | null = null;
    try {
        response = await backendApi.get<ListResponse>("/admin/affiliate-leaderboards", {
            query: { creator_user_id: userId, limit: PREVIEW_LIMIT, offset: 0 },
        });
    } catch (err) {
        // The backend admin endpoint may not be reachable in some envs; fail
        // soft so the rest of the creator page still renders.
        if (err instanceof BackendApiError) {
            return (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle className="text-sm font-medium flex items-center gap-2">
                            <Trophy className="size-4 text-primary" />
                            Affiliate Leaderboards
                        </CardTitle>
                        <CreateDialog
                            fixedCreatorUserId={userId}
                            trigger={
                                <Button size="sm" variant="outline">
                                    <Plus className="size-3.5 mr-1" /> Create
                                </Button>
                            }
                        />
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm text-muted-foreground">
                            Could not load leaderboards: {err.message}
                        </p>
                    </CardContent>
                </Card>
            );
        }
        throw err;
    }

    const rows = response?.data.leaderboards ?? [];
    const total = response?.data.total ?? 0;
    const manageHref = `/creators/leaderboards?creator_user_id=${encodeURIComponent(userId)}`;

    // Admin-side sponsored % per leaderboard (admin DB) so each row can
    // edit it inline — no trip to the leaderboards page. Best-effort:
    // a failure just renders every row at the 100% default.
    const sponsorshipMap = await getLeaderboardSponsorshipMap(
        rows.map((r) => r.id),
    ).catch(() => new Map<string, number>());

    return (
        <Card>
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Trophy className="size-4 text-primary shrink-0" />
                    <span className="truncate">Affiliate Leaderboards</span>
                    {total > 0 && (
                        <Badge variant="outline" className="text-xs ml-1">
                            {total}
                        </Badge>
                    )}
                </CardTitle>
                <div className="flex items-center gap-2 self-start sm:self-auto">
                    <CreateDialog
                        fixedCreatorUserId={userId}
                        trigger={
                            <Button size="sm" variant="outline">
                                <Plus className="size-3.5 mr-1" /> Create
                            </Button>
                        }
                    />
                    <Link
                        href={manageHref}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                        Manage
                        <ExternalLink className="size-3.5" />
                    </Link>
                </div>
            </CardHeader>
            <CardContent>
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        This creator has not submitted any affiliate leaderboards yet.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {rows.map((r) => (
                            // Row split into a Link (body) + Cancel button
                            // sibling so the cancel control isn't trapped
                            // inside the row's click area. Hover state lives
                            // on the inner Link to match the original look.
                            <div
                                key={r.id}
                                className="flex items-stretch gap-2 rounded-md border has-[a:hover]:bg-muted/50 transition-colors"
                            >
                                <Link
                                    href={`/creators/leaderboards/${r.id}`}
                                    className="flex flex-1 min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 p-3"
                                >
                                    <div className="min-w-0 sm:flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium text-sm truncate">{r.title}</span>
                                            {r.is_sponsored && (
                                                <Badge variant="outline" className="text-[10px]">
                                                    sponsored
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                                            <span className="truncate">
                                                {formatDateTime(r.start_date)} → {formatDateTime(r.end_date)}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex items-center flex-wrap gap-1.5 sm:gap-2 sm:shrink-0">
                                        <span className="text-sm tabular-nums font-semibold">${r.total_prize_usd}</span>
                                        <Badge variant="outline" className={`text-[10px] ${APPROVAL_COLORS[r.approval_status]}`}>
                                            {r.approval_status}
                                        </Badge>
                                        <Badge variant="outline" className={`text-[10px] ${TIME_COLORS[r.time_status]}`}>
                                            {r.time_status}
                                        </Badge>
                                        {r.cancelled_at && (
                                            <Badge variant="outline" className="text-[10px] bg-zinc-500/15 text-zinc-600 border-zinc-500/30">
                                                cancelled
                                            </Badge>
                                        )}
                                    </div>
                                </Link>
                                {/* Sponsored % editor + Cancel button —
                                    both sit outside the Link so their
                                    clicks don't navigate the row. The
                                    Sponsored % feeds the /creators
                                    Leaderboard Cost KPI; editing it here
                                    saves a trip to the leaderboards page. */}
                                <div className="flex items-center gap-2 pr-2">
                                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                        <span className="hidden sm:inline">
                                            Sponsored
                                        </span>
                                        <InlineSponsoredPercentage
                                            leaderboardId={r.id}
                                            current={
                                                sponsorshipMap.get(r.id) ?? null
                                            }
                                        />
                                    </div>
                                    <CancelLeaderboardButton
                                        id={r.id}
                                        title={r.title}
                                        disabled={r.cancelled_at !== null}
                                    />
                                </div>
                            </div>
                        ))}
                        {total > rows.length && (
                            <Link
                                href={manageHref}
                                className="block text-center text-xs text-muted-foreground hover:text-foreground py-1"
                            >
                                View all {total} leaderboards →
                            </Link>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
