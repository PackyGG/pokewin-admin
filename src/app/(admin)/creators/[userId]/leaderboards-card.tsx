import Link from "next/link";
import { Trophy, ExternalLink, Plus } from "lucide-react";

import { backendApi } from "@/lib/backend-api/client";
import { BackendApiError } from "@/lib/backend-api/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

import { InfoHint } from "../_components/info-hint";
import { CreateDialog } from "../leaderboards/_components/create-dialog";
import { CancelLeaderboardButton } from "../leaderboards/_components/cancel-leaderboard-button";
import { InlineSponsoredPercentage } from "../leaderboards/_components/inline-sponsored-percentage";
import { InlineCreatorPaid } from "../leaderboards/_components/inline-creator-paid";
import { getLeaderboardSponsorshipMap } from "../_queries/leaderboard-sponsorship";
import { getLeaderboardCreatorPaidMap } from "../_queries/leaderboard-creator-paid";
import { getCreatorLeaderboardWagerMap } from "./_queries/leaderboard-wager-by-board";

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
    // Scoping fields the backend already returns (see LeaderboardAdminRow)
    // — needed to compute each board's total wager against the same
    // code set + window the detail-page standings use.
    affiliate_codes: string[];
    co_creator_user_ids: string[];
    creator_user_id: string;
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
        // soft so the rest of the creator page still renders. This covers
        // BOTH a structured BackendApiError (HTTP non-2xx — its message is a
        // safe, intended summary) AND a raw transport failure (DNS / "fetch
        // failed" / timeout that never became a BackendApiError) — the latter
        // previously re-threw and took the whole creators segment into its
        // error boundary. We log the raw error server-side and show a generic
        // line for the non-BackendApiError case so no raw transport detail
        // leaks into the DOM.
        const isBackendErr = err instanceof BackendApiError;
        if (!isBackendErr) {
            console.error(
                "[creators.detail.leaderboards] backend fetch failed (card degraded):",
                err,
            );
        }
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
                        {isBackendErr
                            ? `Could not load leaderboards: ${err.message}`
                            : "Could not load leaderboards — the backend was unreachable. Refresh to retry."}
                    </p>
                </CardContent>
            </Card>
        );
    }

    const rows = response?.data.leaderboards ?? [];
    const total = response?.data.total ?? 0;
    const manageHref = `/creators/leaderboards?creator_user_id=${encodeURIComponent(userId)}`;

    // Admin-side sponsored % per leaderboard (admin DB) so each row can
    // edit it inline — no trip to the leaderboards page. Plus each
    // board's TOTAL wager so the owner sees volume inline without
    // clicking in. Both best-effort, fetched together: a sponsorship
    // failure renders every row at the 100% default; a wager failure
    // simply omits the "$X wagered" chip (name still renders). The wager
    // map is a single batched scan over the visible boards (PREVIEW_LIMIT
    // ≤ 10) — not N per-row queries — and is cached server-side.
    const [sponsorshipMap, creatorPaidMap, wagerMap] = await Promise.all([
        getLeaderboardSponsorshipMap(rows.map((r) => r.id)).catch(
            () => new Map<string, number>(),
        ),
        // Admin-side "creator paid his part" flag per board (admin DB) so
        // each row can toggle it inline. Best-effort: a failure renders
        // every toggle at the `false` (not-paid) default. Purely an
        // internal tracking flag — no money-math / cost / PnL impact.
        getLeaderboardCreatorPaidMap(rows.map((r) => r.id)).catch(
            () => new Map<string, boolean>(),
        ),
        getCreatorLeaderboardWagerMap(
            rows.map((r) => ({
                id: r.id,
                creatorUserId: r.creator_user_id,
                coCreatorUserIds: r.co_creator_user_ids ?? [],
                affiliateCodes: r.affiliate_codes ?? [],
                startDate: new Date(r.start_date),
                endDate: new Date(r.end_date),
            })),
        ).catch(() => new Map<string, number>()),
    ]);

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
                    <InfoHint
                        text="Wager-race leaderboards this creator runs for their cohort. The total prize is shown per board; the editable Sponsored % sets the house-funded share that feeds the /creators Leaderboard Cost."
                        iconClassName="size-3"
                    />
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
                    <EmptyState
                        icon={Trophy}
                        title="No affiliate leaderboards yet"
                        description="This creator hasn't submitted any leaderboards. Use Create to set one up on their behalf."
                        compact
                    />
                ) : (
                    <div className="space-y-2">
                        {rows.map((r) => {
                            // Total wager of this board — Σ of every standing's
                            // wager over the board's code(s) + window, batched
                            // above. Absent (undefined) when the board had no
                            // qualifying activity OR the wager fetch degraded;
                            // either way we just omit the chip and still render
                            // the name. House-POV: wager is money INTO the house
                            // treasury → emerald (matches the detail page's
                            // emerald "Wagered" column).
                            const wagered = wagerMap.get(r.id);
                            return (
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
                                            {wagered != null && (
                                                <span className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400 shrink-0">
                                                    · {formatCurrency(wagered)} wagered
                                                </span>
                                            )}
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
                                {/* Creator-paid toggle + Sponsored % editor +
                                    Cancel button — all sit outside the Link
                                    so their clicks don't navigate the row.
                                    The Creator-paid tick is a PURELY internal
                                    tracking flag ("so we know if he paid or
                                    not") — no money-math / cost / PnL impact.
                                    The Sponsored % feeds the /creators
                                    Leaderboard Cost KPI; editing it here
                                    saves a trip to the leaderboards page. */}
                                <div className="flex items-center gap-2 pr-2">
                                    <InlineCreatorPaid
                                        leaderboardId={r.id}
                                        initialPaid={creatorPaidMap.get(r.id) ?? false}
                                    />
                                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                        <span className="hidden items-center gap-1 sm:inline-flex">
                                            Sponsored
                                            <InfoHint
                                                text="The house-funded share of this leaderboard's prize pool. Editing it here changes how much of the prize counts as house cost in the Leaderboard Cost figures (defaults to 100%)."
                                                iconClassName="size-2.5"
                                            />
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
                            );
                        })}
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
