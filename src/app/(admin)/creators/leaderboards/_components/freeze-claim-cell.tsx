"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Snowflake } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";

import { freezeClaim, unfreezeClaim } from "../actions";

/**
 * Per-standings-row freeze control. When the user has an active claim hold it
 * renders a "Frozen" badge (hover for the reason) plus an Unfreeze button;
 * otherwise a Freeze button. Both open a small dialog — freeze requires a
 * reason, unfreeze takes an optional release reason. Capability gating is
 * enforced server-side; a rejected action just surfaces via toast.error.
 */
export function FreezeClaimCell({
    leaderboardId,
    userId,
    displayName,
    hold,
}: {
    leaderboardId: string;
    userId: string;
    displayName: string;
    // Active hold for this user, or null when not frozen.
    hold: { reason: string } | null;
}) {
    const [freezeOpen, setFreezeOpen] = useState(false);
    const [unfreezeOpen, setUnfreezeOpen] = useState(false);
    const [reason, setReason] = useState("");
    const [releaseReason, setReleaseReason] = useState("");
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const handleFreeze = (e: React.FormEvent) => {
        e.preventDefault();
        if (!reason.trim()) {
            toast.error("Reason is required");
            return;
        }
        startTransition(async () => {
            const r = await freezeClaim(leaderboardId, userId, { reason: reason.trim() });
            if (!r.success) {
                toast.error(r.error);
                return;
            }
            toast.success("Claim frozen");
            setReason("");
            setFreezeOpen(false);
            router.refresh();
        });
    };

    const handleUnfreeze = (e: React.FormEvent) => {
        e.preventDefault();
        startTransition(async () => {
            const r = await unfreezeClaim(leaderboardId, userId, {
                release_reason: releaseReason.trim() || null,
            });
            if (!r.success) {
                toast.error(r.error);
                return;
            }
            toast.success("Claim unfrozen");
            setReleaseReason("");
            setUnfreezeOpen(false);
            router.refresh();
        });
    };

    if (hold) {
        return (
            <div className="flex items-center justify-end gap-2">
                <Badge
                    className="gap-1 bg-sky-500 text-white hover:bg-sky-500 border-transparent shadow-sm"
                    title={hold.reason}
                >
                    <Snowflake className="size-3" />
                    Frozen
                </Badge>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={isPending}
                    onClick={() => setUnfreezeOpen(true)}
                    className="border-sky-500/40 text-sky-600 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-400"
                >
                    Unfreeze
                </Button>

                <Dialog open={unfreezeOpen} onOpenChange={setUnfreezeOpen}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Unfreeze claim</DialogTitle>
                            <DialogDescription>
                                Re-enable {displayName}&rsquo;s prize claim. The hold is kept for the
                                audit trail. Optionally record why it was released.
                            </DialogDescription>
                        </DialogHeader>
                        <form onSubmit={handleUnfreeze} className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor={`release-reason-${userId}`}>
                                    Release reason{" "}
                                    <span className="text-muted-foreground/60">(optional)</span>
                                </Label>
                                <Textarea
                                    id={`release-reason-${userId}`}
                                    value={releaseReason}
                                    onChange={(e) => setReleaseReason(e.target.value)}
                                    placeholder="e.g. Review cleared — activity was legitimate"
                                    rows={3}
                                    maxLength={500}
                                />
                            </div>
                            <DialogFooter>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setUnfreezeOpen(false)}
                                    disabled={isPending}
                                    className="w-full sm:w-auto"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    type="submit"
                                    disabled={isPending}
                                    className="w-full sm:w-auto"
                                >
                                    {isPending ? "Unfreezing..." : "Unfreeze"}
                                </Button>
                            </DialogFooter>
                        </form>
                    </DialogContent>
                </Dialog>
            </div>
        );
    }

    return (
        <div className="flex justify-end">
            <Button
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => setFreezeOpen(true)}
                className="gap-1 border-sky-500/40 text-sky-600 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-400"
            >
                <Snowflake className="size-3.5" />
                Freeze
            </Button>

            <Dialog open={freezeOpen} onOpenChange={setFreezeOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Freeze claim</DialogTitle>
                        <DialogDescription>
                            Block {displayName} from claiming their prize while a wager-abuse
                            review is open. Scoped to this leaderboard only. A reason is required
                            and recorded in the audit trail.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleFreeze} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor={`freeze-reason-${userId}`}>Reason</Label>
                            <Textarea
                                id={`freeze-reason-${userId}`}
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="e.g. Suspected multi-accounting / chip dumping"
                                rows={4}
                                maxLength={500}
                                required
                            />
                        </div>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setFreezeOpen(false)}
                                disabled={isPending}
                                className="w-full sm:w-auto"
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={isPending}
                                className="w-full sm:w-auto"
                            >
                                {isPending ? "Freezing..." : "Freeze claim"}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </div>
    );
}
