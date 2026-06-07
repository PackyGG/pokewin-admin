import { notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Crown, Medal, Trophy } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
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
import { EmptyState } from "@/components/empty-state";
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
import { getAffiliateLeaderboardRankings } from "@/lib/queries/creators";
import { getLeaderboardSponsorshipMap } from "../../_queries/leaderboard-sponsorship";

import { DetailActions } from "../_components/detail-actions";
import { ManualPaymentPanel } from "../_components/manual-payment-panel";
import { FreezeClaimCell } from "../_components/freeze-claim-cell";
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
    const tz = await getAdminDisplayTimeZone();
    const fmt = (iso: string) => formatDateTime(iso, tz);
    const { id } = await params;
    // Shape-check UUID before any DB / backend call — see src/lib/utils/ids.ts.
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
    const participatingCreatorIds = [lb.creator_user_id, ...(lb.co_creator_user_ids ?? [])];
    const [creators, rankings, sponsorshipMap, claimHolds] = await Promise.all([
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
        // Live standings — computed against the main DB (this
        // backend doesn't expose a /rankings endpoint yet).
        // Wraps in a try/catch so a query error never breaks the
        // page — the rest of the leaderboard config still renders.
        getAffiliateLeaderboardRankings({
            creatorUserId: lb.creator_user_id,
            coCreatorUserIds: lb.co_creator_user_ids ?? [],
            affiliateCodes: lb.affiliate_codes,
            startDate: new Date(lb.start_date),
            endDate: new Date(lb.end_date),
            prizeTiers: lb.prize_tiers,
            limit: 100,
        }).catch((err) => {
            console.error("[leaderboard] rankings query failed", err);
            return [];
        }),
        // Admin-side sponsored % so the Edit dialog can pre-fill it.
        // Best-effort — a failure just defaults the field to 100%.
        getLeaderboardSponsorshipMap([id]).catch((err) => {
            console.error("[leaderboard] sponsorship query failed", err);
            return new Map<string, number>();
        }),
        // Active claim holds (freezes) so each standings row can show a
        // Freeze / Unfreeze control. Best-effort — a failure just renders the
        // standings without freeze state instead of throwing the whole page.
        affiliateLeaderboardsApi.listClaimHolds(id).catch((err) => {
            console.error("[leaderboard] claim holds query failed", err);
            return [] as Awaited<ReturnType<typeof affiliateLeaderboardsApi.listClaimHolds>>;
        }),
    ]);
    // Map user_id → active hold so standings rows can render freeze state in O(1).
    const holdByUserId = new Map(claimHolds.map((h) => [h.user_id, h]));
    const creatorById = new Map(creators.map((c) => [c.id, c]));
    const creator = creatorById.get(lb.creator_user_id) ?? null;
    const coCreatorRows = (lb.co_creator_user_ids ?? []).map((id) => ({
        id,
        username: creatorById.get(id)?.username ?? null,
        email: creatorById.get(id)?.email ?? null,
    }));
    const currentSponsoredPct = sponsorshipMap.get(id) ?? null;

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
                    <DetailActions
                        row={lb}
                        currentSponsoredPct={currentSponsoredPct}
                    />
                </div>
            </PageHero>

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
                                lb.affiliate_codes.length > 0 ? (
                                    <div className="flex gap-1 flex-wrap">
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

            {/* Standings — live rankings of users tied to this
                leaderboard's code(s) by wager volume inside the
                event window. Sorted DESC. Top 3 get a medal icon
                + emerald/silver-zinc/amber accents; lower
                positions are plain. Prize $$ comes from the
                leaderboard's prize_tiers map (null when the row's
                position has no configured tier). */}
            <FadeIn>
                <div className="rounded-lg border">
                    <div className="border-b px-5 py-3 flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Standings
                        </h2>
                        <span className="text-xs text-muted-foreground">
                            {rankings.length === 0
                                ? "no wager activity yet"
                                : rankings.length === 1
                                  ? "1 user wagered"
                                  : `${rankings.length} users wagered`}
                        </span>
                    </div>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-16">Place</TableHead>
                                <TableHead>User</TableHead>
                                <TableHead className="text-right">Wagered</TableHead>
                                <TableHead className="text-right">Prize</TableHead>
                                <TableHead className="text-right w-36">Claim</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rankings.length === 0 ? (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={5} className="p-0">
                                        <EmptyState
                                            icon={Trophy}
                                            title={
                                                lb.time_status === "upcoming"
                                                    ? "Leaderboard hasn't started yet"
                                                    : "No qualifying wager activity"
                                            }
                                            description={
                                                lb.time_status === "upcoming"
                                                    ? "Standings populate once the event window opens and users start wagering on the code."
                                                    : "No users tied to this leaderboard's code(s) wagered inside the event window."
                                            }
                                            compact
                                        />
                                    </TableCell>
                                </TableRow>
                            ) : (
                                rankings.map((r) => {
                                    const isMedal = r.position <= 3;
                                    const PositionIcon =
                                        r.position === 1
                                            ? Crown
                                            : r.position <= 3
                                              ? Medal
                                              : null;
                                    const positionAccent =
                                        r.position === 1
                                            ? "text-amber-500"
                                            : r.position === 2
                                              ? "text-zinc-400"
                                              : r.position === 3
                                                ? "text-orange-500"
                                                : "text-muted-foreground";
                                    const frozen = holdByUserId.get(r.userId) ?? null;
                                    return (
                                        <TableRow
                                            key={r.userId}
                                            className={cn(
                                                frozen &&
                                                    "bg-sky-500/[0.07] hover:bg-sky-500/10",
                                            )}
                                        >
                                            <TableCell>
                                                <div
                                                    className={cn(
                                                        "inline-flex items-center gap-1.5 font-semibold tabular-nums",
                                                        positionAccent,
                                                    )}
                                                >
                                                    {PositionIcon && (
                                                        <PositionIcon className="size-3.5" />
                                                    )}
                                                    #{r.position}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Link
                                                    href={`/users/${r.userId}`}
                                                    className={cn(
                                                        "hover:underline",
                                                        isMedal && "font-semibold",
                                                    )}
                                                >
                                                    {r.username ??
                                                        r.email ??
                                                        r.userId.slice(0, 8)}
                                                </Link>
                                                {r.email && r.username && (
                                                    <p className="text-xs text-muted-foreground truncate">
                                                        {r.email}
                                                    </p>
                                                )}
                                            </TableCell>
                                            {/* Wager volume — money INTO house treasury per
                                                CLAUDE.md house-POV → emerald. */}
                                            <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                                                {formatCurrency(r.totalWageredUsd)}
                                            </TableCell>
                                            {/* Prize is house outflow → rose. Null when
                                                this position is below the lowest
                                                configured tier. */}
                                            <TableCell className="text-right tabular-nums">
                                                {r.prizeUsd != null ? (
                                                    <span className="font-semibold text-rose-600 dark:text-rose-400">
                                                        {formatCurrency(r.prizeUsd)}
                                                    </span>
                                                ) : (
                                                    <span className="text-muted-foreground">—</span>
                                                )}
                                            </TableCell>
                                            {/* Freeze / unfreeze this participant's prize
                                                claim — a wager-abuse hold scoped to this
                                                leaderboard. Frozen rows show a badge + Unfreeze. */}
                                            <TableCell className="text-right">
                                                <FreezeClaimCell
                                                    leaderboardId={lb.id}
                                                    userId={r.userId}
                                                    displayName={
                                                        r.username ??
                                                        r.email ??
                                                        r.userId.slice(0, 8)
                                                    }
                                                    hold={frozen}
                                                />
                                            </TableCell>
                                        </TableRow>
                                    );
                                })
                            )}
                        </TableBody>
                    </Table>
                </div>
            </FadeIn>

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
        </div>
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
