import { notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Crown, Medal, Trophy } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
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
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { getAffiliateLeaderboardRankings } from "@/lib/queries/creators";

import { DetailActions } from "../_components/detail-actions";

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
    const [creators, rankings] = await Promise.all([
        // Hydrate the primary creator plus every co-creator in one query so we
        // can render names alongside each id on the definition card.
        db.user.findMany({
            where: { id: { in: participatingCreatorIds } },
            select: { id: true, username: true, email: true },
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
    ]);
    const creatorById = new Map(creators.map((c) => [c.id, c]));
    const creator = creatorById.get(lb.creator_user_id) ?? null;
    const coCreatorRows = (lb.co_creator_user_ids ?? []).map((id) => ({
        id,
        username: creatorById.get(id)?.username ?? null,
        email: creatorById.get(id)?.email ?? null,
    }));

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
                                {lb.cancelled_at && (
                                    <Badge variant="outline" className="bg-zinc-500/15 text-zinc-600 border-zinc-500/30">
                                        cancelled
                                    </Badge>
                                )}
                            </div>
                        </div>
                    </div>
                    <DetailActions row={lb} />
                </div>
            </PageHero>

            <div className="grid gap-6 md:grid-cols-2">
                <FadeIn>
                    <div className="rounded-lg border p-5 space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Definition
                        </h2>
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
                        <DefRow label="Starts" value={formatDateTime(lb.start_date)} />
                        <DefRow label="Ends" value={formatDateTime(lb.end_date)} />
                        <DefRow label="Created" value={formatDateTime(lb.created_at)} />
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
                            value={lb.approved_at ? formatDateTime(lb.approved_at) : "—"}
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
                            value={lb.cancelled_at ? formatDateTime(lb.cancelled_at) : "—"}
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
                            value={lb.refunded_at ? formatDateTime(lb.refunded_at) : "—"}
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
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rankings.length === 0 ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={4}
                                        className="text-center text-muted-foreground py-6"
                                    >
                                        {lb.time_status === "upcoming"
                                            ? "Leaderboard hasn't started yet."
                                            : "No qualifying wager activity in this window."}
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
                                    return (
                                        <TableRow key={r.userId}>
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
                                <TableRow>
                                    <TableCell colSpan={2} className="text-center text-muted-foreground py-6">
                                        No prize tiers configured.
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
