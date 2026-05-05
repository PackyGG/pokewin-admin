"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

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

import { editLeaderboard } from "../actions";

type Tier = { position: number; prize_amount_usd: string };

type Leaderboard = {
    id: string;
    title: string;
    affiliate_codes: string[];
    creator_prize_usd: string;
    site_bonus_usd: string;
    start_date: string;
    end_date: string;
    prize_tiers: Tier[];
};

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    leaderboard: Leaderboard;
};

function toLocalDateTimeInput(iso: string): string {
    // <input type="datetime-local"> wants `YYYY-MM-DDTHH:mm` in local time.
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Affiliate leaderboards must align to whole-hour UTC marks (backend rule).
 * For whole-hour-offset timezones — which we support — that's equivalent to
 * checking the local date for minutes/seconds/ms === 0. Half-hour zones (Iran,
 * India) would fail this *and* the backend's UTC check, which is by design.
 */
function isTopOfHour(date: Date): boolean {
    return (
        date.getMinutes() === 0 &&
        date.getSeconds() === 0 &&
        date.getMilliseconds() === 0
    );
}

export function EditDialog({ open, onOpenChange, leaderboard }: Props) {
    const [title, setTitle] = useState(leaderboard.title);
    const [codesText, setCodesText] = useState(leaderboard.affiliate_codes.join(", "));
    const [startDate, setStartDate] = useState(toLocalDateTimeInput(leaderboard.start_date));
    const [endDate, setEndDate] = useState(toLocalDateTimeInput(leaderboard.end_date));
    const [tiers, setTiers] = useState<Array<{ position: string; amount: string }>>(
        leaderboard.prize_tiers.map((t) => ({
            position: String(t.position),
            amount: t.prize_amount_usd,
        })),
    );
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const totalPool = Number(leaderboard.creator_prize_usd) + Number(leaderboard.site_bonus_usd);

    const tierSum = tiers.reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
    const tierSumExceeds = tierSum > totalPool + 1e-6;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const titleChanged = title.trim() !== leaderboard.title;
        const codesParsed = codesText
            .split(",")
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
        const codesChanged =
            JSON.stringify(codesParsed) !== JSON.stringify(leaderboard.affiliate_codes);

        const startParsed = startDate ? new Date(startDate) : null;
        const endParsed = endDate ? new Date(endDate) : null;

        if (startParsed && !isTopOfHour(startParsed)) {
            toast.error("Start must be a whole hour (e.g. 17:00, 18:00)");
            return;
        }
        if (endParsed && !isTopOfHour(endParsed)) {
            toast.error("End must be a whole hour (e.g. 17:00, 18:00)");
            return;
        }

        const startISO = startParsed ? startParsed.toISOString() : undefined;
        const endISO = endParsed ? endParsed.toISOString() : undefined;
        const startChanged = startISO && startISO !== new Date(leaderboard.start_date).toISOString();
        const endChanged = endISO && endISO !== new Date(leaderboard.end_date).toISOString();

        const tiersParsed = tiers
            .map((t) => ({
                position: Number(t.position),
                prize_amount_usd: Number(t.amount),
            }))
            .filter((t) => Number.isFinite(t.position) && t.position > 0 && Number.isFinite(t.prize_amount_usd) && t.prize_amount_usd > 0);

        const originalTiers = leaderboard.prize_tiers
            .map((t) => ({ position: t.position, prize_amount_usd: Number(t.prize_amount_usd) }))
            .sort((a, b) => a.position - b.position);
        const newTiersSorted = [...tiersParsed].sort((a, b) => a.position - b.position);
        const tiersChanged = JSON.stringify(originalTiers) !== JSON.stringify(newTiersSorted);

        const payload: {
            title?: string;
            affiliate_codes?: string[];
            start_date?: string;
            end_date?: string;
            prize_tiers?: Array<{ position: number; prize_amount_usd: number }>;
        } = {};

        if (titleChanged) payload.title = title.trim();
        if (codesChanged) payload.affiliate_codes = codesParsed;
        if (startChanged) payload.start_date = startISO;
        if (endChanged) payload.end_date = endISO;
        if (tiersChanged) {
            if (newTiersSorted.length === 0) {
                toast.error("At least one prize tier is required");
                return;
            }
            if (tierSumExceeds) {
                toast.error(`Tier sum ($${tierSum.toFixed(2)}) exceeds total prize pool ($${totalPool.toFixed(2)})`);
                return;
            }
            payload.prize_tiers = newTiersSorted;
        }

        if (Object.keys(payload).length === 0) {
            toast.info("No changes to save");
            onOpenChange(false);
            return;
        }

        startTransition(async () => {
            const r = await editLeaderboard(leaderboard.id, payload);
            if (!r.success) {
                toast.error(r.error);
                return;
            }
            toast.success("Updated");
            onOpenChange(false);
            router.refresh();
        });
    };

    const updateTier = (idx: number, field: "position" | "amount", value: string) => {
        setTiers((prev) =>
            prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)),
        );
    };

    const addTier = () => {
        const nextPos = tiers.length === 0
            ? 1
            : Math.max(...tiers.map((t) => Number(t.position) || 0)) + 1;
        setTiers((prev) => [...prev, { position: String(nextPos), amount: "" }]);
    };

    const removeTier = (idx: number) => {
        setTiers((prev) => prev.filter((_, i) => i !== idx));
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Edit leaderboard</DialogTitle>
                    <DialogDescription>
                        Modify any fields. Empty fields are kept unchanged. Prize tier sum must not exceed
                        the total prize pool of ${totalPool.toFixed(2)} (creator funded + site bonus).
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="title">Title</Label>
                        <Input
                            id="title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={100}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="codes">Affiliate codes (comma-separated, leave empty for all)</Label>
                        <Input
                            id="codes"
                            value={codesText}
                            onChange={(e) => setCodesText(e.target.value)}
                            placeholder="zog, packy"
                        />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="start_date">Start (whole hour only)</Label>
                            <Input
                                id="start_date"
                                type="datetime-local"
                                step={3600}
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="end_date">End (whole hour only)</Label>
                            <Input
                                id="end_date"
                                type="datetime-local"
                                step={3600}
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                            />
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground -mt-2">
                        Leaderboard times must align to whole hours (e.g. 17:00, 18:00). Snapshot
                        and cache jobs run on hourly ticks.
                    </p>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label>Prize tiers</Label>
                            <span
                                className={
                                    tierSumExceeds
                                        ? "text-xs text-destructive font-medium"
                                        : "text-xs text-muted-foreground"
                                }
                            >
                                Sum: ${tierSum.toFixed(2)} / ${totalPool.toFixed(2)}
                            </span>
                        </div>
                        <div className="space-y-2">
                            {tiers.map((t, idx) => (
                                <div key={idx} className="flex gap-2 items-center">
                                    <Input
                                        type="number"
                                        min={1}
                                        step={1}
                                        placeholder="Pos"
                                        value={t.position}
                                        onChange={(e) => updateTier(idx, "position", e.target.value)}
                                        className="w-16 sm:w-24"
                                    />
                                    <Input
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        placeholder="Amount USD"
                                        value={t.amount}
                                        onChange={(e) => updateTier(idx, "amount", e.target.value)}
                                        className="flex-1"
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => removeTier(idx)}
                                        className="shrink-0"
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            ))}
                            <Button type="button" variant="outline" size="sm" onClick={addTier}>
                                <Plus className="size-4 mr-1" /> Add tier
                            </Button>
                        </div>
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
                            disabled={isPending || tierSumExceeds}
                            className="w-full sm:w-auto"
                        >
                            {isPending ? "Saving..." : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
