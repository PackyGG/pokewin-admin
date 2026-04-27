"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { rejectLeaderboard } from "../actions";

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    leaderboardId: string;
    leaderboardTitle: string;
};

export function RejectDialog({ open, onOpenChange, leaderboardId, leaderboardTitle }: Props) {
    const [reason, setReason] = useState("");
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!reason.trim()) {
            toast.error("Reason is required");
            return;
        }
        startTransition(async () => {
            const r = await rejectLeaderboard(leaderboardId, { rejection_reason: reason.trim() });
            if (!r.success) {
                toast.error(r.error);
                return;
            }
            toast.success("Rejected and refund issued");
            setReason("");
            onOpenChange(false);
            router.refresh();
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Reject &ldquo;{leaderboardTitle}&rdquo;</DialogTitle>
                    <DialogDescription>
                        The creator&rsquo;s funded prize will be refunded automatically. Provide a reason
                        the creator can see.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="reason">Rejection reason</Label>
                        <Textarea
                            id="reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="e.g. Date range overlaps with an existing approved leaderboard"
                            rows={4}
                            maxLength={500}
                            required
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="destructive" disabled={isPending}>
                            {isPending ? "Rejecting..." : "Reject and refund"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
