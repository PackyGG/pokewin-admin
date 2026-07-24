import Link from "next/link";
import { Crown, Medal, Trophy } from "lucide-react";

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
import type { LeaderboardRanking } from "@/lib/queries/creators-leaderboards";
import type { ClaimHold, TimeStatus } from "@/lib/backend-api/affiliate-leaderboards";

import { FreezeClaimCell } from "./freeze-claim-cell";

type HoldSummary = Pick<ClaimHold, "reason">;

export function LeaderboardStandingsPanel({
    leaderboardId,
    rankings,
    holdByUserId,
    timeStatus,
    source = "live",
    userHref = (userId) => `/users/${userId}`,
    canSeeMarking = false,
}: {
    leaderboardId: string;
    rankings: LeaderboardRanking[];
    holdByUserId: Map<string, HoldSummary>;
    timeStatus: TimeStatus;
    /**
     * Whether the viewer may SEE the "marked by admin" excluded-user badge
     * (owners + the trusted-viewer allowlist — `canSeeAdminMarking`). Defaults
     * FALSE (fail-closed): a caller that forgets to pass it hides the marking.
     * The row still renders at its real place — only the flag is withheld.
     */
    canSeeMarking?: boolean;
    /**
     * "settled" — weighted standings read from the final snapshot (matches
     * what was paid). "live" — unweighted live estimate from raw wager
     * volume (per-game leaderboard weights aren't applied), shown while a
     * board is active and no snapshot exists yet.
     */
    source?: "settled" | "live";
    userHref?: (userId: string) => string;
}) {
    const showLiveEstimateNote = source === "live" && rankings.length > 0;
    return (
        <FadeIn>
            <div className="rounded-lg border">
                <div className="border-b px-5 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Standings
                        </h2>
                        {rankings.length > 0 && (
                            <span
                                className={cn(
                                    "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                                    source === "settled"
                                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                        : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                                )}
                            >
                                {source === "settled"
                                    ? "Settled · weighted"
                                    : "Live · weighted"}
                            </span>
                        )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {rankings.length === 0
                            ? "no wager activity yet"
                            : rankings.length === 1
                              ? "1 user wagered"
                              : `${rankings.length} users wagered`}
                    </span>
                </div>
                {showLiveEstimateNote && (
                    <div className="border-b bg-amber-500/5 px-5 py-2.5 text-xs text-muted-foreground">
                        Live weighted standings — the per-game leaderboard wager
                        weights are applied, so this matches what packy.gg shows
                        live. Figures can still shift as late wagers land; final
                        standings are locked into a snapshot when the board ends.
                    </div>
                )}
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-16">Place</TableHead>
                            <TableHead>User</TableHead>
                            <TableHead className="text-right">Wagered</TableHead>
                            <TableHead className="text-right">House P&amp;L</TableHead>
                            <TableHead className="text-right">Prize</TableHead>
                            <TableHead>Place reached</TableHead>
                            <TableHead className="text-right w-36">Claim</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rankings.length === 0 ? (
                            <TableRow className="hover:bg-transparent">
                                <TableCell colSpan={7} className="p-0">
                                    <EmptyState
                                        icon={Trophy}
                                        title={
                                            timeStatus === "upcoming"
                                                ? "Leaderboard hasn't started yet"
                                                : "No qualifying wager activity"
                                        }
                                        description={
                                            timeStatus === "upcoming"
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
                                            <span className="inline-flex items-center gap-1.5">
                                                <Link
                                                    href={userHref(r.userId)}
                                                    className={cn(
                                                        "hover:underline",
                                                        isMedal && "font-semibold",
                                                    )}
                                                >
                                                    {r.username ??
                                                        r.email ??
                                                        r.userId.slice(0, 8)}
                                                </Link>
                                                {r.excluded && canSeeMarking && (
                                                    <span
                                                        title="Marked by an admin (on the excluded-users list) — shown here to mirror the real leaderboard, but excluded from analytics aggregates."
                                                        className="rounded-full border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400"
                                                    >
                                                        marked by admin
                                                    </span>
                                                )}
                                            </span>
                                            {r.email && r.username && (
                                                <p className="text-xs text-muted-foreground truncate">
                                                    {r.email}
                                                </p>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                                            {formatCurrency(r.totalWageredUsd)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            <HousePnlValue pnl={r.housePnlUsd} />
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {r.prizeUsd != null ? (
                                                <span className="font-semibold text-rose-600 dark:text-rose-400">
                                                    {formatCurrency(r.prizeUsd)}
                                                </span>
                                            ) : (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <PositionReachedCell
                                                reachedAt={r.positionReachedAt}
                                            />
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <FreezeClaimCell
                                                leaderboardId={leaderboardId}
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
    );
}

function housePnlColorClass(pnl: number): string {
    if (pnl > 0) return "text-emerald-600 dark:text-emerald-400";
    if (pnl < 0) return "text-rose-600 dark:text-rose-400";
    return "text-muted-foreground";
}

function HousePnlValue({ pnl }: { pnl: number }) {
    return (
        <span className={cn("font-medium", housePnlColorClass(pnl))}>
            {pnl === 0 ? "—" : formatCurrency(pnl)}
        </span>
    );
}

function PositionReachedCell({ reachedAt }: { reachedAt: string | null }) {
    if (!reachedAt) {
        return <span className="text-muted-foreground">—</span>;
    }
    return (
        <div className="min-w-[9rem]">
            <p className="text-sm tabular-nums">{formatDateTime(reachedAt)}</p>
            <p className="text-xs text-muted-foreground">
                {formatRelative(reachedAt)}
            </p>
        </div>
    );
}
