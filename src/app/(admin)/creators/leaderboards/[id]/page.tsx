import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

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
import { formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { DetailActions } from "../_components/detail-actions";

export const metadata = { title: "Affiliate Leaderboard" };

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
    const creator = await db.user.findUnique({
        where: { id: lb.creator_user_id },
        select: { id: true, username: true, email: true },
    });

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

            <FadeIn>
                <div className="rounded-lg border">
                    <div className="border-b px-5 py-3">
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
