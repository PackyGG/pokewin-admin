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
import { Input } from "@/components/ui/input";

import { sponsorLeaderboard } from "../actions";

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    leaderboardId: string;
    leaderboardTitle: string;
    currentTotalPrizeUsd: string;
};

export function SponsorDialog({ open, onOpenChange, leaderboardId, leaderboardTitle, currentTotalPrizeUsd }: Props) {
    const [amount, setAmount] = useState("");
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const value = Number(amount);
        if (!Number.isFinite(value) || value <= 0) {
            toast.error("Enter a positive amount");
            return;
        }
        startTransition(async () => {
            const r = await sponsorLeaderboard(leaderboardId, { additional_bonus_usd: value });
            if (!r.success) {
                toast.error(r.error);
                return;
            }
            toast.success("Sponsor bonus added");
            setAmount("");
            onOpenChange(false);
            router.refresh();
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Sponsor &ldquo;{leaderboardTitle}&rdquo;</DialogTitle>
                    <DialogDescription>
                        Adds the amount to the site bonus pool. Current total prize pool: ${currentTotalPrizeUsd}.
                        After adding, you may need to edit prize tiers to redistribute up to the new total.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="amount">Additional bonus (USD)</Label>
                        <Input
                            id="amount"
                            type="number"
                            step="0.01"
                            min="0.01"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="e.g. 1000"
                            required
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={isPending}>
                            {isPending ? "Adding..." : "Add bonus"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
