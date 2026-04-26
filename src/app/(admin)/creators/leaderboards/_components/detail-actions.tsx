"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { approveLeaderboard, cancelLeaderboard } from "../actions";
import { RejectDialog } from "./reject-dialog";
import { EditDialog } from "./edit-dialog";
import { SponsorDialog } from "./sponsor-dialog";

type Row = {
    id: string;
    title: string;
    approval_status: "pending" | "approved" | "rejected";
    cancelled_at: string | null;
    creator_prize_usd: string;
    site_bonus_usd: string;
    affiliate_codes: string[];
    start_date: string;
    end_date: string;
    prize_tiers: Array<{ position: number; prize_amount_usd: string }>;
};

export function DetailActions({ row }: { row: Row }) {
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const [rejectOpen, setRejectOpen] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [sponsorOpen, setSponsorOpen] = useState(false);

    const isCancelled = row.cancelled_at !== null;

    return (
        <div className="flex gap-2 flex-wrap">
            {row.approval_status === "pending" && !isCancelled && (
                <>
                    <Button
                        variant="outline"
                        disabled={isPending}
                        onClick={() => {
                            startTransition(async () => {
                                const r = await approveLeaderboard(row.id);
                                if (!r.success) {
                                    toast.error(r.error);
                                    return;
                                }
                                toast.success("Approved");
                                router.refresh();
                            });
                        }}
                    >
                        Approve
                    </Button>
                    <Button variant="destructive" disabled={isPending} onClick={() => setRejectOpen(true)}>
                        Reject
                    </Button>
                </>
            )}

            {/* Edit allowed in any non-final state. Useful for fixing typos pre-approval
                or swapping codes/tiers post-approval before the period starts. */}
            {!isCancelled && row.approval_status !== "rejected" && (
                <Button variant="outline" disabled={isPending} onClick={() => setEditOpen(true)}>
                    Edit
                </Button>
            )}

            {row.approval_status === "approved" && !isCancelled && (
                <>
                    <Button variant="outline" disabled={isPending} onClick={() => setSponsorOpen(true)}>
                        Add Sponsor Bonus
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={isPending}
                        onClick={() => {
                            if (!confirm(`Cancel "${row.title}"? This will refund the creator's funded prize.`)) return;
                            startTransition(async () => {
                                const r = await cancelLeaderboard(row.id);
                                if (!r.success) {
                                    toast.error(r.error);
                                    return;
                                }
                                toast.success("Cancelled and refunded");
                                router.refresh();
                            });
                        }}
                    >
                        Cancel & Refund
                    </Button>
                </>
            )}

            <RejectDialog
                open={rejectOpen}
                onOpenChange={setRejectOpen}
                leaderboardId={row.id}
                leaderboardTitle={row.title}
            />
            <EditDialog
                open={editOpen}
                onOpenChange={setEditOpen}
                leaderboard={row}
            />
            <SponsorDialog
                open={sponsorOpen}
                onOpenChange={setSponsorOpen}
                leaderboardId={row.id}
                leaderboardTitle={row.title}
                currentTotalPrizeUsd={(Number(row.creator_prize_usd) + Number(row.site_bonus_usd)).toFixed(2)}
            />
        </div>
    );
}
