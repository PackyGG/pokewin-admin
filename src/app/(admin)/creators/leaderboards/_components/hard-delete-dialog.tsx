"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy } from "lucide-react";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { hardDeleteLeaderboard } from "../actions";

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    leaderboardId: string;
    leaderboardTitle: string;
};

/**
 * Hard-delete confirmation dialog. The admin must paste the leaderboard's
 * UUID into the input — submission stays disabled until input === id. This
 * is the "type the resource name to confirm" pattern, made stricter by
 * requiring a UUID rather than a short slug. Backend enforces the same
 * match independently, plus a 1-hour-since-creation window.
 */
export function HardDeleteDialog({ open, onOpenChange, leaderboardId, leaderboardTitle }: Props) {
    const [typed, setTyped] = useState("");
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const matches = typed.trim() === leaderboardId;

    function reset(): void {
        setTyped("");
    }

    async function copyId(): Promise<void> {
        try {
            await navigator.clipboard.writeText(leaderboardId);
            toast.success("ID copied");
        } catch {
            toast.error("Copy failed — paste manually");
        }
    }

    function handleSubmit(e: React.FormEvent): void {
        e.preventDefault();
        if (!matches) {
            toast.error("Confirmation id must exactly match the leaderboard id");
            return;
        }
        startTransition(async () => {
            const r = await hardDeleteLeaderboard(leaderboardId, {
                confirmation_id: typed.trim(),
            });
            if (!r.success) {
                toast.error(r.error);
                return;
            }
            const refunded = Number(r.data?.refund_amount_usd ?? 0);
            toast.success(
                refunded > 0
                    ? `Leaderboard deleted. Refunded $${refunded.toFixed(2)} to creator.`
                    : "Leaderboard deleted",
            );
            reset();
            onOpenChange(false);
            // The detail page no longer exists — bounce back to the list.
            router.push("/creators/leaderboards");
            router.refresh();
        });
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) reset();
                onOpenChange(next);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Hard-delete &ldquo;{leaderboardTitle}&rdquo;</DialogTitle>
                    <DialogDescription className="space-y-2">
                        <span className="block">
                            This <strong>permanently removes</strong> the leaderboard row, its
                            prize tiers, snapshots and any claim records. Allowed only within
                            <strong> 1 hour of creation</strong> — older leaderboards must be
                            cancelled instead.
                        </span>
                        <span className="block">
                            If the creator funded the prize pool and has not been refunded yet,
                            the refund is issued in the same transaction.
                        </span>
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="leaderboard-id-display" className="text-xs text-muted-foreground">
                            Leaderboard ID
                        </Label>
                        <div className="flex items-center gap-2">
                            <code
                                id="leaderboard-id-display"
                                className="flex-1 truncate rounded-md border bg-muted px-2.5 py-1.5 font-mono text-xs"
                            >
                                {leaderboardId}
                            </code>
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                onClick={copyId}
                                disabled={isPending}
                                title="Copy ID to clipboard"
                                aria-label="Copy leaderboard ID"
                            >
                                <Copy className="size-3.5" />
                            </Button>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="confirmation-id">
                            Paste the ID above to confirm
                        </Label>
                        <Input
                            id="confirmation-id"
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            placeholder="00000000-0000-0000-0000-000000000000"
                            autoComplete="off"
                            spellCheck={false}
                            className="font-mono text-xs"
                            disabled={isPending}
                            required
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={isPending}
                            className="w-full sm:w-auto"
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            variant="destructive"
                            disabled={!matches || isPending}
                            className="w-full sm:w-auto"
                        >
                            {isPending ? "Deleting…" : "Permanently delete"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
