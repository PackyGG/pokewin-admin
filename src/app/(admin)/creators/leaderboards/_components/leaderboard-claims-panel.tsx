import Link from "next/link";
import { BadgeCheck, CheckCircle2, Clock } from "lucide-react";

import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { LeaderboardClaim } from "@/lib/queries/creators-leaderboards";
import type { LeaderboardClaimWindow } from "@/lib/reward-expiry/leaderboard-claim-window";

import { LeaderboardClaimExpiryBanner } from "./leaderboard-claim-expiry-banner";

/**
 * Prize-claim panel rendered above the standings table on both the admin and
 * creator-hub leaderboard detail pages: the live claim-window countdown plus a
 * roster of who has already claimed their prize.
 *
 * Prize amounts are money paid out to users (a user win = a house cost), so
 * they render rose per the house-POV color rule — same as the standings Prize
 * column.
 */
export function LeaderboardClaimsPanel({
    claimWindow,
    claims,
    tz,
    userHref = (userId) => `/users/${userId}`,
}: {
    claimWindow: LeaderboardClaimWindow;
    claims: LeaderboardClaim[];
    tz?: string;
    userHref?: (userId: string) => string;
}) {
    const fmt = (iso: string) => formatDateTime(iso, tz);
    const totalClaimedUsd = claims.reduce((sum, c) => sum + c.prizeUsd, 0);

    return (
        <FadeIn>
            <div className="space-y-4">
                <LeaderboardClaimExpiryBanner window={claimWindow} tz={tz} />

                <div className="rounded-lg border">
                    <div className="border-b px-5 py-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <BadgeCheck className="size-3.5 text-muted-foreground" />
                            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                                Prizes claimed
                            </h2>
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">
                            {claims.length === 0
                                ? "none claimed yet"
                                : `${claims.length} claimed · ${formatCurrency(totalClaimedUsd)}`}
                        </span>
                    </div>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-16">Place</TableHead>
                                <TableHead>User</TableHead>
                                <TableHead className="text-right">Prize</TableHead>
                                <TableHead>Claimed</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {claims.length === 0 ? (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={4} className="p-0">
                                        <EmptyState
                                            icon={Clock}
                                            title="No prizes claimed yet"
                                            description="Once a participant claims their leaderboard prize it shows up here with the time they claimed."
                                            compact
                                        />
                                    </TableCell>
                                </TableRow>
                            ) : (
                                claims.map((c) => (
                                    <TableRow key={c.userId}>
                                        <TableCell className="font-semibold tabular-nums">
                                            #{c.position}
                                        </TableCell>
                                        <TableCell>
                                            <Link
                                                href={userHref(c.userId)}
                                                className="hover:underline"
                                            >
                                                {c.username ?? c.email ?? c.userId.slice(0, 8)}
                                            </Link>
                                            {c.email && c.username && (
                                                <p className="text-xs text-muted-foreground truncate">
                                                    {c.email}
                                                </p>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            <span className="font-semibold text-rose-600 dark:text-rose-400">
                                                {formatCurrency(c.prizeUsd)}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-1.5 min-w-[9rem]">
                                                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                                                <div>
                                                    <p className={cn("text-sm tabular-nums")}>
                                                        {fmt(c.claimedAt)}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {formatRelative(c.claimedAt)}
                                                    </p>
                                                </div>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </div>
            </div>
        </FadeIn>
    );
}
