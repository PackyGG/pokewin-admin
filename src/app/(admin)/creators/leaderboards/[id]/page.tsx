import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Trophy } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { getDb } from "@/lib/db";
import {
    affiliateLeaderboardsApi,
    type ApprovalStatus,
    type TimeStatus,
    type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { BackendApiError } from "@/lib/backend-api/errors";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { Badge } from "@/components/ui/badge";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { getAdminDisplayTimeZone } from "@/lib/timezone/server";
import { timezoneLabel } from "@/lib/timezones";
import { cn } from "@/lib/utils";
import { StatPanelSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import {
    getAffiliateLeaderboardRankings,
    getAffiliateLeaderboardClaims,
} from "@/lib/queries/creators";
import { getRewardExpiry } from "@/lib/backend-api/reward-expiry";
import { computeLeaderboardClaimWindow } from "@/lib/reward-expiry/leaderboard-claim-window";
import { compareCreatorsLeaderboards } from "@/lib/clickhouse/compare/creators-leaderboards";

import { DetailActions } from "../_components/detail-actions";
import { ManualPaymentPanel } from "../_components/manual-payment-panel";
import { LeaderboardStandingsPanel } from "../_components/leaderboard-standings-panel";
import { LeaderboardClaimsPanel } from "../_components/leaderboard-claims-panel";
import {
    LeaderboardDetailCountdown,
    type LeaderboardCountdownMode,
} from "../_components/leaderboard-detail-countdown";

export const metadata = { title: "Affiliate Leaderboard" };

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

export default async function AffiliateLeaderboardDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requirePageAccess("/creators/leaderboards");
    const { id } = await params;
    // Shape-check UUID before any DB / backend call — see src/lib/utils/ids.ts.
    if (!isUuid(id)) notFound();

    // Critical path = ONLY the leaderboard definition (the hero title + badges
    // + actions render off this). A 404 → notFound(); a non-404 backend error
    // is caught and rendered as a friendly in-page state below so it can't
    // trip the whole route error boundary. Everything heavy (standings,
    // claims, holds, sponsorship %, creator hydration) streams behind the
    // <Suspense> boundary in <LeaderboardDetailBody>, so the hero paints
    // instantly instead of blocking on the 6-way Promise.all.
    let lb: LeaderboardAdminRow;
    try {
        lb = await affiliateLeaderboardsApi.get(id);
    } catch (err) {
        if (err instanceof BackendApiError && err.status === 404) {
            notFound();
        }
        // Non-404 (backend down / 5xx / network) — render the hero shell with a
        // friendly error state instead of throwing to the route boundary.
        return (
            <div className="space-y-6">
                <PageHero>
                    <div className="flex items-start gap-3">
                        <Link
                            href="/creators/leaderboards"
                            className="mt-1 flex size-9 items-center justify-center rounded-lg border hover:bg-muted"
                        >
                            <ArrowLeft className="size-4" />
                        </Link>
                        <div>
                            <h1 className="text-2xl font-bold leading-tight">
                                Affiliate leaderboard
                            </h1>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Couldn&apos;t load this leaderboard.
                            </p>
                        </div>
                    </div>
                </PageHero>
                <TileErrorFallback
                    label="Leaderboard unavailable"
                    hint="The leaderboard service didn't respond — refresh to retry."
                    size="panel"
                />
            </div>
        );
    }

    const now = Date.now();
    const startMs = new Date(lb.start_date).getTime();
    const endMs = new Date(lb.end_date).getTime();
    let countdownMode: LeaderboardCountdownMode;
    let countdownEdgeIso: string;
    let countdownInitialMs: number;
    if (lb.cancelled_at) {
        countdownMode = "cancelled";
        countdownEdgeIso = lb.end_date;
        countdownInitialMs = 0;
    } else if (lb.time_status === "upcoming" || now < startMs) {
        countdownMode = "starts_in";
        countdownEdgeIso = lb.start_date;
        countdownInitialMs = Math.max(0, startMs - now);
    } else if (lb.time_status === "active" || now < endMs) {
        countdownMode = "ends_in";
        countdownEdgeIso = lb.end_date;
        countdownInitialMs = Math.max(0, endMs - now);
    } else {
        countdownMode = "ended";
        countdownEdgeIso = lb.end_date;
        countdownInitialMs = 0;
    }

    return (
        <div className="space-y-6">
            <PageHero>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-start gap-3">
                        <Link
                            href="/creators/leaderboards"
                            className="mt-1 flex size-9 items-center justify-center rounded-lg border hover:bg-muted"
                        >
                            <ArrowLeft className="size-4" />
                        </Link>
                        <div>
                            <h1 className="text-2xl font-bold leading-tight">{lb.title}</h1>
                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                                <Badge variant="outline" className={APPROVAL_COLORS[lb.approval_status]}>
                                    {lb.approval_status}
                                </Badge>
                                <Badge variant="outline" className={TIME_COLORS[lb.time_status]}>
                                    {lb.time_status}
                                </Badge>
                                {lb.is_sponsored && <Badge variant="outline">sponsored</Badge>}
                                {lb.paid_manually && (
                                    <Badge
                                        variant="outline"
                                        className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                                    >
                                        paid manually
                                    </Badge>
                                )}
                                {lb.cancelled_at && (
                                    <Badge variant="outline" className="bg-zinc-500/15 text-zinc-600 border-zinc-500/30">
                                        cancelled
                                    </Badge>
                                )}
                            </div>
                        </div>
                    </div>
                    {/* Actions render off the definition alone. The admin-side
                        sponsored % (a single-row admin-DB read that only pre-fills
                        the Edit dialog) streams in the body; until then the Edit
                        dialog defaults to 100% — the same fallback the sponsorship
                        query already documents. Keeping it off the hero critical
                        path is what lets the hero paint instantly. */}
                    <DetailActions row={lb} currentSponsoredPct={null} />
                </div>
            </PageHero>

            <Suspense fallback={<LeaderboardDetailBodySkeleton />}>
                <LeaderboardDetailBody
                    lb={lb}
                    countdownMode={countdownMode}
                    countdownEdgeIso={countdownEdgeIso}
                    countdownInitialMs={countdownInitialMs}
                />
            </Suspense>
        </div>
    );
}

/**
 * Streamed body: everything below the hero. Runs the 6-way batch (creator
 * hydration + standings + sponsorship % + claim holds + claims + expiry)
 * off the request's dynamic scope so it never blocks first paint. Each leg
 * already best-effort-catches its own failure, so a single failing read
 * degrades that section instead of the whole page.
 */
async function LeaderboardDetailBody({
    lb,
    countdownMode,
    countdownEdgeIso,
    countdownInitialMs,
}: {
    lb: LeaderboardAdminRow;
    countdownMode: LeaderboardCountdownMode;
    countdownEdgeIso: string;
    countdownInitialMs: number;
}) {
    const tz = await getAdminDisplayTimeZone();
    const fmt = (iso: string) => formatDateTime(iso, tz);
    const db = await getDb();
    const participatingCreatorIds = [lb.creator_user_id, ...(lb.co_creator_user_ids ?? [])];
    const [creators, standings, claimHolds, claims, leaderboardExpiryDays] = await Promise.all([
        // Hydrate the primary creator plus every co-creator in one query so we
        // can render names alongside each id on the definition card.
        // Best-effort — a failure just renders the raw ids (names omitted)
        // instead of throwing the whole page via the Promise.all reject.
        db.user
            .findMany({
                where: { id: { in: participatingCreatorIds } },
                select: { id: true, username: true, email: true },
            })
            .catch((err) => {
                console.error("[leaderboard] creator hydration query failed", err);
                return [] as { id: string; username: string | null; email: string | null }[];
            }),
        // Standings — settled boards read the authoritative WEIGHTED
        // snapshot (affiliate_leaderboard_snapshots); active boards with no
        // snapshot yet fall back to a live UNWEIGHTED estimate from raw
        // affiliate_code_usages (this backend exposes no /rankings endpoint).
        // Wraps in a try/catch so a query error never breaks the page — the
        // rest of the leaderboard config still renders.
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
            console.error("[leaderboard] rankings query failed", err);
            return { rankings: [], source: "live" as const };
        }),
        // Active claim holds (freezes) so each standings row can show a
        // Freeze / Unfreeze control. Best-effort — a failure just renders the
        // standings without freeze state instead of throwing the whole page.
        affiliateLeaderboardsApi.listClaimHolds(lb.id).catch((err) => {
            console.error("[leaderboard] claim holds query failed", err);
            return [] as Awaited<ReturnType<typeof affiliateLeaderboardsApi.listClaimHolds>>;
        }),
        // Settled prize claims — who has already claimed (MAIN DB, indexed on
        // leaderboard_id). Best-effort — a failure just renders an empty
        // claimants list instead of throwing the whole page.
        getAffiliateLeaderboardClaims(lb.id).catch((err) => {
            console.error("[leaderboard] claims query failed", err);
            return [] as Awaited<ReturnType<typeof getAffiliateLeaderboardClaims>>;
        }),
        // Live claim-window length (days after the event ends; 0 = never).
        // null on failure → the banner renders an "unavailable" state.
        getRewardExpiry().then(
            (e) => e.leaderboard_days,
            () => null as number | null,
        ),
    ]);
    const rankings = standings.rankings;
    // "settled" → weighted snapshot (matches what was paid); "live" →
    // unweighted live estimate for an active board with no snapshot yet.
    const standingsSettled = standings.source === "settled";
    const claimWindow = computeLeaderboardClaimWindow({
        endIso: lb.end_date,
        expiryDays: leaderboardExpiryDays,
    });
    // Map user_id → active hold so standings rows can render freeze state in O(1).
    const holdByUserId = new Map(claimHolds.map((h) => [h.user_id, h]));
    const creatorById = new Map(creators.map((c) => [c.id, c]));
    const creator = creatorById.get(lb.creator_user_id) ?? null;
    const coCreatorRows = (lb.co_creator_user_ids ?? []).map((cid) => ({
        id: cid,
        username: creatorById.get(cid)?.username ?? null,
        email: creatorById.get(cid)?.email ?? null,
    }));
    const standingsHousePnlUsd = rankings.reduce(
        (sum, r) => sum + r.housePnlUsd,
        0,
    );

    // Fire-and-forget CQRS comparison (Phase 2B). No-op unless the
    // `creators_leaderboards` surface is in comparison mode; the served value
    // above is ALWAYS the Postgres `rankings`. Mirrors the same opts so the CH
    // twin replicates the EXACT 2-role + blacklist scope. Only meaningful for
    // the LIVE raw path — settled boards now serve the weighted snapshot,
    // which the raw CH twin can't reproduce, so skip the comparison there.
    if (!standingsSettled) {
        void compareCreatorsLeaderboards(
            lb.id,
            {
                creatorUserId: lb.creator_user_id,
                coCreatorUserIds: lb.co_creator_user_ids ?? [],
                affiliateCodes: lb.affiliate_codes,
                startDate: new Date(lb.start_date),
                endDate: new Date(lb.end_date),
                prizeTiers: lb.prize_tiers,
                limit: 100,
            },
            rankings,
        );
    }

    return (
        <>
            <div className="grid gap-6 md:grid-cols-2">
                <FadeIn>
                    <div className="rounded-lg border p-5 space-y-3">
                        <div>
                            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                                Definition
                            </h2>
                            <p className="text-xs text-muted-foreground mt-1">
                                Times in {timezoneLabel(tz)}
                            </p>
                        </div>
                        <DefRow label="ID" value={<span className="font-mono text-xs">{lb.id}</span>} />
                        <DefRow
                            label="Creator"
                            value={
                                <div className="flex flex-col">
                                    <span>{creator?.username ?? "(no username)"}</span>
                                    <span className="text-xs text-muted-foreground font-mono">{lb.creator_user_id}</span>
                                </div>
                            }
                        />
                        {coCreatorRows.length > 0 && (
                            <DefRow
                                label="Co-creators"
                                value={
                                    <div className="flex flex-col gap-1">
                                        {coCreatorRows.map((c) => (
                                            <div key={c.id} className="flex flex-col">
                                                <span>{c.username ?? c.email ?? "(no username)"}</span>
                                                <span className="text-xs text-muted-foreground font-mono">{c.id}</span>
                                            </div>
                                        ))}
                                    </div>
                                }
                            />
                        )}
                        <DefRow
                            label="Affiliate codes"
                            value={
                                <div className="flex flex-col items-end gap-1.5">
                                    {lb.affiliate_codes.length > 0 ? (
                                        <div className="flex gap-1 flex-wrap justify-end">
                                            {lb.affiliate_codes.map((c) => (
                                                <Badge key={c} variant="outline">
                                                    {c}
                                                </Badge>
                                            ))}
                                        </div>
                                    ) : (
                                        <span className="text-muted-foreground italic">all codes</span>
                                    )}
                                    {rankings.length > 0 && (
                                        <HousePnlLabel
                                            label="House P&L (event window)"
                                            pnl={standingsHousePnlUsd}
                                            className="text-xs"
                                        />
                                    )}
                                </div>
                            }
                        />
                        <DefRow label="Starts" value={fmt(lb.start_date)} />
                        <DefRow label="Ends" value={fmt(lb.end_date)} />
                        <LeaderboardDetailCountdown
                            mode={countdownMode}
                            edgeIso={countdownEdgeIso}
                            initialMs={countdownInitialMs}
                        />
                        <DefRow label="Created" value={fmt(lb.created_at)} />
                    </div>
                </FadeIn>

                <FadeIn>
                    <div className="rounded-lg border p-5 space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Prize pool
                        </h2>
                        <DefRow label="Creator funded" value={<span className="tabular-nums">${lb.creator_prize_usd}</span>} />
                        <DefRow label="Site bonus" value={<span className="tabular-nums">${lb.site_bonus_usd}</span>} />
                        <DefRow
                            label="Total"
                            value={<span className="tabular-nums font-semibold">${lb.total_prize_usd}</span>}
                        />
                    </div>
                </FadeIn>

                <FadeIn>
                    <div className="rounded-lg border p-5 space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Approval lifecycle
                        </h2>
                        <DefRow
                            label="Approved at"
                            value={lb.approved_at ? fmt(lb.approved_at) : "—"}
                        />
                        <DefRow
                            label="Approved by"
                            value={
                                lb.approved_by ? (
                                    <span className="font-mono text-xs">{lb.approved_by}</span>
                                ) : (
                                    "—"
                                )
                            }
                        />
                        <DefRow
                            label="Rejection reason"
                            value={lb.rejection_reason ?? <span className="text-muted-foreground">—</span>}
                        />
                    </div>
                </FadeIn>

                <FadeIn>
                    <div className="rounded-lg border p-5 space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Cancellation & refund
                        </h2>
                        <DefRow
                            label="Cancelled at"
                            value={lb.cancelled_at ? fmt(lb.cancelled_at) : "—"}
                        />
                        <DefRow
                            label="Cancelled by"
                            value={
                                lb.cancelled_by ? (
                                    <span className="font-mono text-xs">{lb.cancelled_by}</span>
                                ) : (
                                    "—"
                                )
                            }
                        />
                        <DefRow
                            label="Refunded at"
                            value={lb.refunded_at ? fmt(lb.refunded_at) : "—"}
                        />
                        <DefRow
                            label="Refund amount"
                            value={lb.refund_amount_usd ? `$${lb.refund_amount_usd}` : "—"}
                        />
                        <DefRow
                            label="Creation ledger tx"
                            value={
                                lb.creation_ledger_tx_id ? (
                                    <span className="font-mono text-xs">{lb.creation_ledger_tx_id}</span>
                                ) : (
                                    "—"
                                )
                            }
                        />
                        <DefRow
                            label="Refund ledger tx"
                            value={
                                lb.refund_ledger_tx_id ? (
                                    <span className="font-mono text-xs">{lb.refund_ledger_tx_id}</span>
                                ) : (
                                    "—"
                                )
                            }
                        />
                    </div>
                </FadeIn>

                <FadeIn>
                    <ManualPaymentPanel
                        leaderboardId={lb.id}
                        initialPaidManually={lb.paid_manually}
                        initialPayoutNote={lb.payout_note}
                    />
                </FadeIn>
            </div>

            {/* Window-drift warning — surfaces when the event window
                no longer matches what was originally approved. Two
                triggers:
                  1. start_date < created_at — the start was backdated
                     after the leaderboard was created.
                  2. approved_at exists and is past start_date — the
                     window opened before the approval landed, so any
                     wager activity in the gap counts retroactively.
                Live standings always recompute against the current
                window, so the admin needs to know when that window
                drifted from the originally-approved scoring period. */}
            {(() => {
                const created = new Date(lb.created_at);
                const start = new Date(lb.start_date);
                const startedBeforeCreation = start.getTime() < created.getTime();
                const approvedAfterStart = lb.approved_at
                    ? new Date(lb.approved_at).getTime() > start.getTime()
                    : false;
                if (!startedBeforeCreation && !approvedAfterStart) return null;
                return (
                    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                        <AlertTriangle className="size-4 mt-0.5 text-amber-500 shrink-0" />
                        <div>
                            <div className="font-medium text-amber-500">
                                Window changed after creation
                            </div>
                            <div className="mt-0.5 text-muted-foreground">
                                This leaderboard&apos;s window was changed after
                                creation — live standings are recomputed against
                                the current window, which may not match the
                                originally-approved scoring period.
                            </div>
                        </div>
                    </div>
                );
            })()}

            <LeaderboardClaimsPanel
                claimWindow={claimWindow}
                claims={claims}
                tz={tz}
            />

            <LeaderboardStandingsPanel
                leaderboardId={lb.id}
                rankings={rankings}
                holdByUserId={holdByUserId}
                timeStatus={lb.time_status}
                source={standings.source}
            />

            <FadeIn>
                <div className="rounded-lg border">
                    <div className="border-b px-5 py-3 flex items-center gap-2">
                        <Trophy className="size-3.5 text-muted-foreground" />
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Prize tiers
                        </h2>
                    </div>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Position</TableHead>
                                <TableHead className="text-right">Prize</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {lb.prize_tiers.length === 0 ? (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={2} className="p-0">
                                        <EmptyState
                                            icon={Trophy}
                                            title="No prize tiers configured"
                                            description="This leaderboard has no per-position prizes set."
                                            compact
                                        />
                                    </TableCell>
                                </TableRow>
                            ) : (
                                lb.prize_tiers.map((t) => (
                                    <TableRow key={t.position}>
                                        <TableCell className="font-medium">#{t.position}</TableCell>
                                        <TableCell className="text-right tabular-nums">${t.prize_amount_usd}</TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </div>
            </FadeIn>
        </>
    );
}

/**
 * Fallback for the streamed body — mirrors the 2x2 definition-card grid
 * plus the claims / standings / prize-tiers stack so the layout doesn't
 * jump when the real content swaps in.
 */
function LeaderboardDetailBodySkeleton() {
    return (
        <>
            <div className="grid gap-6 md:grid-cols-2">
                <Skeleton className="h-64 rounded-lg" />
                <Skeleton className="h-40 rounded-lg" />
                <Skeleton className="h-44 rounded-lg" />
                <Skeleton className="h-64 rounded-lg" />
            </div>
            <StatPanelSkeleton rows={4} />
            <StatPanelSkeleton rows={5} />
            <Skeleton className="h-40 rounded-lg" />
        </>
    );
}

function DefRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4 text-sm">
            <span className="text-muted-foreground shrink-0">{label}</span>
            <div className={cn("text-right max-w-[60%]")}>{value}</div>
        </div>
    );
}

function housePnlColorClass(pnl: number): string {
    if (pnl > 0) return "text-emerald-600 dark:text-emerald-400";
    if (pnl < 0) return "text-rose-600 dark:text-rose-400";
    return "text-muted-foreground";
}

function HousePnlLabel({
    pnl,
    label,
    className,
}: {
    pnl: number;
    label: string;
    className?: string;
}) {
    return (
        <span className={cn("tabular-nums", housePnlColorClass(pnl), className)}>
            {label}: {pnl === 0 ? "—" : formatCurrency(pnl)}
        </span>
    );
}
