import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { isUuid } from "@/lib/utils/ids";
import { getDb } from "@/lib/db";
import {
    affiliateLeaderboardsApi,
    type ApprovalStatus,
    type TimeStatus,
} from "@/lib/backend-api/affiliate-leaderboards";
import { BackendApiError } from "@/lib/backend-api/errors";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
    getAffiliateLeaderboardRankings,
    getAffiliateLeaderboardClaims,
} from "@/lib/queries/creators";
import { getRewardExpiry } from "@/lib/backend-api/reward-expiry";
import { computeLeaderboardClaimWindow } from "@/lib/reward-expiry/leaderboard-claim-window";
import { getCreatorLeaderboardWagerMap } from "../../../../(admin)/creators/[userId]/_queries/leaderboard-wager-by-board";

import { LeaderboardStandingsPanel } from "../../../../(admin)/creators/leaderboards/_components/leaderboard-standings-panel";
import { LeaderboardClaimsPanel } from "../../../../(admin)/creators/leaderboards/_components/leaderboard-claims-panel";

export const metadata = { title: "Leaderboard · Creator Hub" };

const APPROVAL_COLORS: Record<ApprovalStatus, string> = {
    pending:
        "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    approved:
        "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

const TIME_COLORS: Record<TimeStatus, string> = {
    upcoming: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
    active:
        "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    ended: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export default async function CreatorHubLeaderboardDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requireCreatorHubPageAccess();
    const { id } = await params;
    if (!isUuid(id)) notFound();

    let lb;
    try {
        lb = await affiliateLeaderboardsApi.get(id);
    } catch (err) {
        if (err instanceof BackendApiError && err.status === 404) {
            notFound();
        }
        throw err;
    }

    const db = await getDb();
    const [creator, standings, claimHolds, wagerMap, claims, leaderboardExpiryDays] = await Promise.all([
        db.user
            .findUnique({
                where: { id: lb.creator_user_id },
                select: { id: true, username: true, email: true },
            })
            .catch((err) => {
                console.error("[creator-hub.leaderboard] creator hydration failed", err);
                return null;
            }),
        getAffiliateLeaderboardRankings({
            leaderboardId: lb.id,
            creatorUserId: lb.creator_user_id,
            coCreatorUserIds: lb.co_creator_user_ids ?? [],
            affiliateCodes: lb.affiliate_codes,
            startDate: new Date(lb.start_date),
            endDate: new Date(lb.end_date),
            prizeTiers: lb.prize_tiers,
            limit: 100,
        }).catch((err) => {
            console.error("[creator-hub.leaderboard] rankings query failed", err);
            return { rankings: [], source: "live" as const };
        }),
        affiliateLeaderboardsApi.listClaimHolds(id).catch((err) => {
            console.error("[creator-hub.leaderboard] claim holds query failed", err);
            return [] as Awaited<ReturnType<typeof affiliateLeaderboardsApi.listClaimHolds>>;
        }),
        getCreatorLeaderboardWagerMap([
            {
                id: lb.id,
                creatorUserId: lb.creator_user_id,
                coCreatorUserIds: lb.co_creator_user_ids ?? [],
                affiliateCodes: lb.affiliate_codes ?? [],
                startDate: new Date(lb.start_date),
                endDate: new Date(lb.end_date),
            },
        ]).catch((err) => {
            console.error("[creator-hub.leaderboard] wager map failed", err);
            return new Map<string, number>();
        }),
        getAffiliateLeaderboardClaims(id).catch((err) => {
            console.error("[creator-hub.leaderboard] claims query failed", err);
            return [] as Awaited<ReturnType<typeof getAffiliateLeaderboardClaims>>;
        }),
        getRewardExpiry().then(
            (e) => e.leaderboard_days,
            () => null as number | null,
        ),
    ]);

    const claimWindow = computeLeaderboardClaimWindow({
        endIso: lb.end_date,
        expiryDays: leaderboardExpiryDays,
    });
    const rankings = standings.rankings;
    const holdByUserId = new Map(claimHolds.map((h) => [h.user_id, h]));
    const creatorLabel =
        creator?.username ?? creator?.email ?? lb.creator_user_id.slice(0, 8);
    const totalWagerUsd =
        wagerMap.get(lb.id) ??
        rankings.reduce((sum, r) => sum + r.totalWageredUsd, 0);

    return (
        <div className="space-y-6">
            <PageHero>
                <div className="flex items-start gap-3">
                    <Link
                        href="/creator-hub/leaderboards"
                        className="mt-1 flex size-9 items-center justify-center rounded-lg border hover:bg-muted"
                    >
                        <ArrowLeft className="size-4" />
                    </Link>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-2xl font-bold leading-tight">{lb.title}</h1>
                        <div className="mt-1 flex items-center gap-2 flex-wrap">
                            <Badge
                                variant="outline"
                                className={APPROVAL_COLORS[lb.approval_status]}
                            >
                                {lb.approval_status}
                            </Badge>
                            <Badge variant="outline" className={TIME_COLORS[lb.time_status]}>
                                {lb.time_status}
                            </Badge>
                            {lb.is_sponsored && <Badge variant="outline">sponsored</Badge>}
                            {lb.cancelled_at && (
                                <Badge
                                    variant="outline"
                                    className="bg-zinc-500/15 text-zinc-600 border-zinc-500/30"
                                >
                                    cancelled
                                </Badge>
                            )}
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">
                            Creator:{" "}
                            <Link
                                href={`/creator-hub/creators/${lb.creator_user_id}`}
                                className="font-medium text-foreground hover:underline"
                            >
                                {creatorLabel}
                            </Link>
                        </p>
                    </div>
                </div>
            </PageHero>

            <FadeIn>
                <div className="rounded-lg border p-5 space-y-3">
                    <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                        Summary
                    </h2>
                    <SummaryRow
                        label="Event window"
                        value={`${formatDate(lb.start_date)} → ${formatDate(lb.end_date)}`}
                    />
                    <SummaryRow
                        label="Prize pool"
                        value={
                            <span className="tabular-nums font-semibold">
                                ${lb.total_prize_usd}
                            </span>
                        }
                    />
                    <SummaryRow
                        label="Total wager"
                        value={
                            totalWagerUsd > 0 ? (
                                <span className="tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                                    {formatCurrency(totalWagerUsd)}
                                </span>
                            ) : (
                                <span className="text-muted-foreground italic">—</span>
                            )
                        }
                    />
                    <SummaryRow
                        label="Affiliate codes"
                        value={
                            lb.affiliate_codes.length > 0 ? (
                                <div className="flex flex-wrap justify-end gap-1">
                                    {lb.affiliate_codes.map((c) => (
                                        <Badge key={c} variant="outline">
                                            {c}
                                        </Badge>
                                    ))}
                                </div>
                            ) : (
                                <span className="text-muted-foreground italic">all codes</span>
                            )
                        }
                    />
                    <div className="border-t pt-3">
                        <Link
                            href={`/creators/leaderboards/${lb.id}`}
                            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                        >
                            Full admin view
                            <ExternalLink className="size-3.5" />
                        </Link>
                    </div>
                </div>
            </FadeIn>

            <LeaderboardClaimsPanel claimWindow={claimWindow} claims={claims} />

            <LeaderboardStandingsPanel
                leaderboardId={lb.id}
                rankings={rankings}
                holdByUserId={holdByUserId}
                timeStatus={lb.time_status}
                source={standings.source}
            />
        </div>
    );
}

function SummaryRow({
    label,
    value,
}: {
    label: string;
    value: React.ReactNode;
}) {
    return (
        <div className="flex items-start justify-between gap-4 text-sm">
            <span className="text-muted-foreground shrink-0">{label}</span>
            <div className={cn("text-right max-w-[65%]")}>{value}</div>
        </div>
    );
}
