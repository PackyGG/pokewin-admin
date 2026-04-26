"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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

export function ListRowActions({ row }: { row: Row }) {
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const [rejectOpen, setRejectOpen] = useState(false);

    if (row.approval_status === "pending") {
        return (
            <div className="flex gap-2 justify-end">
                <Button
                    size="sm"
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
