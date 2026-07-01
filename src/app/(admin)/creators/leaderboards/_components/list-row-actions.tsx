"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { approveLeaderboard } from "../actions";
import { RejectDialog } from "./reject-dialog";

type Row = {
    id: string;
    approval_status: "pending" | "approved" | "rejected";
    cancelled_at: string | null;
    title: string;
};

/**
 * Inline row actions for a PENDING leaderboard. Approve resolves the row (it
 * only renders actions while pending), so on success we OPTIMISTICALLY hide it
 * with NO `router.refresh()` — the dense list never re-renders / loses scroll
 * position. The server stays source of truth via the
 * `revalidateTag("creator-leaderboards")` + `revalidatePath` the action fires
 * (the row re-renders resolved on the next natural render). A failed approve
 * restores the actions and toasts the error. Reject is a close+refocus dialog
 * and is left as-is.
 */
export function ListRowActions({ row }: { row: Row }) {
    const [isPending, startTransition] = useTransition();
    const [rejectOpen, setRejectOpen] = useState(false);
    // Once approve succeeds this row is no longer pending, so it renders no
    // actions — hide them immediately instead of waiting on a route refresh.
    const [resolved, setResolved] = useState(false);

    if (row.approval_status === "pending" && !resolved) {
        return (
            <div className="flex gap-2 justify-end">
                <Button
                    size="sm"
                    variant="outline"
                    disabled={isPending}
                    onClick={() => {
                        // Approval exposes the leaderboard publicly; reverting needs a
                        // refund-bearing cancel. Always confirm — single click is too
                        // easy on a dense table.
                        if (
                            !confirm(
                                `Approve "${row.title}"?\n\nThis goes live immediately. To revert you'd have to cancel and refund.`,
                            )
                        ) {
                            return;
                        }
                        // Optimistically hide the actions — no reload.
                        setResolved(true);
                        startTransition(async () => {
                            const r = await approveLeaderboard(row.id);
                            if (!r.success) {
                                setResolved(false);
                                toast.error(r.error);
                                return;
                            }
                            toast.success("Approved");
                        });
                    }}
                >
                    Approve
                </Button>
                <Button
                    size="sm"
                    variant="destructive"
                    disabled={isPending}
                    onClick={() => setRejectOpen(true)}
                >
                    Reject
                </Button>
                <RejectDialog
                    open={rejectOpen}
                    onOpenChange={setRejectOpen}
                    leaderboardId={row.id}
                    leaderboardTitle={row.title}
                />
            </div>
        );
    }

    // For approved/rejected/cancelled, just link to detail for full action set.
    return null;
}
